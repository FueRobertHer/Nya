import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { storeFailure } from '@/lib/store-failure';
import { restoredAccountsStore } from '@/lib/user-restore/store';
import { forgetEarlierAccount, ForgetRefused, withLinksLock } from '@/lib/links';
import { clearCaches } from '@/lib/cache';
import { linksChanged } from '@/lib/history-import/extend';

// Forgetting, for good, a restored account whose entry can't be read and
// that the Earlier accounts list (Manage) can't show, for having nothing to
// list it by: no directory entry that can be read, and no balance history
// (lib/links.ts whyUnlisted 'unknown'). Its entry holds the net worth totals
// (lib/user-restore/restored.ts totalsHold) and nothing else can end it, so
// the restore card offers this (components/restore-state.ts unreadableNotes).
//
//   POST { account_id, confirm: true }
//                             forgotten as that list forgets an account
//                             (forgetEarlierAccount, every other check of it
//                             standing), under the links lock; only for an
//                             entry that can't be read right now. Answers as
//                             app/api/account-links answers a forget.
//
// Whether or not restores are turned on (RESTORE_ENABLED): the entry holds
// the totals either way. No fresh sign-in, as for any forget. Logs carry no
// id and no name.

// Must match LINKS_LOCK_REQUEST_SECONDS (lib/links.ts): a request never
// outlives the lock it holds. A literal, as route segment config requires.
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

const MAX_ID = 200;

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t forget that account');
  }
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = raw?.account_id;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !Object.keys(raw).every((k) => k === 'account_id' || k === 'confirm') ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_ID ||
    raw.confirm !== true
  ) {
    return NextResponse.json({ error: 'Send { account_id, confirm: true }.' }, { status: 400 });
  }
  try {
    return await withLinksLock(ctx, async () => {
      const report = await restoredAccountsStore.getAllReport(ctx);
      if (![...report.unreadable, ...report.unrecognised].includes(id)) {
        return NextResponse.json({ error: 'That isn’t an account a restore brought back whose details can’t be read.' }, { status: 409 });
      }
      try {
        const { unreadableDates, holdingsDamaged } = await forgetEarlierAccount(ctx, id, { unlisted: true });
        console.log('Restore: an account whose entry couldn’t be read was forgotten');
        return NextResponse.json({ forgotten: true, unreadable_days: unreadableDates.length, ...(holdingsDamaged ? { damaged_holdings: true } : {}) }, { headers: NO_STORE });
      } finally {
        // As for any forget (app/api/account-links): even one that stopped
        // part way changed totals.
        await clearCaches(ctx).catch(() => {});
        await linksChanged(ctx);
      }
    });
  } catch (err) {
    if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Couldn’t forget that account');
  }
}
