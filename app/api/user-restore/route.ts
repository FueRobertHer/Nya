import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { clerkEnabled } from '@/lib/auth-mode';
import { isDemoUser } from '@/lib/demo';
import { freshSignIn, PASSWORD_MAX } from '@/lib/fresh-sign-in';
import { storeFailure } from '@/lib/store-failure';
import { background } from '@/lib/background';
import { sendAccessNotice } from '@/lib/download-notice';
import { scanAccount, inUseMessage, type AccountScan } from '@/lib/user-restore/empty';
import { isUserRestoreRecord, recordView, userRestoreStore, previewsCount, PREVIEWS_PER_HOUR, startsCount, STARTS_PER_DAY, type UserRestoreRecord } from '@/lib/user-restore/store';
import { isUserRestoreId, UNDO_DAYS } from '@/lib/user-restore/ids';
import { isPartName } from '@/lib/user-restore/check';
import { planDigest } from '@/lib/user-restore/file';
import { undoRestore, emptyAccount, UndoRefused, EMPTY_WORDS } from '@/lib/user-restore/undo';
import { restoreEnabled, RESTORE_OFF } from '@/lib/user-restore/enabled';
import { waitingAccounts } from '@/lib/user-restore/restored';
import { earlierAccountLabel, forgettableAccounts, liveAccountIds, loadSuggestionInputs, whyUnlisted } from '@/lib/links';
import { earlierNames } from '@/lib/earlier-names';
import { getHiddenAccounts } from '@/lib/hidden';
import { getItems } from '@/lib/storage';
import { myConnections } from '@/lib/sharing';
import { restoredRowsOf } from '@/lib/user-restore/forget';
import type { UnreadableAccount, UnrecognisedAccount } from '@/components/restore-state';

// Bringing a download back into this account (docs/data-export.md,
// "Bringing it back"): the record of the restore, and what is done to the
// account as a whole. The batches, and the finish, go to
// app/api/user-restore/batch; forgetting a restored account nothing else can
// show, to app/api/user-restore/forget.
//
//   GET                       { enabled, demo, record, record_unreadable,
//                             accounts_unreadable, undo_days, waiting }:
//                             `waiting`, the restored accounts neither linked
//                             nor ended, for the card's next steps;
//                             `accounts_unreadable`, the restored accounts
//                             whose entry can't be read (`entries`, each
//                             named as the Earlier accounts list names it, or
//                             said why it isn't listed; `unrecognised`, those
//                             in a form this version doesn't know, never
//                             offered for removal; `unnamed` when what names
//                             them couldn't be read; `broken_links` when a
//                             saved link can't be, which holds back every
//                             forget) and whether a waiting one's end can't
//                             be (`ends`), apart from the record's own;
//                             and with ?scan=1 whether this account is
//                             empty enough (a scan of its keys, counted:
//                             PREVIEWS_PER_HOUR), and, with Clerk, the people
//                             this account shares with already (`sharing`),
//                             who would see what a restore brings back as it
//                             is shared
//   POST { action: "start", restore_id, plan, source, brought, left_out,
//          without, history, earlier, password? }
//                             the record claimed, after a fresh sign-in, and
//                             kept only if the account is empty; the same
//                             start sent again answers the record
//   POST { action: "empty", confirm: "empty my account", password? }
//                             everything but the app's machinery deleted,
//                             after a fresh sign-in: for an account that
//                             holds data no restore brought
//   DELETE { restore_id, confirm: true, password? }
//                             the restore undone: the account empty again
//
// Off unless RESTORE_ENABLED=1 (lib/user-restore/enabled.ts): with it off,
// this route still says what is recorded and undoes a restore already
// recorded, and refuses the rest. Demo accounts are refused (everyone who
// tries the demo shares its data). Starts, undos and emptyings together are
// counted (STARTS_PER_DAY), and each is emailed to the owner. Logs carry
// counts, never a value, an id or a name. Errors as the storage seam has them
// (lib/store-failure.ts).

// The undo sweeps the container twice, the second time after a pause longer
// than a batch can run (lib/user-restore/undo.ts UNDO_PAUSE_MS).
export const maxDuration = 300;

const NO_STORE = { 'Cache-Control': 'no-store' };

const viewOf = (r: UserRestoreRecord | null) => (r ? recordView(r) : null);

const DEMO_REFUSAL = 'This is a demo account, shared by everyone who tries the app: nothing can be brought back into it, and it can’t be emptied.';

