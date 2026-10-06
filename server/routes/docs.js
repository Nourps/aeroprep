import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { requirePerm } from '../auth.js';
import { queueIndexing, searchChunks } from '../services/pdf.js';

const r = Router();
export const DOC_CATEGORIES = ['fcom', 'fctm', 'qrh', 'mel', 'fcom_bulletin', 'sop', 'tr_notes', 'other'];

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)),
});

const listDocs = db.prepare(`SELECT id, title, category, description, original_name, size, pages, index_status, index_error, created_at
  FROM documents ORDER BY category, title`);

r.get('/', requirePerm('docs.view'), (_req, res) => res.json({ documents: listDocs.all(), categories: DOC_CATEGORIES }));

r.get('/search', requirePerm('docs.view'), (req, res) => {
  const hits = searchChunks(String(req.query.q || ''), { limit: 30 });
  res.json({ results: hits.map(({ doc_id, page, snippet, title, category }) => ({ docId: doc_id, page, snippet, title, category })) });
});

r.get('/:id/file', requirePerm('docs.view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).end();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(config.uploadDir, doc.stored_name));
});

r.post('/', requirePerm('admin'), upload.array('files', 20), (req, res) => {
  const category = DOC_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  const created = [];
  for (const f of req.files || []) {
    const title = (req.files.length === 1 && req.body.title ? String(req.body.title) : f.originalname.replace(/\.pdf$/i, '')).slice(0, 200);
    const info = db.prepare(`INSERT INTO documents (title, category, description, stored_name, original_name, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(title, category, String(req.body.description || '').slice(0, 1000), f.filename,
      Buffer.from(f.originalname, 'latin1').toString('utf8'), f.size, req.user.id);
    queueIndexing(info.lastInsertRowid);
    created.push(info.lastInsertRowid);
  }
  if (!created.length) return res.status(400).json({ error: 'no_pdf' });
  res.json({ created });
});

r.patch('/:id', requirePerm('admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const title = req.body.title !== undefined ? String(req.body.title).slice(0, 200) : doc.title;
  const category = DOC_CATEGORIES.includes(req.body.category) ? req.body.category : doc.category;
  const description = req.body.description !== undefined ? String(req.body.description).slice(0, 1000) : doc.description;
  db.prepare('UPDATE documents SET title = ?, category = ?, description = ? WHERE id = ?').run(title, category, description, doc.id);
  res.json({ ok: true });
});

r.post('/:id/reindex', requirePerm('admin'), (req, res) => {
  queueIndexing(Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/:id', requirePerm('admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  fs.rm(path.join(config.uploadDir, doc.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

export default r;
