import { t, setLang, getLang } from '../i18n.js';
import { h, clear, api, toast, errorText } from '../ui.js';
import { state, render } from '../app.js';

export async function profileView(view) {
  const u = state.user;
  const name = h('input', { value: u.name });
  const lang = h('select', {}, h('option', { value: 'fr', selected: getLang() === 'fr' }, 'Français'), h('option', { value: 'en', selected: getLang() === 'en' }, 'English'));
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });

  const saveProfile = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/me', { method: 'PATCH', body: { name: name.value, lang: lang.value } });
      state.user = r.user;
      setLang(lang.value);
      toast(t('saved'), 'success');
      render();
    } catch (err) { toast(errorText(err), 'error'); }
  };
  const changePassword = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/me', { method: 'PATCH', body: { currentPassword: current.value, newPassword: next.value } });
      current.value = ''; next.value = '';
      toast(t('saved'), 'success');
    } catch (err) { toast(errorText(err), 'error'); }
  };

  clear(view,
    h('div', { class: 'page-head' }, h('h1', {}, t('nav_profile')),
      h('p', { class: 'muted' }, `${u.email} · ${t(`role_${u.role}`)} · ${t('quotaLeft')} : ${u.ai.remaining === null ? t('unlimited') : u.ai.remaining}`)),
    h('div', { class: 'grid two' },
      h('form', { class: 'card stack', onsubmit: saveProfile },
        h('label', {}, t('name'), name), h('label', {}, t('language'), lang), h('button', { class: 'btn primary' }, t('save'))),
      h('form', { class: 'card stack', onsubmit: changePassword }, h('h3', {}, t('changePassword')),
        h('label', {}, t('currentPassword'), current), h('label', {}, t('newPassword'), next, h('small', { class: 'muted' }, t('passwordHint'))),
        h('button', { class: 'btn primary' }, t('save')))));
}
