// components/plan-scenarios.ts
//
// Loading and saving the Plan's scenarios (app/api/plan-scenarios) on the
// page. No React here, so the rules can be tested on their own:
//
//   - Nothing is saved before a load has succeeded, and nothing is shown as
//     "no scenarios" until one has: before that the list is unknown.
//   - One request at a time, in order, so two saves never land out of order
//     and a reload never shows a list between them.
//   - An edit names the version it was made to (`rev`, PUT based_on). When
//     another device changed it since, the server refuses and sends it as it
//     is now, which replaces the one here, and the person is told.
//   - A failed save reloads what is really stored.
//   - Entries that can't be read are named (unreadable may be deleted once
//     the person confirms; unrecognised never), never dropped from view.

import type { PlanScenario, ScenarioDraft } from '@/lib/fire/scenarios';

export type ScenarioEntry = PlanScenario & { id: string };

export type ScenariosState = {
  status: 'loading' | 'ready' | 'error';
  list: ScenarioEntry[];
  unreadable: string[];
  unrecognised: string[];
  /** Why the list couldn't be loaded. */
  error: string | null;
  saving: boolean;
};

export const INITIAL_SCENARIOS: ScenariosState = { status: 'loading', list: [], unreadable: [], unrecognised: [], error: null, saving: false };

type Done<T> = { ok: T } | { error: string };

export type ScenarioClient = {
  load(): Promise<void>;
  create(draft: ScenarioDraft): Promise<Done<ScenarioEntry>>;
  save(id: string, draft: ScenarioDraft, basedOn: string): Promise<Done<ScenarioEntry>>;
  remove(id: string, unreadable?: boolean): Promise<Done<true>>;
};

async function answer(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const message = (body: Record<string, unknown>, fallback: string) => (typeof body.error === 'string' ? body.error : fallback);

/** The part of fetch this uses. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function createScenarioClient(onChange: (s: ScenariosState) => void, fetcher: Fetcher = (url, init) => fetch(url, init)): ScenarioClient {
  let state = INITIAL_SCENARIOS;
  const set = (next: Partial<ScenariosState>) => {
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
      const res = await fetcher('/api/plan-scenarios');
      const body = await answer(res);
      if (!res.ok) {
        set({ status: 'error', error: message(body, 'Your saved scenarios couldn’t be loaded.') });
        return;
      }
      set({
        status: 'ready',
        error: null,
        list: Array.isArray(body.scenarios) ? (body.scenarios as ScenarioEntry[]) : [],
        unreadable: Array.isArray(body.unreadable_ids) ? (body.unreadable_ids as string[]) : [],
        unrecognised: Array.isArray(body.unrecognised_ids) ? (body.unrecognised_ids as string[]) : [],
      });
    } catch {
      set({ status: 'error', error: 'Your saved scenarios couldn’t be loaded: check your connection.' });
    }
  }

  async function send(method: 'POST' | 'PUT' | 'DELETE', payload: unknown): Promise<{ res: Response | null; body: Record<string, unknown> }> {
    try {
      const res = await fetcher('/api/plan-scenarios', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { res, body: await answer(res) };
    } catch {
      return { res: null, body: { error: 'It wasn’t saved: check your connection, and try again.' } };
    }
  }

  const ready = () => state.status === 'ready';

  return {
    load: () => inTurn(loadNow),
    create: (draft) =>
      inTurn(async () => {
        if (!ready()) return { error: 'Your saved scenarios haven’t loaded yet.' };
        set({ saving: true });
        const { res, body } = await send('POST', { scenario: draft });
        set({ saving: false });
        if (!res?.ok) {
          await loadNow();
          return { error: message(body, 'It wasn’t saved. Try again in a moment.') };
        }
        const entry = body.scenario as ScenarioEntry;
        set({ list: [...state.list, entry] });
        return { ok: entry };
      }),
    save: (id, draft, basedOn) =>
      inTurn(async () => {
        if (!ready()) return { error: 'Your saved scenarios haven’t loaded yet.' };
        set({ saving: true });
        const { res, body } = await send('PUT', { id, scenario: draft, based_on: basedOn });
        set({ saving: false });
        if (res?.ok) {
          const entry = body.scenario as ScenarioEntry;
          set({ list: state.list.map((s) => (s.id === id ? entry : s)) });
          return { ok: entry };
        }
        if (res?.status === 409 && body.stale === true && typeof body.scenario === 'object' && body.scenario !== null) {
          // Changed on another device: shown as it is now, and nothing of
          // this save is kept.
          const now = body.scenario as ScenarioEntry;
          set({ list: state.list.map((s) => (s.id === id ? now : s)) });
          return { error: message(body, 'This scenario was changed on another device.') };
        }
        await loadNow();
        return { error: message(body, 'It wasn’t saved. Try again in a moment.') };
      }),
    remove: (id, unreadable) =>
      inTurn(async () => {
        if (!ready()) return { error: 'Your saved scenarios haven’t loaded yet.' };
        set({ saving: true });
        const { res, body } = await send('DELETE', unreadable ? { id, unreadable: true } : { id });
        set({ saving: false });
        if (!res?.ok) {
          await loadNow();
          return { error: message(body, 'It wasn’t deleted. Try again in a moment.') };
        }
        set({ list: state.list.filter((s) => s.id !== id), unreadable: state.unreadable.filter((x) => x !== id) });
        return { ok: true };
      }),
  };
}
