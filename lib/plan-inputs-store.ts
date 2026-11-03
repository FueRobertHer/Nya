// lib/plan-inputs-store.ts
//
// One copy, in the browser, of what GET /api/plan-inputs answers: the saved
// plan and its currency, and each workplace plan's trailing year of
// contributions. Home's FI line and the Plan tab both read it, so the two
// screens ask once between them, and Home asks nothing when it comes back
// within five minutes (D16). components/Dashboard.tsx makes one for each
// signed-in account. No React here, and nothing from lib/fire, so its timing
// rules are tested on their own (test/plan-inputs-store.test.ts) and Home's
// main bundle stays as it is.
//
// The rules, each kept because the Plan saves the whole plan, or because
// Home must not hide its line or show figures that move a moment later:
//
//   - A copy is fresh for five minutes after its answer, for the same plans,
//     unless invalidate() was called since, and only when the plan was
//     answered (or said to be unreadable) and no plan's row failed. A load
//     without `force` (Home) takes a fresh copy as it is; the Plan's loads
//     always ask, since nothing refuses a save made from a plan another
//     device changed since.
//   - Only the newest request's answer is taken, and if an adopt() or
//     invalidate() came after it was sent, only its rows: its plan is older
//     than what is there. A request that failed is shown as failed, as
//     before, but leaves the copy no fresher.
//   - A plan whose row isn't cached comes back pending, and one sync=1
//     request fills it; never two for one plan at once (they would race for
//     its item's lock), and a row a sync filled after a request was sent
//     stays, whatever that request said. An older row is kept, and shown,
//     while it refreshes. A sync that fails gives the plan "failed", which
//     the screens read as "nothing measured", as a failed request did before.
//   - A load waits for a save under way (beginSave() to its end()), so a
//     Plan opened meanwhile shows what was saved. A save brackets only its
//     request and adopt(), never the reload a failed save makes. Two saves
//     at once leave the copy stale, since their answers can land in either
//     order.
//   - load() is called on events only (a screen shown, its plans changed,
//     invalidate()), never because of the copy's state, so a copy that stays
//     stale (a lasting failure) costs a request or two per screen shown,
//     never a loop.

/** One workplace plan's row, by its id (`<item_id>:<account_id>`): the
 *  contribution fields /api/plan-inputs answers, or pending or failed. */
export type PlanRow = {
  id: string;
  /** Not cached on the server: a sync=1 request is filling it. */
  pending?: true;
  /** Couldn't be had: read as nothing measured. */
  failed?: true;
  /** An older row, shown while a sync=1 request refreshes it. */
  refreshing?: true;
  [field: string]: unknown;
};

export type PlanInputsCopy = {
  /** The plans the copy is for, their ids in order, joined with commas;
   *  null before anything was asked. */
  key: string | null;
  /** The plan as last answered: the response's status (0 for a request that
   *  never answered) and its body without the rows. Null until the first
   *  answer. */
  plan: { status: number; body: Record<string, unknown> | null } | null;
  /** Each plan's row, by id. */
  rows: Readonly<Record<string, PlanRow>>;
  /** Bumped by invalidate(): each screen showing the copy loads again. */
  asked: number;
};

/** What a load gives the Plan's own store (lib/whole-list-store.ts read). */
export type PlanLoad = { ok: boolean; status: number; data: Record<string, unknown> | null };

export type PlanInputsStore = {
  get(): PlanInputsCopy;
  subscribe(listener: () => void): () => void;
  /** Brings the copy in for these plans, unless it is fresh and `force` is
   *  off. Resolves once the plan is in; rows may still be syncing. */
  load(plans: readonly string[], opts?: { force?: boolean }): Promise<PlanLoad>;
  /** A save's answer (PUT, or the currency's POST): everything but the rows,
   *  which stay, and the copy's freshness with them. */
  adopt(body: Record<string, unknown>): void;
  /** A save is under way: loads wait for the function returned. */
  beginSave(): () => void;
  /** What the copy rests on changed (a refresh, a link, a restore): it goes
   *  stale, still shown, and every screen showing it loads once. */
  invalidate(): void;
};

type Fetcher = (input: string) => Promise<Response>;

/** How long a copy is taken as it is. */
export const FRESH_MS = 5 * 60 * 1000;

