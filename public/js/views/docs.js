import { t } from '../i18n.js';
import { h, clear, api, toast, errorText, modal, fmtDate } from '../ui.js';
import { can } from '../app.js';

const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
export const docUrl = (id, page) => `/api/docs/${id}/file${page ? `#page=${page}` : ''}`;

function statusChip(d) {
  const key = d.index_status === 'ready' && d.index_error === 'no_text' ? 'idx_no_text' : `idx_${d.index_status}`;
  const cls = d.index_status === 'ready' && !d.index_error ? 'good' : d.index_status === 'error' || d.index_error ? 'bad' : 'warn';
  return h('span', { class: `chip ${cls}`, title: d.index_error || '' }, t(key));
}

function uploadForm(categories, onDone) {
  const files = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, required: true });
  const title = h('input', { type: 'text', placeholder: t('title') });
  const category = h('select', {}, categories.map((c) => h('option', { value: c }, t(`cat_${c}`))));
  const description = h('input', { type: 'text', placeholder: t('description') });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, t('upload'));
  return h('form', {
    class: 'upload-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const form = new FormData();
      for (const f of files.files) form.append('files', f);
      form.append('title', title.value);
      form.append('category', category.value);
      form.append('description', description.value);
      btn.disabled = true;
      btn.textContent = t('loading');
      try {
        await api('/docs', { method: 'POST', form });
        onDone();
      } catch (err) { toast(errorText(err), 'error'); btn.disabled = false; btn.textContent = t('upload'); }
    },
  }, files, category, title, description, btn);
}

function editDoc(d, categories, onDone) {
  const title = h('input', { value: d.title });
  const category = h('select', {}, categories.map((c) => h('option', { value: c, selected: c === d.category }, t(`cat_${c}`))));
  const description = h('textarea', { rows: 3 }, d.description);
  const close = modal(t('edit'), h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      await api(`/docs/${d.id}`, { method: 'PATCH', body: { title: title.value, category: category.value, description: description.value } });
      close(); onDone();
    },
  }, h('label', {}, t('title'), title), h('label', {}, t('category'), category), h('label', {}, t('description'), description),
  h('button', { class: 'btn primary' }, t('save'))));
}

export async function docsView(view, head) {
  const { documents, categories } = await api('/docs');
  const admin = can('admin');
  const reload = () => docsView(view, head);

  const results = h('div');
  const q = h('input', { type: 'search', placeholder: t('searchDocs') });
  const doSearch = async (e) => {
    e.preventDefault();
    if (!q.value.trim()) { clear(results); return; }
    const { results: hits } = await api(`/docs/search?q=${encodeURIComponent(q.value)}`);
    clear(results, hits.length ? h('div', { class: 'card' }, h('ul', { class: 'hits' }, hits.map((r) => h('li', {},
      h('a', { href: docUrl(r.docId, r.page), target: '_blank', rel: 'noopener' }, `${r.title} — p.${r.page}`),
      h('p', { class: 'snippet' }, highlight(r.snippet))))))
      : h('p', { class: 'muted' }, t('none')));
  };

  const grouped = categories.map((c) => [c, documents.filter((d) => d.category === c)]).filter(([, list]) => list.length);

  clear(view, head,
    h('p', { class: 'notice subtle' }, `🔒 ${t('docsConfidential')}`),
    admin ? h('div', { class: 'card' }, h('h3', {}, t('upload')), uploadForm(categories, reload)) : null,
    h('form', { class: 'search-row', onsubmit: doSearch }, q, h('button', { class: 'btn' }, t('search'))),
    results,
    grouped.length ? grouped.map(([c, list]) => h('section', { class: 'doc-group' },
      h('h3', {}, t(`cat_${c}`)),
      h('div', { class: 'doc-list' }, list.map((d) => h('div', { class: 'card doc-card' },
        h('div', { class: 'doc-icon' }, 'PDF'),
        h('div', { class: 'doc-main' },
          h('a', { href: docUrl(d.id), target: '_blank', rel: 'noopener', class: 'doc-title' }, d.title),
          d.description ? h('p', { class: 'muted small' }, d.description) : null,
          h('div', { class: 'row gap small muted' },
            d.pages ? h('span', {}, `${d.pages} ${t('pages')}`) : null, h('span', {}, size(d.size)), h('span', {}, fmtDate(d.created_at)), statusChip(d))),
        admin ? h('div', { class: 'doc-actions' },
          h('button', { class: 'link-btn', onclick: () => editDoc(d, categories, reload) }, t('edit')),
          h('button', { class: 'link-btn', onclick: async () => { await api(`/docs/${d.id}/reindex`, { method: 'POST' }); reload(); } }, t('reindex')),
          h('button', { class: 'link-btn danger', onclick: async () => { if (confirm(`${t('confirmDelete')}\n${d.title}`)) { await api(`/docs/${d.id}`, { method: 'DELETE' }); reload(); } } }, t('delete')))
          : null))))) : h('p', { class: 'muted' }, t('noDocs')));

  // Refresh while documents are being indexed.
  if (documents.some((d) => d.index_status === 'pending' || d.index_status === 'indexing')) {
    setTimeout(() => { if (location.hash.startsWith('#/a320/docs') && view.isConnected) reload(); }, 5000);
  }
}

/** Renders FTS snippets where matches are wrapped in [ ]. */
function highlight(snippet) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of snippet.matchAll(/\[([^\]]*)\]/g)) {
    frag.append(snippet.slice(last, m.index), h('mark', {}, m[1]));
    last = m.index + m[0].length;
  }
  frag.append(snippet.slice(last));
  return frag;
}
