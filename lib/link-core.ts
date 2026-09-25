// lib/link-core.ts
//
// The pure core of account links (lib/links.ts): reading them and following
// them. Its own module so lib/last-known.ts and lib/vanished.ts can follow
// links without a circular import (lib/links.ts imports lib/last-known.ts).

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { decrypt } from './crypto';

// A lazy key, not a module constant: the container (#53) will be a parameter.
export const linksKey = (ctx: Ctx) => kc(ctx, 'account-links');

export type Link = { to: string; linked_at: string; evidence: Record<string, unknown> };

/**
 * Every readable link, old id -> link, and the old ids whose entries couldn't
 * be read or parsed. For the Accounts tab card, which lists the unreadable
 * ones so the user can remove them. Throws only if the hash can't be read.
 */
export async function readLinks(ctx: Ctx): Promise<{ links: Map<string, Link>; unreadable: Set<string> }> {
  const raw = (await redis().hgetall<Record<string, string>>(linksKey(ctx))) ?? {};
  const links = new Map<string, Link>();
  const unreadable = new Set<string>();
  await Promise.all(
    Object.entries(raw).map(async ([old, blob]) => {
      try {
        const parsed = JSON.parse(await decrypt(blob)) as Link;
        if (typeof parsed?.to !== 'string' || typeof parsed?.linked_at !== 'string') throw new Error('malformed');
        links.set(old, parsed);
      } catch {
        unreadable.add(old);
      }
    })
  );
  return { links, unreadable };
}

/**
 * Every link, old id -> link. Throws on a failed read or an unreadable entry:
 * hidden accounts follow links, and treating "couldn't read" as "no links"
 * would put a hidden account back on screen.
 */
export async function getLinks(ctx: Ctx): Promise<Map<string, Link>> {
  const { links, unreadable } = await readLinks(ctx);
  if (unreadable.size > 0) throw new Error(`Account link ${[...unreadable][0]} is unreadable`);
  return links;
}

/**
 * The links that apply: one whose old id is live again (Plaid omitted it once,
 * or the old Item was re-added) is ignored until the user unlinks it, or two
 * live accounts would be folded into one.
 */
export function effectiveLinks(links: Map<string, Link>, liveIds: Set<string>): Map<string, Link> {
  return new Map([...links].filter(([old]) => !liveIds.has(old)));
}

/** The id an account is known by now, following links. Stops at any repeat,
 *  so a cycle anywhere in a chain ends instead of looping, and follows chains
 *  of any realistic length. */
export function resolveId(id: string, links: Map<string, Link>): string {
  const seen = new Set([id]);
  let current = id;
  for (let i = 0; i < 50; i++) {
    const next = links.get(current)?.to;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/** When an earlier id last reported: recorded on the link (evidence.old_last),
 *  falling back to when it was linked. */
const lastReported = (l: Link) =>
  (typeof l.evidence?.old_last === 'string' ? (l.evidence.old_last as string) : null) ?? l.linked_at.slice(0, 10);

/**
 * Every id that is the same account as `id`: the current one first, then the
 * earlier ones, the one that reported most recently first. On a date two ids
 * both have, the first one listed wins, so the order follows the account's own
 * timeline rather than when the user happened to link each. The preview uses
 * the same order, so what it shows is what linking will do.
 */
export function sameAccountIds(id: string, links: Map<string, Link>): string[] {
  const root = resolveId(id, links);
  const older = [...links]
    .filter(([old]) => old !== root && resolveId(old, links) === root)
    .sort((a, b) => (lastReported(a[1]) < lastReported(b[1]) ? 1 : lastReported(a[1]) > lastReported(b[1]) ? -1 : 0))
    .map(([old]) => old);
  return [root, ...older];
}
