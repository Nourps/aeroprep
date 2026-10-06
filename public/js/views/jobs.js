import { t } from '../i18n.js';
import { h, clear, api, toast, errorText, modal, fmtDate } from '../ui.js';
import { state, can } from '../app.js';

const DEFAULTS = { q: '', category: [], typeRating: [], aircraft: [], myHours: '', includeUnknownHours: true, days: '', status: '', sort: 'recent' };
function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('jobFilters') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveFilters(f) {
  try { localStorage.setItem('jobFilters', JSON.stringify(f)); } catch { /* ignore */ }
}

function chipGroup(label, values, selected, prefix, onChange) {
  return h('div', { class: 'filter-group' }, h('span', { class: 'filter-label' }, label),
    h('div', { class: 'chips' }, values.map((v) => h('button', {
      class: `chip toggle ${selected.includes(v) ? 'on' : ''}`,
      onclick: () => { const i = selected.indexOf(v); i > -1 ? selected.splice(i, 1) : selected.push(v); onChange(); },
    }, t(`${prefix}${v}`)))));
}

export async function jobsView(view) {
  const meta = await api('/jobs/meta');
  const f = loadFilters();
  const list = h('div', { class: 'job-list' });
  const countEl = h('span', { class: 'muted' });
  let timer;

  const load = async () => {
    saveFilters(f);
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.category.length) p.set('category', f.category.join(','));
    if (f.typeRating.length) p.set('typeRating', f.typeRating.join(','));
    if (f.aircraft.length) p.set('aircraft', f.aircraft.join(','));
    if (f.myHours !== '') { p.set('myHours', f.myHours); p.set('includeUnknownHours', String(f.includeUnknownHours)); }
    if (f.days) p.set('days', f.days);
    if (f.status) p.set('status', f.status);
    if (f.sort === 'hours') p.set('sort', 'hours');
    const { jobs } = await api(`/jobs?${p}`);
    countEl.textContent = `${jobs.length} · ${t('nav_jobs')}`;
    clear(list, jobs.length ? jobs.map((j) => jobCard(j, load)) : h('p', { class: 'muted card' }, t('noJobs')));
  };
  const reloadSoon = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  const rerender = () => { renderFilters(); load(); };

  const filtersBox = h('div', { class: 'card filters' });
  const renderFilters = () => {
    const search = h('input', { type: 'search', placeholder: '🔎 Airline, base, A320, cadet…', value: f.q, oninput: (e) => { f.q = e.target.value; reloadSoon(); } });
    const hours = h('input', { type: 'number', min: 0, step: 50, value: f.myHours, placeholder: '—', oninput: (e) => { f.myHours = e.target.value; reloadSoon(); } });
    const unknown = h('input', { type: 'checkbox', checked: f.includeUnknownHours, onchange: (e) => { f.includeUnknownHours = e.target.checked; load(); } });
    const days = h('select', { onchange: (e) => { f.days = e.target.value; load(); } },
      h('option', { value: '' }, t('anyTime')), [7, 14, 30, 60].map((d) => h('option', { value: d, selected: String(f.days) === String(d) }, `${d} ${t('days')}`)));
    const status = h('select', { onchange: (e) => { f.status = e.target.value; load(); } },
      h('option', { value: '' }, t('allOffers')), ['saved', 'applied', 'rejected'].map((s) => h('option', { value: s, selected: f.status === s }, t(`st_${s}`))));
    const sort = h('select', { onchange: (e) => { f.sort = e.target.value; load(); } },
      h('option', { value: 'recent', selected: f.sort === 'recent' }, t('sortRecent')), h('option', { value: 'hours', selected: f.sort === 'hours' }, t('sortHours')));
    clear(filtersBox,
      h('div', { class: 'filter-row' }, search,
        h('label', { class: 'inline' }, t('myHours'), hours),
        h('label', { class: 'inline' }, t('postedWithin'), days),
        h('label', { class: 'inline' }, t('myStatus'), status),
        h('label', { class: 'inline' }, sort),
        h('button', { class: 'link-btn', onclick: () => { Object.assign(f, structuredClone(DEFAULTS)); rerender(); } }, t('resetFilters'))),
      f.myHours !== '' ? h('label', { class: 'inline small muted' }, unknown, t('includeUnknownHours')) : null,
      chipGroup(t('category'), meta.categories, f.category, 'jc_', rerender),
      chipGroup(t('typeRating'), meta.typeRatings, f.typeRating, 'tr_', rerender),
      chipGroup(t('aircraft'), meta.aircraft, f.aircraft, 'ac_', rerender));
  };
  renderFilters();

  clear(view,
    h('div', { class: 'page-head row between' },
      h('div', {}, h('h1', {}, t('nav_jobs')), h('p', { class: 'muted' }, t('jobsIntro')),
        h('p', { class: 'muted small' }, `${t('lastRefresh')} : ${meta.lastRefresh ? fmtDate(meta.lastRefresh) : '—'} · ${meta.sources.map((s) => `${s.name} (${s.n})`).join(' · ')}`)),
      can('jobs.add') ? h('button', { class: 'btn primary', onclick: () => addJobModal(load) }, `+ ${t('addJob')}`) : null),
    filtersBox,
    h('div', { class: 'row between' }, countEl),
    list);
  await load();
}

