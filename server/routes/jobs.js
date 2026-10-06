import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { requirePerm, can, rateLimit } from '../auth.js';
import { classify, previewUrl, AIRCRAFT } from '../services/jobs.js';

const r = Router();
const CATEGORIES = ['cadet', 'low_hours', 'type_rated', 'captain', 'instructor', 'unknown'];
const TR = ['required', 'not_required', 'unknown'];
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

r.get('/', requirePerm('jobs.view'), (req, res) => {
  const where = ['j.hidden = 0'];
  const params = { uid: req.user.id };
  const maxAge = Number(getSetting('jobs_max_age_days')) || 45;
  where.push(`(j.last_seen_at >= datetime('now', '-${Math.floor(maxAge)} days') OR m.status IS NOT NULL)`);

  const q = String(req.query.q || '').trim();
  if (q) { where.push('(j.title LIKE @q OR j.company LIKE @q OR j.location LIKE @q OR j.description LIKE @q)'); params.q = `%${q}%`; }
  const cats = list(req.query.category).filter((c) => CATEGORIES.includes(c));
  if (cats.length) where.push(`j.category IN (${cats.map((c) => `'${c}'`).join(',')})`);
  const tr = list(req.query.typeRating).filter((t) => TR.includes(t));
  if (tr.length) where.push(`j.type_rating IN (${tr.map((t) => `'${t}'`).join(',')})`);
  const ac = list(req.query.aircraft).filter((a) => a in AIRCRAFT || a === 'none');
  if (ac.length) {
    where.push(`(${ac.map((a, i) => {
      if (a === 'none') return "j.aircraft = ''";
      params[`ac${i}`] = `%${a}%`;
      return `(',' || j.aircraft || ',') LIKE @ac${i}`;
    }).join(' OR ')})`);
  }
  if (req.query.myHours !== undefined && req.query.myHours !== '') {
    params.myHours = Number(req.query.myHours) || 0;
    where.push(req.query.includeUnknownHours === 'false' ? 'j.min_hours <= @myHours' : '(j.min_hours IS NULL OR j.min_hours <= @myHours)');
  }
  if (req.query.company) { where.push('j.company LIKE @company'); params.company = `%${req.query.company}%`; }
  if (req.query.location) { where.push('j.location LIKE @location'); params.location = `%${req.query.location}%`; }
  if (req.query.source) { where.push('j.source_name = @source'); params.source = String(req.query.source); }
  if (req.query.days) where.push(`COALESCE(j.posted_at, j.first_seen_at) >= date('now', '-${Math.max(1, Math.floor(Number(req.query.days) || 30))} days')`);
  if (['saved', 'applied', 'rejected'].includes(req.query.status)) { where.push('m.status = @status'); params.status = req.query.status; }
  else if (req.query.hideRejected !== 'false') where.push("(m.status IS NULL OR m.status != 'rejected')");

  const order = req.query.sort === 'hours' ? 'j.min_hours IS NULL, j.min_hours ASC' : 'COALESCE(j.posted_at, j.first_seen_at) DESC, j.id DESC';
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const rows = db.prepare(`SELECT j.id, j.url, j.title, j.company, j.location, j.category, j.aircraft, j.type_rating, j.min_hours,
      j.source_name, j.posted_at, j.first_seen_at, j.added_by, j.manual_override, substr(j.description, 1, 600) AS excerpt, m.status
    FROM jobs j LEFT JOIN job_marks m ON m.job_id = j.id AND m.user_id = @uid
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`).all(params);
  res.json({ jobs: rows });
});

r.get('/meta', requirePerm('jobs.view'), (_req, res) => {
  res.json({
    categories: CATEGORIES,
    typeRatings: TR,
    aircraft: [...Object.keys(AIRCRAFT), 'none'],
    sources: db.prepare('SELECT source_name AS name, COUNT(*) AS n FROM jobs WHERE hidden = 0 GROUP BY source_name ORDER BY n DESC').all(),
    lastRefresh: db.prepare('SELECT MAX(last_run_at) AS t FROM job_sources').get().t,
  });
});

