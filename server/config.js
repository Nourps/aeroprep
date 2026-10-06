import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'aeroprep.db'),
  uploadDir: path.join(DATA_DIR, 'documents'),
  // Emails listed here become admin when they register (comma separated).
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // Set to "true" when served behind HTTPS (reverse proxy) so cookies get the Secure flag.
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  // An API key from the environment takes precedence over the one stored from the admin panel.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  duckdnsDomain: process.env.DUCKDNS_DOMAIN || process.env.DOMAIN || '',
  duckdnsToken: process.env.DUCKDNS_TOKEN || '',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 300),
  sessionDays: Number(process.env.SESSION_DAYS || 30),
};

fs.mkdirSync(config.uploadDir, { recursive: true });
