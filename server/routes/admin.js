import { Router } from 'express';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { requirePerm, hashPassword, dailyQuota } from '../auth.js';
import { aiStatus } from '../services/ai.js';
import { refreshAll, runSource } from '../services/jobs.js';

const r = Router();
r.use(requirePerm('admin'));

const ROLES = ['admin', 'member', 'readonly', 'pending'];

// Indicative public prices (USD per million tokens) used only for the cost estimate shown in the panel.
const PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5], 'claude-fable-5-1': [10, 50],
};
const cost = (model, input, output) => {
  const [i, o] = PRICES[model] || [0, 0];
  return (input * i + output * o) / 1e6;
};

// ---------- users ----------
r.get('/users', (_req, res) => {
  const users = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.disabled, u.ai_daily_quota, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM ai_usage a WHERE a.user_id = u.id AND a.kind = 'ask' AND a.created_at >= date('now')) AS ai_today,
      (SELECT COUNT(*) FROM attempts t WHERE t.user_id = u.id) AS answers
    FROM users u ORDER BY u.role = 'pending' DESC, u.created_at DESC`).all();
  res.json({ users: users.map((u) => ({ ...u, effective_quota: dailyQuota(u) })) });
});

r.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });
  const { role, disabled, ai_daily_quota: quota } = req.body;
  if (user.id === req.user.id && ((role && role !== 'admin') || disabled)) return res.status(400).json({ error: 'cannot_demote_self' });
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  }
  if (disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, user.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  if (quota !== undefined) {
    db.prepare('UPDATE users SET ai_daily_quota = ? WHERE id = ?').run(quota === null || quota === '' ? null : Math.round(Number(quota)), user.id);
  }
  res.json({ ok: true });
});

r.post('/users/:id/reset-password', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });
  const temp = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temp), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ temporaryPassword: temp });
});

r.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- settings & AI ----------
const EDITABLE = ['registration_open', 'ai_model', 'ai_effort', 'quota_admin', 'quota_member', 'quota_readonly', 'quota_pending',
  'jobs_refresh_hours', 'jobs_max_age_days', 'exam_seconds_per_question', 'exam_pass_mark'];

r.get('/settings', (_req, res) => {
  const settings = Object.fromEntries(EDITABLE.map((k) => [k, getSetting(k)]));
  const key = getSetting('ai_api_key');
  res.json({ settings, ai: { ...aiStatus(), storedKeyHint: key ? `…${key.slice(-4)}` : null } });
});

r.put('/settings', (req, res) => {
  for (const k of EDITABLE) {
    if (req.body[k] === undefined) continue;
    let v = String(req.body[k]).trim();
    if (k === 'ai_effort' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) continue;
    if (k === 'registration_open') v = v === 'true' ? 'true' : 'false';
    if (k.startsWith('quota_') || k.startsWith('jobs_') || k.startsWith('exam_')) { if (!Number.isFinite(Number(v))) continue; }
    if (k === 'ai_model' && !/^[a-z0-9.\-]+$/.test(v)) continue;
    setSetting(k, v);
  }
  if (typeof req.body.ai_api_key === 'string') setSetting('ai_api_key', req.body.ai_api_key.trim());
  res.json({ ok: true });
});

r.get('/usage', (_req, res) => {
  const rows = db.prepare(`SELECT u.id, u.email, u.name, u.role, a.model,
      SUM(CASE WHEN a.created_at >= date('now') AND a.kind = 'ask' THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN a.kind = 'ask' THEN 1 ELSE 0 END) AS questions,
      SUM(CASE WHEN a.kind = 'generate' THEN 1 ELSE 0 END) AS generations,
      SUM(a.input_tokens) AS input_tokens, SUM(a.output_tokens) AS output_tokens
    FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= date('now', '-30 days')
    GROUP BY a.user_id, a.model ORDER BY input_tokens DESC`).all();
  const byUser = new Map();
  for (const r0 of rows) {
    const e = byUser.get(r0.id) || { id: r0.id, email: r0.email, name: r0.name, role: r0.role, today: 0, questions: 0, generations: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    e.today += r0.today; e.questions += r0.questions; e.generations += r0.generations;
    e.input_tokens += r0.input_tokens; e.output_tokens += r0.output_tokens;
    e.cost_usd += cost(r0.model, r0.input_tokens, r0.output_tokens);
    byUser.set(r0.id, e);
  }
  const recent = db.prepare(`SELECT a.created_at, a.kind, a.model, a.input_tokens, a.output_tokens, a.question, u.email
    FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 50`).all();
  res.json({ users: [...byUser.values()], recent });
});

// ---------- questions ----------
r.get('/questions', (req, res) => {
  const where = ['1 = 1'];
  const p = {};
  if (req.query.space) { where.push('q.space = @space'); p.space = req.query.space; }
  if (req.query.subject) { where.push('q.subject_code = @subject'); p.subject = req.query.subject; }
  if (req.query.source) { where.push('q.source = @source'); p.source = req.query.source; }
  if (req.query.active === '0' || req.query.active === '1') { where.push('q.active = @active'); p.active = Number(req.query.active); }
  if (req.query.flagged === '1') where.push('EXISTS (SELECT 1 FROM flags f WHERE f.question_id = q.id)');
  if (req.query.q) { where.push('(q.question LIKE @q OR q.topic LIKE @q OR q.explanation LIKE @q)'); p.q = `%${req.query.q}%`; }
  const rows = db.prepare(`SELECT q.*, (SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) AS attempts,
      (SELECT AVG(a.correct) FROM attempts a WHERE a.question_id = q.id) AS success,
      (SELECT group_concat(f.note, ' | ') FROM flags f WHERE f.question_id = q.id AND f.note != '') AS flag_notes,
      (SELECT COUNT(*) FROM flags f WHERE f.question_id = q.id) AS flags
    FROM questions q WHERE ${where.join(' AND ')} ORDER BY q.space, q.subject_code, q.id LIMIT 500`).all(p);
  res.json({ questions: rows.map((q) => ({ ...q, options: JSON.parse(q.options) })) });
});

function validQuestion(b) {
  const subject = db.prepare('SELECT space FROM subjects WHERE code = ?').get(b.subject_code);
  if (!subject) return 'invalid_subject';
  if (!b.question || String(b.question).trim().length < 5) return 'invalid_question';
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 6 || b.options.some((o) => !String(o).trim())) return 'invalid_options';
  if (!Number.isInteger(b.correct) || b.correct < 0 || b.correct >= b.options.length) return 'invalid_correct';
  return null;
}

function questionValues(b) {
  const subject = db.prepare('SELECT space FROM subjects WHERE code = ?').get(b.subject_code);
  return {
    space: subject.space, subject_code: b.subject_code, topic: String(b.topic || '').slice(0, 200),
    question: String(b.question).trim(), options: JSON.stringify(b.options.map((o) => String(o).trim())), correct: b.correct,
    explanation: String(b.explanation || ''), difficulty: [1, 2, 3].includes(b.difficulty) ? b.difficulty : 2,
    reference: String(b.reference || '').slice(0, 300), active: b.active === false || b.active === 0 ? 0 : 1,
  };
}

r.post('/questions', (req, res) => {
  const err = validQuestion(req.body);
  if (err) return res.status(400).json({ error: err });
  const v = questionValues(req.body);
  const info = db.prepare(`INSERT INTO questions (space, subject_code, topic, question, options, correct, explanation, difficulty, reference, active, source, created_by)
    VALUES (@space, @subject_code, @topic, @question, @options, @correct, @explanation, @difficulty, @reference, @active, 'admin', @uid)`)
    .run({ ...v, uid: req.user.id });
  res.json({ id: info.lastInsertRowid });
});

r.put('/questions/:id', (req, res) => {
  const err = validQuestion(req.body);
  if (err) return res.status(400).json({ error: err });
  const v = questionValues(req.body);
  db.prepare(`UPDATE questions SET space = @space, subject_code = @subject_code, topic = @topic, question = @question, options = @options,
      correct = @correct, explanation = @explanation, difficulty = @difficulty, reference = @reference, active = @active WHERE id = @id`)
    .run({ ...v, id: Number(req.params.id) });
  res.json({ ok: true });
});

r.patch('/questions/:id', (req, res) => {
  if (req.body.active !== undefined) db.prepare('UPDATE questions SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, Number(req.params.id));
  if (req.body.clearFlags) db.prepare('DELETE FROM flags WHERE question_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/questions/:id', (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

r.get('/questions/export', (req, res) => {
  const rows = db.prepare(`SELECT subject_code AS subject, topic, question, options, correct, explanation, difficulty, reference
    FROM questions WHERE (@space IS NULL OR space = @space) ORDER BY subject_code, id`).all({ space: req.query.space || null });
  res.setHeader('Content-Disposition', 'attachment; filename="aeroprep-questions.json"');
  res.json(rows.map((q) => ({ ...q, options: JSON.parse(q.options) })));
});

// Import: JSON array of {subject, topic, question, options[], correct, explanation, difficulty, reference}
r.post('/questions/import', (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body.questions;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'invalid_format' });
  const errors = [];
  let added = 0;
  const insert = db.prepare(`INSERT INTO questions (space, subject_code, topic, question, options, correct, explanation, difficulty, reference, active, source, created_by)
    VALUES (@space, @subject_code, @topic, @question, @options, @correct, @explanation, @difficulty, @reference, @active, 'import', @uid)`);
  db.transaction(() => {
    items.forEach((raw, i) => {
      const b = { ...raw, subject_code: raw.subject_code || raw.subject };
      const err = validQuestion(b);
      if (err) { errors.push({ index: i, error: err }); return; }
      insert.run({ ...questionValues(b), uid: req.user.id });
      added++;
    });
  })();
  res.json({ added, errors: errors.slice(0, 50) });
});

// ---------- job sources ----------
r.get('/job-sources', (_req, res) => {
  res.json({ sources: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM jobs j WHERE j.source_id = s.id AND j.hidden = 0) AS jobs
    FROM job_sources s ORDER BY s.name`).all() });
});

