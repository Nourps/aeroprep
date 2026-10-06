import { t, subjectName } from '../i18n.js';
import { h, api, toast, errorText, modal } from '../ui.js';
import { can } from '../app.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Loads the subjects of both spaces (cached for the page's lifetime). */
let subjectsCache = null;
export async function allSubjects() {
  if (!subjectsCache) {
    const [atpl, a320] = await Promise.all([api('/quiz/atpl/subjects'), api('/quiz/a320/subjects')]);
    subjectsCache = [...atpl.subjects.map((s) => ({ ...s, space: 'atpl' })), ...a320.subjects.map((s) => ({ ...s, space: 'a320' }))];
  }
  return subjectsCache;
}

/**
 * Question editor. Admins publish (or edit) directly; members propose a question that an admin validates.
 * @param {object} opts { question?, subjects, defaultSubject?, space?, onSaved? }
 */
export function openQuestionEditor({ question = null, subjects, defaultSubject, space, onSaved = () => {} }) {
  const admin = can('admin');
  const v = question || { subject_code: defaultSubject, options: ['', '', '', ''], correct: 0, difficulty: 2, active: 1 };
  const list = space ? subjects.filter((s) => s.space === space) : subjects;
  const subject = h('select', {}, list.map((s) => h('option', { value: s.code, selected: s.code === v.subject_code },
    `${space ? '' : `${s.space.toUpperCase()} · `}${s.code} · ${subjectName(s)}`)));
  const topic = h('input', { value: v.topic || '', placeholder: 'ex. PTU, Fronts, VMCA…' });
  const text = h('textarea', { rows: 3, required: true, placeholder: t('question') }, v.question || '');
  const name = `correct-${Math.random()}`;
  const optRows = h('div', { class: 'stack tight-stack' });

  const relabel = () => [...optRows.children].forEach((row, i) => { row.querySelector('.letter').textContent = LETTERS[i]; });
  const addOpt = (value = '', checked = false) => {
    if (optRows.children.length >= 6) return;
    const row = h('div', { class: 'opt-row' },
      h('label', { class: 'correct-pick', title: t('correctAnswer') }, h('input', { type: 'radio', name, checked }), h('span', { class: 'letter' })),
      h('input', { type: 'text', value, class: 'grow', placeholder: t('answerText') }),
      h('button', { type: 'button', class: 'icon-btn', title: t('delete'), onclick: () => { if (optRows.children.length > 2) { row.remove(); relabel(); } } }, '✕'));
    optRows.append(row);
    relabel();
  };
  v.options.forEach((o, i) => addOpt(o, i === v.correct));

  const explanation = h('textarea', { rows: 3, placeholder: t('explanationHint') }, v.explanation || '');
  const reference = h('input', { value: v.reference || '', placeholder: 'FCOM DSC-29, Part-FCL…' });
  const difficulty = h('select', {}, [1, 2, 3].map((d) => h('option', { value: d, selected: d === v.difficulty }, t(`diff${d}`))));
  const active = h('input', { type: 'checkbox', checked: !!v.active });
  const error = h('div', { class: 'form-error' });

  const collect = () => {
    const rows = [...optRows.children];
    return {
      subject_code: subject.value, topic: topic.value, question: text.value,
      options: rows.map((r) => r.querySelector('input[type=text]').value),
      correct: rows.findIndex((r) => r.querySelector('input[type=radio]').checked),
      explanation: explanation.value, reference: reference.value, difficulty: Number(difficulty.value), active: admin ? active.checked : false,
    };
  };

  const save = async (again) => {
    error.textContent = '';
    const body = collect();
    if (body.correct < 0) { error.textContent = t('pickCorrect'); return; }
    try {
      if (question) await api(`/admin/questions/${question.id}`, { method: 'PUT', body });
      else await api('/questions', { method: 'POST', body });
    } catch (err) { error.textContent = errorText(err); return; }
    toast(admin ? t('questionSaved') : t('questionProposed'), 'success');
    onSaved();
    if (again) {
      // Keep subject, topic and difficulty for fast entry of a series.
      text.value = ''; explanation.value = ''; reference.value = '';
      optRows.replaceChildren();
      for (let i = 0; i < 4; i++) addOpt('', i === 0);
      text.focus();
    } else close();
  };

  const close = modal(question ? t('edit') : t('newQuestion'), h('form', {
    class: 'stack',
    onsubmit: (e) => { e.preventDefault(); save(false); },
  },
  admin ? null : h('p', { class: 'notice subtle small' }, t('proposeNotice')),
  h('div', { class: 'grid two tight' }, h('label', {}, t('subject'), subject), h('label', {}, t('topic'), topic)),
  h('label', {}, t('question'), text),
  h('div', {}, h('span', { class: 'filter-label' }, t('options')), optRows,
    h('button', { type: 'button', class: 'link-btn', onclick: () => addOpt() }, `+ ${t('addAnswer')}`)),
  h('label', {}, t('explanation'), explanation),
  h('div', { class: 'grid three tight' }, h('label', {}, t('reference'), reference), h('label', {}, t('difficulty'), difficulty),
    admin ? h('label', { class: 'inline' }, active, t('active')) : h('span')),
  error,
  h('div', { class: 'row gap' },
    h('button', { class: 'btn primary', type: 'submit' }, t('save')),
    question ? null : h('button', { class: 'btn', type: 'button', onclick: () => save(true) }, t('saveAndNew')))), { wide: true });
  text.focus();
}
