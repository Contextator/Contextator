// What a project may hold, and how much of it it holds (ADR-0117).
//
// Three limits, each either the project's own or the instance's default it inherits: documents,
// chunks and the bytes its uploads keep on disk. `0` is "unlimited", `null` (on the way in) is
// "inherit". The panel shows the figures the server computed; it never counts anything itself, so an
// operator reads the same number the upload that gets refused was measured against.
//
// Reading is for anybody who can see the project. Changing a limit is an administrator's call, because
// a project's quota is the instance owner's lever over a project's owner: the route answers 403 for
// anyone else, and the button is not offered to them.

import { $, ApiError, api, closeDialog, el, emit, formatBytes, fmt, openDialog, state, toast } from './core.js';
import { isAdmin } from './auth.js';

/** The three quotas in the order they are shown; `field` is the key the PATCH route takes. */
const QUOTAS = [
  { key: 'documents', field: 'maxDocuments', label: 'Documents', unit: 'documents', bytes: false },
  { key: 'chunks', field: 'maxChunks', label: 'Chunks', unit: 'chunks', bytes: false },
  { key: 'uploadBytes', field: 'maxUploadBytes', label: 'Upload storage', unit: 'of uploads', bytes: true },
];

/** Binary multiples the byte quota can be typed in, largest first so the exact fit is found first. */
const BYTE_UNITS = [
  { name: 'GiB', size: 1024 ** 3 },
  { name: 'MiB', size: 1024 ** 2 },
  { name: 'KiB', size: 1024 },
  { name: 'bytes', size: 1 },
];

// ---------- pure helpers (tested without a DOM) ----------

/** A byte count as the largest unit that divides it exactly, so the field never shows a rounded figure. */
export function splitBytes(total) {
  if (!Number.isFinite(total) || total <= 0) return { value: 0, unit: 'MiB' };
  const unit = BYTE_UNITS.find((u) => total % u.size === 0) ?? BYTE_UNITS[BYTE_UNITS.length - 1];
  return { value: total / unit.size, unit: unit.name };
}

export function joinBytes(value, unitName) {
  const unit = BYTE_UNITS.find((u) => u.name === unitName) ?? BYTE_UNITS[BYTE_UNITS.length - 1];
  return value * unit.size;
}

/**
 * One limit field as typed. Empty means "inherit the instance's default" (null on the wire), `0` means
 * unlimited, and anything else has to be a whole number: the server refuses fractions and negatives,
 * and saying so here saves the round trip.
 */
export function parseLimitField(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: 'Use a whole number, 0 for unlimited, or leave it empty to inherit.' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'That number is too large.' };
  return { ok: true, value };
}

/** `used / limit` as words: "1,204 of 5,000", "1,204 · no limit". */
export function quotaFigures(q, bytes) {
  const show = (n) => (bytes ? formatBytes(n) : fmt(n));
  const used = q.used == null ? 'unknown' : show(q.used);
  return q.limit > 0 ? `${used} of ${show(q.limit)}` : `${used} · no limit`;
}

/** How full the quota is, 0..1, or null when there is nothing to measure against. */
export function quotaFill(q) {
  if (!(q.limit > 0) || q.used == null) return null;
  return Math.min(1, q.used / q.limit);
}

/**
 * An API error as a sentence for a person. The upload route's refusals carry numbers as fields
 * (`limit`, `used`, `requested`), so a quota refusal is worded with byte units where the quota is
 * bytes; any other error keeps the message the server wrote.
 */
export function describeApiError(err) {
  if (!(err instanceof ApiError)) return err?.message ?? String(err);
  const body = err.body ?? {};
  if (err.status === 413 && body.error === 'quota_exceeded') {
    const meta = {
      max_documents: { noun: 'documents', bytes: false },
      max_chunks: { noun: 'chunks', bytes: false },
      max_upload_bytes: { noun: 'of uploads', bytes: true },
    }[body.quota];
    if (meta && [body.limit, body.used, body.requested].every(Number.isFinite)) {
      const show = (n) => (meta.bytes ? formatBytes(n) : fmt(n));
      return (
        `Upload refused: this project is limited to ${show(body.limit)} ${meta.noun}, holds ${show(body.used)} and this upload would add ${show(body.requested)}. ` +
        'Ask an instance administrator to raise the limit, or remove content first.'
      );
    }
  }
  if (err.status === 503 && body.error === 'quota_usage_unavailable') {
    return 'Upload not checked: the storage this project uses could not be measured right now, so its quota cannot be verified. Try again shortly.';
  }
  return err.message;
}

// ---------- loading ----------

/**
 * The quotas ride on the project's own detail route, not on the list, so this is its own request.
 * It refetches when the selection or the project's counts move (an index run changes both usage
 * figures) and otherwise stays quiet: the poll runs every couple of seconds.
 */
export async function loadQuotas(force = false) {
  const project = state.projects.find((p) => p.id === state.selectedId);
  const q = state.quotas;
  if (!project) {
    q.projectId = null;
    q.data = null;
    q.loadedKey = null;
    return;
  }
  const key = `${project.id}|${project.documentCount}|${project.chunkCount}`;
  if (!force && q.loadedKey === key) return;
  if (q.projectId !== project.id) q.data = null;
  q.projectId = project.id;
  q.loadedKey = key;
  q.status = 'loading';
  try {
    const detail = await api(`/api/projects/${project.id}`);
    if (state.selectedId !== project.id) return; // selection moved on meanwhile
    q.data = detail.quotas ?? null;
    q.status = 'done';
    q.error = '';
  } catch (err) {
    if (state.selectedId !== project.id) return;
    q.status = 'error';
    q.error = err.message;
  }
  emit('render');
}

// ---------- panel ----------

