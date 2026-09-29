// lib/item-usage.ts
//
// Finds linked Plaid Items that are costing money and doing nothing, and FLAGS
// them. It never removes anything: the flagged Items are listed for the user in
// Manage accounts, and each is disconnected only by their own tap and typed
// confirmation (components/UnusedItems.tsx, then /api/disconnect).
//
// Plaid bills per connected Item per month whether or not anyone looks at it,
// so an Item that can no longer be read, or whose every account is hidden, is
// pure cost. An Item is flagged when, for UNUSED_DAYS running:
//   - Plaid keeps refusing it for a reason only the user can fix (a login that
//     needs redoing, consent withdrawn), or
//   - every account it holds is hidden.
// Either clears the moment it stops being true: a successful read that finds
// the Item working, or an account visible, starts the count again. A timeout,
// an outage or a rate limit says nothing and changes nothing. A flag is set only
// by a read made in the same run that confirms the condition, never by a clock
// an earlier run started: the Item may have been reconnected or unhidden since.
//
// The observations live in the container at "snapshot:item-usage" (a hash of
// item id -> record), under the cron's own namespace: like the daily snapshot's
// log it describes this environment's schedule, so exports leave it out and a
// restore keeps the target's own (lib/export.ts, lib/restore.ts). Losing it
// costs nothing but restarting the clocks.
//
// The check reads with /accounts/get, which carries no per-request charge, and
// also registers the webhook URL on Items linked before webhooks were set up.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { getItems, kc, redis, type StoredItem } from './storage';
import { getEffectiveHidden } from './links';
import { webhookUrlFor } from './webhook-url';
import type { Ctx } from './containers';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UNUSED_DAYS = 60;
/** Never shorter than this: a bank outage or a holiday away must not read as
 *  disuse. */
export const MIN_UNUSED_DAYS = 14;

/** Plaid's reasons an Item stays unreadable until the user acts. Left out on
 *  purpose: INVALID_ACCESS_TOKEN (what switching PLAID_ENV or the secret looks
 *  like), NO_ACCOUNTS and ITEM_LOCKED (a bank-side state that can clear alone). */
export const DEAD_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ITEM_NOT_FOUND',
  'ACCESS_NOT_GRANTED',
  'USER_PERMISSION_REVOKED',
  'ITEM_NO_LONGER_AVAILABLE',
  'INVALID_CREDENTIALS',
]);

export type FlagKind = 'refused' | 'hidden';

export type Usage = {
  first_seen: string;
  /** Since when the Item has been refused for a DEAD_CODES reason, or null. */
  error_since: string | null;
  /** Since when every account has been hidden, or null. */
  hidden_since: string | null;
  /** The webhook URL last registered on the Item, or null. */
  webhook: string | null;
  /** When the last check finished, or null. */
  checked_at: string | null;
  /** What the last check concluded: set only if confirmed by that check. */
  flagged: FlagKind | null;
  /** The run that last CONFIRMED the flag with a read of its own, as opposed to
   *  merely leaving it standing after a read that failed. Removal needs this to
   *  be the run made just before it (lib/admin-items.ts). A token, not a time:
   *  two runs can share a millisecond. */
  confirmed_run: string | null;
};

export function unusedDays(): number {
  const n = Number(process.env.PLAID_UNUSED_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_UNUSED_DAYS, Math.floor(n)) : DEFAULT_UNUSED_DAYS;
}

const usageKey = (ctx: Ctx) => kc(ctx, 'snapshot:item-usage');

function parseUsage(value: unknown, now: string): Usage {
  let r: any = value;
  if (typeof value === 'string') {
    try {
      r = JSON.parse(value);
    } catch {
      r = null;
    }
  }
  const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  return {
    first_seen: date(r?.first_seen) ?? now,
    error_since: date(r?.error_since),
    hidden_since: date(r?.hidden_since),
    webhook: typeof r?.webhook === 'string' ? r.webhook : null,
    checked_at: date(r?.checked_at),
    flagged: r?.flagged === 'refused' || r?.flagged === 'hidden' ? r.flagged : null,
    confirmed_run: typeof r?.confirmed_run === 'string' ? r.confirmed_run : null,
  };
}

/** Which flag an Item earns as of `now`, or null. */
export function unusedKind(
  u: Usage,
  now: number,
  days: number,
  /** Whether THIS run's read confirmed each condition (see the header). */
  fresh: { error: boolean; hidden: boolean } = { error: true, hidden: true }
): FlagKind | null {
  const older = (since: string | null) => since !== null && now - Date.parse(since) >= days * DAY_MS;
  if (fresh.error && older(u.error_since)) return 'refused';
  if (fresh.hidden && older(u.hidden_since)) return 'hidden';
  return null;
}

export type FlaggedItem = {
  item_id: string;
  institution_name: string;
  kind: FlagKind;
  /** ISO time the condition was first seen. */
  since: string;
  checked_at: string | null;
  confirmed_run: string | null;
};

/** The linked Items the last check flagged, for the user to review. Reads
 *  only: nothing here calls Plaid. */
export async function readFlagged(ctx: Ctx): Promise<FlaggedItem[]> {
  const [items, stored] = await Promise.all([
    getItems(ctx),
    redis().hgetall(usageKey(ctx)).then((v) => (v ?? {}) as Record<string, unknown>),
  ]);
  const now = new Date().toISOString();
  const out: FlaggedItem[] = [];
  for (const item of items) {
    const u = parseUsage(stored[item.item_id], now);
    if (!u.flagged) continue;
    const since = u.flagged === 'refused' ? u.error_since : u.hidden_since;
    if (!since) continue;
    out.push({ item_id: item.item_id, institution_name: item.institution_name, kind: u.flagged, since, checked_at: u.checked_at, confirmed_run: u.confirmed_run });
  }
  return out;
}

