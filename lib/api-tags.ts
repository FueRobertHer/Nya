// lib/api-tags.ts
//
// The read-only API's tags (#40): what /api/v1/tags and the MCP server's
// list_tags answer. Read the way every answer built on transactions is read
// (lib/api-read.ts readActivity, the Activity tab's own assembly), so a tag's
// count is of the rows the app shows: the window the API reads, hidden
// accounts left out unless asked for, and a tag counted wherever it is on a
// row, put there by the person, carried from an earlier account, or added by
// a rule. Only tags that exist are ever named: one deleted is in no answer.
// Tags that can't be read are a 409 (unreadable), never an empty list.

import type { Ctx } from './containers';
import { firstDay, readActivity, withoutTransactionsNotes, type ApiSource } from './api-read';
import { readTagSet } from './tags';
import { bankRows } from './split-rows';
import { tagVersion } from './api-versions';
import { historyCount } from './spending';

export type ApiTag = {
  id: string;
  name: string;
  /** One of gray, red, orange, yellow, green, teal, blue, purple or pink; a
   *  later version may add colors. */
  color: string;
  /** Transactions carrying it, in the window the API reads. */
  transactions: number;
  last_date: string | null;
  /** Changes whenever its name or color does (lib/api-versions.ts). Added in
   *  version 1. */
  version: string;
};

export async function readTags(ctx: Ctx, opts: { includeHidden?: boolean } = {}): Promise<{ from: string; tags: ApiTag[]; sources: ApiSource[]; notes: string[] }> {
  // Strict: the read that answers 409 when the tags can't be read.
  const [activity] = await Promise.all([readActivity(ctx, !!opts.includeHidden), readTagSet(ctx)]);
  const seen = new Map<string, { transactions: number; last_date: string | null }>();
  // Each transaction once, a split one whole and a group's each on its own
  // (lib/split-rows.ts): its parts carry its tags, and are one transaction.
  for (const t of bankRows(activity.rows)) {
    for (const id of t.tags ?? []) {
      const s = seen.get(id) ?? { transactions: 0, last_date: null };
      s.transactions++;
      if (!s.last_date || t.date > s.last_date) s.last_date = t.date;
      seen.set(id, s);
    }
  }
  return {
    from: firstDay(),
    tags: (activity.tags?.tags ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      ...(seen.get(t.id) ?? { transactions: 0, last_date: null }),
      version: tagVersion(t),
    })),
    sources: activity.sources,
    notes: [...activity.notes, ...withoutTransactionsNotes(activity.view, historyCount(activity.rows), 'list')],
  };
}
