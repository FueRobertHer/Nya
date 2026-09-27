import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import {
  directoryLabels,
  dismissAll,
  dismissPair,
  isUnclaimed,
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
// the user can assign), the links already made, and any saved link that can't
// be read (`broken`), so the user can remove it. POST links or dismisses,
// DELETE unlinks. Everything reads stored state only: opening the Accounts tab
// must not fan out to every institution's Plaid endpoints.
//
// A POST is honoured only for a pair GET would offer right now, recomputed here
// from this container's own data, so a client can't link or dismiss arbitrary
// ids. With #53 the container comes from the session, never the request body.

const MAX_ID = 100;
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null);

async function offered(ctx: Ctx) {
  const inputs = await loadSuggestionInputs(ctx, await liveAccountIds(ctx));
  return { inputs, offer: suggestLinks(inputs) };
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { inputs, offer } = await offered(ctx);
    const ids = [...inputs.links].flatMap(([old, l]) => [old, l.to]);
    const labels = await directoryLabels(ctx, ids);
    const links = [...inputs.links].map(([old, l]) => ({
      old,
      to: l.to,
      linked_at: l.linked_at,
      // An account known only from balances has no name: say what it was.
      old_label:
        labels[old] ??
        (typeof l.evidence?.old_last === 'string' ? `Earlier account (history to ${l.evidence.old_last})` : 'Earlier account'),
      to_label: labels[l.to] ?? l.to,
      // The old id is live again (Plaid returned it, or the old institution was
      // re-added): the link is ignored until the user unlinks it.
      conflict: inputs.liveIds.has(old),
    }));
    return NextResponse.json({
      suggestions: offer.suggestions,
      unclaimed: offer.unclaimed,
      links,
      broken: [...inputs.unreadableLinks],
    });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to load account links' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    const old = id(body?.old);
    const to = id(body?.to);
    const action = body?.action;

    // "None of these": stop offering this earlier account at all.
    if (action === 'dismiss_all') {
      if (!old) return NextResponse.json({ error: 'Expected { old }' }, { status: 400 });
      const { offer } = await offered(ctx);
      if (!isUnclaimed(old, offer)) {
        return NextResponse.json({ error: 'That account is not currently offered' }, { status: 409 });
      }
      await dismissAll(ctx, old);
      return NextResponse.json({ dismissed: true });
    }

    if (!old || !to || (action !== 'link' && action !== 'dismiss')) {
      return NextResponse.json({ error: 'Expected { action: "link" | "dismiss" | "dismiss_all", old, to }' }, { status: 400 });
    }

    const { inputs, offer } = await offered(ctx);
    if (!isOffered(old, to, offer)) {
      return NextResponse.json({ error: 'That pair is not currently offered' }, { status: 409 });
    }

    if (action === 'dismiss') {
      // Changes no view, so nothing to invalidate.
      await dismissPair(ctx, old, to);
      return NextResponse.json({ dismissed: true });
    }

    const suggestion = offer.suggestions.find((s) => s.old === old && s.to === to);
    const unclaimed = offer.unclaimed.find((u) => u.old === old);
    // Recorded on the link: when the earlier id last reported (the order its
    // history is joined in) and what kind of account it was, so a hidden
    // account's earlier id is subtracted with its own sign. An id known only
    // from balances takes the target's kind: the user said it is the same
    // account, and the preview is where a wrong pairing would show.
    const old_type = inputs.directory[old]?.type ?? inputs.directory[to]?.type ?? null;
    await linkAccounts(ctx, 
      old,
      to,
      suggestion
        ? { basis: 'suggested', old_type, ...suggestion.evidence }
        : { basis: 'picked', old_type, old_first: unclaimed?.first, old_last: unclaimed?.last, old_last_balance: unclaimed?.last_balance }
    );
    // Cached payloads carry per-account history and hidden subtraction.
    await clearCaches(ctx);
    return NextResponse.json({ linked: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to update account links' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    const old = id(body?.old);
    if (!old) return NextResponse.json({ error: 'Expected { old }' }, { status: 400 });
    await unlinkAccount(ctx, old);
    await clearCaches(ctx);
    return NextResponse.json({ unlinked: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err);
    return NextResponse.json({ error: 'Failed to unlink' }, { status: 500 });
  }
}
