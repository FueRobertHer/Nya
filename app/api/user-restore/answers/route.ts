import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { storeFailure } from '@/lib/store-failure';
import { ForgetRefused } from '@/lib/links';
import { answer, parseAnswer, AnswerRefused } from '@/lib/user-restore/answering';

// The person's answers about the accounts a restore brought back from a bank
// connected through Plaid (lib/user-restore/answering.ts, which says what
// each does; lib/user-restore/answers.ts, what they do to the rows):
//
//   POST { action: "count", account_ids, end? }
//                             counted as an ended account's, up to its end:
//                             `end` ({ state: "closed" | "left", on, note? }
//                             or { state: "untracked", from }) for each one
//                             with none, at the latest the day after its
//                             download's
//   POST { action: "uncount", account_ids }
//   POST { action: "apart" | "ask-again", connection: { kind: "item" |
//          "connector", id }, account_ids }
//                             not among that connection's accounts, or that
//                             answer taken back
//   POST { action: "hand-over", account_id, to, end? }
//                             carried on by a connector account (`to`)
//   POST { action: "take-back", account_id }
//
// Every field is checked, and anything else refused. Whether or not restores
// are turned on (RESTORE_ENABLED): these answer restores already made, as
// Stop following and Forget do, and turning restores off must not strand a
// bank that waits. Refused while a restore is being written or undone. Under
// the links lock, so a link or a forget of the same account can't land in
// between; the caches are cleared. Logs carry no id and no name.
//
// Errors as on the storage seam (lib/store-failure.ts): 503 with no
// container, 409 for entries that can't be read (with the ids) or that kept
// changing, else 500; 400 for a request that isn't one of the above, 404 for
// an account or a connection that isn't there, 409 for an answer that
// doesn't hold now (a linked or forgotten account, a currency that differs).

// Must match LINKS_LOCK_REQUEST_SECONDS (lib/links.ts): a request never
// outlives the lock it holds. A literal, as route segment config requires.
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t save that answer');
  }
  const body = await req.json().catch(() => undefined);
  const now = Date.now();
  const request = parseAnswer(body, now);
  if (typeof request === 'string') return NextResponse.json({ error: request }, { status: 400 });
  try {
    const answered = await answer(ctx, request, now);
    console.log(`Restore: answered (${request.action}) for ${answered.length} account${answered.length === 1 ? '' : 's'}`);
    return NextResponse.json({ answered: answered.length }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AnswerRefused) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Couldn’t save that answer');
  }
}
