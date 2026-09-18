// The account list at #/~users — who exists, what they may do, and how to reset them.
// Only root and admin reach it; the server refuses /api/users to anyone else.

import { $, api, closeDialog, copyText, el, emit, fmt, icon, initials, openDialog, relativeTime, state, toast } from './core.js';
import { isRoot } from './auth.js';

const ROLE_HINT = {
  root: 'Everything, including user management. The last root account cannot be removed.',
  admin: 'Every project, plus user management — but cannot touch a root account.',
  member: 'Only the projects they are added to, as a viewer or an editor.',
};

export function renderUsersView() {
  const users = state.users;
  const wrap = el('div', {});

  wrap.append(
    el('a', { class: 'back-link', href: '#/', text: '← Projects' }),
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-title' }, [
        el('div', { class: 'title-row' }, [
          el('h1', { text: 'Users' }),
          el('span', { class: 'pill idle', text: `${fmt(users.length)} account${users.length === 1 ? '' : 's'}` }),
        ]),
        el('p', {
          class: 'users-lead',
          text: 'root and admin reach every project. A member reaches only the ones it is added to, as a viewer that reads or an editor that adds sources, uploads files and re-indexes.',
        }),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', { type: 'button', class: 'primary', onclick: () => openUserDialog(null) }, [icon('plus'), 'New user']),
      ]),
    ]),
  );

  if (!state.usersLoaded) {
    wrap.append(el('p', { class: 'users-empty', text: 'Loading accounts…' }));
    return wrap;
  }

  const activeRoots = users.filter((u) => u.role === 'root' && u.isActive).length;
  wrap.append(el('section', { class: 'panel' }, [el('div', { class: 'panel-body' }, users.map((u) => userRow(u, activeRoots)))]));
  return wrap;
}

function userRow(u, activeRoots) {
  const isSelf = u.id === state.me?.id;
  const lastRoot = u.role === 'root' && u.isActive && activeRoots === 1;
  // An admin may look at a root account but never change one; the server says the same.
  const untouchable = u.role === 'root' && !isRoot();
  const locked = lastRoot || isSelf || untouchable;
  const lockWhy = lastRoot
    ? 'The last active root account cannot be removed, demoted or disabled'
    : isSelf
      ? 'You cannot change your own role or disable yourself'
      : untouchable
        ? 'Only a root account can change another root account'
        : undefined;
  const confirming = state.confirmDeleteUser === u.id;

  return el('div', { class: 'user-row' }, [
    el('span', { class: `user-glyph ${u.role}`, 'aria-hidden': 'true', text: initials(u.displayName || u.username) }),
    el('span', { class: 'source-cell' }, [
      el('code', { text: u.username }),
      el('span', { class: 'sub', text: u.displayName || u.email || '—', title: u.email || '' }),
    ]),
    el('span', { class: 'user-role' }, [
      el('span', { class: `pill small ${u.role}`, text: u.role, title: ROLE_HINT[u.role] }),
      isSelf ? el('span', { class: 'pill small you', text: 'you' }) : null,
    ]),
    el('span', { class: `sub${u.isActive ? '' : ' err'}`, text: !u.isActive ? 'disabled' : u.mustChangePassword ? 'password change pending' : 'active' }),
    el('span', { class: 'sub', text: u.role === 'member' ? `${fmt(u.projectCount)} project${u.projectCount === 1 ? '' : 's'}` : 'all projects' }),
    el('span', {
      class: 'sub',
      text: relativeTime(u.lastLoginAt),
      title: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never signed in',
    }),
    el('span', { class: 'source-actions' }, [
      el('button', { type: 'button', class: 'ghost small', disabled: untouchable || undefined, title: untouchable ? lockWhy : undefined, text: 'Edit', onclick: () => openUserDialog(u) }),
      el('button', {
        type: 'button',
        class: 'ghost small',
        disabled: untouchable || undefined,
        title: untouchable ? lockWhy : 'Hand out a new temporary password',
        text: 'Reset password',
        onclick: () => resetPassword(u),
      }),
      el('button', {
        type: 'button',
        class: 'ghost small',
        disabled: locked || undefined,
        title: lockWhy,
        text: u.isActive ? 'Disable' : 'Enable',
        onclick: () => setActive(u, !u.isActive),
      }),
      el('button', {
        type: 'button',
        class: `danger small${confirming ? ' confirm' : ''}`,
        disabled: locked || undefined,
        title: lockWhy,
        text: confirming ? 'Confirm' : 'Delete',
        onclick: () => (confirming ? removeUser(u) : askDeleteUser(u)),
      }),
    ]),
  ]);
}

