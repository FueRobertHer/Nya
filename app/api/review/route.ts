import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import {
  approve,
  ApprovalError,
  parseApprovals,
  parseUndo,
  readReviewSettings,
  repairReview,
  startDay,
  startReview,
  stopReview,
  todayOf,
  undoApprovals,
} from '@/lib/review-store';

// The review queue (lib/review-store.ts): turning it on or off, approving
// transactions as they were shown, undoing that, and repairing what can't be
// read. What needs review is worked out on every read of the transactions
// (lib/review-layer.ts), after the server's cache, so nothing here drops it.
//
// GET  the queue's settings: { review: { on, since } }, 409 when they can't
//      be read (with `repairable` when their bytes are damaged).
// POST { action, ... }, one of:
//   start    { today, since? }  turn it on: transactions dated from `since`
//                               (today, as the page has it, when absent; at
//                               most MAX_SINCE_DAYS back) need review
//   stop     {}                  turn it off; every approval is kept
//   approve  { items }           approve each transaction as the page showed
//                               it: { transaction_id, amount, currency,
//                               category_id, name, pending }, up to
//                               MAX_PER_REQUEST; answers when, and what each
//                               had before, for an undo
//   undo     { items }           put back what an approve replaced:
//                               { transaction_id, approved_at, previous }
//   repair   { confirm: true }   remove the approvals, and the settings,
//                               whose bytes are damaged
//
// Every field is checked (ApprovalError, 400: nothing is saved), and every
// write reads what it replaces strictly first, so an approval or settings
// that can't be read are never saved over: the seam's answers, as every
// store's (lib/store-failure.ts), 409 with the ids, and only the damaged
// ones are ever offered for removal.

const MAX_BODY_CHARS = 256 * 1024;
const ACTIONS = new Set(['start', 'stop', 'approve', 'undo', 'repair']);
const FIELDS: Record<string, readonly string[]> = {
  start: ['today', 'since'],
  stop: [],
  approve: ['items'],
  undo: ['items'],
  repair: ['confirm'],
};

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { settings, unreadable, unrecognised } = await readReviewSettings(ctx);
    if (unreadable || unrecognised) {
      return NextResponse.json(
        { error: 'Your saved review queue settings could not be read, so they were left untouched.', unreadable: true, ...(unreadable ? { repairable: true } : {}) },
        { status: 409 }
      );
    }
    return NextResponse.json({ review: { on: !!settings?.on, since: settings?.since ?? null } });
  } catch (err) {
    return storeFailure(err, 'Failed to read the review queue');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return bad('Request too large', 413);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return bad('Invalid request');
    }
    const action = body.action;
    if (typeof action !== 'string' || !ACTIONS.has(action)) return bad('Unknown action');
    const extra = Object.keys(body).find((k) => k !== 'action' && !FIELDS[action].includes(k));
    if (extra !== undefined) return bad(`${extra.slice(0, 40)} isn’t part of ${action}`);

    if (action === 'start') {
      const today = todayOf(body.today);
      const settings = await startReview(ctx, startDay(body.since, today));
      return NextResponse.json({ review: { on: settings.on, since: settings.since } });
    }
    if (action === 'stop') {
      const settings = await stopReview(ctx);
      return NextResponse.json({ review: { on: false, since: settings?.since ?? null } });
    }
    if (action === 'approve') {
      const items = parseApprovals(body.items);
      const { approved_at, previous } = await approve(ctx, items);
      return NextResponse.json({
        approved_at,
        approved: previous.size,
        previous: [...previous].map(([transaction_id, approval]) => ({ transaction_id, previous: approval })),
      });
    }
    if (action === 'undo') {
      return NextResponse.json({ restored: await undoApprovals(ctx, parseUndo(body.items)) });
    }
    if (body.confirm !== true) return bad('Removing damaged approvals needs your confirmation');
    return NextResponse.json(await repairReview(ctx));
  } catch (err) {
    if (err instanceof ApprovalError) return bad(err.message, err.status);
    return storeFailure(err, 'Failed to change the review queue');
  }
}
