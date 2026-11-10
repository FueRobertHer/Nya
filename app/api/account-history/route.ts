import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getAccountHistories, getAccountHistory } from '@/lib/history';
import { getLinks, effectiveLinks, liveAccountIds, previewLastSeen, sameAccountIds, type Link } from '@/lib/links';
import type { Ctx } from '@/lib/containers';

// Balance history for a single account (real snapshots + estimated
// backfill), for the per-account chart in the Accounts tab. Reads only from
// Redis -- no Plaid calls -- so it's fast enough to fetch on tap.
//
// Follows account links (lib/links.ts): history recorded under an id the
// account had before a reconnect is part of its chart. `with` adds one more
// old id for a preview before the user links it; it only ever reads this
// container's history, and nothing is stored.
//
// `ids` (comma-separated, up to MAX_IDS) answers several accounts from one
// read, `{ histories: { [id]: points } }`, each joined through its own links
// as `id` is: Accounts > Investments reads every investment account at once, and
// one read opens each stored day once (lib/history.ts getAccountHistories).
// It takes no `with`.

/** More investment accounts than anyone keeps. */
const MAX_IDS = 50;

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const params = new URL(req.url).searchParams;
    const many = params.get('ids');
    if (many !== null) return await several(ctx, many);
    const id = params.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing account id' }, { status: 400 });
    }
    const preview = params.get('with')?.slice(0, 100) || null;

    // A chart that can't read the links shows the account unjoined, which is
    // what it showed before links existed. Nothing is hidden or revealed by it.
    let links = new Map<string, Link>();
    try {
      links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx));
    } catch {
      links = new Map();
    }
    // A preview is the link as it would be made: added with the date the
    // link will record (lastSeenOf), so its history is ordered exactly as it
    // will be once linked, and the chart shown is the chart the user will get.
    if (preview && preview !== id && !links.has(preview)) {
      links = new Map(links);
      links.set(preview, {
        to: id,
        linked_at: new Date().toISOString(),
        evidence: { old_last: await previewLastSeen(ctx, preview) },
      });
    }
    const older = sameAccountIds(id, links).filter((x) => x !== id);

    const points = await getAccountHistory(ctx, id, older);
    return NextResponse.json({ points });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to fetch account history' }, { status: 500 });
  }
}

/** The `ids` form: each account's points, from one read. */
async function several(ctx: Ctx, list: string) {
  const ids = [...new Set(list.split(',').map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0) return NextResponse.json({ error: 'Missing account ids' }, { status: 400 });
  if (ids.length > MAX_IDS || ids.some((x) => x.length > 100)) {
    return NextResponse.json({ error: `Up to ${MAX_IDS} account ids at a time` }, { status: 400 });
  }
  // As for one account: links that can't be read leave each account unjoined.
  let links = new Map<string, Link>();
  try {
    links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx));
  } catch {
    links = new Map();
  }
  const all = await getAccountHistories(
    ctx,
    ids.map((id) => ({ account_id: id, olderIds: sameAccountIds(id, links).filter((x) => x !== id) }))
  );
  return NextResponse.json({ histories: Object.fromEntries(ids.map((id, i) => [id, all[i]])) });
}
