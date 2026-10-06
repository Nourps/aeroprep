import { t, subjectName } from '../i18n.js';
import { h, clear, api, pct, progressBar, fmtDate, toast, errorText } from '../ui.js';
import { navigate } from '../app.js';

const home = (space) => (space === 'atpl' ? '#/atpl' : '#/a320');

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
let cleanupKeys = null;
let timerHandle = null;

function stopRunners() {
  if (cleanupKeys) { cleanupKeys(); cleanupKeys = null; }
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
window.addEventListener('hashchange', stopRunners);

function onKeys(handler) {
  if (cleanupKeys) cleanupKeys();
  const fn = (e) => { if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) handler(e); };
  document.addEventListener('keydown', fn);
  cleanupKeys = () => document.removeEventListener('keydown', fn);
}

function atplHead(active) {
  return h('div', { class: 'space-head' },
    h('div', {}, h('h1', {}, 'ATPL EASA'), h('p', { class: 'muted' }, '13 ' + t('subjects').toLowerCase() + ' · Part-FCL')),
    h('div', { class: 'tabs' },
      h('a', { href: '#/atpl', class: `tab ${active === 'subjects' ? 'active' : ''}` }, t('subjects')),
      h('a', { href: '#/atpl/stats', class: `tab ${active === 'stats' ? 'active' : ''}` }, t('stats'))));
}

export async function quizHub(view, space, sub, head) {
  stopRunners();
  const header = head || atplHead(sub);
  if (sub === 'stats') return statsView(view, space, header);
  const { subjects } = await api(`/quiz/${space}/subjects`);
  const selected = new Set();

  const cards = subjects.map((s) => {
    const cb = h('input', { type: 'checkbox', onchange: () => { cb.checked ? selected.add(s.code) : selected.delete(s.code); card.classList.toggle('selected', cb.checked); } });
    const card = h('label', { class: 'card subject-card' },
      h('div', { class: 'row between' },
        h('span', { class: 'code' }, space === 'atpl' ? s.code : s.code.replace('A', 'ATA ')),
        cb),
      h('h3', {}, subjectName(s)),
      progressBar(s.seen, s.total),
      h('div', { class: 'subject-meta' },
        h('span', {}, `${s.total} ${t('questions')}`),
        h('span', {}, `${s.seen} ${t('seen')}`),
        h('span', {}, pct(s.right_answers, s.answered)),
        s.due ? h('span', { class: 'chip warn' }, `${s.due} ${t('due')}`) : null));
    card.dataset.code = s.code;
    return { card, cb };
  });

  const mode = h('select', {}, h('option', { value: 'practice' }, t('practice')), h('option', { value: 'exam' }, t('exam')));
  const filter = h('select', {}, ['all', 'unseen', 'wrong', 'due', 'flagged'].map((f) => h('option', { value: f }, t(`f_${f}`))));
  filter.value = 'unseen';
  const count = h('input', { type: 'number', min: 1, max: 200, value: 20 });
  const help = h('small', { class: 'muted' }, t('modePracticeHelp'));
  mode.addEventListener('change', () => { help.textContent = t(mode.value === 'exam' ? 'modeExamHelp' : 'modePracticeHelp'); });
  const setAll = (v) => cards.forEach(({ cb, card }) => { cb.checked = v; card.classList.toggle('selected', v); v ? selected.add(card.dataset.code) : selected.delete(card.dataset.code); });

  clear(view, header,
    h('div', { class: 'card setup' },
      h('div', { class: 'setup-grid' },
        h('label', {}, t('mode'), mode),
        h('label', {}, t('filter'), filter),
        h('label', {}, t('count'), count),
        h('button', { class: 'btn primary', onclick: () => startQuiz(view, space, { mode: mode.value, filter: filter.value, count: Number(count.value), subjects: [...selected] }) }, t('start'))),
      help,
      h('div', { class: 'row gap' },
        h('button', { class: 'link-btn', onclick: () => setAll(true) }, t('selectAll')),
        h('button', { class: 'link-btn', onclick: () => setAll(false) }, t('selectNone')))),
    h('div', { class: 'grid subjects' }, cards.map((c) => c.card)));
}

export async function startQuiz(view, space, opts) {
  stopRunners();
  let data;
  try {
    data = await api(`/quiz/${space}/start`, { method: 'POST', body: opts });
  } catch (err) { toast(errorText(err), 'error'); return; }
  if (!data.questions.length) { toast(t('noQuestions'), 'info'); return; }
  if (data.mode === 'exam') return runExam(view, space, data);
  return runPractice(view, space, data.questions);
}

