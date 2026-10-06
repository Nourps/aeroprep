import { t, subjectName } from '../i18n.js';
import { h, clear, api, toast, errorText, modal, fmtDate } from '../ui.js';
import { state, navigate } from '../app.js';
import { openQuestionEditor } from './questionForm.js';

/** Reads a text file; falls back to Windows-1252 (Excel's default "CSV" on French Windows). */
async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

const ROLES = ['admin', 'member', 'readonly', 'pending'];
const TABS = ['users', 'settings', 'agent', 'usage', 'questions', 'sources'];
const TAB_LABEL = { users: 'users', settings: 'settings', agent: 'agentTab', usage: 'usage', questions: 'questionBank', sources: 'jobSources' };

export async function adminView(view, tab) {
  if (!TABS.includes(tab)) tab = 'users';
  const content = h('div');
  clear(view,
    h('div', { class: 'space-head' }, h('h1', {}, t('nav_admin')),
      h('div', { class: 'tabs' }, TABS.map((k) => h('a', { href: `#/admin/${k}`, class: `tab ${k === tab ? 'active' : ''}` }, t(TAB_LABEL[k]))))),
    content);
  await { users, settings, agent, usage, questions, sources }[tab](content);
}

// ---------------------------------------------------------------------------
async function users(el) {
  const { users: list } = await api('/admin/users');
  const reload = () => users(el);
  const patch = async (u, body) => { try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body }); reload(); } catch (err) { toast(errorText(err), 'error'); } };
  clear(el, h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['email', 'role', 'aiQuotaDay', 'today', 'answered', 'lastLogin', ''].map((k) => h('th', {}, k ? t(k) : '')))),
    h('tbody', {}, list.map((u) => {
      const role = h('select', { onchange: (e) => patch(u, { role: e.target.value }), disabled: u.id === state.user.id },
        ROLES.map((r) => h('option', { value: r, selected: r === u.role }, t(`role_${r}`))));
      const quota = h('input', { type: 'number', class: 'narrow', min: -1, value: u.ai_daily_quota ?? '', placeholder: `${u.effective_quota} (${t('roleDefault')})`,
        onchange: (e) => patch(u, { ai_daily_quota: e.target.value === '' ? null : Number(e.target.value) }) });
      return h('tr', { class: u.disabled ? 'disabled' : u.role === 'pending' ? 'highlight' : '' },
        h('td', {}, h('div', {}, u.email), h('small', { class: 'muted' }, `${u.name || ''} · ${t('created')} ${fmtDate(u.created_at)}`)),
        h('td', {}, role), h('td', {}, quota), h('td', {}, u.ai_today), h('td', {}, u.answers), h('td', {}, fmtDate(u.last_login_at)),
        h('td', { class: 'actions' }, u.id === state.user.id ? null : [
          h('button', { class: 'link-btn', onclick: () => patch(u, { disabled: !u.disabled }) }, u.disabled ? t('enable') : t('disable')),
          h('button', {
            class: 'link-btn',
            onclick: async () => {
              if (!confirm(`${t('resetPassword')} — ${u.email} ?`)) return;
              const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
              modal(t('resetPassword'), h('div', {}, h('p', {}, t('tempPassword')), h('code', { class: 'big-code' }, r.temporaryPassword)));
            },
          }, t('resetPassword')),
          h('button', { class: 'link-btn danger', onclick: async () => { if (confirm(`${t('confirmDelete')}\n${u.email}`)) { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); reload(); } } }, t('delete')),
        ]));
    })))));
}

