import { t } from '../i18n.js';
import { h, clear, api, errorText, renderMarkdown } from '../ui.js';
import { can } from '../app.js';
import { docUrl } from './docs.js';

// Conversation kept in memory for the browser session.
let history = [];

export async function assistantView(view, head) {
  const status = await api('/ai/status');
  const titles = new Map();
  if (can('docs.view')) for (const d of (await api('/docs')).documents) titles.set(d.id, d.title);

  const citation = (id, page) => (can('docs.view')
    ? h('a', { class: 'cite', href: docUrl(id, page), target: '_blank', rel: 'noopener', title: titles.get(id) || '' }, `${titles.get(id) ? shortTitle(titles.get(id)) : `doc ${id}`} p.${page}`)
    : h('span', { class: 'cite' }, `p.${page}`));

  const quotaLine = h('span', { class: 'muted small' });
  const setQuota = (q) => { quotaLine.textContent = `${t('quotaLeft')} : ${q.remaining === null ? t('unlimited') : q.remaining}`; };
  setQuota(status.quota);

  const thread = h('div', { class: 'chat' });
  const input = h('textarea', { rows: 3, placeholder: t('askPlaceholder'), maxlength: 2000 });
  const send = h('button', { class: 'btn primary', type: 'submit' }, t('ask'));

  const bubble = (role, content) => h('div', { class: `msg ${role}` }, content);
  const answerBlock = (a) => h('div', {},
    renderMarkdown(a.answer, { citation }),
    a.sources?.length ? h('div', { class: 'sources' }, h('b', {}, `${t('sources')} : `),
      a.sources.map((s) => citation(s.docId, s.page))) : null);

  for (const x of history) thread.append(bubble('user', x.q), bubble('bot', answerBlock(x)));

  const submit = async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    send.disabled = true;
    thread.append(bubble('user', question));
    const pending = bubble('bot', h('div', { class: 'spinner' }, h('span'), t('thinking')));
    thread.append(pending);
    pending.scrollIntoView({ behavior: 'smooth', block: 'end' });
    try {
      const res = await api('/ai/ask', { method: 'POST', body: { question, history: history.map(({ q, a }) => ({ q, a })) } });
      if (res.quota) setQuota(res.quota);
      if (!res.answer) { clear(pending, h('p', { class: 'form-error' }, errorText({ body: { error: res.error } }))); return; }
      const entry = { q: question, a: res.answer, answer: res.answer, sources: res.sources };
      history.push(entry);
      clear(pending, answerBlock(entry));
    } catch (err) {
      clear(pending, h('p', { class: 'form-error' }, errorText(err)));
      if (err.body?.quota) setQuota(err.body.quota);
    } finally {
      send.disabled = false;
      input.focus();
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const form = h('form', { class: 'chat-form', onsubmit: submit }, input, h('div', { class: 'row between' }, quotaLine,
    h('div', { class: 'row gap' }, h('button', { type: 'button', class: 'btn', onclick: () => { history = []; assistantView(view, head); } }, t('newChat')), send)));

  const blocked = !status.configured ? t('aiNotConfigured') : status.readyDocuments === 0 ? t('aiNoDocs')
    : status.quota.quota === 0 ? t('quotaExceeded') : null;

  clear(view, head,
    h('div', { class: 'card assistant' },
      h('p', { class: 'muted small' }, `ⓘ ${t('aiDisclaimer')}`),
      thread,
      blocked ? h('p', { class: 'notice' }, blocked) : form));
  if (!blocked) input.focus();
}

const shortTitle = (s) => (s.length > 28 ? `${s.slice(0, 26)}…` : s);
