import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import {
  readNotes,
  addUserNote,
  editUserNote,
  removeUserNote,
  cleanNoteText,
  isNoteDay,
  NoteRefusedError,
  NOTE_TEXT_MAX,
} from '@/lib/timeline-notes';
import { lastEndDay } from '@/lib/lifecycle';
import { storeFailure } from '@/lib/store-failure';

// Notes on the net-worth timeline (lib/timeline-notes.ts). GET lists every
// note, oldest day first, with the ids of any that can't be read (never
// dropped without a word); the chart draws a marker at each. POST adds one of
// the person's own, PATCH changes one, DELETE removes one, one note per
// request. Every field is checked and anything else refused:
//
//   POST   { date, text, account_id? }
//   PATCH  { id, date?, text? }        at least one of date and text
//   DELETE { id }
//
// A date is a real calendar day from 1970 on, and never after the person's
// today: a note says what happened. Text is one line, 1 to 200 characters
// once its spaces are tidied. A note Nya wrote for an account's change
// follows the account, and is refused here (409). Notes ride on no cached
// payload, so nothing is cleared.
//
// Errors as on the storage seam (lib/store-failure.ts): 503 with no
// container, 409 for a note that can't be read or kept changing, 413 for one
// too large, else 500.

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const unknownField = (b: Record<string, unknown>, allowed: string[]) => Object.keys(b).find((k) => !allowed.includes(k));

/** A day a note may be on, or what is wrong with it. */
function dayOf(v: unknown, now: number): string | { error: string } {
  if (!isNoteDay(v)) return { error: 'The date is YYYY-MM-DD, from 1970 on' };
  if (v > lastEndDay(now)) return { error: 'A note is about a day that has come: the date can’t be in the future' };
  return v;
}

const textOf = (v: unknown): string | { error: string } => cleanNoteText(v) ?? { error: `A note is 1 to ${NOTE_TEXT_MAX} characters` };

function failed(err: unknown, fallback: string): NextResponse {
  if (err instanceof NoteRefusedError) return NextResponse.json({ error: err.message }, { status: 409 });
  return storeFailure(err, fallback);
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { notes, unreadable, unrecognised } = await readNotes(ctx);
    return NextResponse.json({ notes, unreadable_ids: unreadable, unrecognised_ids: unrecognised });
  } catch (err) {
    return failed(err, 'Failed to load notes');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const b = await bodyOf(req);
    if (!b) return bad('Send the note, as JSON');
    const extra = unknownField(b, ['date', 'text', 'account_id']);
    if (extra) return bad(`${extra.slice(0, 40)} isn't part of a note`);
    const now = Date.now();
    const date = dayOf(b.date, now);
    if (typeof date !== 'string') return bad(date.error);
    const text = textOf(b.text);
    if (typeof text !== 'string') return bad(text.error);
    if (b.account_id !== undefined && b.account_id !== null && !(typeof b.account_id === 'string' && ID.test(b.account_id))) return bad('Invalid account id');
    const account_id = typeof b.account_id === 'string' ? b.account_id : undefined;
    return NextResponse.json(await addUserNote(ctx, { date, text, ...(account_id ? { account_id } : {}) }, now));
  } catch (err) {
    return failed(err, 'Failed to save the note');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const b = await bodyOf(req);
    if (!b) return bad('Send the change, as JSON');
    const extra = unknownField(b, ['id', 'date', 'text']);
    if (extra) return bad(`${extra.slice(0, 40)} isn't part of a note`);
    if (typeof b.id !== 'string' || !ID.test(b.id)) return bad('Invalid note id');
    if (b.date === undefined && b.text === undefined) return bad('Change the date, the text, or both');
    const now = Date.now();
    const change: { date?: string; text?: string } = {};
    if (b.date !== undefined) {
      const date = dayOf(b.date, now);
      if (typeof date !== 'string') return bad(date.error);
      change.date = date;
    }
    if (b.text !== undefined) {
      const text = textOf(b.text);
      if (typeof text !== 'string') return bad(text.error);
      change.text = text;
    }
    const note = await editUserNote(ctx, b.id, change, now);
    if (!note) return NextResponse.json({ error: 'That note is gone' }, { status: 404 });
    return NextResponse.json({ id: b.id, note });
  } catch (err) {
    return failed(err, 'Failed to save the note');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const b = await bodyOf(req);
    if (!b) return bad('Send the note’s id, as JSON');
    const extra = unknownField(b, ['id']);
    if (extra) return bad(`${extra.slice(0, 40)} isn't part of removing a note`);
    if (typeof b.id !== 'string' || !ID.test(b.id)) return bad('Invalid note id');
    if (!(await removeUserNote(ctx, b.id))) return NextResponse.json({ error: 'That note is gone' }, { status: 404 });
    return NextResponse.json({ id: b.id, removed: true });
  } catch (err) {
    return failed(err, 'Failed to remove the note');
  }
}