// ---------------------------------------------------------------------------
async function settings(el) {
  const { settings: s, ai, duckdns } = await api('/admin/settings');
  const input = (key, type = 'number') => h('input', { type, name: key, value: s[key] });
  const fields = {
    registration_open: h('input', { type: 'checkbox', checked: s.registration_open === 'true' }),
    ai_model: h('input', { type: 'text', value: s.ai_model, list: 'models' }),
    ai_effort: h('select', {}, ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => h('option', { value: e, selected: e === s.ai_effort }, e))),
    ai_api_key: h('input', { type: 'password', placeholder: ai.storedKeyHint || 'sk-ant-…', autocomplete: 'off' }),
    quota_admin: input('quota_admin'), quota_member: input('quota_member'), quota_readonly: input('quota_readonly'), quota_pending: input('quota_pending'),
    jobs_refresh_hours: input('jobs_refresh_hours'), jobs_max_age_days: input('jobs_max_age_days'),
    exam_seconds_per_question: input('exam_seconds_per_question'), exam_pass_mark: input('exam_pass_mark'),
    duckdns_domain: h('input', { type: 'text', value: duckdns.domain, placeholder: 'monaeroprep', disabled: duckdns.fromEnv }),
    duckdns_token: h('input', { type: 'password', placeholder: duckdns.hasToken ? '••••••••' : 'xxxxxxxx-xxxx-…', autocomplete: 'off', disabled: duckdns.fromEnv }),
  };
  const ddStatus = h('span', { class: `chip ${duckdns.ok ? 'good' : duckdns.ok === false ? 'bad' : 'ghost'}` }, duckdns.message);
  const save = async (e) => {
    e.preventDefault();
    const skip = ['ai_api_key', 'registration_open', 'duckdns_token', 'duckdns_domain'];
    const body = Object.fromEntries(Object.entries(fields).filter(([k]) => !skip.includes(k)).map(([k, f]) => [k, f.value]));
    body.registration_open = String(fields.registration_open.checked);
    if (fields.ai_api_key.value) body.ai_api_key = fields.ai_api_key.value;
    if (!duckdns.fromEnv) {
      body.duckdns_domain = fields.duckdns_domain.value;
      if (fields.duckdns_token.value) body.duckdns_token = fields.duckdns_token.value;
    }
    try { await api('/admin/settings', { method: 'PUT', body }); toast(t('saved'), 'success'); settings(el); } catch (err) { toast(errorText(err), 'error'); }
  };
  clear(el, h('form', { class: 'stack', onsubmit: save },
    h('div', { class: 'card stack' }, h('h3', {}, t('users')),
      h('label', { class: 'inline' }, fields.registration_open, t('registrationOpen'))),
    h('div', { class: 'card stack' }, h('h3', {}, t('assistant')),
      h('p', { class: 'muted small' }, ai.configured ? `✓ ${ai.keyFromEnv ? t('keyFromEnv') : ai.storedKeyHint}` : t('aiNotConfigured')),
      h('label', {}, t('apiKey'), fields.ai_api_key, h('small', { class: 'muted' }, t('apiKeyHelp'))),
      h('div', { class: 'grid two tight' }, h('label', {}, t('model'), fields.ai_model), h('label', {}, t('effort'), fields.ai_effort)),
      h('datalist', { id: 'models' }, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].map((m) => h('option', { value: m }))),
      h('h4', {}, t('quotasPerRole')),
      h('div', { class: 'grid four tight' }, ROLES.map((r) => h('label', {}, t(`role_${r}`), fields[`quota_${r}`])))),
    h('div', { class: 'card stack' }, h('h3', {}, `${t('nav_jobs')} · ${t('exam')}`),
      h('div', { class: 'grid two tight' },
        h('label', {}, t('jobsRefreshHours'), fields.jobs_refresh_hours), h('label', {}, t('jobsMaxAge'), fields.jobs_max_age_days),
        h('label', {}, t('examSeconds'), fields.exam_seconds_per_question), h('label', {}, `${t('passMark')} (%)`, fields.exam_pass_mark))),
    h('div', { class: 'card stack' }, h('h3', {}, `🌍 ${t('webAccess')}`),
      h('p', { class: 'muted small' }, t('webAccessIntro')),
      h('div', { class: 'grid two tight' },
        h('label', {}, t('duckdnsDomain'), h('div', { class: 'row gap nowrap' }, fields.duckdns_domain, h('span', { class: 'muted' }, '.duckdns.org'))),
        h('label', {}, t('duckdnsToken'), fields.duckdns_token)),
      h('div', { class: 'row gap' }, h('span', { class: 'small' }, `${t('status')} :`), ddStatus,
        h('button', {
          type: 'button', class: 'btn small',
          onclick: async () => { const r = await api('/admin/duckdns/update', { method: 'POST' }); ddStatus.textContent = r.message; ddStatus.className = `chip ${r.ok ? 'good' : r.ok === false ? 'bad' : 'ghost'}`; },
        }, t('testNow'))),
      h('ol', { class: 'howto' }, [1, 2, 3, 4, 5].map((i) => h('li', {}, t(`webStep${i}`))))),
    h('button', { class: 'btn primary' }, t('save'))));
}

