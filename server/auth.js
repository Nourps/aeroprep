import crypto from 'node:crypto';
import { db, getSetting } from './db.js';
import { config } from './config.js';

export const COOKIE = 'aeroprep_session';

// ---------- passwords (scrypt, built into Node) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
}

// ---------- sessions ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    expires,
    path: '/',
  });
}

export function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

const sessionUser = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.disabled, u.lang, u.ai_daily_quota
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`);

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const user = sessionUser.get(sha256(token), new Date().toISOString());
    if (user && !user.disabled) req.user = user;
  }
  next();
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ---------- permissions ----------
// pending  : newly registered, waiting for an admin. Quizzes only.
// readonly : validated, can read documents and use the quizzes, cannot contribute.
// member   : validated, can also add job offers.
// admin    : everything (users, quotas, documents, questions, job sources).
const PERMS = {
  'quiz': ['admin', 'member', 'readonly', 'pending'],
  'jobs.view': ['admin', 'member', 'readonly', 'pending'],
  'docs.view': ['admin', 'member', 'readonly'],
  'ai.ask': ['admin', 'member', 'readonly', 'pending'], // still limited by quota (0 for pending by default)
  'jobs.add': ['admin', 'member'],
  'admin': ['admin'],
};

export function can(user, perm) {
  return !!user && (PERMS[perm] || []).includes(user.role);
}

export function permissionsFor(user) {
  return Object.keys(PERMS).filter((p) => can(user, p));
}

export const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'auth_required' });

export const requirePerm = (perm) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  if (!can(req.user, perm)) return res.status(403).json({ error: 'forbidden' });
  next();
};

// ---------- CSRF: cookies are SameSite=Lax and every mutating call must be JSON or carry X-Requested-With ----------
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') === 'aeroprep') return next();
  return res.status(403).json({ error: 'csrf' });
}

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  return (req, res, next) => {
    const k = `${req.path}:${key(req)}`;
    const t = Date.now();
    const entry = buckets.get(k) || { count: 0, reset: t + windowMs };
    if (t > entry.reset) { entry.count = 0; entry.reset = t + windowMs; }
    entry.count += 1;
    buckets.set(k, entry);
    if (entry.count > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
}, 60_000).unref();

// ---------- AI quotas ----------
export function dailyQuota(user) {
  if (user.ai_daily_quota !== null && user.ai_daily_quota !== undefined) return user.ai_daily_quota;
  return Number(getSetting(`quota_${user.role}`) ?? 0);
}

export function usedToday(userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND kind = 'ask' AND created_at >= date('now')`)
    .get(userId).n;
}

export function quotaStatus(user) {
  const quota = dailyQuota(user);
  const used = usedToday(user.id);
  return { quota, used, remaining: quota < 0 ? null : Math.max(0, quota - used) };
}
