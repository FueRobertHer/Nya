// lib/timeline-notes.ts
//
// Notes on the net-worth timeline (#50): a few words on a date, drawn as a
// marker on the Home chart, so a step in the line says what it was. When an
// account ends (lib/lifecycle.ts) net worth drops by its balance on that day,
// and the step is real: lib/history.ts treats every past date as a
// measurement, so the line is never smoothed to hide it. A note explains it
// instead. The same step comes with a house purchase, a 401(k) rollover or a
// large transfer between institutions, so the person can write their own.
//
// Two kinds:
//   - "auto": written by Nya when an account's lifecycle changes, one per
//     account under an id made from the account's own id (a provider's id, as
//     the seam allows in a field name), so changing the end date moves the
//     note rather than adding a second, and reopening the account takes it
//     away. The person changes these by changing the account, never directly.
//     Also one per window an account was missing from its bank's answer and
//     assumed closed before it came back (lib/lifecycle.ts), under a random
//     id the window keeps (`missed[].note`), since a field name is plaintext
//     and a day is content the seam keeps out of it (lib/repo.ts): it says
//     why the chart leaves those days out, and stays, since the days stay
//     short.
//   - "user": what the person wrote, under a random id. They add, edit and
//     remove these as they like.
//
// A map store on the storage seam (lib/repo.ts), exportable: the notes are
// the person's own words. Reads are strict except the chart's (readNotes):
// the markers are a display convenience that nothing writes, deletes or
// records on, and the list beside them names what could not be read. The
// stored shape is closed (isTimelineNote): a later release's note reads as
// unrecognised and is left exactly as it is, never edited into this
// release's shape.

import { defineMapStore, type MapStore } from './repo';
import type { Ctx } from './containers';
import { isCalendarDay } from './manual-txn-input';

export type NoteKind = 'auto' | 'user';

export type TimelineNote = {
  /** The day it is about, YYYY-MM-DD: the history's UTC day for an account's
   *  end, the person's own calendar day for one they wrote. */
  date: string;
  text: string;
  kind: NoteKind;
  /** The account it is about, when there is one: always for an auto note. */
  account_id?: string;
  /** When it was written, and last changed (ISO times). */
  created_at: string;
  updated_at?: string;
};

/** The longest note, in characters: a line under a chart, not a diary. */
export const NOTE_TEXT_MAX = 200;
/** How many notes a container may hold, auto ones among them. A note a month
 *  for forty years; a bound on the one read the chart makes. */
export const MAX_NOTES = 500;
/** The earliest day a note may name. Nothing in Nya is older. */
export const FIRST_NOTE_DAY = '1970-01-01';

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const KEYS = new Set(['date', 'text', 'kind', 'account_id', 'created_at', 'updated_at']);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));

/** Note text as it is stored: trimmed, one line, 1 to NOTE_TEXT_MAX characters. */
export function isNoteText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= NOTE_TEXT_MAX && v.trim() === v && !CONTROL.test(v);
}

/** A day a note may be on: a real calendar day, from FIRST_NOTE_DAY on. */
export function isNoteDay(v: unknown): v is string {
  return isCalendarDay(v) && v >= FIRST_NOTE_DAY;
}

/** The current shape, closed: a field this release doesn't know makes the
 *  note unrecognised, so it is never rewritten without it. */
export function isTimelineNote(v: unknown): v is TimelineNote {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const n = v as Record<string, unknown>;
  if (!Object.keys(n).every((k) => KEYS.has(k))) return false;
  return (
    isNoteDay(n.date) &&
    isNoteText(n.text) &&
    (n.kind === 'auto' || n.kind === 'user') &&
    (n.account_id === undefined || (typeof n.account_id === 'string' && ID.test(n.account_id))) &&
    // An auto note is always about an account: it is how it is found again.
    (n.kind !== 'auto' || typeof n.account_id === 'string') &&
    isTime(n.created_at) &&
    (n.updated_at === undefined || isTime(n.updated_at))
  );
}