// ---------- actions ----------

function askDeleteUser(u) {
  state.confirmDeleteUser = u.id;
  emit('render');
  clearTimeout(state.confirmTimer);
  state.confirmTimer = setTimeout(() => {
    if (state.confirmDeleteUser === u.id) {
      state.confirmDeleteUser = null;
      emit('render');
    }
  }, 6000);
}

async function removeUser(u) {
  state.confirmDeleteUser = null;
  try {
    await api(`/api/users/${u.id}`, { method: 'DELETE' });
    toast(`Deleted ${u.username}`);
    emit('refresh');
  } catch (err) {
    toast(err.message);
    emit('render');
  }
}

async function setActive(u, isActive) {
  try {
    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { isActive } });
    toast(isActive ? `${u.username} can sign in again` : `${u.username} is disabled and signed out`);
    emit('refresh');
  } catch (err) {
    toast(err.message);
  }
}

async function resetPassword(u) {
  try {
    const { temporaryPassword } = await api(`/api/users/${u.id}/password`, { method: 'POST', body: {} });
    showTempPassword(u.username, temporaryPassword);
    emit('refresh');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- dialogs ----------

let editing = null;

export function openUserDialog(user) {
  editing = user;
  const dialog = $('#user-dialog');
  const form = $('#user-form');
  form.reset();
  $('#user-error').hidden = true;
  $('#user-dialog-title').textContent = user ? `Edit ${user.username}` : 'New user';
  form.elements.username.disabled = Boolean(user);
  $('#user-password-field').hidden = Boolean(user);
  $('#user-must-change').hidden = Boolean(user);
  $('#user-active-row').hidden = !user;
  $('#user-submit').textContent = user ? 'Save changes' : 'Create user';

  // Only a root account can hand out the root role.
  const roleSelect = form.elements.role;
  roleSelect.replaceChildren(
    ...['member', 'admin', ...(isRoot() ? ['root'] : [])].map((r) => el('option', { value: r, text: r, title: ROLE_HINT[r] })),
  );

  if (user) {
    form.elements.username.value = user.username;
    form.elements.displayName.value = user.displayName || '';
    form.elements.email.value = user.email || '';
    roleSelect.value = user.role;
    form.elements.isActive.checked = user.isActive;
  } else {
    form.elements.mustChangePassword.checked = true;
  }

  openDialog(dialog);
  (user ? form.elements.displayName : form.elements.username).focus();
}

function showTempPassword(username, password) {
  if (!password) return;
  const dialog = $('#temp-password-dialog');
  $('#temp-password-who').textContent = username;
  $('#temp-password-value').textContent = password;
  $('#temp-password-copy').onclick = () => copyText(password);
  openDialog(dialog);
}

export function initUsersUi() {
  const dialog = $('#user-dialog');
  const form = $('#user-form');
  const errorNode = $('#user-error');

  $('#user-cancel').addEventListener('click', () => closeDialog(dialog));
  $('#temp-password-close').addEventListener('click', () => closeDialog($('#temp-password-dialog')));
  $('#user-generate').addEventListener('click', () => {
    form.elements.password.value = randomPassword();
    form.elements.password.type = 'text';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const submit = $('#user-submit');
    submit.disabled = true;
    try {
      if (editing) {
        await api(`/api/users/${editing.id}`, {
          method: 'PATCH',
          body: {
            displayName: String(data.get('displayName')).trim(),
            email: String(data.get('email')).trim() || null,
            role: String(data.get('role')),
            isActive: data.get('isActive') === 'on',
          },
        });
        toast(`Saved ${editing.username}`);
      } else {
        const password = String(data.get('password')).trim();
        const created = await api('/api/users', {
          method: 'POST',
          body: {
            username: String(data.get('username')).trim().toLowerCase(),
            displayName: String(data.get('displayName')).trim(),
            email: String(data.get('email')).trim() || null,
            role: String(data.get('role')),
            ...(password ? { password } : {}),
            mustChangePassword: data.get('mustChangePassword') === 'on',
          },
        });
        toast(`Created ${created.user.username}`);
        closeDialog(dialog);
        showTempPassword(created.user.username, created.temporaryPassword ?? password);
      }
      if (editing) closeDialog(dialog);
      emit('refresh');
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

/** Readable characters only; the person receiving this has to type it once. */
function randomPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return [...bytes].map((n) => alphabet[n % alphabet.length]).join('');
}