export type UsageReport = { checked: number; flagged: number };

/**
 * Checks every linked Item of a container, updates its records and flags.
 * Removes nothing. Never throws for one Item's trouble: that Item is left as it
 * was and the rest go on.
 */
export async function checkItemUsage(
  ctx: Ctx,
  opts: { now?: number; days?: number; runId?: string; onlyItemId?: string } = {}
): Promise<UsageReport> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? unusedDays();
  const stamp = new Date(now).toISOString();
  const run = opts.runId ?? crypto.randomUUID();

  const all = await getItems(ctx);
  // One Item only: the recheck before a removal, which should not wait on every
  // other connection's bank (and whose hidden-set read then stays fresh).
  const items = opts.onlyItemId ? all.filter((i) => i.item_id === opts.onlyItemId) : all;
  const report: UsageReport = { checked: items.length, flagged: 0 };
  if (items.length === 0) return report;

  const stored = ((await redis().hgetall(usageKey(ctx))) ?? {}) as Record<string, unknown>;

  // The hidden set decides one of the two tests. If it can't be read, that test
  // is not run: guessing "nothing is hidden" is the safe direction, since it
  // can only keep an Item unflagged.
  let hidden: Map<string, unknown> | null = null;
  try {
    const read = await getEffectiveHidden(ctx);
    // Without the live ids a paused account link counts as active, which can
    // hide more than the user did (lib/links.ts): not a set to flag on.
    if (read.liveOk) hidden = read.hidden as unknown as Map<string, unknown>;
    else console.error('Item check: live accounts could not be read; skipping the hidden-accounts test.');
  } catch {
    console.error('Item check: the hidden set could not be read; skipping the hidden-accounts test.');
  }

  const webhook = webhookUrlFor(ctx) ?? null;

  for (const item of items) {
    const usage = await checkOne(item, parseUsage(stored[item.item_id], stamp), { now, days, stamp, run, hidden, webhook });
    if (usage.flagged) report.flagged++;
    try {
      await redis().hset(usageKey(ctx), { [item.item_id]: JSON.stringify(usage) });
    } catch (err) {
      console.error('Item check: a record could not be saved.', err instanceof Error ? err.name : typeof err);
    }
  }

  // Records of Items that are gone (a full run only).
  if (opts.onlyItemId) return report;
  try {
    const live = new Set((await getItems(ctx)).map((i) => i.item_id));
    const stale = Object.keys(stored).filter((id) => !live.has(id));
    if (stale.length > 0) await redis().hdel(usageKey(ctx), ...stale);
  } catch (err) {
    console.error('Item check: old records could not be dropped.', err instanceof Error ? err.name : typeof err);
  }

  return report;
}

async function checkOne(
  item: StoredItem,
  usage: Usage,
  o: { now: number; days: number; stamp: string; run: string; hidden: Map<string, unknown> | null; webhook: string | null }
): Promise<Usage> {
  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    return usage; // can't be checked: left exactly as it was
  }

  let ids: string[] | null = null;
  let deadNow = false;
  try {
    const res = await plaidClient.accountsGet({ access_token });
    // /accounts/get is served from what Plaid holds, so a broken Item may answer
    // 200 with the error attached to the Item instead of throwing.
    const itemError = (res.data as any).item?.error?.error_code;
    if (typeof itemError === 'string' && DEAD_CODES.has(itemError)) {
      deadNow = true;
    } else {
      ids = res.data.accounts.map((a) => a.account_id);
      usage.error_since = null;
    }
  } catch (err: any) {
    const code = err?.response?.data?.error_code;
    deadNow = typeof code === 'string' && DEAD_CODES.has(code);
    // Anything else (a timeout, an outage, a rate limit) leaves the clock as it was.
  }
  if (deadNow) usage.error_since ??= o.stamp;

  // Hidden-set test, run only with a good read of both the accounts and the set.
  let hiddenNow = false;
  if (ids !== null && o.hidden !== null) {
    const allHidden = ids.length > 0 && ids.every((id) => o.hidden!.has(id));
    usage.hidden_since = allHidden ? (usage.hidden_since ?? o.stamp) : null;
    hiddenNow = allHidden;
  }

  const kind = unusedKind(usage, o.now, o.days, { error: deadNow, hidden: hiddenNow });
  if (kind) {
    usage.flagged = kind;
    usage.confirmed_run = o.run;
  } else if (ids !== null || deadNow) {
    // A read that worked, or one that confirmed the Item is refused but not
    // yet for long enough: either way the old verdict no longer stands. The
    // exception is a hidden flag when the hidden set couldn't be read to
    // confirm it.
    if (!(usage.flagged === 'hidden' && o.hidden === null)) {
      usage.flagged = null;
      usage.confirmed_run = null;
    }
  }
  // A read that failed for any other reason says nothing: the flag stays.
  usage.checked_at = o.stamp;

  // Register the webhook on an Item that predates it (free, and once per URL).
  if (ids !== null && o.webhook && usage.webhook !== o.webhook) {
    try {
      await plaidClient.itemWebhookUpdate({ access_token, webhook: o.webhook });
      usage.webhook = o.webhook;
    } catch {
      // Tried again on the next run.
    }
  }
  return usage;
}