export const timelineNotesStore: MapStore<TimelineNote> = defineMapStore<TimelineNote>('timeline-notes', {
  what: 'timeline notes',
  isValid: isTimelineNote,
  exportable: true, // the person's own words, and what happened to their accounts
});

/** The id of an account's auto note: the account's own id, which the seam
 *  allows in a field name, so a change to its lifecycle finds it again. */
export const autoNoteId = (account_id: string) => `lifecycle.${account_id}`;

/** A new id for the note on a window an account was missing (lib/lifecycle.ts
 *  liftAssumedClosures): random, and kept on the window, which is how the
 *  note is found again. */
export const newMissedNoteId = () => `missed.${crypto.randomUUID()}`;

/** An id newMissedNoteId makes. */
export const isMissedNoteId = (v: unknown): v is string => typeof v === 'string' && /^missed\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** The id a window's note had before windows kept their notes' ids: the
 *  account's id and the window's first day, a day in a plaintext field name,
 *  which the seam forbids. Only to find such a note and move it
 *  (lib/lifecycle.ts adoptMissedNotes). */
export const legacyMissedNoteId = (account_id: string, from: string) => `missed.${account_id}.${from}`;

/** A note refused for what it asks, with a message for the person: 400. */
export class NoteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteRefusedError';
  }
}

/** Collapses whitespace and trims, so a pasted line stores as one line. */
export function cleanNoteText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return isNoteText(t) ? t : null;
}

/**
 * Writes (or moves) an account's auto note. A compare-and-set: it never
 * writes over a note this release can't read (the seam refuses, and the
 * caller says so), and one that is somehow a user note under that id is
 * left alone.
 */
export async function writeAutoNote(ctx: Ctx, account_id: string, date: string, text: string, now: number = Date.now()): Promise<void> {
  await writeNoteUnder(ctx, autoNoteId(account_id), account_id, date, text, now);
}

/** Writes the note on a window an account was missing, under the id the
 *  window keeps, as writeAutoNote. */
export async function writeMissedNote(ctx: Ctx, id: string, account_id: string, from: string, text: string, now: number = Date.now()): Promise<void> {
  await writeNoteUnder(ctx, id, account_id, from, text, now);
}

/**
 * Moves the note on a missing window from the id it had before windows kept
 * their notes' ids (legacyMissedNoteId) to the window's own, as it was
 * written; with none there to move, writes it afresh. The new one is written
 * before the old one goes, so a failure between them leaves the note under
 * both ids, never under neither. Each a compare-and-set.
 */
export async function moveMissedNote(ctx: Ctx, from_id: string, to_id: string, account_id: string, date: string, text: string, now: number = Date.now()): Promise<void> {
  const old = await timelineNotesStore.get(ctx, from_id);
  if (!old || old.kind !== 'auto' || old.account_id !== account_id) {
    await writeNoteUnder(ctx, to_id, account_id, date, text, now);
    return;
  }
  await timelineNotesStore.update(ctx, to_id, (current) => current ?? old);
  await timelineNotesStore.update(ctx, from_id, (current) => (current && current.kind === 'auto' && current.account_id === account_id ? null : current));
}

/** Removes the note on a missing window, when it is Nya's about the account. */
export async function removeMissedNote(ctx: Ctx, id: string, account_id: string): Promise<void> {
  await timelineNotesStore.update(ctx, id, (current) => (current && current.kind === 'auto' && current.account_id === account_id ? null : current));
}

async function writeNoteUnder(ctx: Ctx, id: string, account_id: string, date: string, text: string, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  const clean = cleanNoteText(text) ?? cleanNoteText(text.slice(0, NOTE_TEXT_MAX - 1).trim() + '…');
  if (!clean || !isNoteDay(date)) return;
  await timelineNotesStore.update(ctx, id, (current) => {
    if (current && current.kind !== 'auto') return current;
    return current
      ? { ...current, date, text: clean, updated_at: at }
      : { date, text: clean, kind: 'auto', account_id, created_at: at };
  });
}