/** The signed-in Clerk account is one of Preview's demo accounts. */
async function isDemo(): Promise<boolean> {
  if (!clerkEnabled()) return false;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return !!userId && isDemoUser(userId);
}

const scanView = (scan: AccountScan) => ({ ...scan, message: scan.found.length > 0 ? inUseMessage(scan) : null });

/**
 * Each of these accounts as the Earlier accounts list (Manage) shows it, so
 * a note that says to forget one names the one it means (forgetting is for
 * good): what the directory calls it, and the name and days the list shows
 * it by, told apart from any that would read the same (lib/earlier-names.ts);
 * or, for one the list leaves out, why (lib/links.ts whyUnlisted), the
 * accounts a link joins it to, whether the list would show it once that is
 * undone, and, for one the card itself forgets (nothing to list it by), what
 * that would take of the rows a restore brought back for it. `unknown`, the
 * entries this version doesn't know, are only named: nothing here offers to
 * remove them (lib/repo.ts). `broken_links`: a saved link can't be read,
 * which holds back every forget until it is removed. These reads failing
 * loses only the names (`unnamed`), never the record and its undo.
 */
async function named(
  ctx: Ctx,
  ids: readonly string[],
  unknown: readonly string[]
): Promise<{ entries: UnreadableAccount[]; unrecognised: UnrecognisedAccount[]; unnamed: boolean; broken_links: boolean }> {
  if (ids.length === 0 && unknown.length === 0) return { entries: [], unrecognised: [], unnamed: false, broken_links: false };
  try {
    const live = await liveAccountIds(ctx, { strict: true, readOnly: true });
    const [inputs, hidden, items] = await Promise.all([loadSuggestionInputs(ctx, live), getHiddenAccounts(ctx), getItems(ctx)]);
    const stored = new Set(items.map((i) => i.item_id));
    const earlier = forgettableAccounts(inputs, new Set(hidden.keys()), stored);
    const names = earlierNames(earlier);
    const listed = new Map(earlier.map((e) => [e.id, e]));
    const labelOf = (id: string) => (inputs.directory[id] ? earlierAccountLabel(inputs.directory[id]) : null);
    const entries = await Promise.all(
      ids.map(async (id): Promise<UnreadableAccount> => {
        const e = listed.get(id);
        const why = e ? null : whyUnlisted(inputs, stored, id);
        const others =
          why === 'linked' ? [inputs.links.get(id)!.to] : why === 'linked-to' ? [...inputs.links].filter(([, l]) => l.to === id).map(([old]) => old).sort() : [];
        return {
          account_id: id,
          label: labelOf(id),
          listed: e ? { name: names.get(id)!, first: e.first, last: e.last } : null,
          unlisted: why
            ? { why, others: others.map(labelOf), listable: !!inputs.directory[id] || !!inputs.spans[id], rows: why === 'unknown' ? await restoredRowsOf(ctx, id) : null }
            : null,
        };
      })
    );
    return { entries, unrecognised: unknown.map((id) => ({ account_id: id, label: labelOf(id) })), unnamed: false, broken_links: inputs.unreadableLinks.size > 0 };
  } catch (err) {
    // What failed, never its message: one can name an account.
    console.error(`Restore: couldn’t name the restored accounts whose entries can’t be read (${ids.length + unknown.length}): ${err instanceof Error ? err.name : 'not an error'}`);
    return {
      entries: ids.map((id) => ({ account_id: id, label: null, listed: null, unlisted: null })),
      unrecognised: unknown.map((id) => ({ account_id: id, label: null })),
      unnamed: true,
      broken_links: false,
    };
  }
}

/** Whom this account shares with now, and what: sharing is between people,
 *  outside the account, so an empty account can share already (a net worth,
 *  spending), and a restore's data is then shown as it is shared. What I
 *  call each, the kinds and how many accounts; none with the shared
 *  password, which has no people. */
async function sharingNow(): Promise<{ label: string; kinds: string[]; accounts: number }[]> {
  if (!clerkEnabled()) return [];
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) return [];
  const { connections } = await myConnections(userId);
  return connections
    .map((c) => ({ label: c.label, kinds: Object.keys(c.views).sort(), accounts: Object.keys(c.sharing).length }))
    .filter((c) => c.kinds.length > 0 || c.accounts > 0);
}

function tooMany(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: `A restore can be started, undone or emptied ${STARTS_PER_DAY} times a day. Try again later.`, retry_after_seconds: retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const passwordOf = (v: unknown): string | null | 'bad' => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= PASSWORD_MAX ? v : 'bad');

