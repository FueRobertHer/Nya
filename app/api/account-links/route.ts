import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import {
  ForgetRefused,
  PROVIDER,
  directoryLabels,
  dismissAll,
  dismissPair,
  effectiveLinks,
  forgetEarlierAccount,
  forgettableAccounts,
  withLinksLock,
  isManualChoice,
  isUnclaimed,
  isOffered,
  linkAccounts,
  liveAccountIds,
  loadSuggestionInputs,
  manualChoices,
  suggestLinks,
  unlinkAccount,
} from '@/lib/links';
import { clearCaches } from '@/lib/cache';
import { contentKey, readStoredTxns } from '@/lib/transactions';
import { carriedCategories, carryCounts, getCarried, getOverrides } from '@/lib/overrides';
import { rememberedIdsByItem } from '@/lib/last-known';
import type { Link } from '@/lib/link-core';
import { getHiddenAccounts } from '@/lib/hidden';
import { getItems } from '@/lib/storage';

// Linking an account's history across a reconnect (lib/links.ts).
//
// GET lists what to offer (suggestions with evidence, and balance-only history
// the user can assign), every earlier account that can be linked by hand
// (`manual`), the links already made with how many categories each carried
// across, and any saved link that can't be read (`broken`), so the user can
// remove it. POST links or dismisses, DELETE unlinks. Everything reads stored
// state only: opening the Accounts tab must not fan out to every
// institution's Plaid endpoints.
//
// A POST is honoured only for a pair GET would offer right now (or list for
// linking by hand), recomputed here from this container's own data, so a
// client can't link or dismiss arbitrary ids. With #53 the container comes
// from the session, never the request body.

const MAX_ID = 100;
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null);

async function offered(ctx: Ctx) {
  const inputs = await loadSuggestionInputs(ctx, await liveAccountIds(ctx));
  return { inputs, offer: suggestLinks(inputs), manual: manualChoices(inputs) };
}

/**
 * Per linked earlier account, how many categorized rows it had and how many
 * show on the account now (lib/overrides.ts). Reads nothing more unless an
 * active link actually carries something, and then only the stores of the
 * Items that own the accounts it lands on. Empty when that can't be read.
 */
async function categoryCounts(ctx: Ctx, links: Map<string, Link>, liveIds: Set<string>) {
  try {
    const active = effectiveLinks(links, liveIds);
    if (active.size === 0) return {};
    const carried = await getCarried(ctx, [...active.keys()]);
    const categories = carriedCategories(carried, active);
    if (categories.size === 0) return carryCounts(carried, active, new Set());
    const targets = new Set([...categories.keys()].map((k) => k.slice(0, k.indexOf('|'))));
    const byItem = await rememberedIdsByItem(ctx);
    const items = Object.entries(byItem).filter(([, ids]) => ids.some((id) => targets.has(id))).map(([item_id]) => item_id);
    const own = await getOverrides(ctx);
    const shown = new Set<string>();
    for (const item_id of items) {
      try {
        for (const t of await readStoredTxns(ctx, item_id, { shown: true })) {
          // A row with a category of its own shows that one, not the carried one.
          if (own[t.transaction_id] === undefined) shown.add(contentKey(t.account_id, t));
        }
      } catch {
        // an unreadable store counts as nothing carried yet
      }
    }
    return carryCounts(carried, active, shown);
  } catch {
    return {};
  }
}

/**
 * The earlier accounts to offer for forgetting. Empty when what decides it
 * can't be read: with the live accounts unreadable every account would look
 * like an earlier one.
 */
