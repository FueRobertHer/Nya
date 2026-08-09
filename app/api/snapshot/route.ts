import { NextResponse } from 'next/server';
import { computeNetWorth, accountBalanceMap } from '@/lib/networth';
import { recordSnapshot } from '@/lib/history';
import { clearCaches } from '@/lib/cache';
import { rememberAccounts } from '@/lib/last-known';

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
    const { institutions, netWorth } = await computeNetWorth();

    // Same rule as the dashboard fetch: only record clean, non-empty reads.
    const clean = institutions.every((i) => !i.error);
    if (!clean || institutions.length === 0) {
      return NextResponse.json({ recorded: false });
    }

    await recordSnapshot(netWorth, accountBalanceMap(institutions));
    // Record how to draw these accounts, alongside the balances. On a day the
    // app is never opened this cron is the only clean fetch there is, so
    // without it an account added since the last dashboard load would be in the
    // snapshot with nothing to render it from, and recovery would draw its
    // institution short (lib/last-known.ts reports the shortfall but cannot
    // undo it).
    await rememberAccounts(institutions);
    await clearCaches(); // cached payloads now have yesterday's history
    return NextResponse.json({ recorded: true });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Snapshot failed' }, { status: 500 });
  }
}
