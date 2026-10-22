// lib/earlier-names.ts
//
// The names the Earlier accounts list shows (components/AccountLinks.tsx),
// one per account, and the restore card's note that says to forget one
// (components/restore-state.ts), which must name it exactly as the list
// does: its label ("Chase Checking ••1111"), or "Balance history" for one
// whose directory entry can't be read. Forgetting is for good, so two that
// would read the same in the list (the same name over the same days: two
// accounts whose details are damaged, say) are told apart by the end of
// each one's id, which never changes. Pure, for the page and the server.

/** An account as the list holds it: its id, its label (null: none can be
 *  read) and its days. */
export type EarlierListed = { id: string; label: string | null; first: string | null; last: string | null };

/** The name the list shows for an account with no label. */
export const UNLABELLED = 'Balance history';

/** The end of each of these ids, by id: four characters, or as many more as
 *  it takes for no two to read the same. The same ids always end the same. */
export function idEnds(ids: readonly string[]): Map<string, string> {
  const longest = Math.max(...ids.map((id) => id.length));
  for (let n = 4; ; n++) {
    const cut = ids.map((id) => id.slice(-n));
    if (new Set(cut).size === ids.length || n >= longest) return new Map(ids.map((id, i) => [id, cut[i]]));
  }
}

/** Each account's name in the list (see the header), by id: its label, or
 *  "Balance history", then, where another would read the same over the same
 *  days, " · …" and the end of its id ("Balance history · …9vp2"). */
export function earlierNames(list: readonly EarlierListed[]): Map<string, string> {
  const base = (e: EarlierListed) => e.label ?? UNLABELLED;
  const alike = new Map<string, string[]>();
  for (const e of list) {
    const key = JSON.stringify([base(e), e.first, e.last]);
    alike.set(key, [...(alike.get(key) ?? []), e.id]);
  }
  const ends = new Map<string, string>();
  for (const ids of alike.values()) if (ids.length > 1) for (const [id, end] of idEnds(ids)) ends.set(id, end);
  return new Map(list.map((e) => [e.id, ends.has(e.id) ? `${base(e)} · …${ends.get(e.id)}` : base(e)]));
}

/**
 * Why the Earlier accounts list leaves an account out (lib/links.ts
 * whyUnlisted), in the order it is checked:
 *   live             it is reporting now;
 *   manual           it is a manual account;
 *   connected        its institution is still connected (its Item stored);
 *   link-unreadable  a link saved under its id can't be read;
 *   linked           it is linked to another account, whose history it is
 *                    part of;
 *   linked-to        another account is linked to it;
 *   unknown          there is nothing to list it by: no directory entry
 *                    that can be read, and no balance history.
 */
export type Unlisted = 'live' | 'manual' | 'connected' | 'link-unreadable' | 'linked' | 'linked-to' | 'unknown';
