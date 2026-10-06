import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { loadSeedQuestions, loadSeedInsights } from './db.js';
import { loadUser, csrfGuard, purgeExpiredSessions } from './auth.js';
import authRoutes from './routes/auth.js';
import quizRoutes from './routes/quiz.js';
import docsRoutes from './routes/docs.js';
import aiRoutes from './routes/ai.js';
import jobsRoutes from './routes/jobs.js';
import adminRoutes from './routes/admin.js';
import questionRoutes from './routes/questions.js';
import insightRoutes from './routes/insights.js';
import { startAgentScheduler } from './services/agent.js';
import { startDuckdns } from './services/duckdns.js';
import { resumePendingIndexing } from './services/pdf.js';
import { startScheduler } from './services/jobs.js';

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'");
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(loadUser);

const api = express.Router();
api.use(csrfGuard);
api.use('/auth', authRoutes);
api.use('/quiz', quizRoutes);
api.use('/docs', docsRoutes);
api.use('/ai', aiRoutes);
api.use('/jobs', jobsRoutes);
api.use('/admin', adminRoutes);
api.use('/questions', questionRoutes);
api.use('/insights', insightRoutes);
api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});
app.use('/api', api);

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

const added = loadSeedQuestions();
if (added) console.log(`[seed] ${added} question(s) added from seed/`);
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600_000).unref();
resumePendingIndexing();
startScheduler();
loadSeedInsights();
startAgentScheduler();
startDuckdns();

app.listen(config.port, config.host, () => {
  console.log(`AeroPrep listening on http://${config.host}:${config.port}`);
});
