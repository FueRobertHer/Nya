// lib/review-read.ts
//
// What the read layer (lib/activity.ts finishActivity) reads for the review
// queue and merchants' default categories, in one place: the queue's
// settings, the defaults and the approvals of the rows being read
// (lib/review-store.ts, lib/vendor-default-store.ts), each a display read
// that never fails for its own data's sake. What can't be read is a note and
// a mark on the rows it concerns (lib/review-layer.ts reviewLayerOf), never
// an empty store: no approval is taken for none, so nothing approved is put
// back in the queue, and no default for none, so a note says the defaults
// file nothing. Storage failing still throws, as every display read's does.

import type { Ctx } from './containers';
import { readApprovalsForDisplay, readReviewSettings } from './review-store';
import { readVendorDefaults } from './vendor-default-store';
import { approvalIdsOf, type ReviewParts } from './review-layer';
import type { OlderTxn, Txn } from './transactions';

/** The settings and the defaults, which don't depend on the rows: read
 *  beside everything else the read layer reads first. */
export async function readReviewBasics(ctx: Ctx): Promise<Pick<ReviewParts, 'settings' | 'settingsUnread' | 'defaults' | 'defaultsUnread'>> {
  const [settings, defaults] = await Promise.all([readReviewSettings(ctx), readVendorDefaults(ctx)]);
  return {
    settings: settings.settings ? { on: settings.settings.on, since: settings.settings.since } : null,
    settingsUnread: settings.unreadable || settings.unrecognised,
    defaults: defaults.state,
    defaultsUnread: defaults.unreadable || defaults.unrecognised,
  };
}

/** Everything the layer is built from, for these rows: the basics read
 *  first, and the approvals of the rows (only theirs, by id). */
export async function readReviewParts(ctx: Ctx, rows: Iterable<Txn | OlderTxn>, basics: Awaited<ReturnType<typeof readReviewBasics>>): Promise<ReviewParts> {
  const approvals = await readApprovalsForDisplay(ctx, approvalIdsOf(rows));
  return { ...basics, approvals: approvals.approvals, approvalsUnknown: approvals.unknown };
}
