// The signed-in account: who it is, what it may do, and the top-bar menu that says so.
//
// The helpers below decide what the dashboard *shows*. They are a mirror of src/auth/policy.ts,
// never the authority: every rule is enforced again on the server, so a hidden button that a
// reader brings back with DevTools still answers 403.

import { $, api, closeDialog, el, emit, initials, openDialog, state, toast } from './core.js';

export async function loadMe() {
  try {
    state.me = await api('/api/auth/me');
  } catch {
    state.me = null; // api() has already sent us to /login
  }
  renderUserMenu();
  return state.me;
}

export const isRoot = () => state.me?.role === 'root';
export const isAdmin = () => state.me?.role === 'root' || state.me?.role === 'admin';

/** An admin's access to every project is implicit, so it reads as `editor` everywhere. */
export const projectRole = (project) => (isAdmin() ? 'editor' : (state.me?.projects?.[project.id] ?? null));
export const canEdit = (project) => projectRole(project) === 'editor';
export const canCreateProject = () => isAdmin();
export const canDeleteProject = () => isAdmin();
export const canManageUsers = () => isAdmin();
export const canManageMembers = () => isAdmin();

// ---------- top bar ----------

let menuOpen = false;

export function renderUserMenu() {
  const host = $('#user-menu');
  if (!host) return;
  host.replaceChildren();
  const me = state.me;
  if (!me) return;

  const label = me.displayName || me.username;
  host.append(
    el(
      'button',
      {
        type: 'button',
        class: 'user-btn',
        'aria-haspopup': 'menu',
        'aria-expanded': String(menuOpen),
        'aria-label': `Account menu for ${label}`,
        onclick: () => {
          menuOpen = !menuOpen;
          renderUserMenu();
        },
      },
      [
        el('span', { class: `avatar ${me.role}`, 'aria-hidden': 'true', text: initials(label) }),
        el('span', { class: 'user-name', text: label }),
        el('span', { class: `pill small ${me.role}`, text: me.role }),
      ],
    ),
  );

  if (!menuOpen) return;
  host.append(
    el('div', { class: 'menu', role: 'menu' }, [
      el('div', { class: 'menu-head' }, [el('span', { class: 'bold', text: label }), el('span', { class: 'sub', text: me.email || me.username })]),
      el('button', {
        type: 'button',
        class: 'menu-item',
        role: 'menuitem',
        text: 'Change password',
        onclick: () => {
          closeMenu();
          openPasswordDialog();
        },
      }),
      canManageUsers() ? el('a', { class: 'menu-item', role: 'menuitem', href: '#/~users', text: 'Users', onclick: closeMenu }) : null,
      el('span', { class: 'menu-sep' }),
      el('button', { type: 'button', class: 'menu-item danger-text', role: 'menuitem', text: 'Sign out', onclick: signOut }),
    ]),
  );
  host.querySelector('.menu-item')?.focus();
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  renderUserMenu();
}

export async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* the cookie is gone either way */
  }
  location.replace('/login');
}

// ---------- change password ----------

/** The forced first-sign-in change happens on /change-password; this is the voluntary path. */
export function openPasswordDialog() {
  const dialog = $('#password-dialog');
  const form = $('#password-form');
  form.reset();
  $('#password-error').hidden = true;
  openDialog(dialog);
  form.elements.currentPassword.focus();
}

export function initAuthUi() {
  const dialog = $('#password-dialog');
  const form = $('#password-form');
  const errorNode = $('#password-error');

  $('#password-cancel').addEventListener('click', () => closeDialog(dialog));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const newPassword = String(data.get('newPassword'));
    if (newPassword !== String(data.get('confirmPassword'))) {
      errorNode.textContent = 'The two new passwords do not match.';
      errorNode.hidden = false;
      return;
    }
    const submit = $('#password-submit');
    submit.disabled = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: String(data.get('currentPassword')), newPassword } });
      closeDialog(dialog);
      toast('Password changed — your other sessions were signed out');
      await loadMe();
      emit('refresh');
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  // Scoped to clicks outside the menu: a blanket pointerdown handler would tear the menu down
  // before the click on one of its own items had a chance to land.
  document.addEventListener('pointerdown', (event) => {
    if (!$('#user-menu')?.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  window.addEventListener('hashchange', closeMenu);
}
