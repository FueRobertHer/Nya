// lib/link-core.ts
//
// The pure core of account links (lib/links.ts): reading them and following
// them. Its own module so lib/last-known.ts and lib/vanished.ts can follow
// links without a circular import (lib/links.ts imports lib/last-known.ts).

import { redis, k } from './storage';
import { decrypt } from './crypto';

// A lazy key, not a module constant: the container (#53) will be a parameter.
export const linksKey = () => k('account-links');

export type Link = { to: string; linked_at: string; evidence: Record<string, unknown> };

/**
 * Every link, old id -> link. Throws on a failed read or an unreadable entry:
 * hidden accounts follow links, and treating "couldn't read" as "no links"
 * would put a hidden account back on screen.
 */
export async function getLinks(): Promise<Map<string, Link>> {
  const raw = (await redis().hgetall<Record<string, string>>(linksKey())) ?? {};
  const out = new Map<string, Link>();
  await Promise.all(
    Object.entries(raw).map(async ([old, blob]) => {
      const parsed = JSON.parse(await decrypt(blob)) as Link;
      if (typeof parsed?.to !== 'string') throw new Error(`Account link ${old} is malformed`);
      out.set(old, parsed);
    })
  );
  return out;
}

/**
 * The links that apply: one whose old id is live again (Plaid omitted it once,
 * or the old Item was re-added) is ignored until the user unlinks it, or two
 * live accounts would be folded into one.
 */
export function effectiveLinks(links: Map<string, Link>, liveIds: Set<string>): Map<string, Link> {
  return new Map([...links].filter(([old]) => !liveIds.has(old)));
}

/** The id an account is known by now, following links (cycle-guarded). */
export function resolveId(id: string, links: Map<string, Link>): string {
  let current = id;
  for (let i = 0; i < 5; i++) {
    const next = links.get(current)?.to;
    if (!next || next === id) break;
    current = next;
  }
  return current;
}

/** Every id that is the same account as `id`, the current one first, then
 *  older ones newest link first. */
export function sameAccountIds(id: string, links: Map<string, Link>): string[] {
  const root = resolveId(id, links);
  const older = [...links]
    .filter(([old]) => old !== root && resolveId(old, links) === root)
    .sort((a, b) => (a[1].linked_at < b[1].linked_at ? 1 : -1))
    .map(([old]) => old);
  return [root, ...older];
}

