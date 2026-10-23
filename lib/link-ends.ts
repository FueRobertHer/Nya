// lib/link-ends.ts
//
// What a link would do to the end of the account it links to. An end
// follows an account across a link (lib/lifecycle.ts effectiveLifecycle: an
// account's own entry first, else the newest of its ids'), so linking an
// earlier account that ended (closed at the bank, no longer yours, not
// followed: the file's end, or one set by hand) ends the live account from
// that day too, and it counts in nothing from then. That is step one's model
// and stays: an end is about the account, whichever id it was set on, and
// reopening the live account afterwards (Accounts that ended) takes it away
// from every id. The link sheet says it before the link is made
// (components/AccountLinks.tsx), from what this works out. The end a count
// answer wrote for a restored account is left out: the link takes that one
// away first (lib/user-restore/answering.ts beforeLink).

import type { Ctx } from './containers';
import type { Link } from './link-core';
import { effectiveLifecycle, endOf, lifecycleOf, lifecycleStore, sameEnd, type EndedLifecycle } from './lifecycle';
import { restoredAnswersStore } from './user-restore/store';

/** A link that would end the live account it links to: from which day, and
 *  how the earlier account ended. */
export type CarriedEnd = { old: string; to: string; state: EndedLifecycle['state']; day: string };

/**
 * Of the links that could be made (`pairs`), those that would end the
 * account they link to, which isn't ended now (see the header). `links` are
 * the links that apply now. Strict: what can't be read throws.
 */
export async function endsALinkWouldCarry(ctx: Ctx, pairs: readonly { old: string; to: string }[], links: ReadonlyMap<string, Link>): Promise<CarriedEnd[]> {
  if (pairs.length === 0) return [];
  const entries = await lifecycleStore.getAll(ctx);
  if (entries.size === 0) return [];
  const answers = await restoredAnswersStore.getMany(ctx, [...new Set(pairs.map((p) => p.old))]);
  const now = effectiveLifecycle(entries, links);
  const out: CarriedEnd[] = [];
  for (const { old, to } of pairs) {
    if (now.ended.has(to)) continue;
    const after = new Map(entries);
    // The end a count answer wrote goes with the link (beforeLink).
    const wrote = answers.get(old)?.ended;
    const own = entries.get(old);
    if (wrote && own && sameEnd(own.lifecycle, wrote as EndedLifecycle)) after.delete(old);
    const linked = new Map(links);
    linked.set(old, { to, linked_at: new Date(0).toISOString(), evidence: {} } as Link);
    const view = effectiveLifecycle(after, linked);
    const ended = view.ended.get(to);
    const entry = lifecycleOf(view, to);
    if (!ended || !entry || endOf(entry.lifecycle) === null) continue;
    out.push({ old, to, state: entry.lifecycle.state as EndedLifecycle['state'], day: ended.from });
  }
  return out;
}