async function earlierAccounts(ctx: Ctx, inputs: Awaited<ReturnType<typeof offered>>['inputs']) {
  try {
    const [live, hidden, items] = await Promise.all([liveAccountIds(ctx, { strict: true }), getHiddenAccounts(ctx), getItems(ctx)]);
    return forgettableAccounts({ ...inputs, liveIds: live }, new Set(hidden.keys()), new Set(items.map((i) => i.item_id)));
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { inputs, offer, manual } = await offered(ctx);
    const ids = [...inputs.links].flatMap(([old, l]) => [old, l.to]);
    const [labels, counts, forgettable] = await Promise.all([
      directoryLabels(ctx, ids),
      categoryCounts(ctx, inputs.links, inputs.liveIds),
      earlierAccounts(ctx, inputs),
    ]);
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
      // Categories set on the earlier account's transactions, and how many
      // match a transaction of this one (so far: the rows arrive as it syncs).
      ...(counts[old] ? { categories: counts[old] } : {}),
    }));
    return NextResponse.json({
      suggestions: offer.suggestions,
      unclaimed: offer.unclaimed,
      manual,
      // Earlier accounts the user can forget for good (hidden ones say so).
      earlier: forgettable,
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

/** Links an offered (or by-hand) pair, recomputed from this container's own
 *  data right now. Run inside withLinksLock. */
async function linkPair(ctx: Ctx, old: string, to: string) {
  const { inputs, offer, manual } = await offered(ctx);
  const byHand = !isOffered(old, to, offer) && isManualChoice(old, to, manual);
  if (!isOffered(old, to, offer) && !byHand) {
    return NextResponse.json({ error: 'That pair is not currently offered' }, { status: 409 });
  }

  const suggestion = offer.suggestions.find((s) => s.old === old && s.to === to);
  const unclaimed = offer.unclaimed.find((u) => u.old === old) ?? manual.find((m) => m.old === old);
  // Recorded on the link: when the earlier id last reported (the order its
  // history is joined in) and what kind of account it was, so a hidden
  // account's earlier id is subtracted with its own sign. An id known only
  // from balances takes the target's kind: the user said it is the same
  // account, and the preview is where a wrong pairing would show.
  const old_type = inputs.directory[old]?.type ?? inputs.directory[to]?.type ?? null;
  // Which provider each side came from: one today, recorded so a link
  // between two aggregators' ids needs no change to what is stored.
  const providers = {
    old_provider: inputs.directory[old]?.provider ?? PROVIDER,
    to_provider: inputs.directory[to]?.provider ?? PROVIDER,
  };
  await linkAccounts(ctx, 
    old,
    to,
    suggestion
      ? { basis: 'suggested', old_type, ...providers, ...suggestion.evidence }
      : {
          basis: byHand ? 'by_hand' : 'picked',
          old_type,
          ...providers,
          old_first: unclaimed?.first,
          old_last: unclaimed?.last,
          old_last_balance: unclaimed?.last_balance,
        }
  );
  // Cached payloads carry per-account history and hidden subtraction.
  await clearCaches(ctx);
  return NextResponse.json({ linked: true });
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json().catch(() => null);
    const old = id(body?.old);
    const to = id(body?.to);
    const action = body?.action;

    // Forget an earlier account for good: its balances, name and carried
    // categories (lib/links.ts forgetEarlierAccount re-checks it may).
    if (action === 'forget') {
      if (!old) return NextResponse.json({ error: 'Expected { old }' }, { status: 400 });
      try {
        const { unreadable } = await withLinksLock(ctx, () => forgetEarlierAccount(ctx, old));
        await clearCaches(ctx);
        // `unreadable`: dates whose maps no one can decrypt, left as they are.
        return NextResponse.json({ forgotten: true, unreadable });
      } catch (err) {
        if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
        throw err;
      }
    }

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
      return NextResponse.json({ error: 'Expected { action: "link" | "dismiss" | "dismiss_all" | "forget", old, to }' }, { status: 400 });
    }

    if (action === 'link') {
      try {
        return await withLinksLock(ctx, () => linkPair(ctx, old, to));
      } catch (err) {
        if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
        throw err;
      }
    }
    // "Not the same" / "Not this one": only for a pair on offer.
    const { offer } = await offered(ctx);
    if (!isOffered(old, to, offer)) {
      return NextResponse.json({ error: 'That pair is not currently offered' }, { status: 409 });
    }
    // Changes no view, so nothing to invalidate.
    await dismissPair(ctx, old, to);
    return NextResponse.json({ dismissed: true });
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