function flagButton(q) {
  const btn = h('button', { class: `link-btn flag ${q.flagged ? 'on' : ''}` }, q.flagged ? `⚑ ${t('unflag')}` : `⚐ ${t('flag')}`);
  btn.addEventListener('click', async () => {
    if (q.flagged) await api(`/quiz/flag/${q.id}`, { method: 'DELETE' });
    else {
      const note = prompt(t('flagNote'), '');
      if (note === null) return;
      await api(`/quiz/flag/${q.id}`, { method: 'POST', body: { note } });
    }
    q.flagged = !q.flagged;
    btn.className = `link-btn flag ${q.flagged ? 'on' : ''}`;
    btn.textContent = q.flagged ? `⚑ ${t('unflag')}` : `⚐ ${t('flag')}`;
  });
  return btn;
}

function questionHeader(q, i, n) {
  return h('div', { class: 'q-head' },
    h('span', { class: 'muted' }, `${t('question')} ${i + 1} ${t('of')} ${n}`),
    h('span', { class: 'chip' }, q.subject), q.topic ? h('span', { class: 'chip ghost' }, q.topic) : null,
    h('span', { class: `chip diff-${q.difficulty}` }, t(`diff${q.difficulty}`)));
}

// ---------------------------------------------------------------------------
// Practice: immediate correction
// ---------------------------------------------------------------------------
function runPractice(view, space, questions) {
  let i = 0;
  const results = [];
  let chosen = null;
  let answered = null;

  const show = () => {
    const q = questions[i];
    chosen = null; answered = null;
    const optionEls = q.options.map((o, k) => h('button', { class: 'option', onclick: () => select(k) },
      h('span', { class: 'letter' }, LETTERS[k]), h('span', {}, o.text)));
    const feedback = h('div', { class: 'feedback' });
    const validate = h('button', { class: 'btn primary', disabled: true, onclick: () => check() }, t('validate'));
    const nextBtn = h('button', { class: 'btn primary', style: { display: 'none' }, onclick: () => next() }, i + 1 < questions.length ? t('next') : t('finish'));

    const select = (k) => {
      if (answered) return;
      chosen = k;
      optionEls.forEach((el, j) => el.classList.toggle('chosen', j === k));
      validate.disabled = false;
    };
    const check = async () => {
      if (chosen === null || answered) return;
      validate.disabled = true;
      try {
        answered = await api('/quiz/answer', { method: 'POST', body: { questionId: q.id, chosen: q.options[chosen].idx } });
      } catch (err) { validate.disabled = false; toast(errorText(err), 'error'); return; }
      results.push({ q, correct: answered.correct });
      optionEls.forEach((el, j) => {
        el.disabled = true;
        if (q.options[j].idx === answered.correctIndex) el.classList.add('right');
        else if (j === chosen) el.classList.add('wrong');
      });
      clear(feedback,
        h('div', { class: `verdict ${answered.correct ? 'ok' : 'ko'}` }, answered.correct ? `✓ ${t('correct')}` : `✗ ${t('wrong')}`),
        answered.explanation ? h('div', { class: 'explanation' }, h('b', {}, `${t('explanation')} — `), answered.explanation) : null,
        answered.reference ? h('div', { class: 'muted small' }, `${t('reference')} : ${answered.reference}`) : null);
      validate.style.display = 'none';
      nextBtn.style.display = '';
      nextBtn.focus();
    };
    const next = () => { i++; if (i < questions.length) show(); else summary(); };

    onKeys((e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) select(n - 1);
      const letter = LETTERS.indexOf(e.key.toUpperCase());
      if (letter > -1 && letter < q.options.length && e.key.length === 1) select(letter);
      if (e.key === 'Enter') { e.preventDefault(); answered ? next() : check(); }
    });

    clear(view,
      h('div', { class: 'quiz' },
        h('div', { class: 'quiz-top' }, progressBar(i, questions.length, 'thin'),
          h('button', { class: 'link-btn', onclick: () => { stopRunners(); results.length ? summary() : navigate(home(space)); } }, `✕ ${t('finish')}`)),
        h('div', { class: 'card question-card' },
          questionHeader(q, i, questions.length),
          h('p', { class: 'q-text' }, q.question),
          h('div', { class: 'options' }, optionEls),
          feedback,
          h('div', { class: 'row between' }, flagButton(q), h('div', { class: 'row gap' }, validate, nextBtn)))));
  };

  const summary = () => {
    stopRunners();
    const right = results.filter((r) => r.correct).length;
    const wrongQs = results.filter((r) => !r.correct).map((r) => r.q);
    clear(view, h('div', { class: 'card result-card' },
      h('h2', {}, t('sessionDone')),
      h('div', { class: 'big-score' }, pct(right, results.length)),
      h('p', { class: 'muted' }, `${right} / ${results.length}`),
      h('div', { class: 'row gap center' },
        wrongQs.length ? h('button', { class: 'btn primary', onclick: () => runPractice(view, space, wrongQs.map((q) => ({ ...q, options: [...q.options].sort(() => Math.random() - 0.5) }))) }, `${t('retryWrong')} (${wrongQs.length})`) : null,
        h('button', { class: 'btn', onclick: () => navigate(home(space)) }, t('backToSubjects')))));
  };

  show();
}

