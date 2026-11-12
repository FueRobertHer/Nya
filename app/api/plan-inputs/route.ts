import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/repo';
import { readPlanAnswer } from '@/lib/plan-copies';
import { getItems, type StoredItem } from '@/lib/storage';
import { syncInvestments } from '@/lib/invstore';
import { readAccountCaches, writeAccountCache } from '@/lib/cache';
import { activityWithImports, hasCurrentImports, hasPlanFields, type InvestmentActivity } from '@/lib/investment-activity';
import { importKeysOrNull, importsFingerprint, readAccountImports } from '@/lib/investment-imports-store';
import type { AccountImport } from '@/lib/investment-imports';
import { begin } from '@/lib/eager';
import { loggable } from '@/lib/log-safe';

// The Plan's inputs in one request, for Home's FI line and the Plan tab
// alike (lib/plan-inputs-store.ts keeps one copy of the answer for both):
// the saved plan and the currency its figures are in, as GET /api/fire-plan
// answers them, and each workplace plan's trailing year of contributions,
// as GET /api/investment-activity answers them for the account.
//
// GET ?plan=<item_id>:<account_id>, once per workplace plan, answers
// { plan, currency, ..., plans: [{ id, ... }] }, a row for each plan asked
// for, in the order asked: its contribution fields (contributions_12m and
// the rest, and the note), or `pending: true` when its activity isn't
// cached, or `failed: true` when it can't be had (an id that isn't one, an
// item that isn't linked, a sync that threw). Nothing waits on Plaid: the
// plan's reads (lib/plan-copies.ts readPlanAnswer) and every cached row are
// begun together, one round trip. A saved plan
// that can't be read is a 409 flagged `unreadable`, with the rows, so the
// Plan's error state keeps its contributions.
//
// GET ?sync=1&plan=... answers the rows alone, for the plans given (the
// pending ones): a cached row as it is, and the rest from their items'
// stored investment transactions, brought up to date first, one sync per
// item however many of its plans are asked for (two would race for its
// lock, lib/invstore.ts), and cached by the rule the Accounts tab's route
// keeps (lib/investment-activity.ts cacheable). A Plaid outage answers the
// stored rows, saying so in the note, as that route does.
//
// Each row joins the transactions imported for its account from the
// brokerage's download, as the Accounts tab's route does
// (lib/investment-activity.ts activityWithImports): a cached row counts only
// when it was built under the imports there are now, which one HKEYS beside
// the rows checks (none with no plans asked for), and imports that can't be
// read (or listed) leave Plaid's rows alone, said in the note and not cached.
//
// A cached row is served without checking its item is still linked, as the
// Accounts tab's route checks: unlinking an item clears the cache
// (lib/disconnect-item.ts clearCaches), so a row cached for it is gone.
//
// Nothing here is stored but the account cache's rows, by today's rule:
// what the person chose is read fresh, and what is measured from their
// accounts comes from the account cache, under its age and dropped with it.

/** At most this many plans in one request. */
const MAX_PLANS = 100;

/** The fields of an account's activity the Plan reads (components/plan-inputs.ts
 *  contributionsFrom and yearFrom). */
const PLAN_FIELDS = [
  'contributions_12m',
  'contributions_12m_from',
  'contributions_12m_partial',
  'contributions_12m_rows',
  'contributions_12m_activity_from',
  'dividends_12m',
  'note',
] as const;

type Wanted = { id: string; item_id: string; account_id: string } | { id: string; item_id: null; account_id: null };
type Row = { id: string; pending?: true; failed?: true } & Partial<Pick<InvestmentActivity, (typeof PLAN_FIELDS)[number]>>;

/** Each plan asked for once, in the order first asked; an id that isn't
 *  `<item_id>:<account_id>` is kept, to be answered as failed. */
function wantedOf(params: URLSearchParams): Wanted[] {
  const ids = [...new Set(params.getAll('plan'))];
  return ids.map((id) => {
    // At the first ':': a Plaid item id holds none. A connector card's id
    // does, but its accounts have no subtype, so none is a workplace plan.
    const at = id.indexOf(':');
    const item_id = at > 0 ? id.slice(0, at) : '';
    const account_id = at > 0 ? id.slice(at + 1) : '';
    return item_id && account_id ? { id, item_id, account_id } : { id, item_id: null, account_id: null };
  });
}

/** A row from a cached payload, or null when it is one cached before the
 *  Plan's fields existed, or built under other imports than there are now
 *  (or with `fingerprint` null, when which there are couldn't be listed). */
