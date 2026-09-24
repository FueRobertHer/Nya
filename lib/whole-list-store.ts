// lib/whole-list-store.ts
//
// Client-side loading and saving for a store the server keeps as one whole
// value, replaced on every save (goals, budgets). No React here, so the timing
// rules can be tested on their own; components/Dashboard.tsx drives it.
//
// Every rule exists because a save sends the WHOLE list, so saving from a list
// that is not what the server holds overwrites real data:
//
//   - Nothing can be saved until a load has succeeded. Before that the list on
//     screen means "unknown", and is shown as loading, never as "none".
//   - One save or reload at a time. Two saves in flight could land out of
//     order, and a reload finishing between them would show a list that no
//     longer matches the server while looking loaded.
//   - A reload's result is ignored if a newer load has started since.
//   - A failed save reloads what is really stored, so the screen never keeps
//     an optimistic list the server rejected.
//   - "Could not load" and "could not save" are separate messages, shown where
//     the list is, not somewhere else on the page.

export type ListStatus = 'loading' | 'ready' | 'error';

export type ListState<T> = {
  status: ListStatus;
  value: T;
  /** Why the list could not be loaded (status 'error'). Editing is off. */
  error: string | null;
  /** Why the last save did not go through. Cleared by the next success. */
  saveError: string | null;
  saving: boolean;
};

/** The state before the first load: loading, so the empty value is never
 *  shown as "none". */
export function initialListState<T>(empty: T): ListState<T> {
  return { status: 'loading', value: empty, error: null, saveError: null, saving: false };
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type WholeListStore<T> = {
  get(): ListState<T>;
  load(): Promise<void>;
  /** True only once the server has accepted `next`. */
  save(next: T): Promise<boolean>;
};

export function createWholeListStore<T>(opts: {
  url: string;
  /** The JSON field the server reads and returns, e.g. "goals". */
  field: string;
  /** For messages: "goals", "budgets". */
  noun: string;
  empty: T;
  isValid: (v: unknown) => v is T;
  onChange: (state: ListState<T>) => void;
  fetch?: Fetcher;
}): WholeListStore<T> {
  const doFetch: Fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
  const Noun = opts.noun[0].toUpperCase() + opts.noun.slice(1);
  let state: ListState<T> = initialListState(opts.empty);
  let loadSeq = 0;

  const set = (patch: Partial<ListState<T>>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };

  async function load(): Promise<void> {
    const mine = ++loadSeq;
    set({ status: 'loading', error: null });
    let res: Response;
    let data: Record<string, unknown> | null = null;
    try {
      res = await doFetch(opts.url);
      data = await res.json().catch(() => null);
    } catch {
      if (mine === loadSeq) {
        set({ status: 'error', error: `${Noun} could not be loaded. Editing is paused until they are; press Refresh to try again.` });
      }
      return;
    }
    if (mine !== loadSeq) return; // a newer load has started; its answer wins
    const value = data?.[opts.field];
    if (!res.ok || !opts.isValid(value)) {
      set({
        status: 'error',
        error: data?.unreadable
          ? `Your saved ${opts.noun} could not be read, so they have been left untouched and editing is paused.`
          : `${Noun} could not be loaded. Editing is paused until they are; press Refresh to try again.`,
      });
      return;
    }
    set({ status: 'ready', value, error: null });
  }

  async function save(next: T): Promise<boolean> {
    if (state.status !== 'ready') {
      set({ saveError: `${Noun} are still loading. Try again in a moment.` });
      return false;
    }
    if (state.saving) {
      set({ saveError: 'Still saving the last change. Try again in a moment.' });
      return false;
    }
    const before = state.value;
    set({ saving: true, value: next, saveError: null }); // optimistic
    let ok = false;
    try {
      const res = await doFetch(opts.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [opts.field]: next }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      set({ saving: false });
      return true;
    }
    // Back to the last list the server confirmed straight away, so even if
    // the reload below fails too, nothing on the page shows an unsaved list.
    set({ value: before, saveError: `Could not save ${opts.noun}. Showing what is saved.` });
    await load(); // still marked saving, so nothing else starts meanwhile
    set({ saving: false });
    return false;
  }

  return { get: () => state, load, save };
}