// ---------------------------------------------------------------------------
async function agent(el) {
  const [{ settings: s }, status, a, b] = await Promise.all([api('/admin/settings'), api('/admin/agent'), api('/quiz/atpl/subjects'), api('/quiz/a320/subjects')]);
  const check = (k) => h('input', { type: 'checkbox', checked: s[k] === 'true' });
  const num = (k) => h('input', { type: 'number', min: 1, value: s[k], class: 'narrow' });
  const f = {
    agent_jobs_enabled: check('agent_jobs_enabled'), agent_jobs_hours: num('agent_jobs_hours'), agent_jobs_max_searches: num('agent_jobs_max_searches'),
    agent_jobs_focus: h('textarea', { rows: 3 }, s.agent_jobs_focus),
    agent_insights_enabled: check('agent_insights_enabled'), agent_insights_days: num('agent_insights_days'), agent_insights_per_run: num('agent_insights_per_run'),
    agent_questions_enabled: check('agent_questions_enabled'), agent_questions_per_week: num('agent_questions_per_week'),
  };
  const save = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(f).map(([k, el2]) => [k, el2.type === 'checkbox' ? String(el2.checked) : el2.value]));
    try { await api('/admin/settings', { method: 'PUT', body }); toast(t('saved'), 'success'); } catch (err) { toast(errorText(err), 'error'); }
  };
  const run = (path, body) => async () => {
    try { await api(path, { method: 'POST', body }); toast(t('researchStarted'), 'success'); setTimeout(() => agent(el), 1500); }
    catch (err) { toast(errorText(err), 'error'); }
  };
  const subjects = [...a.subjects.map((x) => ({ ...x, space: 'ATPL' })), ...b.subjects.map((x) => ({ ...x, space: 'A320' }))];
  const qSubject = h('select', {}, subjects.map((x) => h('option', { value: x.code }, `${x.space} · ${x.code} · ${subjectName(x)} (${x.total})`)));
  const qCount = h('input', { type: 'number', min: 1, max: 20, value: 10, class: 'narrow' });
  const qTopic = h('input', { placeholder: t('topicOptional') });
  // Estimate with the default model's prices (Opus 5.5: $4 / $20 per M tokens) + $10 per 1 000 web searches.
  const costOf = (r) => (((r.input_tokens || 0) * 4 + (r.output_tokens || 0) * 20) / 1e6 + (r.web_searches || 0) * 0.01).toFixed(2);
  const running = status.runs.some((r) => r.status === 'running');

  clear(el,
    status.configured ? null : h('p', { class: 'notice' }, t('aiNotConfigured')),
    h('p', { class: 'muted' }, t('agentIntro')),
    h('form', { class: 'stack', onsubmit: save },
      h('div', { class: 'card stack' }, h('h3', {}, `💼 ${t('agentJobs')}`),
        h('label', { class: 'inline' }, f.agent_jobs_enabled, t('agentJobsEnable')),
        h('div', { class: 'row gap' }, h('label', { class: 'inline' }, t('everyHours'), f.agent_jobs_hours), h('label', { class: 'inline' }, t('maxSearches'), f.agent_jobs_max_searches)),
        h('label', {}, t('agentFocus'), f.agent_jobs_focus),
        h('div', {}, h('button', { type: 'button', class: 'btn small', onclick: run('/admin/agent/jobs') }, `▶ ${t('runNow')}`))),
      h('div', { class: 'card stack' }, h('h3', {}, `ⓘ ${t('agentInsights')}`),
        h('label', { class: 'inline' }, f.agent_insights_enabled, t('agentInsightsEnable')),
        h('div', { class: 'row gap' }, h('label', { class: 'inline' }, t('olderThanDays'), f.agent_insights_days), h('label', { class: 'inline' }, t('cardsPerRun'), f.agent_insights_per_run)),
        h('div', {}, h('button', { type: 'button', class: 'btn small', onclick: run('/admin/agent/insights') }, `▶ ${t('runNow')}`))),
      h('div', { class: 'card stack' }, h('h3', {}, `❓ ${t('agentQuestions')}`),
        h('label', { class: 'inline' }, f.agent_questions_enabled, t('agentQuestionsEnable')),
        h('label', { class: 'inline' }, t('perWeek'), f.agent_questions_per_week),
        h('p', { class: 'muted small' }, t('agentQuestionsHelp')),
        h('div', { class: 'filter-row' }, qSubject, h('label', { class: 'inline' }, t('count'), qCount), qTopic,
          h('button', { type: 'button', class: 'btn small', onclick: () => run('/admin/agent/questions', { subject: qSubject.value, count: Number(qCount.value), topic: qTopic.value })() }, `✨ ${t('generate')}`))),
      h('button', { class: 'btn primary' }, t('save'))),
    h('div', { class: 'card table-wrap' }, h('h3', {}, `${t('agentRuns')} ${running ? '⏳' : ''}`),
      status.runs.length ? h('table', { class: 'table small' }, h('tbody', {}, status.runs.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.started_at)), h('td', {}, t(`task_${r.task}`)),
        h('td', {}, h('span', { class: `chip ${r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : 'warn'}` }, t(`run_${r.status}`))),
        h('td', { class: 'ellipsis wide' }, r.detail)))))
        : h('p', { class: 'muted' }, t('none')),
      status.last30.length ? h('p', { class: 'muted small' }, `${t('last30d')} : ${status.last30.map((r) => `${t(`task_${r.kind.replace('agent-', '')}`)} ${r.runs}× · ${r.web_searches} ${t('searches')} · ~$${costOf(r)}`).join(' — ')}`) : null));
  if (running) setTimeout(() => { if (el.isConnected && location.hash.startsWith('#/admin/agent')) agent(el); }, 8000);
}

