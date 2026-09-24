import { NextResponse } from 'next/server';
import { getAccountHistory } from '@/lib/history';
import { getLinks, effectiveLinks, liveAccountIds, sameAccountIds } from '@/lib/links';

// Balance history for a single account (real snapshots + estimated
// backfill), for the per-account chart in the Accounts tab. Reads only from
// Redis -- no Plaid calls -- so it's fast enough to fetch on tap.
//
// Follows account links (lib/links.ts): history recorded under an id the
// account had before a reconnect is part of its chart. `with` adds one more
// old id for a preview before the user links it; it only ever reads this
// container's history, and nothing is stored.

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const id = params.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing account id' }, { status: 400 });
    }
    const preview = params.get('with')?.slice(0, 100) || null;

    // A chart that can't read the links shows the account unjoined, which is
    // what it showed before links existed. Nothing is hidden or revealed by it.
    let older: string[] = [];
    try {
      const links = effectiveLinks(await getLinks(), await liveAccountIds());
      older = sameAccountIds(id, links).filter((x) => x !== id);
    } catch {
      older = [];
    }
    if (preview && preview !== id && !older.includes(preview)) older = [...older, preview];

    const points = await getAccountHistory(id, older);
    return NextResponse.json({ points });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fetch account history' }, { status: 500 });
  }
}