/** Removes an account's auto note: its lifecycle no longer says anything
 *  happened on a day (it was reopened, or an assumed closure lifted). */
export async function removeAutoNote(ctx: Ctx, account_id: string): Promise<void> {
  await timelineNotesStore.update(ctx, autoNoteId(account_id), (current) => (current && current.kind === 'auto' ? null : current));
}

/**
 * Removes every note Nya wrote about an account, its end's and its missing
 * windows' alike: forgetting the account (lib/lifecycle.ts forgetLifecycle),
 * since each names it. Reads the notes with a report: one that can't be read
 * holds nothing anyone can read, and is left. Strict about storage.
 */
export async function removeAccountNotes(ctx: Ctx, account_id: string): Promise<void> {
  const { entries } = await timelineNotesStore.getAllReport(ctx);
  for (const [id, note] of entries) {
    if (note.kind !== 'auto' || note.account_id !== account_id) continue;
    await timelineNotesStore.update(ctx, id, (current) => (current && current.kind === 'auto' && current.account_id === account_id ? null : current));
  }
}

/** Adds one of the person's own notes, under a random id. Refused past
 *  MAX_NOTES, counting every entry, readable or not. */
export async function addUserNote(
  ctx: Ctx,
  note: { date: string; text: string; account_id?: string },
  now: number = Date.now()
): Promise<{ id: string; note: TimelineNote }> {
  if ((await timelineNotesStore.count(ctx)) >= MAX_NOTES) {
    throw new NoteRefusedError(`You have ${MAX_NOTES} notes, the most Nya keeps. Remove one to add another.`);
  }
  const id = crypto.randomUUID();
  const value: TimelineNote = {
    date: note.date,
    text: note.text,
    kind: 'user',
    ...(note.account_id ? { account_id: note.account_id } : {}),
    created_at: new Date(now).toISOString(),
  };
  await timelineNotesStore.set(ctx, id, value);
  return { id, note: value };
}

/** Changes one of the person's own notes. Null when there is none under the
 *  id; refused for an auto note, which follows its account. */
export async function editUserNote(
  ctx: Ctx,
  id: string,
  change: { date?: string; text?: string },
  now: number = Date.now()
): Promise<TimelineNote | null> {
  let refused = false;
  const written = await timelineNotesStore.update(ctx, id, (current) => {
    refused = false;
    if (!current) return null;
    if (current.kind !== 'user') {
      refused = true;
      return current;
    }
    return { ...current, ...(change.date ? { date: change.date } : {}), ...(change.text ? { text: change.text } : {}), updated_at: new Date(now).toISOString() };
  });
  if (refused) throw new NoteRefusedError('That note follows an account’s change: change the account to change it.');
  return written;
}

/** Removes one of the person's own notes. False when there is none; refused
 *  for an auto note, as for an edit. */
export async function removeUserNote(ctx: Ctx, id: string): Promise<boolean> {
  let refused = false;
  let found = false;
  await timelineNotesStore.update(ctx, id, (current) => {
    refused = false;
    found = current !== null;
    if (current && current.kind !== 'user') {
      refused = true;
      return current;
    }
    return null;
  });
  if (refused) throw new NoteRefusedError('That note follows an account’s change: reopen the account to remove it.');
  return found;
}

/** A note as the app and the chart read it, with its id. */
export type NoteForClient = TimelineNote & { id: string };

/**
 * Every note, oldest day first, and the ids of those that can't be read, by
 * why (the seam's report): for the chart and the notes card, which show what
 * they read and say what they couldn't. A display: nothing writes, deletes
 * or records on it. A failure to reach storage still throws.
 */
export async function readNotes(ctx: Ctx): Promise<{ notes: NoteForClient[]; unreadable: string[]; unrecognised: string[] }> {
  const report = await timelineNotesStore.getAllReport(ctx);
  const notes = [...report.entries].map(([id, note]) => ({ id, ...note }));
  notes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return { notes, unreadable: report.unreadable, unrecognised: report.unrecognised };
}
