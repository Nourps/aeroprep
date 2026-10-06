import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession,
  requireAuth, rateLimit, permissionsFor, quotaStatus,
} from '../auth.js';

const r = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, lang: u.lang,
    permissions: permissionsFor(u),
    ai: quotaStatus(u),
  };
}

r.get('/me', (req, res) => {
  res.json({
    user: req.user ? publicUser(req.user) : null,
    registrationOpen: getSetting('registration_open') === 'true',
  });
});

r.post('/register', rateLimit({ windowMs: 3600_000, max: 10 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = req.body.password;
  const lang = req.body.lang === 'en' ? 'en' : 'fr';
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  if (userCount > 0 && getSetting('registration_open') !== 'true') return res.status(403).json({ error: 'registration_closed' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'invalid_email' });
  if (!validatePassword(password)) return res.status(400).json({ error: 'weak_password' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_taken' });

  // The very first account, and any address listed in ADMIN_EMAILS, becomes admin.
  const role = userCount === 0 || config.adminEmails.includes(email) ? 'admin' : 'pending';
  const info = db.prepare('INSERT INTO users (email, name, password_hash, role, lang) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, hashPassword(password), role, lang);
  createSession(res, info.lastInsertRowid, req);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ user: publicUser(user) });
});

r.post('/login', rateLimit({ windowMs: 15 * 60_000, max: 20 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  if (user.disabled) return res.status(403).json({ error: 'account_disabled' });
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  createSession(res, user.id, req);
  res.json({ user: publicUser(user) });
});

r.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

r.patch('/me', requireAuth, (req, res) => {
  const { name, lang, currentPassword, newPassword } = req.body;
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 80), req.user.id);
  if (lang === 'fr' || lang === 'en') db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
  if (newPassword !== undefined) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(currentPassword || ''), row.password_hash)) return res.status(400).json({ error: 'bad_credentials' });
    if (!validatePassword(newPassword)) return res.status(400).json({ error: 'weak_password' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

export default r;