r.get('/:id', requirePerm('jobs.view'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json({ job });
});

r.post('/preview', requirePerm('jobs.add'), rateLimit({ windowMs: 60_000, max: 10, key: (req) => req.user.id }), async (req, res) => {
  try {
    res.json(await previewUrl(String(req.body.url || '')));
  } catch (err) {
    res.json({ fetched: false, reason: err.message === 'private_address' || err.message === 'invalid_url' ? err.message : 'fetch_failed' });
  }
});

function cleanJob(body, fallback = {}) {
  const pick = (k, max) => (body[k] !== undefined ? String(body[k]).trim().slice(0, max) : fallback[k] ?? '');
  const job = {
    title: pick('title', 300), company: pick('company', 200), location: pick('location', 200), description: pick('description', 20000),
    category: CATEGORIES.includes(body.category) ? body.category : fallback.category,
    type_rating: TR.includes(body.type_rating) ? body.type_rating : fallback.type_rating,
    aircraft: body.aircraft !== undefined ? list(body.aircraft).filter((a) => a in AIRCRAFT).join(',') : fallback.aircraft,
    min_hours: body.min_hours === '' || body.min_hours === null ? null
      : body.min_hours !== undefined ? Math.max(0, Math.round(Number(body.min_hours) || 0)) : fallback.min_hours ?? null,
  };
  return job;
}

r.post('/', requirePerm('jobs.add'), (req, res) => {
  let url;
  try { url = new URL(String(req.body.url || '')); } catch { return res.status(400).json({ error: 'invalid_url' }); }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'invalid_url' });
  if (db.prepare('SELECT 1 FROM jobs WHERE url = ?').get(url.toString())) return res.status(409).json({ error: 'already_exists' });
  const auto = classify({ title: req.body.title || '', description: req.body.description || '' });
  // Fields left empty (or on "auto") fall back to the automatic classification.
  const body = { ...req.body };
  for (const k of ['aircraft', 'min_hours']) if (body[k] === '' || body[k] === null) delete body[k];
  const job = cleanJob(body, { category: auto.category, type_rating: auto.typeRating, aircraft: auto.aircraft, min_hours: auto.minHours });
  if (!job.title) return res.status(400).json({ error: 'title_required' });
  const host = url.hostname.replace(/^www\./, '');
  const info = db.prepare(`INSERT INTO jobs (url, title, company, location, description, category, aircraft, type_rating, min_hours,
      source_name, posted_at, added_by, manual_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(url.toString(), job.title, job.company, job.location, job.description,
    job.category, job.aircraft, job.type_rating, job.min_hours, `manual (${host})`, req.body.posted_at || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

r.patch('/:id', requirePerm('jobs.add'), (req, res) => {
  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const job = cleanJob(req.body, existing);
  db.prepare(`UPDATE jobs SET title = ?, company = ?, location = ?, description = ?, category = ?, aircraft = ?, type_rating = ?,
      min_hours = ?, manual_override = 1 WHERE id = ?`)
    .run(job.title || existing.title, job.company, job.location, job.description, job.category, job.aircraft, job.type_rating, job.min_hours, existing.id);
  res.json({ ok: true });
});

r.delete('/:id', requirePerm('jobs.add'), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (!can(req.user, 'admin') && job.added_by !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  // Offers from automatic sources are hidden (otherwise the next refresh would bring them back).
  if (job.source_id) db.prepare('UPDATE jobs SET hidden = 1 WHERE id = ?').run(job.id);
  else db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ ok: true });
});

r.post('/:id/mark', requirePerm('jobs.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!['saved', 'applied', 'rejected'].includes(req.body.status)) {
    db.prepare('DELETE FROM job_marks WHERE user_id = ? AND job_id = ?').run(req.user.id, id);
  } else {
    db.prepare(`INSERT INTO job_marks (user_id, job_id, status) VALUES (?, ?, ?)
      ON CONFLICT(user_id, job_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`).run(req.user.id, id, req.body.status);
  }
  res.json({ ok: true });
});

export default r;