/** The start's body, made into the record it claims, or what is wrong. */
async function recordOfStart(raw: Record<string, unknown>, now: Date): Promise<UserRestoreRecord | string> {
  if (!onlyKeys(raw, ['action', 'restore_id', 'plan', 'source', 'brought', 'left_out', 'without', 'history', 'earlier', 'password'])) return 'This start has a field Nya doesn’t take.';
  if (!isUserRestoreId(raw.restore_id)) return 'restore_id must be the id the page made for this restore.';
  const record = {
    version: 1,
    id: raw.restore_id,
    status: 'writing',
    started_at: now.toISOString(),
    finished_at: null,
    undo_until: null,
    last_batch_at: null,
    source: raw.source,
    plan: raw.plan,
    done: 0,
    brought: raw.brought,
    left_out: raw.left_out,
    without: raw.without,
    history: raw.history,
    earlier: raw.earlier,
  };
  if (!isUserRestoreRecord(record)) return 'This start isn’t one Nya can record. Choose the file again.';
  if (!record.plan.batches.every((b) => isPartName(b.part) && b.count >= 1)) return 'This plan names a part this version of Nya doesn’t write. Choose the file again.';
  if (Date.parse(record.source.exported_at) > now.getTime() + 5 * 60_000) return 'This file says it was made after now.';
  // The backfill never estimates over the restored history's last day
  // (app/api/backfill): no day of it can be after the download was made.
  if (record.history && record.history.last > new Date(record.source.exported_at).toISOString().slice(0, 10)) return 'This plan names balance history after the day its file was made. Choose the file again.';
  if ((await planDigest(record.plan.batches)) !== record.plan.digest) return 'This plan’s digest isn’t of its batches. Choose the file again.';
  return record;
}