function rowFrom(id: string, cached: Record<string, unknown>, fingerprint: string | null): Row | null {
  if (!hasPlanFields(cached) || fingerprint === null || !hasCurrentImports(cached, fingerprint)) return null;
  const row: Record<string, unknown> = { id };
  for (const f of PLAN_FIELDS) row[f] = cached[f];
  return row as Row;
}

function failure(err: unknown): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  console.error(loggable(err));
  return NextResponse.json({ error: 'Failed to load the plan’s inputs' }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const wanted = wantedOf(params);
    if (wanted.length > MAX_PLANS) return NextResponse.json({ error: `At most ${MAX_PLANS} plans at a time` }, { status: 400 });
    const ctx = await dataCtx();
    const fields = wanted.flatMap((w) => (w.item_id ? [w.id] : []));
    if (params.get('sync') === '1') return NextResponse.json({ plans: await syncedRows(ctx, wanted, fields) });

    // Begun together, so Redis sends the reads at once.
    const answer = begin(() => readPlanAnswer(ctx));
    const [cached, keys] = await Promise.all([readAccountCaches<Record<string, unknown>>(ctx, fields), fields.length > 0 ? importKeysOrNull(ctx) : []]);
    const fingerprint = keys ? importsFingerprint(keys) : null;
    const plans: Row[] = wanted.map((w) => {
      if (!w.item_id) return { id: w.id, failed: true };
      const hit = cached.get(w.id);
      return (hit && rowFrom(w.id, hit, fingerprint)) ?? { id: w.id, pending: true };
    });
    try {
      return NextResponse.json({ ...(await answer), plans });
    } catch (err) {
      if (!(err instanceof StoredDataUnreadableError)) throw err;
      console.error('Stored plan assumptions unreadable:', describeUnreadable(err));
      // As GET /api/fire-plan answers it, with the rows: the Plan says why,
      // and its figures keep their contributions.
      return NextResponse.json({ error: err.message, unreadable: true, plans }, { status: 409 });
    }
  } catch (err) {
    return failure(err);
  }
}

type Ctx = Awaited<ReturnType<typeof dataCtx>>;

/** The rows asked for, each item synced once for all its plans not cached. */
async function syncedRows(ctx: Ctx, wanted: Wanted[], fields: string[]): Promise<Row[]> {
  const [cached, keys] = await Promise.all([readAccountCaches<Record<string, unknown>>(ctx, fields), fields.length > 0 ? importKeysOrNull(ctx) : []]);
  const fingerprint = keys ? importsFingerprint(keys) : null;
  const rows = new Map<string, Row>();
  const byItem = new Map<string, { id: string; account_id: string }[]>();
  for (const w of wanted) {
    if (!w.item_id) continue;
    const hit = cached.get(w.id);
    const row = hit ? rowFrom(w.id, hit, fingerprint) : null;
    if (row) rows.set(w.id, row);
    else byItem.set(w.item_id, [...(byItem.get(w.item_id) ?? []), { id: w.id, account_id: w.account_id }]);
  }
  if (byItem.size > 0) {
    let items: StoredItem[] | null = null;
    try {
      items = await getItems(ctx);
    } catch (err) {
      console.error(loggable(err));
    }
    // Every account's imports in one read; when that fails, each account's
    // on its own, so one account's entry that can't be read never holds the
    // others back (null: an account's can't be read).
    const account_ids = [...new Set([...byItem.values()].flat().map((a) => a.account_id))];
    let imports = new Map<string, AccountImport[] | null>(account_ids.map((id) => [id, null]));
    if (keys) {
      try {
        imports = await readAccountImports(ctx, account_ids, keys);
      } catch (err) {
        console.error(loggable(err));
        const each = await Promise.all(
          account_ids.map((id) =>
            readAccountImports(ctx, [id], keys).then(
              (read) => [id, read.get(id) ?? []] as const,
              (e) => {
                console.error(loggable(e));
                return [id, null] as const;
              }
            )
          )
        );
        imports = new Map(each);
      }
    }
    await Promise.all(
      [...byItem].map(async ([item_id, accounts]) => {
        const item = items?.find((i) => i.item_id === item_id);
        if (!item) return;
        try {
          const sync = await syncInvestments(ctx, item);
          await Promise.all(
            accounts.map(async ({ id, account_id }) => {
              const { payload, cacheable } = activityWithImports(sync, account_id, imports.get(account_id) ?? null, fingerprint ?? '');
              if (cacheable) await writeAccountCache(ctx, id, payload);
              rows.set(id, rowFrom(id, payload, fingerprint)!);
            })
          );
        } catch (err) {
          console.error(loggable(err));
          for (const { id } of accounts) rows.delete(id);
        }
      })
    );
  }
  return wanted.map((w) => rows.get(w.id) ?? { id: w.id, failed: true });
}