// ---------------------------------------------------------------------------
async function usage(el) {
  const u = await api('/admin/usage');
  const n = (x) => (x || 0).toLocaleString();
  clear(el,
    h('div', { class: 'card table-wrap' }, h('h3', {}, t('last30d')), h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['email', 'today', 'questions', 'generate', 'tokens', 'estCost'].map((k) => h('th', {}, t(k))))),
      h('tbody', {}, u.users.map((r) => h('tr', {},
        h('td', {}, r.email || '—'), h('td', {}, r.today), h('td', {}, r.questions), h('td', {}, r.generations),
        h('td', {}, `${n(r.input_tokens)} in / ${n(r.output_tokens)} out`), h('td', {}, `$${r.cost_usd.toFixed(2)}`)))))),
    h('div', { class: 'card table-wrap' }, h('h3', {}, t('recentCalls')), h('table', { class: 'table small' },
      h('tbody', {}, u.recent.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.created_at)), h('td', {}, r.email || '—'), h('td', {}, r.kind), h('td', {}, r.model),
        h('td', {}, `${n(r.input_tokens)} / ${n(r.output_tokens)}`), h('td', { class: 'ellipsis' }, r.question)))))));
}

// ---------------------------------------------------------------------------
let qFilters = { space: 'atpl', subject: '', active: '', flagged: '', q: '' };
async function questions(el) {
  const [atpl, a320] = await Promise.all([api('/quiz/atpl/subjects'), api('/quiz/a320/subjects')]);
  const allSubjects = [...atpl.subjects.map((s) => ({ ...s, space: 'atpl' })), ...a320.subjects.map((s) => ({ ...s, space: 'a320' }))];
  const list = h('div');
  const reload = async () => {
    const p = new URLSearchParams(Object.entries(qFilters).filter(([, v]) => v !== ''));
    const { questions: qs } = await api(`/admin/questions?${p}`);
    clear(list, h('p', { class: 'muted' }, `${qs.length} ${t('questions')}`), qs.map((q) => h('div', { class: `card q-admin ${q.active ? '' : 'inactive'}` },
      h('div', { class: 'row between' },
        h('div', { class: 'row gap' }, h('span', { class: 'chip' }, q.subject_code), q.topic ? h('span', { class: 'chip ghost' }, q.topic) : null,
          h('span', { class: 'chip ghost' }, q.source), q.active ? null : h('span', { class: 'chip warn' }, t('inactive')),
          q.flags ? h('span', { class: 'chip bad', title: q.flag_notes || '' }, `⚑ ${q.flags} ${t('flags')}`) : null),
        h('span', { class: 'muted small' }, q.attempts ? `${q.attempts} ${t('attempts')} · ${Math.round(q.success * 100)} % ${t('successRate')}` : '')),
      h('p', { class: 'q-text' }, q.question),
      h('ol', { class: 'opts', type: 'A' }, q.options.map((o, i) => h('li', { class: i === q.correct ? 'right' : '' }, o))),
      q.flag_notes ? h('p', { class: 'notice subtle small' }, q.flag_notes) : null,
      h('div', { class: 'row gap' },
        h('button', { class: 'link-btn', onclick: () => openQuestionEditor({ question: q, subjects: allSubjects, onSaved: reload }) }, t('edit')),
        h('button', { class: 'link-btn', onclick: async () => { await api(`/admin/questions/${q.id}`, { method: 'PATCH', body: { active: !q.active } }); reload(); } }, q.active ? t('disable') : t('enable')),
        q.flags ? h('button', { class: 'link-btn', onclick: async () => { await api(`/admin/questions/${q.id}`, { method: 'PATCH', body: { clearFlags: true } }); reload(); } }, '⚐ ✕') : null,
        h('button', { class: 'link-btn danger', onclick: async () => { if (confirm(t('confirmDelete'))) { await api(`/admin/questions/${q.id}`, { method: 'DELETE' }); reload(); } } }, t('delete'))))));
  };

  const space = h('select', { onchange: (e) => { qFilters.space = e.target.value; qFilters.subject = ''; questions(el); } },
    h('option', { value: '' }, t('all')), ['atpl', 'a320'].map((s) => h('option', { value: s, selected: qFilters.space === s }, s.toUpperCase())));
  const subject = h('select', { onchange: (e) => { qFilters.subject = e.target.value; reload(); } }, h('option', { value: '' }, t('all')),
    allSubjects.filter((s) => !qFilters.space || s.space === qFilters.space).map((s) => h('option', { value: s.code, selected: qFilters.subject === s.code }, `${s.code} · ${subjectName(s)}`)));
  const state_ = h('select', { onchange: (e) => { const v = e.target.value; qFilters.active = v === 'inactive' ? '0' : ''; qFilters.flagged = v === 'flagged' ? '1' : ''; reload(); } },
    h('option', { value: '' }, t('all')), h('option', { value: 'inactive', selected: qFilters.active === '0' }, t('onlyInactive')), h('option', { value: 'flagged', selected: qFilters.flagged === '1' }, t('onlyFlagged')));
  const search = h('input', { type: 'search', value: qFilters.q, placeholder: t('search'), onchange: (e) => { qFilters.q = e.target.value; reload(); } });
  const importInput = h('input', { type: 'file', accept: '.csv,.txt,.json,text/csv,application/json', style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await readText(file);
        const body = /\.json$/i.test(file.name) ? JSON.parse(text) : { csv: text };
        const res = await api('/admin/questions/import', { method: 'POST', body });
        if (res.errors.length) {
          modal(t('importResult'), h('div', {}, h('p', {}, `+${res.added} ${t('questions')}`),
            h('p', { class: 'form-error' }, `${res.errors.length} ${t('linesRejected')} :`),
            h('ul', {}, res.errors.map((er) => h('li', {}, `${t('line')} ${er.line} — ${t(`qerr_${er.error}`)}`)))));
        } else toast(`+${res.added} ${t('questions')}`, 'success');
        reload();
      } catch (err) { toast(errorText(err), 'error'); }
    } });
  clear(el,
    h('div', { class: 'card filters' }, h('div', { class: 'filter-row' },
      h('label', { class: 'inline' }, t('space'), space), h('label', { class: 'inline' }, subject), h('label', { class: 'inline' }, state_), search,
      h('button', { class: 'btn primary', onclick: () => openQuestionEditor({ subjects: allSubjects, defaultSubject: qFilters.subject || (qFilters.space === 'a320' ? 'A29' : '010'), space: qFilters.space || undefined, onSaved: reload }) }, `+ ${t('newQuestion')}`),
      h('button', { class: 'btn', onclick: () => importInput.click() }, t('importCsv')), importInput,
      h('a', { class: 'btn', href: '/modele-questions.csv', download: 'modele-questions.csv' }, t('csvTemplate')),
      h('a', { class: 'btn', href: `/api/admin/questions/export${qFilters.space ? `?space=${qFilters.space}` : ''}` }, t('exportJson')))),
    h('details', { class: 'card' }, h('summary', {}, `📄 ${t('csvHowTo')}`),
      h('ol', { class: 'howto' }, [1, 2, 3, 4].map((i) => h('li', {}, t(`csvStep${i}`))))),
    await generatorCard(reload),
    list);
  reload();
}

