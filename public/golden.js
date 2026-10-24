// A project's golden questions: the questions its documentation must keep answering (FR-347).
//
// Each question names the file (and optionally the heading) that is the right answer. The set is stored
// per project and read by the evaluation (`npm run eval -- --project <name>`), which asks every question
// of the live index through the same search path an agent uses. The server has no route that runs the
// evaluation (it is a command-line tool that reads DATABASE_URL), so the panel keeps the questions and
// hands over the command; it never scores anything itself.
//
// Reading is for anybody who can see the project; adding, editing and deleting is an editor's.

import { $, api, closeDialog, copyText, el, emit, fmt, openDialog, state, toast } from './core.js';
import { canEdit } from './auth.js';

/** The server's own limits (src/services/golden-questions.ts), checked here so a form says so before a round trip. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_KEY = 100;
export const MAX_TEXT = 4000;
export const MAX_PATH = 1024;
export const MAX_TAGS = 32;
export const MAX_TAG = 64;
export const MAX_QUESTIONS = 1000;
/** How many questions are drawn before "Show more": a set can hold a thousand and #detail is rebuilt every poll. */
export const PAGE = 25;

// ---------- pure helpers (tested without a DOM) ----------

/** Tags as typed: comma or line separated, trimmed, empties dropped, repeats folded. */
export function parseTags(text) {
  const seen = new Set();
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * The form's values as the API takes them: an empty heading or note is `null` (clear it), the query is
 * trimmed the way the server trims it, and tags are split out of one field.
 */
export function normalizeForm(values) {
  const heading = String(values.expectHeading ?? '').trim();
  const note = String(values.note ?? '').trim();
  return {
    key: String(values.key ?? '').trim(),
    lang: values.lang === 'tr' ? 'tr' : 'en',
    query: String(values.query ?? '').trim(),
    expectFile: String(values.expectFile ?? '').trim(),
    expectHeading: heading === '' ? null : heading,
    tags: parseTags(values.tags),
    note: note === '' ? null : note,
  };
}

/** The first thing wrong with a question, as a sentence; null when the server will accept it. */
export function validateQuestion(question, { creating }) {
  if (creating) {
    if (!question.key) return 'Give the question a key.';
    if (question.key.length > MAX_KEY) return `The key is at most ${MAX_KEY} characters.`;
    if (!KEY_PATTERN.test(question.key)) return 'The key uses lowercase letters, digits and hyphens, and starts with a letter or digit.';
  }
  if (!question.query) return 'Write the question an agent would ask.';
  if (question.query.length > MAX_TEXT) return `The question is at most ${fmt(MAX_TEXT)} characters.`;
  if (!question.expectFile) return 'Name the file that holds the right answer.';
  if (question.expectFile.length > MAX_PATH) return `The file path is at most ${fmt(MAX_PATH)} characters.`;
  if (question.expectHeading && question.expectHeading.length > MAX_PATH) return `The heading is at most ${fmt(MAX_PATH)} characters.`;
  if (question.tags.length > MAX_TAGS) return `At most ${MAX_TAGS} tags.`;
  if (question.tags.some((tag) => tag.length > MAX_TAG)) return `A tag is at most ${MAX_TAG} characters.`;
  if (question.note && question.note.length > MAX_TEXT) return `The note is at most ${fmt(MAX_TEXT)} characters.`;
  return null;
}

/**
 * The PATCH body for an edit: only the fields that differ from the stored question, so saving cannot
 * overwrite a field somebody else changed meanwhile. `key` is never sent; it is the name a miss list cites.
 */
export function questionPatch(stored, typed) {
  const patch = {};
  if (typed.lang !== stored.lang) patch.lang = typed.lang;
  if (typed.query !== stored.query) patch.query = typed.query;
  if (typed.expectFile !== stored.expectFile) patch.expectFile = typed.expectFile;
  if (typed.expectHeading !== (stored.expectHeading ?? null)) patch.expectHeading = typed.expectHeading;
  if (typed.tags.join('\n') !== (stored.tags ?? []).join('\n')) patch.tags = typed.tags;
  if (typed.note !== (stored.note ?? null)) patch.note = typed.note;
  return patch;
}

/** The body of a create: every field, the optional ones only when there is something to say. */
export function questionCreateBody(typed) {
  const body = { key: typed.key, lang: typed.lang, query: typed.query, expectFile: typed.expectFile, tags: typed.tags };
  if (typed.expectHeading) body.expectHeading = typed.expectHeading;
  if (typed.note) body.note = typed.note;
  return body;
}

/** A project name as one shell word: bare when it is plain, single-quoted otherwise. */
function shellWord(text) {
  return /^[\w.@%+=:,/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** The command that runs the stored set against the live index. */
export function evalCommand(projectName) {
  return `npm run eval -- --project ${shellWord(projectName)}`;
}

// ---------- loading ----------

/**
 * The set is read when a project is selected and after each change the panel makes; the poll leaves it
 * alone (somebody else's edit shows on Refresh), because a set can be a thousand rows long.
 */
export async function loadGolden(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  const g = state.golden;
  if (!project) {
    g.projectId = null;
    g.questions = [];
    g.status = 'idle';
    return;
  }
  if (!force && g.projectId === project.id && g.status !== 'idle') return;
  if (g.projectId !== project.id) {
    g.questions = [];
    g.shown = PAGE;
    g.confirmDelete = null;
  }
  g.projectId = project.id;
  g.status = 'loading';
  try {
    const { questions } = await api(`/api/projects/${project.id}/golden-questions`);
    if (state.selectedId !== project.id) return; // selection moved on meanwhile
    g.questions = questions;
    g.status = 'done';
    g.error = '';
  } catch (err) {
    if (state.selectedId !== project.id) return;
    g.status = 'error';
    g.error = err.message;
  }
  emit('render');
}

// ---------- panel ----------

function questionRow(project, q, mayEdit) {
  const g = state.golden;
  const confirming = g.confirmDelete === q.id;
  return el('li', { class: 'golden-item' }, [
    el('div', { class: 'golden-head' }, [
      el('code', { class: 'golden-key', text: q.key }),
      el('span', {
        class: 'pill small queued',
        text: q.lang === 'tr' ? 'Turkish' : 'English',
        title: `The question is written in ${q.lang === 'tr' ? 'Turkish' : 'English'}`,
      }),
      ...q.tags.map((tag) => el('span', { class: 'golden-tag', text: tag })),
    ]),
    el('p', { class: 'golden-query', text: q.query }),
    el(
      'p',
      { class: 'golden-expect' },
      ['Expects ', el('code', { text: q.expectFile }), q.expectHeading ? [' under ', el('code', { text: q.expectHeading })] : null].flat(),
    ),
    q.note ? el('p', { class: 'field-hint', text: q.note }) : null,
    mayEdit
      ? el('div', { class: 'source-actions' }, [
          el('button', {
            type: 'button',
            class: 'ghost small',
            text: 'Edit',
            'aria-label': `Edit the question ${q.key}`,
            onclick: () => openGoldenDialog(project, q),
          }),
          el('button', {
            type: 'button',
            class: `danger small${confirming ? ' confirm' : ''}`,
            text: confirming ? 'Confirm' : 'Delete',
            'aria-label': confirming ? `Confirm deleting the question ${q.key}` : `Delete the question ${q.key}`,
            onclick: () => (confirming ? void removeQuestion(project, q) : askDelete(q)),
          }),
          confirming ? el('button', { type: 'button', class: 'ghost small', text: 'Keep', onclick: () => askDelete(null) }) : null,
        ])
      : null,
  ]);
}

function askDelete(q) {
  state.golden.confirmDelete = q ? q.id : null;
  emit('render');
}

async function removeQuestion(project, q) {
  const g = state.golden;
  g.confirmDelete = null;
  try {
    await api(`/api/projects/${project.id}/golden-questions/${q.id}`, { method: 'DELETE' });
    toast(`Deleted ${q.key}`);
  } catch (err) {
    toast(err.message);
  }
  await loadGolden(true);
}

function evalHint(project) {
  const command = evalCommand(project.name);
  return el('div', { class: 'golden-eval' }, [
    el('p', {
      class: 'field-hint',
      text: 'The evaluation asks every question of the live index and reports recall. It is run from a shell that can reach the database; the panel does not run it. Export JSONL gives the same set as a file, for --golden.',
    }),
    el('div', { class: 'golden-command' }, [
      el('code', { text: command }),
      el('button', {
        type: 'button',
        class: 'ghost small',
        text: 'Copy',
        'aria-label': 'Copy the evaluation command',
        onclick: () => void copyText(command),
      }),
    ]),
  ]);
}

export function renderGolden(project) {
  const g = state.golden;
  const mine = g.projectId === project.id;
  const mayEdit = canEdit(project);
  const questions = mine ? g.questions : [];
  const full = questions.length >= MAX_QUESTIONS;
  const shown = questions.slice(0, g.shown);

  let body;
  if (!mine || g.status === 'idle' || (g.status === 'loading' && questions.length === 0)) {
    body = el('p', { class: 'hint', text: 'Reading the questions…' });
  } else if (g.status === 'error' && questions.length === 0) {
    body = el('p', { class: 'form-error', role: 'alert' }, [
      `Could not read the golden questions: ${g.error} `,
      el('button', { type: 'button', class: 'ghost small', text: 'Retry', onclick: () => void loadGolden(true) }),
    ]);
  } else if (questions.length === 0) {
    body = el('p', {
      class: 'hint',
      text: mayEdit
        ? 'No questions yet. Add the questions this documentation must keep answering, each with the file that answers it.'
        : 'No questions yet. Somebody with edit access can add them.',
    });
  } else {
    body = el('div', {}, [
      el(
        'ul',
        { class: 'golden-list' },
        shown.map((q) => questionRow(project, q, mayEdit)),
      ),
      questions.length > shown.length
        ? el('button', {
            type: 'button',
            class: 'ghost small',
            text: `Show ${Math.min(PAGE, questions.length - shown.length)} more (${fmt(questions.length - shown.length)} hidden)`,
            onclick: () => {
              g.shown += PAGE;
              emit('render');
            },
          })
        : null,
    ]);
  }

  return el('section', { class: 'panel', id: 'golden-panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Golden questions' }),
        el('p', {
          text: `The questions this project's documentation must keep answering, each with the file that is the right answer.${questions.length ? ` ${fmt(questions.length)} stored.` : ''}`,
        }),
      ]),
      el('div', { class: 'source-actions' }, [
        el('button', { type: 'button', class: 'ghost small', text: 'Refresh', onclick: () => void loadGolden(true) }),
        questions.length
          ? el('a', {
              class: 'btn ghost small',
              href: `/api/projects/${project.id}/golden-questions/export`,
              download: 'golden.jsonl',
              text: 'Export JSONL',
            })
          : null,
        mayEdit
          ? el('button', {
              type: 'button',
              class: 'ghost small',
              text: 'Add question',
              disabled: full,
              title: full ? `A project holds at most ${fmt(MAX_QUESTIONS)} questions` : null,
              onclick: () => openGoldenDialog(project, null),
            })
          : null,
      ]),
    ]),
    body,
    evalHint(project),
  ]);
}

