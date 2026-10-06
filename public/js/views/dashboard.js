import { t } from '../i18n.js';
import { h, clear, api, pct, progressBar } from '../ui.js';
import { state, can } from '../app.js';
import { startQuiz } from './quiz.js';

function totals(subjects) {
  return subjects.reduce((a, s) => ({
    total: a.total + s.total, seen: a.seen + s.seen, answered: a.answered + s.answered,
    right: a.right + s.right_answers, due: a.due + s.due, mastered: a.mastered + s.mastered,
  }), { total: 0, seen: 0, answered: 0, right: 0, due: 0, mastered: 0 });
}

function spaceCard(space, title, tot, view) {
  return h('div', { class: 'card space-card' },
    h('div', { class: 'row between' }, h('h2', {}, title), h('a', { href: `#/${space}`, class: 'btn small' }, '→')),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', {}, tot.due), h('span', {}, t('dueReviews'))),
      h('div', { class: 'kpi' }, h('b', {}, `${tot.seen}/${tot.total}`), h('span', {}, t('questionsSeen'))),
      h('div', { class: 'kpi' }, h('b', {}, pct(tot.right, tot.answered)), h('span', {}, t('accuracy'))),
      h('div', { class: 'kpi' }, h('b', {}, tot.mastered), h('span', {}, t('mastered')))),
    progressBar(tot.seen, tot.total),
    tot.due ? h('button', { class: 'btn primary', onclick: () => startQuiz(view, space, { mode: 'practice', filter: 'due', count: 50, subjects: [] }) }, `${t('startReview')} (${tot.due})`) : null);
}

export async function dashboardView(view) {
  const [atpl, a320, jobs] = await Promise.all([
    api('/quiz/atpl/subjects'), api('/quiz/a320/subjects'),
    can('jobs.view') ? api('/jobs?limit=5') : { jobs: [] },
  ]);
  const name = state.user.name || state.user.email.split('@')[0];
  clear(view,
    h('div', { class: 'page-head' }, h('h1', {}, `${t('welcome')} ${name}`), h('p', { class: 'muted' }, t('dashboardIntro'))),
    h('div', { class: 'grid two' },
      spaceCard('atpl', 'ATPL EASA', totals(atpl.subjects), view),
      spaceCard('a320', 'Airbus A320', totals(a320.subjects), view)),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, t('nav_jobs')), h('a', { href: '#/jobs', class: 'btn small' }, t('browseJobs'))),
      jobs.jobs.length ? h('ul', { class: 'plain-list' }, jobs.jobs.map((j) => h('li', {},
        h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer' }, j.title),
        h('span', { class: 'muted' }, ` — ${j.company || ''} ${j.location ? `· ${j.location}` : ''}`),
        h('span', { class: `chip cat-${j.category}` }, t(`jc_${j.category}`)))))
        : h('p', { class: 'muted' }, t('noJobs'))));
}
