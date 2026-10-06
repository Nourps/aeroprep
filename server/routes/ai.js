import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { requirePerm, quotaStatus, rateLimit } from '../auth.js';
import { askDocuments, generateQuestions, aiStatus } from '../services/ai.js';

const r = Router();

function apiError(err, res) {
  if (err.code === 'ai_not_configured') return res.status(503).json({ error: 'ai_not_configured' });
  if (err.code === 'not_found' || err.code === 'no_text' || err.code === 'refusal') return res.status(400).json({ error: err.code });
  if (err instanceof Anthropic.AuthenticationError) return res.status(502).json({ error: 'ai_bad_key' });
  if (err instanceof Anthropic.RateLimitError) return res.status(503).json({ error: 'ai_rate_limited' });
  if (err instanceof Anthropic.BadRequestError) { console.error('[ai] bad request', err.message); return res.status(502).json({ error: 'ai_bad_request', detail: err.message }); }
  if (err instanceof Anthropic.APIError) { console.error('[ai] api error', err.status, err.message); return res.status(502).json({ error: 'ai_unavailable' }); }
  console.error('[ai]', err);
  return res.status(500).json({ error: 'server_error' });
}

r.get('/status', requirePerm('ai.ask'), (req, res) => {
  const docs = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE index_status = 'ready'").get().n;
  res.json({ ...aiStatus(), readyDocuments: docs, quota: quotaStatus(req.user) });
});

r.post('/ask', requirePerm('ai.ask'), rateLimit({ windowMs: 60_000, max: 6, key: (req) => req.user.id }), async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question || question.length > 2000) return res.status(400).json({ error: 'invalid_question' });
  const q = quotaStatus(req.user);
  if (q.quota >= 0 && q.used >= q.quota) return res.status(429).json({ error: 'quota_exceeded', quota: q });
  const history = Array.isArray(req.body.history) ? req.body.history.filter((h) => h && h.q && h.a) : [];
  try {
    const result = await askDocuments(req.user, question, history);
    res.json({ ...result, quota: quotaStatus(req.user) });
  } catch (err) {
    apiError(err, res);
  }
});

r.post('/generate', requirePerm('admin'), async (req, res) => {
  const docId = Number(req.body.docId);
  const fromPage = Math.max(1, Number(req.body.fromPage) || 1);
  const toPage = Math.max(fromPage, Math.min(fromPage + 60, Number(req.body.toPage) || fromPage));
  const count = Math.max(1, Math.min(25, Number(req.body.count) || 10));
  const subject = String(req.body.subject || 'A99');
  if (!db.prepare("SELECT 1 FROM subjects WHERE code = ? AND space = 'a320'").get(subject)) return res.status(400).json({ error: 'invalid_subject' });
  try {
    res.json(await generateQuestions(req.user, { docId, fromPage, toPage, count, subject }));
  } catch (err) {
    apiError(err, res);
  }
});

export default r;
