// components/plan-list.ts
//
// Your plans on the page (GET /api/plans, lib/plan-copies.ts readPlans):
// your plan and its copies, for the Plans sheet, the copy open and Also
// change it in, and every write the sheet and a copy make (lib/plan-writes.ts
// through app/api/plans). Your plan itself is shown and saved through the
// Plan tab's own store (app/api/fire-plan); its row here only names it, and
// takes each of that store's answers (adoptMain). No React here, so the
// rules can be tested on their own:
//
//   - Nothing is shown as "no copies" until a load has succeeded, and
//     nothing is changed before one has.
//   - One request at a time, in order, so two writes never land out of
//     order and a reload never shows a list between them.
//   - Every write names the stamp the page loaded (`based_on`). A refused one
//     (changed on another device, say) reloads what is really stored, and
//     says why; so does any other that fails.
//   - Entries that can't be read are named (damaged ones may be deleted once
//     the person confirms; a newer version's never), never dropped from view.

import { isStoredPlan, type FirePlanV2, type StoredPlan } from '@/lib/fire/plan-v2';
import type { Facts } from '@/lib/fire/copies';
import { isTaxChoices, type TaxChoices } from '@/lib/fire/tax-choices';

/** One plan as GET /api/plans answers it, the facts every plan shares in
 *  its fields. Your plan before its entry is made has no plan (the
 *  defaults) and no stamps. */
export type PlanRow = {
  id: string;
  name: string;
  plan: StoredPlan | null;
  currency: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Its own tax choices; null takes your plan's. */
  tax: TaxChoices | null;
};

export type PlansState = {
  status: 'loading' | 'ready' | 'error';
  /** Your plan's id, and whether it stands in for one that wasn't found. */
  main: string;
  missing: boolean;
  /** Your plan first, then the copies in the order they were made. */
  list: PlanRow[];
  unreadable: string[];
  unrecognised: string[];
  /** Why the list couldn't be loaded. */
  error: string | null;
  saving: boolean;
};

export const INITIAL_PLANS: PlansState = { status: 'loading', main: 'main', missing: false, list: [], unreadable: [], unrecognised: [], error: null, saving: false };

/** Every plan there is, readable or not: what the limit counts. */
export const plansCount = (s: PlansState) => s.list.length + s.unreadable.length + s.unrecognised.length;

/** The copies: every plan but yours. */
export const copiesOf = (s: PlansState) => s.list.filter((r) => r.id !== s.main);

/** A save of one plan whole, at the stamp it was loaded at. */
export type PlanSave = { id: string; plan: FirePlanV2; currency: string | null; based_on: string | null; tax?: TaxChoices };

/** Done, or why not; `stale` when what is stored stopped it, and the list was
 *  read again. */
export type Done<T> = { ok: T } | { error: string; stale?: boolean };

/** Your plan as GET /api/fire-plan answers it (lib/plan-copies.ts
 *  mainAnswer): `body` whole, for the copy of the Plan's inputs. */
export type MainAnswer = { id: string; plan: StoredPlan | null; currency: string | null; updated_at: string | null; body: Record<string, unknown> };

export type PlansClient = {
  load(): Promise<void>;
  /** A new copy of `from`: New copy, Duplicate, Try it. */
  create(input: { from: string; name: string; plan: FirePlanV2; currency: string | null }): Promise<Done<PlanRow>>;
  /** Saves plans whole, all or none: a copy's save, or Also change it in.
   *  Answers your plan as stored after it, too. */
  save(saves: PlanSave[], factsWere: Facts): Promise<Done<{ rows: PlanRow[]; main: MainAnswer | null }>>;
  rename(id: string, name: string, basedOn: string | null): Promise<Done<PlanRow>>;
  /** A copy's amounts said to be in `currency` (the person's answer). */
  relabel(id: string, currency: string, basedOn: string | null): Promise<Done<PlanRow>>;
  remove(id: string, basedOn: string | null, unreadable?: boolean): Promise<Done<true>>;
  /** Makes a copy your plan: answered as your plan is. */
  makeMain(id: string, basedOn: string): Promise<Done<MainAnswer>>;
  /** Your plan as its store last answered it: its row here takes it, unless
   *  another plan is yours now, when the list is read again. */
  adoptMain(answer: Record<string, unknown>): void;
};

async function answer(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const message = (body: Record<string, unknown>, fallback: string) => (typeof body.error === 'string' ? body.error : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A row as the route sends it, or null when it isn't one. */
export function rowFrom(v: unknown): PlanRow | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  if (r.plan !== null && !isStoredPlan(r.plan)) return null;
  return { id: r.id, name: r.name, plan: r.plan as StoredPlan | null, currency: stringOrNull(r.currency), created_at: stringOrNull(r.created_at), updated_at: stringOrNull(r.updated_at), tax: isTaxChoices(r.tax) ? r.tax : null };
}

/** Your plan as an answer gives it, or null when it isn't one. */
export function mainFrom(v: unknown): MainAnswer | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (typeof b.id !== 'string' || (b.plan !== null && !isStoredPlan(b.plan))) return null;
  return { id: b.id, plan: b.plan as StoredPlan | null, currency: stringOrNull(b.currency), updated_at: stringOrNull(b.updated_at), body: b };
}

