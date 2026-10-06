import { db } from './db.js';

/** Validates a question payload { subject_code, question, options[], correct, ... }. Returns an error code or null. */
export function validQuestion(b) {
  const subject = db.prepare('SELECT space FROM subjects WHERE code = ?').get(b.subject_code ?? '');
  if (!subject) return 'invalid_subject';
  if (!b.question || String(b.question).trim().length < 5) return 'invalid_question';
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 6 || b.options.some((o) => !String(o).trim())) return 'invalid_options';
  if (!Number.isInteger(b.correct) || b.correct < 0 || b.correct >= b.options.length) return 'invalid_correct';
  return null;
}

export function questionValues(b) {
  const subject = db.prepare('SELECT space FROM subjects WHERE code = ?').get(b.subject_code);
  return {
    space: subject.space, subject_code: b.subject_code, topic: String(b.topic || '').slice(0, 200),
    question: String(b.question).trim(), options: JSON.stringify(b.options.map((o) => String(o).trim())), correct: b.correct,
    explanation: String(b.explanation || ''), difficulty: [1, 2, 3].includes(Number(b.difficulty)) ? Number(b.difficulty) : 2,
    reference: String(b.reference || '').slice(0, 300), active: b.active === false || b.active === 0 ? 0 : 1,
  };
}

const insertStmt = () => db.prepare(`INSERT INTO questions
  (space, subject_code, topic, question, options, correct, explanation, difficulty, reference, active, source, created_by)
  VALUES (@space, @subject_code, @topic, @question, @options, @correct, @explanation, @difficulty, @reference, @active, @source, @uid)`);

export function insertQuestion(b, { source, uid }) {
  return insertStmt().run({ ...questionValues(b), source, uid }).lastInsertRowid;
}

/** Imports many questions; returns { added, errors: [{ index/line, error }] }. */
export function importQuestions(items, { source, uid, active = true }) {
  const errors = [];
  let added = 0;
  const stmt = insertStmt();
  db.transaction(() => {
    items.forEach((raw, i) => {
      const b = { ...raw, subject_code: normalizeSubject(raw.subject_code ?? raw.subject) };
      if (!active) b.active = false;
      const err = validQuestion(b);
      if (err) { errors.push({ line: raw._line ?? i + 1, error: err }); return; }
      stmt.run({ ...questionValues(b), source, uid });
      added++;
    });
  })();
  return { added, errors };
}

/** "50" (Excel drops leading zeros) → "050", "a29" → "A29". */
export function normalizeSubject(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (/^\d{1,3}$/.test(s)) return s.padStart(3, '0');
  return s;
}

// ---------------------------------------------------------------------------
// CSV (Excel "CSV UTF-8" or "CSV (séparateur : point-virgule)") import
// ---------------------------------------------------------------------------
const COLUMN_ALIASES = {
  subject: ['matiere', 'matière', 'subject', 'code', 'chapitre'],
  topic: ['theme', 'thème', 'topic', 'sujet'],
  question: ['question', 'enonce', 'énoncé'],
  a: ['a', 'reponse a', 'réponse a', 'answer a', 'option a'],
  b: ['b', 'reponse b', 'réponse b', 'answer b', 'option b'],
  c: ['c', 'reponse c', 'réponse c', 'answer c', 'option c'],
  d: ['d', 'reponse d', 'réponse d', 'answer d', 'option d'],
  e: ['e', 'reponse e', 'réponse e', 'answer e', 'option e'],
  f: ['f', 'reponse f', 'réponse f', 'answer f', 'option f'],
  correct: ['bonne reponse', 'bonne réponse', 'bonne_reponse', 'correct', 'answer', 'reponse', 'réponse', 'solution'],
  explanation: ['explication', 'explanation', 'commentaire'],
  difficulty: ['difficulte', 'difficulté', 'difficulty', 'niveau'],
  reference: ['reference', 'référence', 'source', 'ref'],
};

function parseCsvRows(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0];
  const count = (ch) => firstLine.split(ch).length - 1;
  const sep = [';', ',', '\t'].sort((x, y) => count(y) - count(x))[0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parses a CSV into question payloads (with _line for error reporting). */
export function parseQuestionsCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { items: [], error: 'empty_csv' };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const col = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx > -1) col[key] = idx;
  }
  if (col.subject === undefined || col.question === undefined || col.a === undefined || col.b === undefined || col.correct === undefined) {
    return { items: [], error: 'missing_columns' };
  }
  const items = rows.slice(1).map((r, i) => {
    const get = (k) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
    const options = ['a', 'b', 'c', 'd', 'e', 'f'].map(get).filter((o, idx) => o !== '' || idx < 2);
    const c = get('correct').toUpperCase();
    const correct = /^[A-F]$/.test(c) ? c.charCodeAt(0) - 65 : /^\d$/.test(c) ? Number(c) - 1 : -1;
    return {
      _line: i + 2, subject: get('subject'), topic: get('topic'), question: get('question'), options, correct,
      explanation: get('explanation'), difficulty: Number(get('difficulty')) || 2, reference: get('reference'),
    };
  });
  return { items };
}
