import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { emptyTagSet, readTagSet, TagError, type TagSet } from '@/lib/tags';
import { txnAnnotationStore } from '@/lib/txn-annotations';
import { changeTags } from '@/lib/tag-actions';

// Your tags (lib/tags.ts), for the Tags screen in Settings, Transactions
// (components/TagsCard.tsx) and the tag pickers on a transaction.
//
// GET answers the tags (`tags`, the stored list, or an empty one) and, for
// each, how many transactions it was put on by hand (`counts`; what rules add
// is counted on the Activity tab, where they apply).
//
// POST makes one change, named by `action`, in one compare-and-set, and
// answers the tags as they are after it. A change refused says why (400 a bad
// request, 404 a tag gone since the page loaded, 409 a name another tag has
// or too many tags). Nothing here drops a cache: tags are applied after it
// (lib/activity.ts), so a change shows on the next load of the list.
//
//   add     { name, color? }
//   rename  { id, name }
//   recolor { id, color }
//   delete  { id }   (off every transaction and out of every rule: lib/tag-delete.ts)
//
// A deletion cut off part way is finished before any change here
// (lib/tag-delete.ts finishDeleting). Each action is lib/tag-actions.ts, which
// the API's writes call too.

const MAX_BODY_CHARS = 4 * 1024;

function failure(err: unknown, what: string): NextResponse {
  if (err instanceof TagError) return NextResponse.json({ error: err.message }, { status: err.status });
  return storeFailure(err, what);
}

/** How many transactions each tag was put on by hand. Read leniently: a
 *  count for the screen, which nothing writes or deletes on (a record that
 *  can't be read isn't counted). */
async function handCounts(ctx: Awaited<ReturnType<typeof dataCtx>>, set: TagSet): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(set.tags.map((t) => [t.id, 0]));
  for (const record of (await txnAnnotationStore.getAllLenient(ctx)).values()) {
    for (const id of record.tags ?? []) if (id in counts) counts[id]++;
  }
  return counts;
}

export async function GET() {
  try {
    const ctx = await dataCtx();
    const set = (await readTagSet(ctx)) ?? emptyTagSet();
    return NextResponse.json({ tags: set, counts: await handCounts(ctx, set) });
  } catch (err) {
    return failure(err, 'Failed to load your tags');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // Whatever an earlier deletion left to sweep goes first (lib/tag-actions.ts).
    const done = await changeTags(ctx, body);
    if (!done) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const set: TagSet = done.set;
    return NextResponse.json({ tags: set, counts: await handCounts(ctx, set), ...(done.made ? { created: done.made } : {}) });
  } catch (err) {
    return failure(err, 'Failed to change your tags');
  }
}