/** The part of fetch this uses. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function createPlansClient(onChange: (s: PlansState) => void, fetcher: Fetcher = (url, init) => fetch(url, init)): PlansClient {
  let state = INITIAL_PLANS;
  const set = (next: Partial<PlansState>) => {
    state = { ...state, ...next };
    onChange(state);
  };
  // One request at a time, in the order asked.
  let chain: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => undefined);
    return run;
  };

  async function loadNow(): Promise<void> {
    try {
      const res = await fetcher('/api/plans', { cache: 'no-store' });
      const body = await answer(res);
      if (!res.ok) {
        set({ status: 'error', error: message(body, 'Your plans couldn’t be loaded.') });
        return;
      }
      const list = Array.isArray(body.plans) ? body.plans.map(rowFrom).filter((r): r is PlanRow => r !== null) : [];
      set({
        status: 'ready',
        error: null,
        main: typeof body.main === 'string' ? body.main : 'main',
        missing: body.missing === true,
        list,
        unreadable: strings(body.unreadable_ids),
        unrecognised: strings(body.unrecognised_ids),
      });
    } catch {
      set({ status: 'error', error: 'Your plans couldn’t be loaded: check your connection.' });
    }
  }

  async function send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', payload: unknown): Promise<{ res: Response | null; body: Record<string, unknown> }> {
    try {
      const res = await fetcher('/api/plans', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { res, body: await answer(res) };
    } catch {
      return { res: null, body: { error: 'It wasn’t saved: check your connection, and try again.' } };
    }
  }

  /** A write: refused before a load, else sent, and on any failure the list
   *  read again, with why. */
  const write = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', payload: unknown, fallback: string, done: (body: Record<string, unknown>) => T | null): Promise<Done<T>> =>
    inTurn(async () => {
      if (state.status !== 'ready') return { error: 'Your plans haven’t loaded yet. Try again in a moment.' };
      set({ saving: true });
      const { res, body } = await send(method, payload);
      const ok = res?.ok ? done(body) : null;
      if (ok === null) {
        await loadNow();
        set({ saving: false });
        return { error: message(body, fallback), stale: body.stale === true };
      }
      set({ saving: false });
      return { ok };
    });

  const replace = (row: PlanRow) => set({ list: state.list.map((r) => (r.id === row.id ? row : r)) });

  return {
    load: () => inTurn(loadNow),
    create: (input) =>
      write('POST', input, 'It wasn’t made. Try again in a moment.', (body) => {
        const row = rowFrom(body.plan);
        if (row) set({ list: [...state.list, row] });
        return row;
      }),
    save: (saves, factsWere) =>
      write('PUT', { saves, facts_were: factsWere }, 'It wasn’t saved. Try again in a moment.', (body) => {
        const rows = Array.isArray(body.plans) ? body.plans.map(rowFrom).filter((r): r is PlanRow => r !== null) : [];
        for (const row of rows) replace(row);
        const main = mainFrom(body.main);
        const mainRow = main && state.list.find((r) => r.id === main.id);
        if (main && mainRow) replace({ ...mainRow, plan: main.plan, currency: main.currency, updated_at: main.updated_at });
        return { rows, main };
      }),
    rename: (id, name, basedOn) =>
      write('PATCH', { id, name, based_on: basedOn }, 'It wasn’t renamed. Try again in a moment.', (body) => {
        const row = rowFrom(body.plan);
        if (row) replace(row);
        return row;
      }),
    relabel: (id, currency, basedOn) =>
      write('PATCH', { id, currency, based_on: basedOn }, 'It wasn’t saved. Try again in a moment.', (body) => {
        const row = rowFrom(body.plan);
        if (row) replace(row);
        return row;
      }),
    remove: (id, basedOn, unreadable) =>
      write('DELETE', unreadable ? { id, based_on: basedOn, unreadable: true } : { id, based_on: basedOn }, 'It wasn’t deleted. Try again in a moment.', () => {
        set({ list: state.list.filter((r) => r.id !== id), unreadable: state.unreadable.filter((x) => x !== id) });
        return true as const;
      }),
    makeMain: (id, basedOn) =>
      inTurn(async () => {
        if (state.status !== 'ready') return { error: 'Your plans haven’t loaded yet. Try again in a moment.' };
        set({ saving: true });
        const { res, body } = await send('PATCH', { main: id, based_on: basedOn });
        const main = res?.ok ? mainFrom(body) : null;
        // Either way the list is read again: your plan is another now, and
        // the plans are in their order as yours and copies.
        await loadNow();
        set({ saving: false });
        return main ? { ok: main } : { error: message(body, 'It wasn’t made your plan. Try again in a moment.'), stale: body.stale === true };
      }),
    adoptMain: (body) => {
      const main = mainFrom(body);
      if (!main || state.status !== 'ready') return;
      if (main.id !== state.main) {
        void inTurn(loadNow);
        return;
      }
      const row = state.list.find((r) => r.id === main.id);
      if (row) replace({ ...row, plan: main.plan, currency: main.currency, updated_at: main.updated_at });
    },
  };
}
