import { t, setLang, getLang } from './i18n.js';
import { h, clear, api, spinner, toast, errorText } from './ui.js';
import { authView } from './views/auth.js';
import { dashboardView } from './views/dashboard.js';
import { quizHub } from './views/quiz.js';
import { docsView } from './views/docs.js';
import { assistantView } from './views/assistant.js';
import { jobsView } from './views/jobs.js';
import { adminView } from './views/admin.js';
import { profileView } from './views/profile.js';

export const state = { user: null, registrationOpen: true };
export const can = (perm) => !!state.user?.permissions.includes(perm);

const root = document.getElementById('app');

export async function refreshMe() {
  const me = await api('/auth/me');
  state.user = me.user;
  state.registrationOpen = me.registrationOpen;
  if (state.user && state.user.lang !== getLang() && !sessionStorage.getItem('langChosen')) setLang(state.user.lang);
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function header(section) {
  const link = (hash, key, perm) => (perm && !can(perm) ? null
    : h('a', { href: hash, class: section === key ? 'active' : '' }, t(`nav_${key}`)));
  const toggleLang = async () => {
    const next = getLang() === 'fr' ? 'en' : 'fr';
    setLang(next);
    sessionStorage.setItem('langChosen', '1');
    if (state.user) api('/auth/me', { method: 'PATCH', body: { lang: next } }).catch(() => {});
    render();
  };
  const menuBtn = h('button', { class: 'icon-btn menu-btn', 'aria-label': 'menu', onclick: () => nav.classList.toggle('open') }, '☰');
  const nav = h('nav', { class: 'main-nav', onclick: (e) => { if (e.target.tagName === 'A') nav.classList.remove('open'); } },
    link('#/', 'home'), link('#/atpl', 'atpl'), link('#/a320', 'a320'), link('#/jobs', 'jobs'), link('#/admin', 'admin', 'admin'),
    h('span', { class: 'nav-spacer' }),
    link('#/profile', 'profile'),
    h('button', { class: 'link-btn', onclick: async () => { await api('/auth/logout', { method: 'POST' }); state.user = null; navigate('#/login'); } }, t('logout')));
  return h('header', { class: 'topbar' },
    h('a', { href: '#/', class: 'brand' }, h('span', { class: 'brand-mark' }, '✈'), h('span', {}, 'AeroPrep')),
    state.user ? nav : h('span', { class: 'nav-spacer' }),
    h('button', { class: 'lang-btn', onclick: toggleLang, title: t('language') }, getLang() === 'fr' ? 'EN' : 'FR'),
    state.user ? menuBtn : null);
}

export async function render() {
  const [path] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const section = parts[0] || 'home';

  if (!state.user && section !== 'login' && section !== 'register') return navigate('#/login');
  if (state.user && (section === 'login' || section === 'register')) return navigate('#/');

  const main = h('main', { class: 'container' });
  clear(root, header(section), main);
  if (state.user?.role === 'pending' && section !== 'login') main.append(h('div', { class: 'notice' }, t('pendingNotice')));
  const view = h('div', { class: 'view' }, spinner());
  main.append(view);

  try {
    switch (section) {
      case 'login': case 'register': await authView(view, section); break;
      case 'home': await dashboardView(view); break;
      case 'atpl': await quizHub(view, 'atpl', parts[1] || 'subjects'); break;
      case 'a320': {
        const sub = parts[1] || 'systems';
        if (sub === 'docs') await docsView(view, a320Tabs('docs'));
        else if (sub === 'ask') await assistantView(view, a320Tabs('ask'));
        else await quizHub(view, 'a320', sub === 'systems' ? 'subjects' : sub, a320Tabs(sub));
        break;
      }
      case 'jobs': await jobsView(view); break;
      case 'admin': await adminView(view, parts[1] || 'users'); break;
      case 'profile': await profileView(view); break;
      default: clear(view, h('p', {}, '404'));
    }
  } catch (err) {
    console.error(err);
    if (err.status === 401) { state.user = null; return navigate('#/login'); }
    clear(view, h('div', { class: 'card error' }, errorText(err)));
  }
}

/** Sub-navigation of the A320 space (kept separate from the ATPL space). */
export function a320Tabs(active) {
  const items = [['systems', t('systems')], ['stats', t('stats')]];
  if (can('docs.view')) items.push(['docs', t('documents')]);
  items.push(['ask', t('assistant')]);
  return h('div', { class: 'space-head' },
    h('div', {}, h('h1', {}, 'Airbus A320'), h('p', { class: 'muted' }, t('a320Intro'))),
    h('div', { class: 'tabs' }, items.map(([k, label]) => h('a', { href: `#/a320/${k}`, class: `tab ${k === active ? 'active' : ''}` }, label))));
}

window.addEventListener('hashchange', render);
// A link to the current hash (e.g. "ATPL" while a quiz is running) re-renders the page instead of doing nothing.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute('href') === location.hash && !e.defaultPrevented) { e.preventDefault(); render(); }
});
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status) toast(errorText(e.reason), 'error'); });

(async () => {
  try { await refreshMe(); } catch { /* offline */ }
  render();
})();
