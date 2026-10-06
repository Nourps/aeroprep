import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { db } from '../db.js';
import { config } from '../config.js';

const CHUNK_CHARS = 1800;

/** Extracts the text of every page of a PDF. Yields { page, text }. */
async function* extractPages(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const pdf = await loadingTask.promise;
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      page.cleanup();
      yield { page: p, total: pdf.numPages, text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
    }
  } finally {
    await loadingTask.destroy();
  }
}

/** Splits a long page into overlapping chunks so search results stay focused. */
function chunkText(text) {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS - 200) {
    chunks.push(text.slice(start, start + CHUNK_CHARS));
  }
  return chunks;
}

const queue = [];
let running = false;

export function queueIndexing(docId) {
  if (!queue.includes(docId)) queue.push(docId);
  if (!running) void runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await indexDocument(id);
    } catch (err) {
      console.error(`[pdf] indexing document ${id} failed:`, err.message);
      db.prepare("UPDATE documents SET index_status = 'error', index_error = ? WHERE id = ?").run(String(err.message).slice(0, 500), id);
    }
  }
  running = false;
}

async function indexDocument(id) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) return;
  db.prepare("UPDATE documents SET index_status = 'indexing', index_error = NULL WHERE id = ?").run(id);
  db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(id);
  const insert = db.prepare('INSERT INTO doc_chunks (text, doc_id, page) VALUES (?, ?, ?)');
  let pages = 0;
  let batch = [];
  const flush = db.transaction((rows) => { for (const r of rows) insert.run(r.text, id, r.page); });
  for await (const { page, total, text } of extractPages(path.join(config.uploadDir, doc.stored_name))) {
    pages = total;
    for (const chunk of chunkText(text)) if (chunk.trim()) batch.push({ text: chunk, page });
    if (batch.length >= 200) { flush(batch); batch = []; }
  }
  flush(batch);
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM doc_chunks WHERE doc_id = ?').get(id).n;
  db.prepare("UPDATE documents SET index_status = 'ready', pages = ?, index_error = ? WHERE id = ?")
    .run(pages, chunks === 0 ? 'no_text' : null, id);
  console.log(`[pdf] indexed document ${id} (${pages} pages, ${chunks} chunks)`);
}

/** Resume documents left half-indexed by a restart. */
export function resumePendingIndexing() {
  for (const { id } of db.prepare("SELECT id FROM documents WHERE index_status IN ('pending','indexing')").all()) queueIndexing(id);
}

// ---------- search ----------
const STOP = new Set(('the a an and or of to in on for with is are be by at as it this that from what how when which why ' +
  'le la les un une des du de et ou en au aux est sont pour par sur dans avec que qui quoi comment quand quel quelle quels quelles ' +
  'pourquoi ce cette ces il elle se sa son ses ne pas plus').split(' '));

/** Builds a forgiving FTS5 query: every meaningful word, OR-combined, prefix-matched. */
export function ftsQuery(text) {
  const words = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .match(/[a-z0-9]+/g) || [];
  const terms = [...new Set(words.filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)))].slice(0, 16);
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export function searchChunks(query, { limit = 8, docIds = null } = {}) {
  const match = ftsQuery(query);
  if (!match) return [];
  let sql = `SELECT c.doc_id, c.page, snippet(doc_chunks, 0, '[', ']', ' … ', 40) AS snippet, c.text, d.title, d.category,
      bm25(doc_chunks) AS rank
    FROM doc_chunks c JOIN documents d ON d.id = c.doc_id WHERE doc_chunks MATCH ?`;
  const params = [match];
  if (docIds?.length) { sql += ` AND c.doc_id IN (${docIds.map(() => '?').join(',')})`; params.push(...docIds); }
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function pageText(docId, page) {
  return db.prepare('SELECT text FROM doc_chunks WHERE doc_id = ? AND page = ? ORDER BY rowid').all(docId, page)
    .map((r) => r.text).join('\n');
}
