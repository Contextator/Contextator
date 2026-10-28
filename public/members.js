// Who may see and change one project. root and admin reach every project without being listed here;
// this panel is about the member accounts that only reach the projects they are added to.

import { $, api, ApiError, closeDialog, el, emit, openDialog, relativeTime, state, toast } from './core.js';
import { canManageMembers } from './auth.js';
import { ACCOUNT_MODE_NOTE } from './mcp.js';

export async function loadMembers(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  if (!project) {
    state.members = [];
    state.membersFor = null;
    return;
  }
  if (!force && state.membersFor === project.id) return;
  state.membersFor = project.id;
  try {
    const members = await api(`/api/projects/${project.id}/members`);
    if (state.selectedId !== project.id) return; // selection moved on meanwhile
    state.members = members;
    emit('render');
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(err.message);
  }
}

/**
 * The honest caveat under the member list: whether membership reaches the MCP endpoint at all depends on
 * the project's `mcpAuth` mode, so the note follows it. Only `account` ties the endpoint to membership;
 * `token` hangs it on tokens and `open` on nothing.
 */
function mcpAccessNote(project) {
  if (project.mcpAuth === 'account') {
    return el('p', { class: 'members-note ok' }, [
      el('strong', { text: ACCOUNT_MODE_NOTE.lead }),
      ` ${ACCOUNT_MODE_NOTE.body} See MCP access below.`,
    ]);
  }
  if (project.mcpAuth === 'token') {
    return el('p', { class: 'members-note ok' }, [
      el('strong', { text: 'The MCP endpoint is behind a token. ' }),
      'Membership governs the dashboard; ',
      el('code', { text: project.mcpUrl }),
      ' answers only to a client holding one of this project’s tokens — see MCP access below.',
    ]);
  }
  return el('p', { class: 'members-note' }, [
    el('strong', { text: 'Membership governs the dashboard, not the MCP endpoint. ' }),
    'Anyone who can reach ',
    el('code', { text: project.mcpUrl }),
    ' can read this project’s indexed documents, whatever their role here. Require a token under MCP access to change that.',
  ]);
}

export function renderMembers(project) {
  const members = state.membersFor === project.id ? state.members : [];
  const manage = canManageMembers();

  // ADR-0134: a row an SSO group granted is the group's to change while group mapping is on — the next
  // sign-in of that person would put it back — so it is shown with its groups and cannot be edited here.
  const groupsOn = Boolean(state.me?.oidc?.groups);

  const rows = members.map((m) => {
    const fromGroup = m.origin === 'oidc_group';
    const locked = fromGroup && groupsOn;
    const lockWhy = 'Granted by a single sign-on group. Change the group mapping under Users, or disable the account to cut access now.';
    return el('div', { class: 'user-row member-row' }, [
      el('span', { class: 'user-glyph member', 'aria-hidden': 'true', text: (m.displayName || m.username).slice(0, 2).toUpperCase() }),
      el('span', { class: 'source-cell' }, [
        el('code', { text: m.username }),
        el('span', { class: 'sub', text: m.displayName || '—' }),
        fromGroup
          ? el('span', {
              class: 'sub',
              text: `group: ${(m.groups ?? []).join(', ')}${groupsOn ? '' : ' (group mapping is off; editing makes this a manual membership)'}`,
              title: lockWhy,
            })
          : null,
      ]),
      manage
        ? el(
            'select',
            {
              class: 'role-select',
              'aria-label': `Project role of ${m.username}`,
              disabled: locked || undefined,
              title: locked ? lockWhy : undefined,
              onchange: (event) => setMemberRole(project, m, event.target.value, event.target),
            },
            ['viewer', 'editor'].map((r) => el('option', { value: r, selected: m.role === r || undefined, text: r })),
          )
        : el('span', { class: `pill small ${m.role}`, text: m.role }),
      el('span', { class: 'sub', text: relativeTime(m.createdAt), title: m.createdAt ? new Date(m.createdAt).toLocaleString() : '' }),
      el(
        'span',
        { class: 'source-actions' },
        manage
          ? [
              el('button', {
                type: 'button',
                class: 'danger small',
                disabled: locked || undefined,
                title: locked ? lockWhy : undefined,
                text: 'Remove',
                onclick: () => removeMember(project, m),
              }),
            ]
          : [],
      ),
    ]);
  });

  return el('section', { class: 'panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Members' }),
        el('p', {
          text: 'root and admin accounts always have full access. Members listed here see this project only: a viewer reads, an editor adds sources, uploads files and re-indexes.',
        }),
      ]),
      manage ? el('button', { type: 'button', class: 'ghost small', text: 'Add member', onclick: () => void openMemberDialog(project) }) : null,
    ]),
    rows.length
      ? el('div', {}, rows)
      : el('p', { class: 'sources-empty', text: 'No members yet. Only root and admin accounts can see this project.' }),
    mcpAccessNote(project),
  ]);
}

// ---------- actions ----------

async function setMemberRole(project, member, role, select) {
  const previous = member.role;
  member.role = role; // optimistic: the row must not flicker back while the request is in flight
  try {
    await api(`/api/projects/${project.id}/members/${member.userId}`, { method: 'PUT', body: { role } });
    toast(`${member.username} is now ${role} on ${project.name}`);
  } catch (err) {
    member.role = previous;
    select.value = previous;
    toast(err.message);
    // A 409 means the row is group-managed; reload so it shows as locked instead of inviting the same edit.
    if (err instanceof ApiError && err.status === 409) await loadMembers(true);
  }
}

async function removeMember(project, member) {
  try {
    await api(`/api/projects/${project.id}/members/${member.userId}`, { method: 'DELETE' });
    toast(`${member.username} no longer has access to ${project.name}`);
    await loadMembers(true);
  } catch (err) {
    toast(err.message);
    if (err instanceof ApiError && err.status === 409) await loadMembers(true);
  }
}

// ---------- dialog ----------

let dialogProject = null;

export async function openMemberDialog(project) {
  dialogProject = project;
  const dialog = $('#member-dialog');
  const form = $('#member-form');
  form.reset();
  $('#member-error').hidden = true;

  // The account list is only kept warm by the users view; fetch it on demand from a project page.
  if (!state.usersLoaded) {
    try {
      state.users = await api('/api/users');
      state.usersLoaded = true;
    } catch (err) {
      toast(err.message);
      return;
    }
  }

  // Only member accounts are offered: root and admin already reach every project.
  const taken = new Set(state.members.map((m) => m.userId));
  const candidates = state.users.filter((u) => u.role === 'member' && u.isActive && !taken.has(u.id));
  const select = form.elements.userId;
  select.replaceChildren(
    ...candidates.map((u) => el('option', { value: u.id, text: u.displayName ? `${u.username} — ${u.displayName}` : u.username })),
  );

  $('#member-empty').hidden = candidates.length > 0;
  $('#member-picker').hidden = candidates.length === 0;
  $('#member-submit').disabled = candidates.length === 0;

  openDialog(dialog);
}

export function initMembersUi() {
  const dialog = $('#member-dialog');
  const form = $('#member-form');
  const errorNode = $('#member-error');

  $('#member-cancel').addEventListener('click', () => closeDialog(dialog));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    const data = new FormData(form);
    const submit = $('#member-submit');
    submit.disabled = true;
    try {
      await api(`/api/projects/${dialogProject.id}/members/${String(data.get('userId'))}`, {
        method: 'PUT',
        body: { role: String(data.get('role')) },
      });
      closeDialog(dialog);
      toast('Member added');
      await loadMembers(true);
      emit('refresh');
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