// ---------- dialog ----------

let dialogProject = null;
let dialogStored = null;

function openGoldenDialog(project, stored) {
  dialogProject = project;
  dialogStored = stored;
  const form = $('#golden-form');
  form.reset();
  $('#golden-error').hidden = true;
  $('#golden-title').textContent = stored ? `Edit ${stored.key}` : 'Add a golden question';
  $('#golden-submit').textContent = stored ? 'Save changes' : 'Add question';
  const e = form.elements;
  e.key.value = stored?.key ?? '';
  e.key.readOnly = Boolean(stored);
  $('#golden-key-hint').textContent = stored
    ? 'The key names the question in a miss list, so it cannot be changed.'
    : 'Lowercase letters, digits and hyphens. Cannot be changed later.';
  e.lang.value = stored?.lang ?? 'en';
  e.query.value = stored?.query ?? '';
  e.expectFile.value = stored?.expectFile ?? '';
  e.expectHeading.value = stored?.expectHeading ?? '';
  e.tags.value = (stored?.tags ?? []).join(', ');
  e.note.value = stored?.note ?? '';
  openDialog($('#golden-dialog'));
  (stored ? e.query : e.key).focus();
}

export function initGoldenUi() {
  const dialog = $('#golden-dialog');
  const form = $('#golden-form');
  const errorNode = $('#golden-error');
  $('#golden-cancel').addEventListener('click', () => closeDialog(dialog));

  const fail = (message) => {
    errorNode.textContent = message;
    errorNode.hidden = false;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    const typed = normalizeForm(Object.fromEntries(new FormData(form)));
    if (dialogStored) typed.key = dialogStored.key;
    const problem = validateQuestion(typed, { creating: !dialogStored });
    if (problem) return fail(problem);

    const base = `/api/projects/${dialogProject.id}/golden-questions`;
    let request;
    if (dialogStored) {
      const patch = questionPatch(dialogStored, typed);
      if (Object.keys(patch).length === 0) {
        closeDialog(dialog);
        return;
      }
      request = () => api(`${base}/${dialogStored.id}`, { method: 'PATCH', body: patch });
    } else {
      request = () => api(base, { method: 'POST', body: questionCreateBody(typed) });
    }
    const submit = $('#golden-submit');
    submit.disabled = true;
    try {
      await request();
      closeDialog(dialog);
      toast(dialogStored ? `Saved ${typed.key}` : `Added ${typed.key}`);
      await loadGolden(true);
    } catch (err) {
      fail(err.message);
    } finally {
      submit.disabled = false;
    }
  });
}
