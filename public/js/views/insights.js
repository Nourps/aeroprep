import { t } from '../i18n.js';
import { h, clear, api, toast, errorText, modal, fmtDate, renderMarkdown } from '../ui.js';
import { can } from '../app.js';

let cache = null;
export async function loadInsights(force = false) {
  if (!cache || force) cache = (await api('/insights')).insights;
  return cache;
}

/** Finds the airline card matching a job's company name. */
export function insightForCompany(cards, company) {
  const c = String(company || '').toLowerCase().trim();
  if (!c) return null;
  return cards.find((card) => card.kind === 'airline' && card.match.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
    .some((m) => c === m || c.startsWith(`${m} `) || c.includes(m) && m.length > 4)) || null;
}

const updatedLine = (c) => `${t('updated')} ${fmtDate(c.updated_at)} · ${t(`upd_${c.updated_by}`)}`;

export function openInsight(card, onChange = () => {}) {
  const admin = can('admin');
  const body = h('div', { class: 'insight-body' },
    h('p', { class: 'lead' }, card.summary),
    card.salary_fo || card.salary_cpt ? h('div', { class: 'salary-grid' },
      card.salary_fo ? h('div', {}, h('span', { class: 'muted small' }, t('payFo')), h('b', {}, card.salary_fo)) : null,
      card.salary_cpt ? h('div', {}, h('span', { class: 'muted small' }, t('payCpt')), h('b', {}, card.salary_cpt)) : null) : null,
    renderMarkdown(card.body),
    card.sources.length ? h('div', { class: 'sources-list' }, h('b', {}, t('sources')),
      h('ul', {}, card.sources.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || s.url))))) : null,
    h('p', { class: 'muted small' }, updatedLine(card), card.locked ? ` · 🔒 ${t('lockedCard')}` : ''),
    admin ? h('div', { class: 'row gap' },
      h('button', {
        class: 'btn small',
        onclick: async () => {
          try { await api(`/insights/${card.key}/refresh`, { method: 'POST' }); toast(t('researchStarted'), 'success'); close(); }
          catch (err) { toast(errorText(err), 'error'); }
        },
      }, `✨ ${t('refreshWithAi')}`),
      h('button', { class: 'btn small', onclick: () => { close(); editInsight(card, onChange); } }, t('edit')),
      h('button', { class: 'link-btn danger', onclick: async () => { if (confirm(t('confirmDelete'))) { await api(`/insights/${card.key}`, { method: 'DELETE' }); close(); onChange(); } } }, t('delete')))
      : null);
  const close = modal(card.title, body, { wide: true });
}

function editInsight(card, onChange) {
  const f = {
    title: h('input', { value: card.title }), region: h('input', { value: card.region }), match: h('input', { value: card.match }),
    summary: h('textarea', { rows: 2 }, card.summary), salary_fo: h('input', { value: card.salary_fo }), salary_cpt: h('input', { value: card.salary_cpt }),
    body: h('textarea', { rows: 14 }, card.body), locked: h('input', { type: 'checkbox', checked: !!card.locked }),
  };
  const close = modal(t('edit'), h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      try { await api(`/insights/${card.key}`, { method: 'PUT', body }); close(); onChange(); } catch (err) { toast(errorText(err), 'error'); }
    },
  },
  h('div', { class: 'grid three tight' }, h('label', {}, t('title'), f.title), h('label', {}, t('region'), f.region), h('label', {}, t('matchNames'), f.match)),
  h('label', {}, t('summary'), f.summary),
  h('div', { class: 'grid two tight' }, h('label', {}, t('payFo'), f.salary_fo), h('label', {}, t('payCpt'), f.salary_cpt)),
  h('label', {}, t('content'), f.body),
  h('label', { class: 'inline' }, f.locked, t('lockCard')),
  h('button', { class: 'btn primary' }, t('save'))), { wide: true });
}

export async function insightsView(container) {
  const cards = await loadInsights(true);
  const reload = () => insightsView(container);
  const topics = cards.filter((c) => c.kind === 'topic');
  const airlines = cards.filter((c) => c.kind === 'airline');
  const regions = [...new Set(airlines.map((c) => c.region || '—'))];
  const tile = (c) => h('button', { class: `card insight-card ${c.kind}`, onclick: () => openInsight(c, reload) },
    h('div', { class: 'row between' }, h('h3', {}, c.title), c.region ? h('span', { class: 'chip ghost' }, c.region) : null),
    h('p', { class: 'muted small' }, c.summary),
    c.salary_fo ? h('div', { class: 'small' }, h('b', {}, `${t('payFoShort')} `), c.salary_fo) : null,
    c.salary_cpt ? h('div', { class: 'small' }, h('b', {}, `${t('payCptShort')} `), c.salary_cpt) : null,
    h('div', { class: 'muted tiny' }, updatedLine(c)));

  const newCard = h('input', { placeholder: t('airlineName') });
  clear(container,
    h('p', { class: 'muted' }, t('insightsIntro')),
    can('admin') ? h('form', {
      class: 'search-row',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!newCard.value.trim()) return;
        try { await api('/insights', { method: 'POST', body: { name: newCard.value } }); toast(t('researchStarted'), 'success'); newCard.value = ''; }
        catch (err) { toast(errorText(err), 'error'); }
      },
    }, newCard, h('button', { class: 'btn' }, `✨ ${t('newAirlineCard')}`)) : null,
    h('h2', {}, t('guides')),
    h('div', { class: 'grid insights' }, topics.map(tile)),
    regions.map((r) => [h('h2', {}, r), h('div', { class: 'grid insights' }, airlines.filter((c) => (c.region || '—') === r).map(tile))]));
}