function quotaRow(def, q) {
  const fill = quotaFill(q);
  const text = quotaFigures(q, def.bytes);
  const state_ = fill == null ? '' : fill >= 1 ? ' full' : fill >= 0.9 ? ' near' : '';
  return el('div', { class: 'quota-row' }, [
    el('span', { class: 'quota-label', text: def.label }),
    el('span', { class: 'quota-figures', text }),
    fill == null
      ? el('span', { class: 'quota-meter none', 'aria-hidden': 'true' })
      : el(
          'span',
          {
            class: `quota-meter${state_}`,
            role: 'meter',
            'aria-label': `${def.label} used`,
            'aria-valuemin': '0',
            'aria-valuemax': String(q.limit),
            'aria-valuenow': String(q.used),
            'aria-valuetext': text,
          },
          [el('span', { class: 'quota-meter-fill', style: `width:${Math.round(fill * 100)}%` })],
        ),
    el('span', {
      class: `pill small ${q.inherited ? 'idle' : 'queued'}`,
      text: q.inherited ? 'instance default' : 'set for this project',
      title: q.inherited
        ? "Follows the instance's default; changing the default changes this limit."
        : "This project's own limit; it does not follow the instance default.",
    }),
  ]);
}

export function renderQuotas(project) {
  const q = state.quotas;
  const data = q.projectId === project.id ? q.data : null;
  const body =
    data == null
      ? el('p', { class: q.status === 'error' ? 'form-error' : 'hint', role: q.status === 'error' ? 'alert' : null }, [
          q.status === 'error' ? `Could not read the quotas: ${q.error} ` : 'Reading quotas… ',
          q.status === 'error' ? el('button', { type: 'button', class: 'ghost small', text: 'Retry', onclick: () => void loadQuotas(true) }) : null,
        ])
      : el(
          'div',
          { class: 'quota-list' },
          QUOTAS.map((def) => quotaRow(def, data[def.key])),
        );

  return el('section', { class: 'panel', id: 'quotas-panel' }, [
    el('div', { class: 'sources-head' }, [
      el('div', {}, [
        el('h3', { text: 'Quotas' }),
        el('p', {
          text: 'What this project may hold. An upload or an index run that would go over a limit is refused with a message that says which one. 0 means no limit.',
        }),
      ]),
      el('div', { class: 'source-actions' }, [
        el('button', { type: 'button', class: 'ghost small', text: 'Refresh', onclick: () => void loadQuotas(true) }),
        isAdmin() && data
          ? el('button', { type: 'button', class: 'ghost small', text: 'Edit limits', onclick: () => openQuotaDialog(project, data) })
          : null,
      ]),
    ]),
    body,
    data && data.uploadBytes.used == null
      ? el('p', { class: 'field-hint', text: 'The upload storage could not be measured just now; uploads are refused until it can be.' })
      : null,
  ]);
}

// ---------- dialog ----------

let dialogProject = null;
let dialogInitial = null;

function openQuotaDialog(project, data) {
  dialogProject = project;
  dialogInitial = {};
  const form = $('#quota-form');
  form.reset();
  $('#quota-error').hidden = true;
  for (const def of QUOTAS) {
    const current = data[def.key];
    // An inherited limit starts empty, so saving without touching it keeps inheriting.
    const own = current.inherited ? null : current.limit;
    dialogInitial[def.key] = own;
    if (def.bytes) {
      const parts = own == null ? { value: '', unit: 'MiB' } : splitBytes(own);
      form.elements[def.key].value = own == null ? '' : String(parts.value);
      form.elements.uploadBytesUnit.value = parts.unit;
    } else {
      form.elements[def.key].value = own == null ? '' : String(own);
    }
    const hint = $(`#quota-${def.key}-now`);
    hint.textContent = `Now: ${quotaFigures(current, def.bytes)}${current.inherited ? ' (instance default)' : ''}.`;
  }
  openDialog($('#quota-dialog'));
  form.elements.documents.focus();
}

/**
 * Only the limits that changed go on the wire: an absent key is left alone by the route, so saving one
 * field cannot overwrite a limit somebody else changed in the meantime.
 */
export function quotaPatch(initial, typed) {
  const patch = {};
  for (const def of QUOTAS) {
    if (typed[def.key] !== initial[def.key]) patch[def.field] = typed[def.key];
  }
  return patch;
}

export function initQuotasUi() {
  const dialog = $('#quota-dialog');
  const form = $('#quota-form');
  const errorNode = $('#quota-error');
  $('#quota-cancel').addEventListener('click', () => closeDialog(dialog));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    const typed = {};
    for (const def of QUOTAS) {
      const parsed = parseLimitField(form.elements[def.key].value);
      if (!parsed.ok) {
        errorNode.textContent = `${def.label}: ${parsed.message}`;
        errorNode.hidden = false;
        form.elements[def.key].focus();
        return;
      }
      typed[def.key] = def.bytes && parsed.value != null ? joinBytes(parsed.value, form.elements.uploadBytesUnit.value) : parsed.value;
    }
    const patch = quotaPatch(dialogInitial, typed);
    if (Object.keys(patch).length === 0) {
      closeDialog(dialog);
      return;
    }
    const submit = $('#quota-submit');
    submit.disabled = true;
    try {
      const { quotas } = await api(`/api/projects/${dialogProject.id}/quotas`, { method: 'PATCH', body: patch });
      state.quotas.data = quotas;
      state.quotas.projectId = dialogProject.id;
      state.quotas.status = 'done';
      closeDialog(dialog);
      toast(`Saved the quotas of ${dialogProject.name}`);
      await loadQuotas(true); // the PATCH answer carries limits; re-read so usage is as fresh as the limits
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
