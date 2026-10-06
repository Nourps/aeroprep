import { t, getLang } from '../i18n.js';
import { h, clear, api, errorText } from '../ui.js';
import { state, navigate, refreshMe } from '../app.js';

export async function authView(view, mode) {
  const isRegister = mode === 'register';
  const err = h('div', { class: 'form-error' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'email' });
  const password = h('input', { type: 'password', required: true, minlength: isRegister ? 10 : null, autocomplete: isRegister ? 'new-password' : 'current-password' });
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 80 });

  const submit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: { email: email.value, password: password.value, name: name.value, lang: getLang() } });
      await refreshMe();
      navigate('#/');
    } catch (ex) {
      err.textContent = errorText(ex);
    }
  };

  const closed = isRegister && !state.registrationOpen;
  clear(view, h('div', { class: 'auth-wrap' },
    h('div', { class: 'auth-card card' },
      h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark big' }, '✈'), h('h1', {}, 'AeroPrep'), h('p', { class: 'muted' }, t('appTagline'))),
      closed ? h('p', { class: 'notice' }, t('registrationClosed')) : h('form', { onsubmit: submit, class: 'stack' },
        h('h2', {}, t(isRegister ? 'register' : 'login')),
        isRegister ? h('label', {}, t('name'), name) : null,
        h('label', {}, t('email'), email),
        h('label', {}, t('password'), password, isRegister ? h('small', { class: 'muted' }, t('passwordHint')) : null),
        err,
        h('button', { class: 'btn primary', type: 'submit' }, t(isRegister ? 'register' : 'login'))),
      h('p', { class: 'muted center' },
        isRegister ? [t('haveAccount'), ' ', h('a', { href: '#/login' }, t('login'))]
          : [t('noAccount'), ' ', h('a', { href: '#/register' }, t('register'))]))));
  email.focus();
}
