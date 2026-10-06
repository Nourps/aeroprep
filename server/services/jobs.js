import dns from 'node:dns/promises';
import net from 'node:net';
import { db, getSetting } from '../db.js';

const UA = 'AeroPrepBot/1.0 (self-hosted pilot job aggregator; respects robots.txt)';

// ---------------------------------------------------------------------------
// Classification (heuristics on title + description, editable by hand later)
// ---------------------------------------------------------------------------
export const AIRCRAFT = {
  a320: /\b(a\s?-?3(18|19|20|21)(neo|ceo)?|a32[01x]|a320\s?family|airbus\s?320)\b/i,
  a220: /\b(a\s?-?220|cs\s?-?(100|300))\b/i,
  b737: /\b(b?\s?-?737|boeing\s?737|737\s?max|b73[789m])\b/i,
  b757_767: /\b(b?\s?-?7[56]7|boeing\s?7[56]7)\b/i,
  b777_787: /\b(b?\s?-?7[78]7|boeing\s?7[78]7|triple\s?seven|dreamliner)\b/i,
  a330_350: /\b(a\s?-?3[35]0|airbus\s?3[35]0)\b/i,
  widebody_other: /\b(a\s?-?380|b?\s?-?747|boeing\s?747)\b/i,
  atr: /\batr\s?-?(42|72)?\b/i,
  dash8: /\b(dash\s?-?8|dhc\s?-?8|q\s?-?400)\b/i,
  embraer: /\b(embraer|e\s?-?(170|175|190|195)(-?e2)?|erj|e-?jets?)\b/i,
  bizjet: /\b(citation|falcon|gulfstream|global\s?(express|[0-9]{4})|challenger|learjet|phenom|legacy\s?[0-9]{3}|praetorian|pc\s?-?(12|24))\b/i,
};

const RE = {
  cadet: /\b(cadets?|ab[\s-]?initio|trainee\s+pilots?|[ée]l[èe]ves?\s+pilotes?|mpl|future\s+pilots?|pilot\s+academy)\b/i,
  captain: /\b(captains?|commandants?\s+de\s+bord|cdb|\bcpt\b|pic\b(?!\s*time)|command\s+upgrade)\b/i,
  instructor: /\b(tri|tre|sfi|sfe|instructors?|instructeurs?|examiners?)\b/i,
  lowHours: /\b(low[\s-]?hours?|low[\s-]?timers?|non[\s-]?type[\s-]?rated|newly\s+qualified|f\s?atpl|frozen\s+atpl|cpl\s*\/\s*ir|jeunes?\s+pilotes?|sans\s+qualification\s+de\s+type)\b/i,
  typeRated: /\b(type[\s-]?rated|valid\s+(a3\d\d|b7\d\d|[a-z0-9 ]{0,20})?\s*type\s+rating|current\s+on\s+type|qualifi[ée]s?\s+(sur|de\s+type)|dec\s+held)\b/i,
  trNotRequired: /\b(non[\s-]?type[\s-]?rated|no\s+type\s+rating\s+(is\s+)?required|type\s+rating\s+(will\s+be\s+|is\s+)?(provided|funded|sponsored|offered|included)|(sponsored|funded|bonded)\s+type\s+rating|without\s+(a\s+)?type\s+rating|sans\s+qualification\s+de\s+type|qualification\s+de\s+type\s+(financ[ée]e|fournie|offerte))\b/i,
  trRequired: /\b(type[\s-]?rated|valid\s+[a-z0-9 ]{0,25}type\s+rating|type\s+rating\s+(is\s+)?(required|mandatory|essential)|current\s+on\s+type|qualification\s+de\s+type\s+(valide|requise|exig[ée]e))\b/i,
  pilot: /\b(pilots?|pilotes?|first\s+officers?|second\s+officers?|captains?|copilot(e)?s?|co-pilot(e)?s?|commandants?\s+de\s+bord|officiers?\s+pilotes?|f\/o|cadets?|flight\s+deck\s+crew|flight\s+crew)\b/i,
};

export function detectAircraft(text) {
  return Object.entries(AIRCRAFT).filter(([, re]) => re.test(text)).map(([k]) => k);
}

export function detectMinHours(text) {
  const re = /(\d{1,2}[ ,. ]\d{3}|\d{2,5})\s*\+?\s*(?:total\s+)?(?:flight\s+|flying\s+)?(?:hours|hrs?|h\b|heures|fh\b|tt\b)/gi;
  const values = [];
  for (const m of text.matchAll(re)) {
    const n = Number(m[1].replace(/[ ,. ]/g, ''));
    if (n >= 100 && n <= 20000) values.push(n);
  }
  // The largest stated threshold is usually the total-time requirement.
  return values.length ? Math.max(...values) : null;
}