const urlOf = (ids: readonly string[], sync: boolean) => {
  const query = [...(sync ? ['sync=1'] : []), ...ids.map((id) => `plan=${encodeURIComponent(id)}`)];
  return `/api/plan-inputs${query.length ? `?${query.join('&')}` : ''}`;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The rows an answer gave, by id; null when it gave none. */
function rowsOf(answer: unknown): Map<string, PlanRow> | null {
  if (!Array.isArray(answer)) return null;
  const rows = new Map<string, PlanRow>();
  for (const r of answer) if (isObject(r) && typeof r.id === 'string') rows.set(r.id, { ...r, id: r.id });
  return rows;
}

/** The plan was answered, or said to be unreadable: what the copy may be
 *  taken as. */
const planAnswered = (plan: PlanInputsCopy['plan']) => !!plan && (plan.status === 200 || (plan.status === 409 && plan.body?.unreadable === true));

export function createPlanInputsStore(opts: { fetch?: Fetcher; now?: () => number } = {}): PlanInputsStore {
  // Read when a request is sent, never kept: the dashboard replaces fetch
  // later (its sign-out watcher).
  const send = (url: string) => (opts.fetch ? opts.fetch(url) : fetch(url));
  const now = opts.now ?? Date.now;
  let copy: PlanInputsCopy = { key: null, plan: null, rows: {}, asked: 0 };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PlanInputsCopy>) => {
    copy = { ...copy, ...patch };
    for (const listener of listeners) listener();
  };

  /** When the copy's plan was answered, by a request sent after the last
   *  adopt() and invalidate(). */
  let answeredAt: number | null = null;
  let stale = false;
  /** Bumped by every adopt() and invalidate(). */
  let gen = 0;
  let sent = 0;
  /** The last request sent, while it runs. */
  let running: { key: string; seq: number; gen: number; asked: number; tick: number; promise: Promise<PlanLoad> } | null = null;
  /** The plans a sync=1 request is filling. */
  const syncing = new Set<string>();
  /** Orders requests sent against syncs answered: each plan's row, by the
   *  tick its sync answered at. */
  let tick = 0;
  const filled = new Map<string, number>();
  let saves = 0;
  /** Two saves were under way at once. */
  let overlapped = false;
  let saved: Promise<void> = Promise.resolve();
  let release = () => {};

  const settled = (): PlanLoad => {
    const plan = copy.plan;
    const status = plan?.status ?? 0;
    return { ok: status >= 200 && status < 300, status, data: plan?.body ?? null };
  };

  function fresh(ids: readonly string[], key: string): boolean {
    if (copy.key !== key || stale || answeredAt === null || now() - answeredAt >= FRESH_MS || !planAnswered(copy.plan)) return false;
    return ids.every((id) => !!copy.rows[id] && !copy.rows[id].failed);
  }

  /** One sync=1 request for the plans pending or refreshing that no sync is
   *  filling yet. */
  function sync(ids: readonly string[]) {
    const want = ids.filter((id) => (copy.rows[id]?.pending || copy.rows[id]?.refreshing) && !syncing.has(id));
    if (want.length === 0) return;
    for (const id of want) syncing.add(id);
    void (async () => {
      let given: Map<string, PlanRow> | null = null;
      try {
        const res = await send(urlOf(want, true));
        if (res.ok) given = rowsOf(((await res.json().catch(() => null)) as { plans?: unknown } | null)?.plans);
      } catch {
        // Failed, below.
      }
      const rows = { ...copy.rows };
      const at = ++tick;
      for (const id of want) {
        syncing.delete(id);
        filled.set(id, at);
        const row = given?.get(id);
        rows[id] = row && !row.pending ? row : { id, failed: true };
      }
      set({ rows });
    })();
  }

  function request(ids: readonly string[], key: string): Promise<PlanLoad> {
    const mine = { key, seq: ++sent, gen, asked: copy.asked, tick: ++tick, promise: null as unknown as Promise<PlanLoad> };
    mine.promise = (async () => {
      let status = 0;
      let body: Record<string, unknown> | null = null;
      try {
        const res = await send(urlOf(ids, false));
        status = res.status;
        const data: unknown = await res.json().catch(() => null);
        body = isObject(data) ? data : null;
      } catch {
        // Never answered: status 0.
      }
      if (running === mine) running = null;
      const { plans: answered, ...planPart } = body ?? {};
      // Only the newest request is taken (a newer one was sent after it), and
      // its plan only if nothing was adopted or invalidated since it was sent:
      // that plan is older than the copy's. Its rows are the newest asked for
      // either way.
      const newest = mine.seq === sent;
      const patch: Partial<PlanInputsCopy> = {};
      if (newest && mine.gen === gen) {
        patch.plan = { status, body: body ? planPart : null };
        // A failure is shown (Home hides its line, as before), but never makes
        // the copy count as answered, then or after a save's answer.
        if (planAnswered(patch.plan)) {
          answeredAt = now();
          stale = false;
        }
      }
      if (newest) {
        patch.key = key;
        // A request that gave no rows (it failed) leaves every plan to sync.
        const given = rowsOf(answered);
        const rows = { ...copy.rows };
        for (const id of ids) {
          // A sync that answered after this request was sent read later than
          // it did: its row stays, and isn't synced again.
          if ((filled.get(id) ?? 0) > mine.tick) continue;
          const row = given?.get(id);
          if (row && !row.pending) rows[id] = row;
          else {
            const old = rows[id];
            rows[id] = old && !old.pending && !old.failed ? { ...old, refreshing: true } : { id, pending: true };
          }
        }
        patch.rows = rows;
      }
      if (Object.keys(patch).length > 0) set(patch);
      sync(ids);
      return { ok: status >= 200 && status < 300, status, data: body ? planPart : null };
    })();
    running = mine;
    return mine.promise;
  }

  async function load(plans: readonly string[], { force = false }: { force?: boolean } = {}): Promise<PlanLoad> {
    while (saves > 0) await saved;
    const ids = [...plans];
    const key = ids.join(',');
    // The Plan never takes a request sent before the last adopt() or
    // invalidate(); Home never one from before the last invalidate().
    if (running && running.key === key && (force ? running.gen === gen : running.asked === copy.asked)) return running.promise;
    if (!force && fresh(ids, key)) {
      sync(ids);
      return settled();
    }
    return request(ids, key);
  }

  return {
    get: () => copy,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    adopt(body) {
      const { plans: _rows, ...planPart } = body;
      gen++;
      set({ plan: { status: 200, body: planPart } });
    },
    beginSave() {
      if (saves++ === 0) saved = new Promise((resolve) => (release = resolve));
      else overlapped = true;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        if (--saves > 0) return;
        // Two at once (a plan's PUT and its currency's POST) may answer in
        // either order, so the last answer adopted may not be the last
        // written: the next load asks.
        if (overlapped) stale = true;
        overlapped = false;
        release();
      };
    },
    invalidate() {
      gen++;
      stale = true;
      set({ asked: copy.asked + 1 });
    },
  };
}
