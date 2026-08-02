import { NextResponse } from 'next/server';
import { setAccountHidden } from '@/lib/hidden';
import { computeNetWorth } from '@/lib/networth';
import { clearCaches, readCache, NET_WORTH_CACHE_KEY } from '@/lib/cache';
import { estimatedLayerCovers, clearBackfillDone } from '@/lib/history';

// Hides or unhides ONE account per request.
//
// One at a time, deliberately, for the same reason app/api/manual-accounts
// works that way: the client's account list can be stale (a tab left open, a
// second device, the localStorage snapshot painted before the network load
// resolves), and a whole-list write from that state would silently re-show or
// re-hide accounts it didn't know about.
//
// Note this does NOT clear the backfill flag. Hiding changes no balance, and
// the estimated history layer is corrected by subtraction at read time
// (lib/history.ts) rather than by regeneration, so a toggle costs zero Plaid
// calls. Clearing the flag would force a full transaction re-pull for nothing.

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const account_id = String(body?.account_id ?? '').slice(0, 100);
    const hidden = body?.hidden === true;
    if (!account_id) {
      return NextResponse.json({ error: 'Missing account id' }, { status: 400 });
    }

    // The account's type is stored alongside the id so that subtracting it from
    // past totals never depends on a live Plaid fetch succeeding. Look it up
    // once, here, while the account is definitely present.
    let type: string | null = null;
    if (hidden) {
      const findType = (institutions: any[]): string | null => {
        for (const inst of institutions ?? []) {
          const match = inst.accounts?.find((a: any) => a.account_id === account_id);
          if (match) return match.type;
        }
        return null;
      };

      // Try the cached payload first, since this is a lookup of one string and
      // a live computeNetWorth() fans out to every institution's balance
      // endpoint. But fall through to the live call when the account ISN'T
      // there: the cache lives for 15 minutes, so an account linked or created
      // in that window is missing from it, and treating that as "no such
      // account" would make a freshly added account impossible to hide.
      const cached = await readCache<{ institutions: any[] }>(NET_WORTH_CACHE_KEY);
      type = findType(cached?.institutions ?? []);
      if (!type) type = findType((await computeNetWorth()).institutions);

      if (!type) {
        return NextResponse.json(
          { error: 'That account is not currently available to hide' },
          { status: 404 }
        );
      }
    }

    await setAccountHidden(account_id, type ?? '', hidden);

    // The estimated layer can only subtract an account it knows about, either
    // via a per-date balance or via the flat term. If it knows neither -- the
    // account was linked after the last backfill, or the layer predates the
    // flat key existing -- force a recompute, or the estimated region would sit
    // high by this account's balance and put a step at the estimated/real seam.
    //
    // Checked by membership, not by type: a MANUAL depository account looks
    // like cash but is in the flat term, because backfill's cashType loop only
    // covers Plaid accounts.
    let recompute = false;
    if (hidden && !(await estimatedLayerCovers(account_id))) {
      await clearBackfillDone();
      recompute = true;
    }

    // Both cached payloads embed the visibility decision (net worth excludes
    // hidden accounts, transactions omit their rows), so both must go or the
    // change wouldn't show for up to the 15-minute TTL.
    await clearCaches();

    // The caller has to act on this: clearing the flag only makes a recompute
    // POSSIBLE, it doesn't trigger one. The client's automatic backfill fires
    // only when history is "thin", which is never true for anyone who already
    // has an estimated layer -- i.e. exactly the users this branch is for.
    return NextResponse.json({ account_id, hidden, recompute });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to update hidden accounts' }, { status: 500 });
  }
}