export function classify({ title = '', description = '' }) {
  const all = `${title}\n${description}`;
  let category = 'unknown';
  if (RE.cadet.test(title) || (RE.cadet.test(all) && !RE.captain.test(title))) category = 'cadet';
  else if (RE.instructor.test(title)) category = 'instructor';
  else if (RE.captain.test(title)) category = 'captain';
  else if (RE.lowHours.test(all)) category = 'low_hours';
  else if (RE.typeRated.test(all)) category = 'type_rated';

  let typeRating = 'unknown';
  if (category === 'cadet' || RE.trNotRequired.test(all)) typeRating = 'not_required';
  else if (RE.trRequired.test(all) || category === 'captain') typeRating = 'required';
  if (category === 'unknown' && typeRating === 'required') category = 'type_rated';
  if (category === 'unknown' && typeRating === 'not_required') category = 'low_hours';

  const minHours = category === 'cadet' ? null : detectMinHours(all);
  return { category, typeRating, aircraft: detectAircraft(all).join(','), minHours };
}

export const isPilotJob = (title, description = '') => RE.pilot.test(title) || (RE.pilot.test(description.slice(0, 600)) && !/engineer|mechanic|cabin/i.test(title));

// ---------------------------------------------------------------------------
// Fetching helpers
// ---------------------------------------------------------------------------
// The server usually runs on a home network: never let a pasted link reach private addresses.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('invalid_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('private_address');
}

async function fetchText(url, { accept = '*/*' } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${current}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error('response_too_large');
    return text;
  }
  throw new Error('too_many_redirects');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const robotsCache = new Map();
async function allowedByRobots(url) {
  const u = new URL(url);
  let rules = robotsCache.get(u.origin);
  if (!rules) {
    rules = [];
    try {
      const txt = await fetchText(`${u.origin}/robots.txt`);
      let applies = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const [k, ...rest] = line.split(':');
        const v = rest.join(':').trim();
        if (/^user-agent$/i.test(k)) applies = v === '*' || /aeroprep/i.test(v);
        else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
      }
    } catch { /* no robots.txt: allowed */ }
    robotsCache.set(u.origin, rules);
  }
  return !rules.some((p) => u.pathname.startsWith(p));
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}

function toIsoDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Extracts schema.org JobPosting objects from a page's JSON-LD blocks. */
export function extractJsonLdJobs(html, pageUrl) {
  const jobs = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      if (node['@graph']) stack.push(node['@graph']);
      const type = [].concat(node['@type'] || []);
      if (!type.includes('JobPosting')) continue;
      const loc = [].concat(node.jobLocation || [])[0]?.address;
      const location = loc ? [loc.addressLocality, loc.addressRegion, loc.addressCountry?.name || loc.addressCountry].filter(Boolean).join(', ') : '';
      jobs.push({
        title: stripHtml(node.title || ''),
        company: node.hiringOrganization?.name || '',
        location,
        description: stripHtml(node.description || ''),
        url: node.url || pageUrl,
        postedAt: toIsoDate(node.datePosted),
      });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Source connectors
// ---------------------------------------------------------------------------
const CONNECTORS = {
  async rss(src) {
    const xml = await fetchText(src.target, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
    const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    return blocks.map((b) => {
      const linkHref = b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
      return {
        title: stripHtml(xmlTag(b, 'title')),
        url: decodeEntities(linkHref || xmlTag(b, 'link') || xmlTag(b, 'guid')),
        description: stripHtml(xmlTag(b, 'description') || xmlTag(b, 'content:encoded') || xmlTag(b, 'summary') || xmlTag(b, 'content')),
        location: stripHtml(xmlTag(b, 'location') || xmlTag(b, 'job:location')),
        company: stripHtml(xmlTag(b, 'company')) || src.company,
        postedAt: toIsoDate(xmlTag(b, 'pubDate') || xmlTag(b, 'published') || xmlTag(b, 'updated')),
      };
    });
  },
  // Greenhouse public job board API: https://developers.greenhouse.io/job-board.html
  async greenhouse(src) {
    const json = JSON.parse(await fetchText(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(src.target)}/jobs?content=true`));
    return (json.jobs || []).map((j) => ({
      title: j.title, url: j.absolute_url, location: j.location?.name || '', company: src.company,
      description: stripHtml(decodeEntities(j.content || '')), postedAt: toIsoDate(j.updated_at),
    }));
  },
  // Lever public postings API: https://github.com/lever/postings-api
  async lever(src) {
    const json = JSON.parse(await fetchText(`https://api.lever.co/v0/postings/${encodeURIComponent(src.target)}?mode=json`));
    return (json || []).map((j) => ({
      title: j.text, url: j.hostedUrl, location: j.categories?.location || '', company: src.company,
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n'),
      postedAt: j.createdAt ? toIsoDate(j.createdAt) : null,
    }));
  },
  // Any careers page that publishes schema.org JobPosting markup (made for search engines).
  async jsonld(src) {
    if (!(await allowedByRobots(src.target))) throw new Error('Disallowed by robots.txt');
    const html = await fetchText(src.target, { accept: 'text/html' });
    return extractJsonLdJobs(html, src.target).map((j) => ({ ...j, company: j.company || src.company }));
  },
};

const upsert = db.prepare(`INSERT INTO jobs (url, title, company, location, description, category, aircraft, type_rating, min_hours, source_id, source_name, posted_at)
  VALUES (@url, @title, @company, @location, @description, @category, @aircraft, @typeRating, @minHours, @sourceId, @sourceName, @postedAt)
  ON CONFLICT(url) DO UPDATE SET
    title = excluded.title, company = excluded.company, location = excluded.location, description = excluded.description,
    posted_at = COALESCE(excluded.posted_at, jobs.posted_at), last_seen_at = datetime('now'),
    category = CASE WHEN jobs.manual_override = 1 THEN jobs.category ELSE excluded.category END,
    aircraft = CASE WHEN jobs.manual_override = 1 THEN jobs.aircraft ELSE excluded.aircraft END,
    type_rating = CASE WHEN jobs.manual_override = 1 THEN jobs.type_rating ELSE excluded.type_rating END,
    min_hours = CASE WHEN jobs.manual_override = 1 THEN jobs.min_hours ELSE excluded.min_hours END`);

export async function runSource(src) {
  const connector = CONNECTORS[src.kind];
  try {
    const items = await connector(src);
    let kept = 0;
    db.transaction(() => {
      for (const it of items) {
        if (!it.title || !/^https?:\/\//i.test(it.url || '')) continue;
        if (src.pilot_filter && !isPilotJob(it.title, it.description)) continue;
        const c = classify(it);
        upsert.run({
          url: it.url, title: it.title.slice(0, 300), company: (it.company || src.company || '').slice(0, 200),
          location: (it.location || '').slice(0, 200), description: (it.description || '').slice(0, 20000),
          category: c.category, aircraft: c.aircraft, typeRating: c.typeRating, minHours: c.minHours,
          sourceId: src.id, sourceName: src.name, postedAt: it.postedAt || null,
        });
        kept++;
      }
    })();
    const status = `ok: ${kept} pilot offer(s) / ${items.length} item(s)`;
    db.prepare("UPDATE job_sources SET last_run_at = datetime('now'), last_status = ? WHERE id = ?").run(status, src.id);
    return { ok: true, kept, total: items.length };
  } catch (err) {
    db.prepare("UPDATE job_sources SET last_run_at = datetime('now'), last_status = ? WHERE id = ?").run(`error: ${err.message}`.slice(0, 300), src.id);
    return { ok: false, error: err.message };
  }
}

let refreshing = null;
export function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const results = [];
    for (const src of db.prepare('SELECT * FROM job_sources WHERE enabled = 1').all()) {
      results.push({ id: src.id, name: src.name, ...(await runSource(src)) });
    }
    return results;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function startScheduler() {
  const tick = () => {
    const hours = Number(getSetting('jobs_refresh_hours')) || 0;
    if (hours <= 0) return;
    const last = db.prepare('SELECT MIN(COALESCE(last_run_at, \'1970-01-01\')) AS t FROM job_sources WHERE enabled = 1').get().t;
    if (last && Date.now() - new Date(`${last.replace(' ', 'T')}Z`).getTime() >= hours * 3600_000) {
      refreshAll().catch((e) => console.error('[jobs] refresh failed', e));
    }
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 10 * 60_000).unref();
}

// ---------------------------------------------------------------------------
// Manual add: best-effort preview of a pasted link
// ---------------------------------------------------------------------------
// Sites whose terms forbid automated access: we never fetch them, the user fills the form.
const NO_FETCH = /(^|\.)(linkedin\.com|facebook\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+)$/i;

export async function previewUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('invalid_url');
  if (NO_FETCH.test(u.hostname)) return { fetched: false, reason: 'site_not_fetched' };
  if (!(await allowedByRobots(url))) return { fetched: false, reason: 'robots' };
  const html = await fetchText(url, { accept: 'text/html' });
  const [job] = extractJsonLdJobs(html, url);
  const meta = (name) => decodeEntities(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, 'i'))?.[1] || '');
  const base = job || {
    title: meta('og:title') || stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    description: meta('og:description') || meta('description'),
    company: meta('og:site_name'),
    location: '',
    postedAt: null,
  };
  return { fetched: true, ...base, url, ...classify(base) };
}