async function generatorCard(reload) {
  const { documents } = await api('/docs');
  const ready = documents.filter((d) => d.index_status === 'ready' && !d.index_error);
  if (!ready.length) return null;
  const { subjects } = await api('/quiz/a320/subjects');
  const doc = h('select', {}, ready.map((d) => h('option', { value: d.id }, `${d.title} (${d.pages} p.)`)));
  const subject = h('select', {}, subjects.map((s) => h('option', { value: s.code }, `${s.code} · ${subjectName(s)}`)));
  const from = h('input', { type: 'number', min: 1, value: 1, class: 'narrow' });
  const to = h('input', { type: 'number', min: 1, value: 10, class: 'narrow' });
  const count = h('input', { type: 'number', min: 1, max: 25, value: 10, class: 'narrow' });
  const btn = h('button', { class: 'btn' }, t('generate'));
  return h('details', { class: 'card' }, h('summary', {}, `✨ ${t('generateFromDoc')}`),
    h('form', {
      class: 'filter-row',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; btn.textContent = t('loading');
        try {
          const r = await api('/ai/generate', { method: 'POST', body: { docId: Number(doc.value), subject: subject.value, fromPage: Number(from.value), toPage: Number(to.value), count: Number(count.value) } });
          toast(`${r.added} ${t('generated')}`, 'success');
          qFilters = { ...qFilters, space: 'a320', active: '0', subject: '' };
          navigate('#/admin/questions');
        } catch (err) { toast(errorText(err), 'error'); } finally { btn.disabled = false; btn.textContent = t('generate'); }
      },
    }, doc, subject, h('label', { class: 'inline' }, t('fromPage'), from), h('label', { class: 'inline' }, t('toPage'), to), h('label', { class: 'inline' }, t('count'), count), btn));
}