function jobCard(j, reload) {
  const mark = async (status) => { await api(`/jobs/${j.id}/mark`, { method: 'POST', body: { status: j.status === status ? null : status } }); reload(); };
  const aircraft = j.aircraft ? j.aircraft.split(',') : [];
  const canEdit = can('jobs.add');
  const canDelete = can('admin') || j.added_by === state.user.id;
  return h('article', { class: `card job-card ${j.status ? `st-${j.status}` : ''}` },
    h('div', { class: 'job-main' },
      h('h3', {}, h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer' }, j.title)),
      h('div', { class: 'muted' }, [j.company, j.location].filter(Boolean).join(' · ')),
      h('div', { class: 'chips' },
        h('span', { class: `chip cat-${j.category}` }, t(`jc_${j.category}`)),
        h('span', { class: `chip tr-${j.type_rating}` }, t(`tr_${j.type_rating}`)),
        aircraft.map((a) => h('span', { class: 'chip ghost' }, t(`ac_${a}`))),
        h('span', { class: 'chip ghost' }, j.min_hours ? `≥ ${j.min_hours} h` : t('hoursUnknown'))),
      j.excerpt ? h('p', { class: 'excerpt' }, j.excerpt.length >= 600 ? `${j.excerpt}…` : j.excerpt) : null,
      h('div', { class: 'muted small' }, `${t('source')} : ${j.source_name} · ${fmtDate(j.posted_at || j.first_seen_at)}`)),
    h('div', { class: 'job-actions' },
      h('a', { class: 'btn small primary', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, t('viewOffer')),
      h('button', { class: `btn small ${j.status === 'saved' ? 'on' : ''}`, onclick: () => mark('saved') }, `★ ${t('save_')}`),
      h('button', { class: `btn small ${j.status === 'applied' ? 'on' : ''}`, onclick: () => mark('applied') }, `✓ ${t('applied_')}`),
      h('button', { class: `btn small ${j.status === 'rejected' ? 'on' : ''}`, onclick: () => mark('rejected') }, `⊘ ${t('hide_')}`),
      canEdit ? h('button', { class: 'link-btn small', onclick: () => editJobModal(j, reload) }, t('reclassify')) : null,
      canDelete ? h('button', { class: 'link-btn small danger', onclick: async () => { if (confirm(t('confirmDelete'))) { await api(`/jobs/${j.id}`, { method: 'DELETE' }); reload(); } } }, t('delete')) : null));
}

function jobForm(values, onSubmit, submitLabel) {
  const meta = { categories: ['cadet', 'low_hours', 'type_rated', 'captain', 'instructor', 'unknown'], typeRatings: ['required', 'not_required', 'unknown'],
    aircraft: ['a320', 'a220', 'b737', 'b757_767', 'b777_787', 'a330_350', 'widebody_other', 'atr', 'dash8', 'embraer', 'bizjet'] };
  const fields = {
    title: h('input', { value: values.title || '', required: true }),
    company: h('input', { value: values.company || '' }),
    location: h('input', { value: values.location || '' }),
    category: h('select', {}, h('option', { value: 'auto' }, t('autoDetect')), meta.categories.map((c) => h('option', { value: c, selected: c === values.category }, t(`jc_${c}`)))),
    type_rating: h('select', {}, h('option', { value: 'auto' }, t('autoDetect')), meta.typeRatings.map((c) => h('option', { value: c, selected: c === values.type_rating }, t(`tr_${c}`)))),
    min_hours: h('input', { type: 'number', min: 0, value: values.min_hours ?? '' }),
    description: h('textarea', { rows: 5 }, values.description || ''),
  };
  const selectedAc = new Set((values.aircraft || '').split(',').filter(Boolean));
  const acBox = h('div', { class: 'chips' }, meta.aircraft.map((a) => {
    const b = h('button', { type: 'button', class: `chip toggle ${selectedAc.has(a) ? 'on' : ''}`, onclick: () => { selectedAc.has(a) ? selectedAc.delete(a) : selectedAc.add(a); b.classList.toggle('on'); } }, t(`ac_${a}`));
    return b;
  }));
  return h('form', {
    class: 'stack',
    onsubmit: (e) => {
      e.preventDefault();
      onSubmit({
        title: fields.title.value, company: fields.company.value, location: fields.location.value, category: fields.category.value,
        type_rating: fields.type_rating.value, min_hours: fields.min_hours.value, description: fields.description.value, aircraft: [...selectedAc].join(','),
      });
    },
  },
  h('label', {}, t('title'), fields.title),
  h('div', { class: 'grid two tight' }, h('label', {}, t('company'), fields.company), h('label', {}, t('location'), fields.location)),
  h('div', { class: 'grid three tight' }, h('label', {}, t('category'), fields.category), h('label', {}, t('typeRating'), fields.type_rating), h('label', {}, t('minHours'), fields.min_hours)),
  h('div', {}, h('span', { class: 'filter-label' }, t('aircraft')), acBox, h('small', { class: 'muted' }, t('autoHint'))),
  h('label', {}, t('description'), fields.description),
  h('button', { class: 'btn primary' }, submitLabel));
}

function addJobModal(reload) {
  const url = h('input', { type: 'url', placeholder: 'https://…', required: true });
  const formSlot = h('div');
  const info = h('p', { class: 'muted small' });
  const fetchBtn = h('button', { class: 'btn', type: 'submit' }, t('fetchInfo'));
  const showForm = (values) => clear(formSlot, jobForm(values, async (v) => {
    try {
      await api('/jobs', { method: 'POST', body: { ...v, url: url.value } });
      toast(t('jobAdded'), 'success');
      close();
      reload();
    } catch (err) { toast(errorText(err), 'error'); }
  }, t('addJob')));
  const close = modal(t('addJob'), h('div', { class: 'stack' },
    h('form', {
      class: 'search-row',
      onsubmit: async (e) => {
        e.preventDefault();
        fetchBtn.disabled = true;
        const p = await api('/jobs/preview', { method: 'POST', body: { url: url.value } }).catch(() => ({ fetched: false }));
        fetchBtn.disabled = false;
        info.textContent = p.fetched ? '' : t(p.reason === 'site_not_fetched' || p.reason === 'robots' ? 'previewBlocked' : 'previewFailed');
        showForm(p.fetched ? { ...p, type_rating: p.typeRating, min_hours: p.minHours } : {});
      },
    }, url, fetchBtn),
    info, formSlot), { wide: true });
  url.focus();
}

async function editJobModal(j, reload) {
  const { job } = await api(`/jobs/${j.id}`);
  const close = modal(t('reclassify'), jobForm(job, async (v) => {
    try { await api(`/jobs/${j.id}`, { method: 'PATCH', body: v }); close(); reload(); } catch (err) { toast(errorText(err), 'error'); }
  }, t('save')), { wide: true });
}
