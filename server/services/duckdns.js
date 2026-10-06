// Keeps the DuckDNS name pointing at this machine's public IP (the home box IP changes from time to time).
import { getSetting } from '../db.js';
import { config } from '../config.js';

export const duckdnsState = { lastUpdate: null, ok: null, message: 'not configured' };

export function duckdnsConfig() {
  const domain = (config.duckdnsDomain || getSetting('duckdns_domain') || '').trim().replace(/\.duckdns\.org$/i, '');
  const token = (config.duckdnsToken || getSetting('duckdns_token') || '').trim();
  return { domain, token, fromEnv: !!(config.duckdnsDomain && config.duckdnsToken) };
}

export async function updateDuckdns() {
  const { domain, token } = duckdnsConfig();
  if (!domain || !token) {
    Object.assign(duckdnsState, { ok: null, message: 'not configured' });
    return duckdnsState;
  }
  try {
    // Empty ip= lets DuckDNS use the address the request comes from (the box's public IP).
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}&ip=&verbose=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.text()).trim();
    const [status, ip] = body.split(/\r?\n/);
    Object.assign(duckdnsState, {
      lastUpdate: new Date().toISOString(), ok: status === 'OK',
      message: status === 'OK' ? `${domain}.duckdns.org → ${ip || '?'}` : 'KO (domaine ou token incorrect)',
    });
  } catch (err) {
    Object.assign(duckdnsState, { lastUpdate: new Date().toISOString(), ok: false, message: err.message });
  }
  return duckdnsState;
}

export function startDuckdns() {
  setTimeout(updateDuckdns, 5_000).unref();
  setInterval(updateDuckdns, 5 * 60_000).unref();
}