export async function GET(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t read what was brought back');
  }
  try {
    const [report, demo, waiting] = await Promise.all([
      userRestoreStore.getReport(ctx),
      isDemo(),
      waitingAccounts(ctx, () => liveAccountIds(ctx, { strict: true, readOnly: true })),
    ]);
    const answer: Record<string, unknown> = {
      enabled: restoreEnabled(),
      demo,
      record: viewOf(report.value),
      // A record that can't be read holds the totals as an unfinished one does
      // (lib/user-restore/restored.ts); emptying the account is the way out.
      record_unreadable: report.unreadable || report.unrecognised,
      // A restored account's entry or end that can't be read holds them too,
      // with its own way out: the end's repair on the Accounts tab, or
      // forgetting the account. Never a reason to empty the account.
      accounts_unreadable: { ...(await named(ctx, waiting.unread.entries, waiting.unread.unrecognised)), ends: waiting.unread.ends },
      undo_days: UNDO_DAYS,
      waiting: waiting.accounts,
    };
    if (new URL(req.url).searchParams.get('scan') === '1') {
      const counted = await previewsCount.take(ctx);
      if (counted.count > PREVIEWS_PER_HOUR) {
        return NextResponse.json(
          { error: `Nya looks at whether this account is empty ${PREVIEWS_PER_HOUR} times an hour at most. Try again later.` },
          { status: 429, headers: { 'Retry-After': String(counted.secondsLeft) } }
        );
      }
      answer.scan = scanView(await scanAccount(ctx));
      answer.sharing = await sharingNow();
    }
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    return storeFailure(err, 'Couldn’t read what was brought back');
  }
}

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t start bringing the download back');
  }
  const raw = await req.json().catch(() => null);
  if (!isObject(raw)) return NextResponse.json({ error: 'Send { action }.' }, { status: 400 });
  const action = raw.action;
  if (action !== 'start' && action !== 'empty') return NextResponse.json({ error: 'action must be start or empty.' }, { status: 400 });
  if (!restoreEnabled()) return NextResponse.json({ error: RESTORE_OFF }, { status: 403 });
  const password = passwordOf(raw.password);
  if (password === 'bad') return NextResponse.json({ error: 'password must be text.' }, { status: 400 });
  let candidate: UserRestoreRecord | null = null;
  if (action === 'start') {
    const made = await recordOfStart(raw, new Date());
    if (typeof made === 'string') return NextResponse.json({ error: made }, { status: 400 });
    candidate = made;
  } else if (!onlyKeys(raw, ['action', 'confirm', 'password']) || raw.confirm !== EMPTY_WORDS) {
    return NextResponse.json({ error: `To empty this account, type “${EMPTY_WORDS}”.` }, { status: 400 });
  }
  // Before the sign-in, so a demo visitor isn't asked to confirm it's them for nothing.
  if (await isDemo().catch(() => false)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });

  try {
    const allowance = await startsCount.read(ctx);
    if (allowance.count >= STARTS_PER_DAY) return tooMany(allowance.secondsLeft);
    const signedIn = await freshSignIn(req, password);
    if (signedIn instanceof NextResponse) return signedIn;
    if (signedIn.userId && isDemoUser(signedIn.userId)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });
    const taken = await startsCount.take(ctx);
    if (taken.count > STARTS_PER_DAY) return tooMany(taken.secondsLeft);

    if (!candidate) {
      const { deleted } = await emptyAccount(ctx, { userId: signedIn.userId });
      console.log(`Restore: an account was emptied (${deleted} keys)`);
      background(sendAccessNotice(ctx, { kind: 'emptied' }, new Date()));
      return NextResponse.json({ emptied: true }, { headers: NO_STORE });
    }

    // One restore at a time: of two tabs, one claims the record.
    const start = candidate;
    const claimed = await userRestoreStore.update(ctx, (cur) => cur ?? start);
    if (!claimed || claimed.id !== start.id) {
      const finished = claimed?.status === 'finished';
      return NextResponse.json(
        {
          error: finished
            ? `This account already has a restore, from ${claimed.started_at.slice(0, 10)}: undo it, or empty this account, before bringing another download back.`
            : `A restore is already under way here, started ${claimed?.started_at.slice(0, 10) ?? 'just now'}: finish it where it started, or undo it.`,
          record: viewOf(claimed),
        },
        { status: 409 }
      );
    }
    if (claimed.started_at !== start.started_at) {
      // The same start sent again, its answer lost: the record as it is.
      if (claimed.plan.digest !== start.plan.digest) return NextResponse.json({ error: 'This restore started from another file: resume it with that one, or undo it.', record: viewOf(claimed) }, { status: 409 });
      return NextResponse.json({ record: viewOf(claimed) }, { headers: NO_STORE });
    }
    // Empty, looked at again now that the record is claimed: a bank linked
    // in another tab since the preview is caught.
    const scan = await scanAccount(ctx);
    if (scan.found.length > 0) {
      await userRestoreStore.update(ctx, (cur) => (cur && cur.id === start.id && cur.done === 0 ? null : cur));
      return NextResponse.json({ error: inUseMessage(scan), scan: scanView(scan) }, { status: 409 });
    }
    console.log(`Restore: started, ${claimed.plan.batches.length} batches`);
    background(sendAccessNotice(ctx, { kind: 'restore' }, new Date()));
    return NextResponse.json({ record: viewOf(claimed) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof UndoRefused) return NextResponse.json({ error: err.message }, { status: err.status });
    return storeFailure(err, action === 'start' ? 'Couldn’t start bringing the download back' : 'Couldn’t empty this account');
  }
}

export async function DELETE(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t undo the restore');
  }
  const raw = await req.json().catch(() => null);
  if (!isObject(raw) || !onlyKeys(raw, ['restore_id', 'confirm', 'password']) || !isUserRestoreId(raw.restore_id) || raw.confirm !== true) {
    return NextResponse.json({ error: 'Send { restore_id, confirm: true }.' }, { status: 400 });
  }
  const password = passwordOf(raw.password);
  if (password === 'bad') return NextResponse.json({ error: 'password must be text.' }, { status: 400 });
  if (await isDemo().catch(() => false)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });
  try {
    const allowance = await startsCount.read(ctx);
    if (allowance.count >= STARTS_PER_DAY) return tooMany(allowance.secondsLeft);
    const signedIn = await freshSignIn(req, password);
    if (signedIn instanceof NextResponse) return signedIn;
    const taken = await startsCount.take(ctx);
    if (taken.count > STARTS_PER_DAY) return tooMany(taken.secondsLeft);
    const { deleted } = await undoRestore(ctx, raw.restore_id, { userId: signedIn.userId });
    console.log(`Restore: undone (${deleted} keys)`);
    background(sendAccessNotice(ctx, { kind: 'restore-undone' }, new Date()));
    return NextResponse.json({ undone: true }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof UndoRefused) return NextResponse.json({ error: err.message }, { status: err.status });
    return storeFailure(err, 'Couldn’t undo the restore');
  }
}
