// The account list at #/~users — who exists, what they may do, and how to reset them.
// Only root and admin reach it; the server refuses /api/users to anyone else.

import { $, api, ApiError, closeDialog, copyText, el, emit, fmt, icon, initials, openDialog, relativeTime, state, toast } from './core.js';
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
  wrap.append(
    el('section', { class: 'panel' }, [
      el(
        'div',
        { class: 'panel-body' },
        users.map((u) => userRow(u, activeRoots)),
      ),
    ]),
  );
  const groups = renderGroupMappings();
  if (groups) wrap.append(groups);
  return wrap;
}

// ---------- SSO group mappings (ADR-0134) ----------

// Kept here rather than in `state`: only this view reads it, and it is reloaded after every change. A failed
// load is not retried until the next window, or the render that follows it would ask again at once.
const mappingsState = { list: [], loading: false, failed: false, at: 0, confirming: null, timer: null };
const MAPPINGS_STALE_MS = 15_000;

function loadMappings() {
  if (mappingsState.loading) return;
  mappingsState.loading = true;
  api('/api/oidc/group-mappings')
    .then((body) => {
      mappingsState.list = body.mappings;
      mappingsState.failed = false;
    })
    .catch((err) => {
      mappingsState.failed = true;
      if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
    })
    .finally(() => {
      mappingsState.loading = false;
      mappingsState.at = Date.now();
      if (state.view === 'users') emit('render');
    });
}

function renderGroupMappings() {
  const oidc = state.me?.oidc;
  // Mappings can be prepared before the claim is switched on; with no SSO at all and none stored there is nothing to show.
  if (!oidc?.enabled && mappingsState.list.length === 0 && !mappingsState.loading && mappingsState.at !== 0) return null;
  if (!mappingsState.loading && Date.now() - mappingsState.at > MAPPINGS_STALE_MS) loadMappings();

  const rows = mappingsState.list.map((m) =>
    el('div', { class: 'user-row member-row' }, [
      el('span', { class: 'user-glyph member', 'aria-hidden': 'true', text: initials(m.group) }),
      el('span', { class: 'source-cell' }, [el('code', { text: m.group }), el('span', { class: 'sub', text: `→ ${m.projectName}` })]),
      el('span', { class: `pill small ${m.role}`, text: m.role }),
      el('span', { class: 'sub', text: relativeTime(m.createdAt), title: m.createdAt ? new Date(m.createdAt).toLocaleString() : '' }),
      el('span', { class: 'source-actions' }, [
        el('button', {
          type: 'button',
          class: `danger small${mappingsState.confirming === m.id ? ' confirm' : ''}`,
          text: mappingsState.confirming === m.id ? 'Confirm' : 'Delete',
          title: 'Updates or removes, now, the memberships this mapping granted to people already signed in',
          onclick: () => (mappingsState.confirming === m.id ? deleteMapping(m) : askDeleteMapping(m)),
        }),
      ]),
    ]),
  );

  return el('section', { class: 'panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'SSO group mappings' }),
        el('p', {
          text: 'A person who signs in through single sign-on gets a membership in each project their provider groups map to, and loses it at the next sign-in once they leave the group. Memberships added by hand are never changed by a group; where two groups map the same project, the higher role applies.',
        }),
      ]),
      el('button', { type: 'button', class: 'ghost small', text: 'Add mapping', onclick: openMappingDialog }),
    ]),
    oidc?.groups
      ? null
      : el('p', {
          class: 'members-note',
          text: 'Group mapping is off: mappings are stored but no sign-in applies them until OIDC_GROUPS_CLAIM names the claim that carries the groups.',
        }),
    rows.length
      ? el('div', {}, rows)
      : el('p', { class: 'sources-empty', text: mappingsState.failed ? 'The mappings could not be loaded.' : 'No mappings yet.' }),
  ]);
}

