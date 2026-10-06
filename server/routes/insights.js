import { Router } from 'express';
import { db } from '../db.js';
import { requirePerm } from '../auth.js';
import { refreshInsight, createAirlineCard } from '../services/agent.js';

// Context cards of the jobs tab: airlines (pay, conditions, recruitment) and general topics.
const r = Router();
const parse = (c) => ({ ...c, sources: JSON.parse(c.sources || '[]') });

r.get('/', requirePerm('jobs.view'), (_req, res) => {
  res.json({ insights: db.prepare('SELECT * FROM insights ORDER BY kind DESC, region, title').all().map(parse) });
});

r.put('/:key', requirePerm('admin'), (req, res) => {
  const c = db.prepare('SELECT * FROM insights WHERE key = ?').get(req.params.key);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const pick = (k, max) => (req.body[k] !== undefined ? String(req.body[k]).slice(0, max) : c[k]);
  db.prepare(`UPDATE insights SET title = ?, region = ?, match = ?, summary = ?, body = ?, salary_fo = ?, salary_cpt = ?, locked = ?,
      updated_at = datetime('now'), updated_by = 'admin' WHERE key = ?`)
    .run(pick('title', 200), pick('region', 100), pick('match', 300), pick('summary', 600), pick('body', 20000),
      pick('salary_fo', 300), pick('salary_cpt', 300), req.body.locked === undefined ? c.locked : (req.body.locked ? 1 : 0), c.key);
  res.json({ ok: true });
});

r.delete('/:key', requirePerm('admin'), (req, res) => {
  db.prepare('DELETE FROM insights WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

// Research runs take a minute or two: they are started in the background and the page polls the cards.
r.post('/', requirePerm('admin'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name_required' });
  createAirlineCard(name, req.user.id).catch((e) => console.error('[insights]', e.message));
  res.json({ started: true });
});

r.post('/:key/refresh', requirePerm('admin'), (req, res) => {
  if (!db.prepare('SELECT 1 FROM insights WHERE key = ?').get(req.params.key)) return res.status(404).json({ error: 'not_found' });
  refreshInsight(req.params.key, req.user.id).catch((e) => console.error('[insights]', e.message));
  res.json({ started: true });
});

export default r;