function validSource(b) {
  if (!['rss', 'greenhouse', 'lever', 'jsonld'].includes(b.kind)) return 'invalid_kind';
  if (!String(b.name || '').trim()) return 'name_required';
  if (!String(b.target || '').trim()) return 'target_required';
  if ((b.kind === 'rss' || b.kind === 'jsonld') && !/^https?:\/\//i.test(b.target)) return 'invalid_url';
  return null;
}

r.post('/job-sources', (req, res) => {
  const err = validSource(req.body);
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare('INSERT INTO job_sources (name, kind, target, company, enabled, pilot_filter) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(req.body.name).trim(), req.body.kind, String(req.body.target).trim(), String(req.body.company || '').trim(),
      req.body.enabled === false ? 0 : 1, req.body.pilot_filter === false ? 0 : 1);
  res.json({ id: info.lastInsertRowid });
});

r.put('/job-sources/:id', (req, res) => {
  const err = validSource(req.body);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE job_sources SET name = ?, kind = ?, target = ?, company = ?, enabled = ?, pilot_filter = ? WHERE id = ?')
    .run(String(req.body.name).trim(), req.body.kind, String(req.body.target).trim(), String(req.body.company || '').trim(),
      req.body.enabled === false ? 0 : 1, req.body.pilot_filter === false ? 0 : 1, Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/job-sources/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM jobs WHERE source_id = ? AND id NOT IN (SELECT job_id FROM job_marks)').run(id);
  db.prepare('DELETE FROM job_sources WHERE id = ?').run(id);
  res.json({ ok: true });
});

r.post('/job-sources/:id/run', async (req, res) => {
  const src = db.prepare('SELECT * FROM job_sources WHERE id = ?').get(Number(req.params.id));
  if (!src) return res.status(404).json({ error: 'not_found' });
  res.json(await runSource(src));
});

r.post('/job-sources/refresh', async (_req, res) => {
  res.json({ results: await refreshAll() });
});

export default r;