function askDeleteMapping(m) {
  mappingsState.confirming = m.id;
  emit('render');
  clearTimeout(mappingsState.timer);
  mappingsState.timer = setTimeout(() => {
    if (mappingsState.confirming === m.id) {
      mappingsState.confirming = null;
      emit('render');
    }
  }, 6000);
}

async function deleteMapping(m) {
  mappingsState.confirming = null;
  try {
    await api(`/api/oidc/group-mappings/${m.id}`, { method: 'DELETE' });
    toast('Mapping deleted');
  } catch (err) {
    toast(err.message);
  }
  loadMappings();
  emit('refresh');
}

// The dialog is built once and kept in <body>, outside #detail: the poll rebuilds #detail wholesale, which
// would throw away a group name that is half typed.
let mappingDialog = null;

function mappingDialogNode() {
  if (mappingDialog) return mappingDialog;
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const group = el('input', { name: 'group', type: 'text', maxlength: '256', required: true, autocomplete: 'off', spellcheck: 'false' });
  const project = el('select', { name: 'projectId' });
  const submit = el('button', { type: 'submit', class: 'primary', text: 'Add mapping' });
  const cancel = el('button', { type: 'button', class: 'ghost', text: 'Cancel' });
  const form = el('form', { method: 'dialog', novalidate: true }, [
    el('div', { class: 'dialog-head' }, [
      el('h2', { text: 'Add group mapping' }),
      el('p', {
        class: 'muted',
        text: 'Give everyone in a provider group access to a project. The group name is matched exactly, capitals included.',
      }),
    ]),
    el('div', { class: 'dialog-body' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Group name' }), group]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Project' }), project]),
      el('div', { class: 'radio-row' }, [
        el('label', {}, [el('input', { type: 'radio', name: 'role', value: 'viewer', checked: true }), ' Viewer — reads the project']),
        el('label', {}, [el('input', { type: 'radio', name: 'role', value: 'editor' }), ' Editor — adds sources, uploads, re-indexes']),
      ]),
      error,
    ]),
    el('div', { class: 'dialog-foot' }, [cancel, submit]),
  ]);
  mappingDialog = el('dialog', { class: 'dialog' }, [form]);
  document.body.append(mappingDialog);

  cancel.addEventListener('click', () => closeDialog(mappingDialog));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const data = new FormData(form);
    const name = String(data.get('group'));
    if (name.trim() === '' || !data.get('projectId')) {
      error.textContent = 'Name a group and pick a project.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await api('/api/oidc/group-mappings', {
        method: 'POST',
        body: { group: name, projectId: String(data.get('projectId')), role: String(data.get('role')) },
      });
      closeDialog(mappingDialog);
      toast('Mapping added');
      loadMappings();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return mappingDialog;
}

function openMappingDialog() {
  const dialog = mappingDialogNode();
  const form = dialog.querySelector('form');
  form.reset();
  dialog.querySelector('.form-error').hidden = true;
  dialog.querySelector('select[name="projectId"]').replaceChildren(...state.projects.map((p) => el('option', { value: p.id, text: p.name })));
  openDialog(dialog);
  form.elements.group.focus();
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
    el('span', {
      class: `sub${u.isActive ? '' : ' err'}`,
      text: !u.isActive ? 'disabled' : u.mustChangePassword ? 'password change pending' : 'active',
    }),
    el('span', { class: 'sub', text: u.role === 'member' ? `${fmt(u.projectCount)} project${u.projectCount === 1 ? '' : 's'}` : 'all projects' }),
    el('span', {
      class: 'sub',
      text: relativeTime(u.lastLoginAt),
      title: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never signed in',
    }),
    el('span', { class: 'source-actions' }, [
      el('button', {
        type: 'button',
        class: 'ghost small',
        disabled: untouchable || undefined,
        title: untouchable ? lockWhy : undefined,
        text: 'Edit',
        onclick: () => openUserDialog(u),
      }),
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