// ---------------------------------------------------------------------------
// Exam: timed, navigation between questions, graded at the end
// ---------------------------------------------------------------------------
function runExam(view, space, data) {
  const { questions, examId, durationSeconds } = data;
  const answers = {};       // questionId -> displayed option index
  const deadline = Date.now() + durationSeconds * 1000;
  let i = 0;
  let submitted = false;
  const timer = h('span', { class: 'timer' });
  const navGrid = h('div', { class: 'exam-nav' });
  const body = h('div');

  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    timer.textContent = `${t('timeLeft')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    timer.classList.toggle('low', left < 120);
    if (left === 0 && !submitted) { toast(t('timeUp'), 'info'); submit(); }
  };

  const renderNav = () => clear(navGrid, questions.map((q, k) =>
    h('button', { class: `nav-cell ${answers[q.id] !== undefined ? 'done' : ''} ${k === i ? 'current' : ''} ${q.flagged ? 'flagged' : ''}`, onclick: () => { i = k; show(); } }, k + 1)));

  const show = () => {
    const q = questions[i];
    const opts = q.options.map((o, k) => h('button', { class: `option ${answers[q.id] === k ? 'chosen' : ''}`, onclick: () => { answers[q.id] = k; show(); } },
      h('span', { class: 'letter' }, LETTERS[k]), h('span', {}, o.text)));
    clear(body, h('div', { class: 'card question-card' },
      questionHeader(q, i, questions.length),
      h('p', { class: 'q-text' }, q.question),
      h('div', { class: 'options' }, opts),
      h('div', { class: 'row between' }, flagButton(q),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn', disabled: i === 0, onclick: () => { i--; show(); } }, t('previous')),
          i + 1 < questions.length ? h('button', { class: 'btn primary', onclick: () => { i++; show(); } }, t('next')) : null))));
    renderNav();
  };

  const submit = async (confirmFirst = false) => {
    if (submitted) return;
    const missing = questions.filter((q) => answers[q.id] === undefined).length;
    if (confirmFirst && !confirm(`${t('confirmSubmit')} ${missing}`)) return;
    submitted = true;
    stopRunners();
    const payload = Object.fromEntries(questions.filter((q) => answers[q.id] !== undefined).map((q) => [q.id, q.options[answers[q.id]].idx]));
    let res;
    try { res = await api(`/quiz/exam/${examId}/submit`, { method: 'POST', body: { answers: payload } }); }
    catch (err) { submitted = false; toast(errorText(err), 'error'); return; }
    examResults(view, space, questions, res);
  };

  onKeys((e) => {
    const n = Number(e.key);
    const q = questions[i];
    if (n >= 1 && n <= q.options.length) { answers[q.id] = n - 1; show(); }
    if (e.key === 'ArrowRight' && i + 1 < questions.length) { i++; show(); }
    if (e.key === 'ArrowLeft' && i > 0) { i--; show(); }
  });
  timerHandle = setInterval(tick, 1000);
  tick();

  clear(view, h('div', { class: 'quiz exam' },
    h('div', { class: 'quiz-top sticky' }, timer, h('button', { class: 'btn primary', onclick: () => submit(true) }, t('submitExam'))),
    navGrid, body));
  show();
}

function examResults(view, space, questions, res) {
  const byId = new Map(res.results.map((r) => [r.id, r]));
  clear(view,
    h('div', { class: 'card result-card' },
      h('h2', {}, t('score')),
      h('div', { class: `big-score ${res.passed ? 'ok' : 'ko'}` }, `${res.score} %`),
      h('p', {}, h('span', { class: `chip ${res.passed ? 'good' : 'bad'}` }, res.passed ? `✓ ${t('passed')}` : `✗ ${t('failed')}`),
        ' ', h('span', { class: 'muted' }, `${res.right}/${res.total} · ${t('passMark')} ${res.passMark} %`)),
      h('button', { class: 'btn', onclick: () => navigate(home(space)) }, t('backToSubjects'))),
    questions.map((q, k) => {
      const r = byId.get(q.id);
      if (!r) return null;
      const text = (idx) => q.options.find((o) => o.idx === idx)?.text;
      return h('div', { class: `card review-card ${r.correct ? 'ok' : 'ko'}` },
        questionHeader(q, k, questions.length),
        h('p', { class: 'q-text' }, q.question),
        h('p', {}, h('b', {}, `${t('yourAnswer')} : `), r.chosen === null ? h('em', {}, t('noAnswer')) : text(r.chosen), r.correct ? ' ✓' : ' ✗'),
        r.correct ? null : h('p', { class: 'right-answer' }, h('b', {}, `${t('correct')} : `), text(r.correctIndex)),
        r.explanation ? h('div', { class: 'explanation' }, r.explanation) : null,
        r.reference ? h('div', { class: 'muted small' }, `${t('reference')} : ${r.reference}`) : null);
    }));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
async function statsView(view, space, header) {
  const [stats, { subjects }] = await Promise.all([api(`/quiz/${space}/stats`), api(`/quiz/${space}/subjects`)]);
  const days = [];
  for (let d = 29; d >= 0; d--) days.push(new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10));
  const byDay = new Map(stats.daily.map((d) => [d.day, d]));
  const maxDay = Math.max(1, ...stats.daily.map((d) => d.answered));

  const activity = h('div', { class: 'chart', role: 'img', 'aria-label': t('last30') },
    days.map((d) => {
      const v = byDay.get(d);
      const n = v?.answered || 0;
      return h('div', { class: 'col', title: `${d} · ${n} ${t('answered')}${n ? ` · ${pct(v.right_answers, n)}` : ''}` },
        h('div', { class: 'fill', style: { height: `${(n / maxDay) * 100}%` } }));
    }));

  const boxes = [1, 2, 3, 4, 5, 6].map((b) => ({ b, n: stats.boxes.find((x) => x.box === b)?.n || 0 }));
  const maxBox = Math.max(1, ...boxes.map((x) => x.n));

  clear(view, header,
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, `${t('last30')} — ${t('answered')}`), activity,
        h('div', { class: 'row between muted small' }, h('span', {}, fmtDate(days[0])), h('span', {}, fmtDate(days[29])))),
      h('div', { class: 'card' }, h('h3', {}, t('leitner')),
        h('div', { class: 'hbars' }, boxes.map(({ b, n }) => h('div', { class: 'hbar', title: `${t('box')} ${b}: ${n}` },
          h('span', { class: 'lbl' }, `${t('box')} ${b}${b === 6 ? ' ★' : ''}`),
          h('div', { class: 'track' }, h('div', { class: `fill seq-${b}`, style: { width: `${(n / maxBox) * 100}%` } })),
          h('span', { class: 'val' }, n)))))),
    h('div', { class: 'card' }, h('h3', {}, t('subjects')),
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('questionsSeen')), h('th', {}, t('accuracy')), h('th', {}, t('due')), h('th', {}, t('mastered')))),
        h('tbody', {}, subjects.map((s) => h('tr', {},
          h('td', {}, `${s.code} · ${subjectName(s)}`), h('td', {}, `${s.seen}/${s.total}`),
          h('td', {}, pct(s.right_answers, s.answered)), h('td', {}, s.due), h('td', {}, s.mastered)))))),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, t('examHistory')),
        stats.exams.length ? h('table', { class: 'table' }, h('tbody', {}, stats.exams.map((e) => h('tr', {},
          h('td', {}, fmtDate(e.finished_at)), h('td', {}, e.subjects.length > 4 ? `${e.subjects.length} ${t('subjects').toLowerCase()}` : e.subjects.join(', ')),
          h('td', {}, `${e.total} q`),
          h('td', {}, h('span', { class: `chip ${e.score >= stats.passMark ? 'good' : 'bad'}` }, `${e.score} %`))))))
          : h('p', { class: 'muted' }, t('none'))),
      h('div', { class: 'card' }, h('h3', {}, t('weakTopics')),
        stats.weakTopics.length ? h('table', { class: 'table' }, h('tbody', {}, stats.weakTopics.map((w) => h('tr', {},
          h('td', {}, w.subject), h('td', {}, w.topic), h('td', {}, pct(w.right_answers, w.answered)), h('td', { class: 'muted' }, `${w.answered} ${t('answered')}`)))))
          : h('p', { class: 'muted' }, t('none')))));
}
