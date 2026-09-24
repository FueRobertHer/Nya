import { NextResponse } from 'next/server';
import { computeNetWorth, recordFetch, isRecordable } from '@/lib/networth';
import { clearCaches } from '@/lib/cache';
import { rememberAccounts } from '@/lib/last-known';
import { finishMasterRotation } from '@/lib/crypto';

// Daily snapshot endpoint, hit by Vercel Cron (see vercel.json) so the
// net-worth chart stays gapless even on days the app isn't opened.
//
// This route is excluded from the session gate in proxy.ts and instead
// authenticates the cron caller: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}` automatically when a CRON_SECRET env var is set on the
// project. Without a valid secret the route always 401s.

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Finish a master key rotation if this deployment is the one it was
    // rotating to (lib/crypto.ts). Also happens on first use of a data key;
    // this makes sure it happens within a day even if none is used. Best
    // effort: a failure here must not cost the day's snapshot.
    await finishMasterRotation().catch((err) => console.error('Master rotation finish failed', err instanceof Error ? err.message : err));
    const { institutions, netWorth } = await computeNetWorth();

    // Same rule as the dashboard fetch: only a clean, non-empty read records a
    // total. A partly failed one still records the accounts that answered, for
    // their own charts: on a day the app isn't opened this is the only fetch.
    const recorded = await recordFetch(institutions, netWorth);
    const clean = institutions.every(isRecordable);
    if (!clean || institutions.length === 0) {
      return NextResponse.json({ recorded: false });
    }

    // Record how to draw these accounts, alongside the balances. On a day the
    // app is never opened this cron is the only clean fetch there is, so
    // without it an account added since the last dashboard load would be in the
    // snapshot with nothing to render it from, and recovery would draw its
    // institution short (lib/last-known.ts reports the shortfall but cannot
    // undo it).
    await rememberAccounts(institutions);
    await clearCaches(); // cached payloads now have yesterday's history
    return NextResponse.json({ recorded: recorded !== null });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Snapshot failed' }, { status: 500 });
  }
}
