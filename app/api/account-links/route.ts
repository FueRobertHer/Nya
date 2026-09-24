import { NextResponse } from 'next/server';
import {
  directoryLabels,
  dismissPair,
  isOffered,
  linkAccounts,
  liveAccountIds,
  loadSuggestionInputs,
  suggestLinks,
  unlinkAccount,
} from '@/lib/links';
import { clearCaches } from '@/lib/cache';

// Linking an account's history across a reconnect (lib/links.ts).
//
// GET lists what to offer (suggestions with evidence, and balance-only history
// the user can assign) and the links already made. POST links or dismisses,
// DELETE unlinks. Everything reads stored state only: opening the Accounts tab
// must not fan out to every institution's Plaid endpoints.
//
// A POST is honoured only for a pair GET would offer right now, recomputed here
// from this container's own data, so a client can't link or dismiss arbitrary
// ids. With #53 the container comes from the session, never the request body.

const MAX_ID = 100;
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null);

async function offered() {
  const inputs = await loadSuggestionInputs(await liveAccountIds());
  return { inputs, offer: suggestLinks(inputs) };
}

export async function GET() {
  try {
    const { inputs, offer } = await offered();
    const ids = [...inputs.links].flatMap(([old, l]) => [old, l.to]);
    const labels = await directoryLabels(ids);
    const links = [...inputs.links].map(([old, l]) => ({
      old,
      to: l.to,
      linked_at: l.linked_at,
      old_label: labels[old] ?? old,
      to_label: labels[l.to] ?? l.to,
      // The old id is live again (Plaid returned it, or the old institution was
      // re-added): the link is ignored until the user unlinks it.
      conflict: inputs.liveIds.has(old),
    }));
    return NextResponse.json({ suggestions: offer.suggestions, unclaimed: offer.unclaimed, links });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to load account links' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const old = id(body?.old);
    const to = id(body?.to);
    const action = body?.action;
    if (!old || !to || (action !== 'link' && action !== 'dismiss')) {
      return NextResponse.json({ error: 'Expected { action: "link" | "dismiss", old, to }' }, { status: 400 });
    }

    const { offer } = await offered();
    if (!isOffered(old, to, offer)) {
      return NextResponse.json({ error: 'That pair is not currently offered' }, { status: 409 });
    }

    if (action === 'dismiss') {
      // Changes no view, so nothing to invalidate.
      await dismissPair(old, to);
      return NextResponse.json({ dismissed: true });
    }

    const suggestion = offer.suggestions.find((s) => s.old === old && s.to === to);
    const unclaimed = offer.unclaimed.find((u) => u.old === old);
    await linkAccounts(old, to, suggestion
      ? { basis: 'suggested', ...suggestion.evidence }
      : { basis: 'picked', old_first: unclaimed?.first, old_last: unclaimed?.last, old_last_balance: unclaimed?.last_balance });
    // Cached payloads carry per-account history and hidden subtraction.
    await clearCaches();
    return NextResponse.json({ linked: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to update account links' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const old = id(body?.old);
    if (!old) return NextResponse.json({ error: 'Expected { old }' }, { status: 400 });
    await unlinkAccount(old);
    await clearCaches();
    return NextResponse.json({ unlinked: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to unlink' }, { status: 500 });
  }
}
