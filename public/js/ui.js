import { t } from './i18n.js';

/** Hyperscript helper. Children are appended as text unless they are Nodes: no innerHTML with user data. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'x-requested-with': 'aeroprep' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function errorText(err) {
  const code = err?.body?.error || err?.message;
  const txt = t(`err_${code}`);
  return txt.startsWith('err_') ? `${t('error')} : ${code}` : txt;
}

// ---------- toasts & modal ----------
export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const el = h('div', { class: `toast ${type}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), 4500);
}

export function modal(title, content, { wide = false } = {}) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'close' }, '✕')),
      h('div', { class: 'modal-body' }, content)));
  document.body.append(overlay);
  return close;
}

// ---------- small widgets ----------
export const spinner = () => h('div', { class: 'spinner' }, h('span'), t('loading'));

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' },
    items.map(([key, label]) => h('button', { class: `tab ${key === active ? 'active' : ''}`, role: 'tab', onclick: () => onChange(key) }, label)));
}

export function progressBar(value, max, cls = '') {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return h('div', { class: `bar ${cls}`, title: `${pct}%` }, h('div', { style: { width: `${pct}%` } }));
}

export function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)} %` : '—';
}

export function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}${s.length > 10 ? 'Z' : ''}`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Very small, safe Markdown subset: escapes everything, then bold/italic/code/lists/headings + citation links. */
export function renderMarkdown(text, { citation } = {}) {
  const container = h('div', { class: 'md' });
  const lines = String(text).split('\n');
  let list = null;
  const inline = (s) => {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[doc:\d+ p\.\d+\]|\*[^*\s][^*]*\*)/g;
    let last = 0;
    for (const m of s.matchAll(re)) {
      frag.append(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) frag.append(h('strong', {}, tok.slice(2, -2)));
      else if (tok.startsWith('`')) frag.append(h('code', {}, tok.slice(1, -1)));
      else if (tok.startsWith('[doc:')) {
        const [, id, page] = tok.match(/\[doc:(\d+) p\.(\d+)\]/);
        frag.append(citation ? citation(Number(id), Number(page)) : tok);
      } else frag.append(h('em', {}, tok.slice(1, -1)));
      last = m.index + tok.length;
    }
    frag.append(s.slice(last));
    return frag;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (!list) { list = h(/^\s*\d/.test(line) ? 'ol' : 'ul'); container.append(list); }
      list.append(h('li', {}, inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    container.append(heading ? h('h4', {}, inline(heading[1])) : h('p', {}, inline(line)));
  }
  return container;
}