// ---------------------------------------------------------------------------
async function sources(el) {
  const { sources: list } = await api('/admin/job-sources');
  const reload = () => sources(el);
  const kinds = ['rss', 'greenhouse', 'lever', 'jsonld'];
  const editSource = (src) => {
    const v = src || { kind: 'rss', enabled: 1, pilot_filter: 1 };
    const f = {
      name: h('input', { value: v.name || '', required: true }),
      kind: h('select', {}, kinds.map((k) => h('option', { value: k, selected: k === v.kind }, t(`kind_${k}`)))),
      target: h('input', { value: v.target || '', required: true }),
      company: h('input', { value: v.company || '' }),
      enabled: h('input', { type: 'checkbox', checked: !!v.enabled }),
      pilot_filter: h('input', { type: 'checkbox', checked: !!v.pilot_filter }),
    };
    const close = modal(src ? t('edit') : t('addSource'), h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: f.name.value, kind: f.kind.value, target: f.target.value, company: f.company.value, enabled: f.enabled.checked, pilot_filter: f.pilot_filter.checked };
        try { await api(src ? `/admin/job-sources/${src.id}` : '/admin/job-sources', { method: src ? 'PUT' : 'POST', body }); close(); reload(); } catch (err) { toast(errorText(err), 'error'); }
      },
    }, h('label', {}, t('name'), f.name), h('label', {}, t('kind'), f.kind), h('label', {}, t('target'), f.target),
    h('label', {}, t('company'), f.company),
    h('label', { class: 'inline' }, f.enabled, t('enabled')), h('label', { class: 'inline' }, f.pilot_filter, t('pilotFilter')),
    h('button', { class: 'btn primary' }, t('save'))));
  };
  const runBtn = (label, path) => {
    const b = h('button', {
      class: 'btn small',
      onclick: async () => {
        b.disabled = true; b.textContent = t('loading');
        try { await api(path, { method: 'POST' }); } catch (err) { toast(errorText(err), 'error'); }
        reload();
      },
    }, label);
    return b;
  };
  clear(el,
    h('p', { class: 'notice subtle' }, t('sourcesHelp')),
    h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => editSource(null) }, `+ ${t('addSource')}`), runBtn(t('refreshAll'), '/admin/job-sources/refresh')),
    h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['name', 'kind', 'target', 'nav_jobs', 'status', ''].map((k) => h('th', {}, k ? t(k) : '')))),
      h('tbody', {}, list.length ? list.map((s) => h('tr', { class: s.enabled ? '' : 'disabled' },
        h('td', {}, s.name, s.company ? h('div', { class: 'muted small' }, s.company) : null), h('td', {}, s.kind), h('td', { class: 'ellipsis' }, s.target),
        h('td', {}, s.jobs), h('td', { class: 'small' }, s.last_status ? `${fmtDate(s.last_run_at)} — ${s.last_status}` : '—'),
        h('td', { class: 'actions' }, runBtn(t('run'), `/admin/job-sources/${s.id}/run`),
          h('button', { class: 'link-btn', onclick: () => editSource(s) }, t('edit')),
          h('button', { class: 'link-btn danger', onclick: async () => { if (confirm(t('confirmDelete'))) { await api(`/admin/job-sources/${s.id}`, { method: 'DELETE' }); reload(); } } }, t('delete')))))
        : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, t('none')))))));
}
