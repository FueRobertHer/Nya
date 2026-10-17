import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { UnreadableValueError } from '@/lib/repo';
import { taxonomyForReading } from '@/lib/category-store';
import { categoryById, indexTaxonomy } from '@/lib/categories';
import { clearDefault, repairDefaults, restoreVendorEntry, VendorDefaultError, vendorDefaultsStore } from '@/lib/vendor-default-store';
import { isVendorEntry } from '@/lib/vendor-defaults';

// Merchants' default categories (lib/vendor-defaults.ts): the Defaults list
// under Manage, and a transaction's detail, which say what each default is and
// clear one. A default is set by the person's own categorizations
// (app/api/recategorize, which records each), never here.
//
// GET     every merchant with a default: { defaults: [{ id, name,
//         category_id, since, agree, set_at }] }, the category followed
//         through a merge, `agree` how many of its last three
//         categorizations agree with it now. 409 when they can't be read
//         (with `repairable` when their bytes are damaged).
// DELETE  { id }: clears that merchant's default and forgets its
//         categorizations, so two that agree set one afresh. 404 when there
//         is none.
// POST    { action: "restore", after, previous }: Card Mode's undo of a
//         categorization's vote, as the recategorization answered it (only
//         while the merchant's entry is still exactly `after`, what that vote
//         left);
//         { action: "repair", confirm: true }: removes the defaults if their
//         bytes are damaged.
//
// Strict throughout: the value is read before every change, and one that
// can't be read is never saved over (409, lib/store-failure.ts).

const ENTRY_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_BODY_CHARS = 16 * 1024;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function body(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad('Request too large', 413);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    return bad('Invalid request');
  }
}

/** A store failure, flagged `repairable` when the value's bytes are damaged
 *  (never when a later release wrote it). */
const failure = (err: unknown, what: string) =>
  storeFailure(err, what, err instanceof UnreadableValueError && !err.unrecognised ? { repairable: true } : undefined);

export async function GET() {
  try {
    const ctx = await dataCtx();
    const state = await vendorDefaultsStore.get(ctx);
    // Followed through merges where the categories can be read; as kept
    // otherwise (the list then names them by id, and the page by its own set).
    const ix = await taxonomyForReading(ctx)
      .then((r) => indexTaxonomy(r.taxonomy))
      .catch(() => null);
    const resolve = (id: string) => (ix ? (categoryById(ix, id)?.id ?? null) : id);
    const defaults = (state?.vendors ?? []).flatMap((e) => {
      if (!e.default) return [];
      const category_id = resolve(e.default.category_id) ?? e.default.category_id;
      return [
        {
          id: e.id,
          name: e.name,
          category_id,
          since: e.default.since,
          agree: e.votes.filter((v) => (resolve(v.category_id) ?? v.category_id) === category_id).length,
          set_at: e.default.set_at,
        },
      ];
    });
    defaults.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ defaults });
  } catch (err) {
    return failure(err, 'Failed to read your defaults');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const b = await body(req);
    if (b instanceof NextResponse) return b;
    if (Object.keys(b).some((k) => k !== 'id')) return bad('Say only which default to clear');
    if (typeof b.id !== 'string' || !ENTRY_ID.test(b.id)) return bad('Invalid default');
    if (!(await clearDefault(ctx, b.id))) return bad('That default was already cleared. Reload to see your defaults as they are.', 404);
    return NextResponse.json({ success: true });
  } catch (err) {
    return failure(err, 'Failed to clear the default');
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const b = await body(req);
    if (b instanceof NextResponse) return b;
    if (b.action === 'repair') {
      if (Object.keys(b).some((k) => k !== 'action' && k !== 'confirm')) return bad('Unknown action');
      if (b.confirm !== true) return bad('Removing damaged defaults needs your confirmation');
      return NextResponse.json({ removed: await repairDefaults(ctx) });
    }
    if (b.action !== 'restore' || Object.keys(b).some((k) => !['action', 'after', 'previous'].includes(k))) return bad('Unknown action');
    if (!isVendorEntry(b.after)) return bad('Say what the vote being undone left');
    if (!(b.previous === null || isVendorEntry(b.previous))) return bad('What it was before isn’t a merchant’s categories');
    const restored = await restoreVendorEntry(ctx, { after: b.after, previous: b.previous });
    return NextResponse.json({ restored });
  } catch (err) {
    if (err instanceof VendorDefaultError) return bad(err.message, err.status);
    return failure(err, 'Failed to change your defaults');
  }
}
