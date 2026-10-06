import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pending' CHECK (role IN ('admin','member','readonly','pending')),
  disabled INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT 'fr',
  ai_daily_quota INTEGER,               -- NULL = use the role quota
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  code TEXT PRIMARY KEY,
  space TEXT NOT NULL CHECK (space IN ('atpl','a320')),
  name_en TEXT NOT NULL,
  name_fr TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  space TEXT NOT NULL CHECK (space IN ('atpl','a320')),
  subject_code TEXT NOT NULL REFERENCES subjects(code),
  topic TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  options TEXT NOT NULL,                -- JSON array of strings
  correct INTEGER NOT NULL,             -- index in options
  explanation TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 2, -- 1 easy, 2 medium, 3 hard
  source TEXT NOT NULL DEFAULT 'admin',  -- seed | admin | ai | import
  seed_key TEXT UNIQUE,
  reference TEXT NOT NULL DEFAULT '',    -- e.g. "FCOM DSC-29" or a document/page
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(space, subject_code, active);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen INTEGER,
  correct INTEGER NOT NULL,
  mode TEXT NOT NULL,
  exam_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, question_id);

-- Leitner boxes for spaced repetition (box 1..6, 6 = mastered)
CREATE TABLE IF NOT EXISTS srs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  box INTEGER NOT NULL DEFAULT 1,
  due_at TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS flags (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  subjects TEXT NOT NULL,               -- JSON array
  question_ids TEXT NOT NULL,           -- JSON array
  answers TEXT,                         -- JSON object {questionId: chosenIndex}
  duration_s INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  score REAL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL DEFAULT '',
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  pages INTEGER,
  index_status TEXT NOT NULL DEFAULT 'pending', -- pending | indexing | ready | error
  index_error TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks USING fts5(
  text,
  doc_id UNINDEXED,
  page UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'ask',     -- ask | generate
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);

CREATE TABLE IF NOT EXISTS job_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rss','greenhouse','lever','jsonld')),
  target TEXT NOT NULL,                 -- feed URL, board token, company slug or page URL
  company TEXT NOT NULL DEFAULT '',     -- default company name for offers of this source
  enabled INTEGER NOT NULL DEFAULT 1,
  pilot_filter INTEGER NOT NULL DEFAULT 1, -- keep only pilot-related offers
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'unknown',   -- cadet | low_hours | type_rated | captain | instructor | unknown
  aircraft TEXT NOT NULL DEFAULT '',          -- comma separated tags: a320,b737,b777,...
  type_rating TEXT NOT NULL DEFAULT 'unknown',-- required | not_required | unknown
  min_hours INTEGER,
  source_id INTEGER REFERENCES job_sources(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL DEFAULT 'manual',
  posted_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manual_override INTEGER NOT NULL DEFAULT 0, -- 1 = classification edited by hand, keep on refresh
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS job_marks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('saved','applied','rejected')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id)
);
`);

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  registration_open: 'true',
  ai_model: 'claude-opus-5-5',
  ai_effort: 'medium',
  ai_api_key: '',
  quota_admin: '-1', // -1 = unlimited
  quota_member: '20',
  quota_readonly: '5',
  quota_pending: '0',
  jobs_refresh_hours: '6',
  jobs_max_age_days: '45',
  exam_seconds_per_question: '75',
  exam_pass_mark: '75',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// ---------- subjects & seed questions ----------
export const SUBJECTS = [
  // EASA ATPL(A) — 13 subjects
  ['010', 'atpl', 'Air Law', 'Réglementation', 1],
  ['021', 'atpl', 'Airframe, Systems & Powerplant', 'Cellule, systèmes et moteurs', 2],
  ['022', 'atpl', 'Instrumentation', 'Instrumentation', 3],
  ['031', 'atpl', 'Mass & Balance', 'Masse et centrage', 4],
  ['032', 'atpl', 'Performance', 'Performances', 5],
  ['033', 'atpl', 'Flight Planning & Monitoring', 'Préparation et suivi du vol', 6],
  ['040', 'atpl', 'Human Performance & Limitations', 'Performances humaines', 7],
  ['050', 'atpl', 'Meteorology', 'Météorologie', 8],
  ['061', 'atpl', 'General Navigation', 'Navigation générale', 9],
  ['062', 'atpl', 'Radio Navigation', 'Radionavigation', 10],
  ['070', 'atpl', 'Operational Procedures', 'Procédures opérationnelles', 11],
  ['081', 'atpl', 'Principles of Flight', 'Mécanique du vol', 12],
  ['090', 'atpl', 'Communications', 'Communications', 13],
  // A320 family — systems (FCOM DSC chapters)
  ['A20', 'a320', 'Aircraft general & limitations', 'Généralités & limitations', 1],
  ['A21', 'a320', 'Air conditioning & pressurization', 'Conditionnement d\'air & pressurisation', 2],
  ['A22', 'a320', 'Auto flight (FMGS, AP/FD, A/THR)', 'Pilote automatique (FMGS, AP/FD, A/THR)', 3],
  ['A24', 'a320', 'Electrical', 'Électrique', 4],
  ['A26', 'a320', 'Fire protection', 'Protection incendie', 5],
  ['A27', 'a320', 'Flight controls & laws', 'Commandes de vol & lois', 6],
  ['A28', 'a320', 'Fuel', 'Carburant', 7],
  ['A29', 'a320', 'Hydraulics', 'Hydraulique', 8],
  ['A30', 'a320', 'Ice & rain protection', 'Protection givre & pluie', 9],
  ['A31', 'a320', 'Indicating / ECAM', 'Indications / ECAM', 10],
  ['A32', 'a320', 'Landing gear & brakes', 'Train d\'atterrissage & freins', 11],
  ['A34', 'a320', 'Navigation', 'Navigation', 12],
  ['A35', 'a320', 'Oxygen', 'Oxygène', 13],
  ['A36', 'a320', 'Pneumatic / bleed air', 'Pneumatique / prélèvement', 14],
  ['A49', 'a320', 'APU', 'APU', 15],
  ['A70', 'a320', 'Engines (CFM56 / V2500)', 'Moteurs (CFM56 / V2500)', 16],
  ['A99', 'a320', 'Procedures & operations', 'Procédures & exploitation', 17],
];

const upsertSubject = db.prepare(`INSERT INTO subjects (code, space, name_en, name_fr, sort) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(code) DO UPDATE SET space = excluded.space, name_en = excluded.name_en, name_fr = excluded.name_fr, sort = excluded.sort`);
for (const s of SUBJECTS) upsertSubject.run(...s);

/** Loads seed/*.json question banks. New seed questions are added, existing ones are left untouched. */
export function loadSeedQuestions() {
  const dir = path.join(ROOT, 'seed');
  if (!fs.existsSync(dir)) return 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO questions
    (space, subject_code, topic, question, options, correct, explanation, difficulty, source, seed_key, reference)
    VALUES (@space, @subject, @topic, @question, @options, @correct, @explanation, @difficulty, 'seed', @key, @reference)`);
  const subjects = new Map(SUBJECTS.map((s) => [s[0], s[1]]));
  let added = 0;
  const tx = db.transaction((items) => {
    for (const q of items) {
      const space = subjects.get(q.subject);
      if (!space) throw new Error(`Unknown subject ${q.subject} in seed ${q.key}`);
      added += insert.run({
        space,
        subject: q.subject,
        topic: q.topic || '',
        question: q.question,
        options: JSON.stringify(q.options),
        correct: q.correct,
        explanation: q.explanation || '',
        difficulty: q.difficulty || 2,
        key: q.key,
        reference: q.reference || '',
      }).changes;
    }
  });
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    tx(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  return added;
}

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
