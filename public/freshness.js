// How fresh a source is, from the admin API's `lastSyncedAt` and its schedule (Faz 10, ADR-0119 decision 7).
//
// Freshness lives in the panel and the admin API only; `/metrics` stays unlabeled. A source on a
// schedule is overdue once it has gone twice its interval without a sync (one missed tick is a busy
// server, two is a problem). A manual source has no schedule to be late for, so it is only flagged when
// it has not synced for a month: the point is to notice a mirror nobody is refreshing.

import { el, relativeTime } from './core.js';

const MINUTE = 60_000;
export const MANUAL_STALE_DAYS = 30;

const EVERY = (minutes) => (minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`);

const ageText = (ms) => {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${Math.max(minutes, 0)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
};

/**
 * `{ tone, label, title }` for one source; `tone` is `ok` (on time), `warn` (late or never) or `muted`
 * (manual, nothing to be late for).
 */
export function sourceFreshness(source, now = Date.now()) {
  const interval = source.syncIntervalMinutes ?? null;
  if (!source.lastSyncedAt) {
    return {
      tone: 'warn',
      label: 'never synced',
      title: interval ? `Scheduled every ${EVERY(interval)}, but it has not synced yet` : 'Manual source: it has not been synced yet',
    };
  }
  const age = now - new Date(source.lastSyncedAt).getTime();
  if (interval) {
    const title = `Scheduled every ${EVERY(interval)}; the last sync was ${ageText(age)} ago`;
    return age > interval * 2 * MINUTE ? { tone: 'warn', label: 'overdue', title } : { tone: 'ok', label: 'current', title };
  }
  if (age > MANUAL_STALE_DAYS * 24 * 60 * MINUTE) {
    return { tone: 'warn', label: 'not refreshed', title: `Manual source, last synced ${ageText(age)} ago` };
  }
  return { tone: 'muted', label: 'manual', title: 'Synced when someone asks (at the start of an index run, or with Sync)' };
}

const PILL_CLASS = { ok: 'idle', warn: 'stale', muted: 'queued' };

/** The last-sync cell of a source row: when, and whether that is on time. */
export function renderSourceFreshness(source) {
  const freshness = sourceFreshness(source);
  return el('span', { class: 'source-cell source-fresh' }, [
    el('span', {
      class: 'sub',
      text: relativeTime(source.lastSyncedAt),
      title: source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : 'never synced',
    }),
    el('span', { class: `pill small ${PILL_CLASS[freshness.tone]}`, text: freshness.label, title: freshness.title }),
  ]);
}
