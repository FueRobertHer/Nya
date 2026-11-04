import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement, FakeEvent } from './mini-dom';
import { OFF } from './plan-gen';

// The Plans sheet (components/PlansSheet.tsx, the tax plan's C2), used as a
// person would (react-dom/client over test/mini-dom.ts), with the real plans
// client (components/plan-list.ts) over a store answered here as
// app/api/plans would: your plan first with its badge, then the copies in
// the order they were made, each with its FI age and how it differs; a
// plan's level (Open it, Make this your plan, Rename, Duplicate, and Delete
// last, as the destructive row); Delete's level, which asks first; the name
// levels; where focus goes back to; the limit, a list that can't load, a
// damaged entry and one a newer version saved; and Compare's chips. The Plan
// tab around it is test/plan-bar-view.test.tsx's.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-copies.test.tsx says why): elements are compared with toBe,
// or their words and attributes are.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useEffect, useMemo, useState } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { PlansSheet, REFUSED_TEXT } = await import('@/components/PlansSheet');
const { INITIAL_PLANS, createPlansClient } = await import('@/components/plan-list');
const { copyDiffParts } = await import('@/components/plan-diff');
const { wholeMoney } = await import('@/components/plan-text');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planOf } = await import('@/lib/fire/plan-v2');
const { planFigures } = await import('@/lib/fire/plan-figures');
type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;
type PlansState = import('@/components/plan-list').PlansState;
type SheetPlan = import('@/components/PlansSheet').SheetPlan;
type PlanJob = import('@/lib/fire/jobs').PlanJob;
type PlanJobResult = import('@/lib/fire/jobs').PlanJobResult;
type SimResult = import('@/lib/fire/simulate').SimResult;

const PLAN = planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 });
const MEASURED = { spending: 40_000, savings: 30_000, assets: 300_000 };
const money = (n: number) => wholeMoney(n, 'USD');

type Copy = { id: string; name: string; over?: Partial<FirePlanV2> };
const COPIES: Copy[] = [
  { id: 'c1', name: 'Retire at 50', over: { targetAge: 50 } },
  { id: 'c2', name: 'Spend more', over: { spending: 50_000 } },
  { id: 'c3', name: 'Save more', over: { savings: 40_000 } },
];

type Stored = { id: string; name: string; plan: FirePlanV2; createdAt: string; updatedAt: string };
type Options = { unreadable?: string[]; unrecognised?: string[]; missing?: boolean; failLoads?: number; hold?: boolean };

/** Your plans' store, answered here as app/api/plans would: each write
 *  restamps what it wrote. Every write is recorded with its body
 *  (`sent`); `refuse` refuses the next one as changed elsewhere; with
 *  `hold`, a write is answered only once `release` is called. */
function store(copies: Copy[], { unreadable = [], unrecognised = [], missing = false, failLoads = 0, hold = false }: Options = {}) {
  let n = 0;
  const stamp = () => `2026-10-23T00:00:${String(++n).padStart(2, '0')}.000Z`;
  let main = 'main';
  let list: Stored[] = [
    { id: 'main', name: 'First plan', plan: PLAN, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: stamp() },
    ...copies.map((c, i) => {
      const at = `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      return { id: c.id, name: c.name, plan: { ...PLAN, ...c.over }, createdAt: at, updatedAt: at };
    }),
  ];
  let bad = [...unreadable];
  let failures = failLoads;
  let made = 0;
  const sent: Record<string, unknown>[] = [];
  const ctl = { refuse: null as string | null };
  let held: (() => void)[] = [];
  const rowOf = (s: Stored) => ({ id: s.id, name: s.name, plan: s.plan, currency: 'USD', created_at: s.createdAt, updated_at: s.updatedAt });
  const ordered = () => [...list.filter((s) => s.id === main), ...list.filter((s) => s.id !== main).sort((a, b) => a.createdAt.localeCompare(b.createdAt))];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (failures > 0) {
        failures--;
        return json({ error: 'Your plans couldn’t be read. Try again in a moment.' }, 500);
      }
      return json({ main, missing, plans: ordered().map(rowOf), unreadable_ids: bad, unrecognised_ids: unrecognised });
    }
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    sent.push({ method, ...body });
    if (hold) await new Promise<void>((r) => held.push(r));
    if (ctl.refuse) {
      const error = ctl.refuse;
      ctl.refuse = null;
      return json({ error, stale: true }, 409);
    }
    if (method === 'POST') {
      const at = stamp();
      const created: Stored = { id: `new${++made}`, name: String(body.name), plan: body.plan as FirePlanV2, createdAt: at, updatedAt: at };
      list = [...list, created];
      return json({ plan: rowOf(created) });
    }
    if (method === 'PATCH' && typeof body.main === 'string') {
      main = body.main;
      const s = list.find((x) => x.id === main)!;
      s.updatedAt = stamp();
      return json({ id: s.id, plan: s.plan, currency: 'USD', updated_at: s.updatedAt });
    }
    if (method === 'PATCH') {
      const s = list.find((x) => x.id === body.id)!;
      s.name = String(body.name);
      s.updatedAt = stamp();
      return json({ plan: rowOf(s) });
    }
    list = list.filter((s) => s.id !== body.id);
    bad = bad.filter((id) => id !== body.id);
    return json({ ok: true });
  };
  const release = () => {
    const now = held;
    held = [];
    for (const r of now) r();
  };
  return { fetcher, sent, ctl, release };
}

/** The time a sheet takes to slide in (one frame) and a request to be answered. */
const pass = fakeClock();
const settle = (ms = 10) => pass(ms);

/** Every plan in the list as the Plan tab hands them in: your plan first,
 *  each with its figures and how it differs from yours. */
function sheetPlans(state: PlansState): SheetPlan[] {
  const mine = state.list.find((r) => r.id === state.main);
  if (state.status !== 'ready' || !mine?.plan) return [];
  const base = planOf(mine.plan);
  return state.list.map((row) => {
    const plan = planOf(row.plan ?? PLAN);
    const figures = planFigures(plan, MEASURED, { count: OFF });
    return {
      id: row.id,
      name: row.name,
      isMain: row.id === state.main,
      updatedAt: row.updated_at,
      plan,
      outcome: 'refused' in figures ? { kind: 'not-run', reason: REFUSED_TEXT } : { kind: 'figures', figures },
      parts: row.id === state.main ? [] : copyDiffParts(base, plan, money),
    };
  });
}

type Shown = { planState?: 'loading' | 'ready' | 'error'; whyNot?: string | null; measuring?: boolean };

/** The sheet as the Plan tab holds it, open (or `closed` until its opener,
 *  a button outside it as the Plan bar's Plans is, is pressed), with the
 *  tab's handlers over the plans client: the calls out of it in order
 *  (`said`), each commit's open and plan shown (`seen`), and the compare
 *  jobs asked of the worker (`jobs`, never answered). */
async function mount(fetcher: ReturnType<typeof store>['fetcher'], { shown = {} as Shown, closed = false } = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  const seen: string[] = [];
  const jobs: PlanJob[] = [];
  const cache = new Map<string, SimResult>();
  const run = (job: PlanJob): Promise<PlanJobResult> => {
    jobs.push(job);
    return new Promise(() => {});
  };
  const ctl: { setOpen: (open: boolean) => void } = { setOpen: () => {} };
  function Harness({ planState = 'ready', whyNot = null, measuring = false }: Shown) {
    const [state, setState] = useState<PlansState>(INITIAL_PLANS);
    const client = useMemo(() => createPlansClient(setState, fetcher), []);
    useEffect(() => void client.load(), [client]);
    const [open, setOpen] = useState(!closed);
    const [openId, setOpenId] = useState<string | null>(null);
    ctl.setOpen = setOpen;
    useEffect(() => {
      const now = `${open ? 'open' : 'closed'}, ${openId ?? 'your plan'}`;
      if (seen[seen.length - 1] !== now) seen.push(now);
    });
    const plans = planState === 'ready' ? sheetPlans(state) : [];
    const rowOf = (id: string) => state.list.find((r) => r.id === id);
    // As components/PlanTab.tsx's createCopy, renamePlan, deletePlan and
    // makeMain hand them in.
    return (
      <>
        <button className="btn" onClick={() => setOpen(true)}>
          Plans
        </button>
        <PlansSheet
          open={open}
          onClose={() => {
            said.push('close');
            setOpen(false);
          }}
          state={state}
          plans={plans}
          measuring={measuring}
          planState={planState}
          whyNot={whyNot}
          openId={openId}
          onOpen={(id) => {
            said.push(`open ${id}`);
            setOpenId(id);
          }}
          onCreate={async (from, name, openIt) => {
            const source = plans.find((p) => p.id === from);
            if (!source) return 'That plan changed since this opened, so nothing was made: open it again.';
            const r = await client.create({ from, name, plan: source.plan, currency: 'USD' });
            if ('error' in r) return r.error;
            if (openIt) {
              said.push('close', `open ${r.ok.id}`);
              setOpen(false);
              setOpenId(r.ok.id);
            }
            return true;
          }}
          onRename={async (id, name) => {
            const r = await client.rename(id, name, rowOf(id)?.updated_at ?? null);
            return 'error' in r ? r.error : true;
          }}
          onDelete={async (id, unreadable) => {
            const r = await client.remove(id, rowOf(id)?.updated_at ?? null, unreadable);
            return 'error' in r ? r.error : true;
          }}
          onMakeMain={async (id) => {
            const r = await client.makeMain(id, rowOf(id)!.updated_at!);
            return 'error' in r ? r.error : true;
          }}
          onRetry={() => void client.load()}
          run={run}
          cache={cache}
          method="historical"
          money={money}
          today="2026-10-23"
        />
      </>
    );
  }
  await act(async () => root.render(<Harness {...shown} />));
  await settle();

  const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
  /** The sheet on the page (not one sliding out). */
  const dialog = () => host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  /** The sheet, open or sliding out. */
  const anySheet = () => host.findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null;
  /** The button outside the sheet that opens it. */
  const opener = () => host.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'btn' && e.textContent.trim() === 'Plans')[0]!;
  /** A row in the sheet (a plan's, or an action's), by its title. */
  const row = (title: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent === title)[0] ?? null;
  /** Any other button in the sheet, by its words or its label. */
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0] ?? null;
  const press = async (el: FakeElement | null | undefined, what = 'nothing') => {
    if (!el) throw new Error(`no ${what} to press`);
    el.focus();
    await act(async () => click(el));
    await settle();
  };
  const key = async (k: string) => {
    const e = new FakeEvent('keydown');
    e.key = k;
    await act(async () => void (dom.document.defaultView as unknown as FakeElement).dispatchEvent(e));
    await settle();
  };
  /** The plans' rows, each as its title, its line under it and whether it
   *  has the badge and a chevron. */
  const rows = () =>
    (dialog()?.findAll((e) => e.tagName === 'UL' && e.getAttribute('aria-label') === 'Your plans')[0]?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) =>
      [b.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent, b.findAll((t) => classOf(t).includes('list-row-sub'))[0]?.textContent ?? null, b.findAll((t) => classOf(t).includes('badge'))[0]?.textContent ?? null, b.findAll((t) => t.tagName === 'svg').length === 1].join(' | ')
    );
  /** The action rows of a plan's level: title, sub, class, popup and chevron. */
  const actions = () =>
    (dialog()?.findAll((e) => e.tagName === 'UL' && classOf(e).includes('list-rows'))[0]?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) =>
      [b.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent, b.findAll((t) => classOf(t).includes('list-row-sub'))[0]?.textContent ?? '', b.getAttribute('class'), b.getAttribute('aria-haspopup') ?? '', b.findAll((t) => t.tagName === 'svg').length === 1 ? 'chevron' : ''].join(' | ')
    );
  const helpers = () => dialog()?.findAll((e) => e.tagName === 'P' && classOf(e).includes('helper')).map((e) => e.textContent) ?? [];
  const alerts = () => dialog()?.findAll((e) => e.getAttribute('role') === 'alert').map((e) => e.textContent) ?? [];
  return {
    said,
    seen,
    jobs,
    dialog,
    anySheet,
    opener,
    row,
    button,
    press,
    key,
    rows,
    actions,
    helpers,
    alerts,
    focused: () => dom.document.activeElement as unknown as FakeElement,
    /** The sheet's title. */
    title: () => dialog()?.getAttribute('aria-label') ?? null,
    field: () => dialog()?.findAll((e) => e.tagName === 'INPUT')[0] ?? null,
    status: () => dialog()?.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent) ?? [],
    picks: () => dialog()?.findAll((e) => e.getAttribute('aria-pressed') !== null).map((e) => `${e.textContent}: ${e.getAttribute('aria-pressed')}${e.getAttribute('aria-disabled') === 'true' ? ' (locked)' : ''}`) ?? [],
    show: async (props: Shown) => {
      await act(async () => root.render(<Harness {...props} />));
      await settle();
    },
    reopen: async () => {
      await act(async () => ctl.setOpen(true));
      await settle();
    },
    unmount: () => act(async () => root.unmount()),
  };
}
type Mounted = Awaited<ReturnType<typeof mount>>;

/** Opens a plan's level from its row. */
const level = async (s: Mounted, name: string) => s.press(s.row(name), name);

describe('the list', () => {
  test('your plan first with its badge, then the copies in the order they were made, each with when it reaches FI and how it differs first; every row opens its level', async () => {
    const { fetcher } = store([COPIES[1], COPIES[0], COPIES[2]].map((c, i) => ({ ...c, id: `c${i + 1}` })));
    const s = await mount(fetcher);
    expect(s.title()).toBe('Plans');
    expect(s.helpers()[0]).toBe('Each plan is whole: a copy starts as your plan, and changes you make in it stay in it.');
    expect(s.rows()).toEqual([
      'First plan | FI around 52 | Your plan | true',
      'Spend more | FI around 55, 3 years later · Annual spending: $50,000 a year (your plan: $40,000 a year) |  | true',
      'Retire at 50 | FI around 52, as in your plan · Stop age: 50 (your plan: 55) |  | true',
      'Save more | FI around 50, 2 years sooner · Annual savings: $40,000 a year (your plan: $30,000 a year) |  | true',
    ]);
    for (const name of ['First plan', 'Spend more']) expect(s.row(name)?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(s.button('Compare')?.disabled).toBe(false);
    expect(s.button('New copy')?.disabled).toBe(false);
    await s.unmount();
  });

  test('while what Nya measures loads, each row’s FI age waits as a placeholder', async () => {
    const { fetcher } = store(COPIES);
    const s = await mount(fetcher, { shown: { measuring: true } });
    expect(s.rows()).toEqual(['First plan |  | Your plan | true', 'Retire at 50 |  |  | true', 'Spend more |  |  | true', 'Save more |  |  | true']);
    expect(s.dialog()!.findAll((e) => (e.getAttribute('class') ?? '') === 'skeleton rows-skeleton-sub')).toHaveLength(4);
    expect(s.dialog()!.textContent).not.toContain('FI around');
    await s.unmount();
  });

  test('while your plan loads, only why and the rows as placeholders, said once; nothing is compared, and New copy and Compare wait', async () => {
    const { fetcher } = store(COPIES);
    const whyNot = 'Your plan is still loading: plans open, and are compared, once it has.';
    const s = await mount(fetcher, { shown: { planState: 'loading', whyNot } });
    const sheet = s.dialog()!;
    expect(s.helpers()).toEqual([whyNot]);
    // Not a spinner: the rows as they will be, hidden, the card busy, and one status.
    expect(sheet.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('spinner'))).toHaveLength(0);
    expect(s.status()).toEqual(['Loading your plans']);
    expect(sheet.findAll((e) => e.getAttribute('aria-busy') === 'true')).toHaveLength(1);
    expect(sheet.findAll((e) => e.tagName === 'UL')[0].getAttribute('aria-hidden')).toBe('true');
    // As many placeholders as there are plans, once the list is in.
    expect(sheet.findAll((e) => e.tagName === 'LI')).toHaveLength(4);
    for (const absent of ['First plan', 'Retire at 50', 'FI around']) expect(sheet.textContent).not.toContain(absent);
    expect(s.button('Compare')?.disabled).toBe(true);
    expect(s.button('New copy')?.disabled).toBe(true);
    expect(s.jobs).toEqual([]);

    await s.show({ planState: 'ready', whyNot: null });
    expect(s.rows()).toHaveLength(4);
    expect(s.button('New copy')?.disabled).toBe(false);
    await s.unmount();
  });

  test('a list that can’t load says why, critically, with Try again, which loads it', async () => {
    const { fetcher } = store(COPIES, { failLoads: 1 });
    const s = await mount(fetcher);
    expect(s.alerts()).toEqual(['Critical: Your plans couldn’t be read. Try again in a moment.']);
    expect(s.rows()).toEqual([]);
    expect(s.button('New copy')?.disabled).toBe(true);
    await s.press(s.button('Try again'), 'Try again');
    expect(s.alerts()).toEqual([]);
    expect(s.rows()).toHaveLength(4);
    await s.unmount();
  });

  test('a damaged entry is a critical notice with Delete it, which asks first and deletes only it; plans a newer version saved are named, never shown', async () => {
    const { fetcher, sent } = store([COPIES[0]], { unreadable: ['bad1'], unrecognised: ['n1', 'n2'] });
    const s = await mount(fetcher);
    expect(s.dialog()!.textContent).toContain('A saved plan couldn’t be read: its stored data is damaged.');
    expect(s.helpers()).toContain('2 plans were saved by a newer version of Nya: kept, and not shown here.');
    expect(s.rows()).toHaveLength(2);
    await s.press(s.button('Delete it'), 'Delete it');
    expect(s.title()).toBe('Delete');
    expect(s.helpers()).toEqual(['Delete the plan that couldn’t be read? What it held can’t be recovered from here, and this can’t be undone.']);
    expect(sent).toEqual([]);
    await s.press(s.button('Delete'), 'Delete');
    expect(sent).toEqual([{ method: 'DELETE', id: 'bad1', based_on: null, unreadable: true }]);
    expect(s.title()).toBe('Plans');
    expect(s.dialog()!.textContent).not.toContain('couldn’t be read');
    // Nothing after it: focus on the row before it.
    expect(s.focused()).toBe(s.row('Retire at 50')!);
    await s.unmount();
  });

  test('one plan from a newer version is said as one', async () => {
    const { fetcher } = store([], { unrecognised: ['n1'] });
    const s = await mount(fetcher);
    expect(s.helpers()).toContain('A plan was saved by a newer version of Nya: kept, and not shown here.');
    await s.unmount();
  });

  test('at 11 plans, damaged ones counted: the limit line, New copy off, and a Duplicate says why', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `Plan ${i + 1}`, over: { targetAge: 50 + i } }));
    const { fetcher, sent } = store(nine, { unreadable: ['bad1'] });
    const s = await mount(fetcher);
    expect(s.helpers()).toContain('You have 11 plans, the most Nya keeps: delete one to make another.');
    expect(s.button('New copy')?.disabled).toBe(true);
    await level(s, 'Plan 3');
    await s.press(s.row('Duplicate'), 'Duplicate');
    expect(s.title()).toBe('Plan 3');
    expect(s.alerts()).toEqual(['Critical: You have 11 plans, the most Nya keeps: delete one to make another.']);
    expect(sent).toEqual([]);
    await s.unmount();
  });

  test('your plan not found: the one shown as yours is said', async () => {
    const { fetcher } = store(COPIES, { missing: true });
    const s = await mount(fetcher);
    expect(s.helpers()).toContain('Your plan wasn’t found, so “First plan” is shown as yours.');
    await s.unmount();
  });
});

describe('a plan’s level', () => {
  test('a copy’s: how it differs, in full; Open it and Make this your plan act in place, Rename and Duplicate open a level, and Delete is last, its title in red, asking first, with no chevron', async () => {
    const { fetcher } = store([{ id: 'c1', name: 'Leaner', over: { targetAge: 50, spending: 35_000, savings: 35_000 } }]);
    const s = await mount(fetcher);
    await level(s, 'Leaner');
    expect(s.title()).toBe('Leaner');
    expect(s.helpers()).toEqual(['Stop age: 50 (your plan: 55); Annual spending: $35,000 a year (your plan: $40,000 a year); Annual savings: $35,000 a year (your plan: $30,000 a year).']);
    expect(s.actions()).toEqual([
      'Open it |  | list-row |  | ',
      'Make this your plan | Your plan now stays, as a copy. | list-row |  | ',
      'Rename |  | list-row | dialog | chevron',
      'Duplicate |  | list-row | dialog | chevron',
      'Delete | Asks before it deletes | list-row neg | dialog | ',
    ]);
    // No footer: the level is its actions.
    expect(s.button('New copy')).toBeNull();
    expect(s.button('Compare')).toBeNull();
    await s.unmount();
  });

  test('your plan’s: no Make this your plan and no Delete, and why it can’t be deleted', async () => {
    const { fetcher } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'First plan');
    expect(s.title()).toBe('First plan');
    expect(s.actions()).toEqual(['Open it |  | list-row |  | ', 'Rename |  | list-row | dialog | chevron', 'Duplicate |  | list-row | dialog | chevron']);
    expect(s.helpers()).toEqual(['Your plan can’t be deleted: make another your plan first.']);
    await s.unmount();
  });

  test('the back arrow and Escape go back to the list, with focus on the row that opened it', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.button('Back'), 'Back');
    expect(s.title()).toBe('Plans');
    expect(s.focused()).toBe(s.row('Spend more')!);
    await level(s, 'Save more');
    await s.key('Escape');
    expect(s.title()).toBe('Plans');
    expect(s.focused()).toBe(s.row('Save more')!);
    // A plan's own level goes back to the plan's.
    await level(s, 'Save more');
    await s.press(s.row('Rename'), 'Rename');
    expect(s.title()).toBe('Rename');
    await s.key('Escape');
    expect(s.title()).toBe('Save more');
    await s.press(s.row('Delete'), 'Delete');
    expect(s.title()).toBe('Delete');
    await s.press(s.button('Back'), 'Back');
    expect(s.title()).toBe('Save more');
    // None of it saved anything, or left the sheet.
    expect(sent).toEqual([]);
    expect(s.said).toEqual([]);
    await s.unmount();
  });

  test('Open it closes the sheet and opens the copy in one commit; your plan’s goes back to your plan', async () => {
    const { fetcher } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.row('Open it'), 'Open it');
    expect(s.said).toEqual(['close', 'open c2']);
    // Never a commit with the sheet closed on the plan it was opened from.
    expect(s.seen).toEqual(['open, your plan', 'closed, c2']);
    await settle(400);
    await s.reopen();
    expect(s.title()).toBe('Plans');
    await level(s, 'First plan');
    await s.press(s.row('Open it'), 'Open it');
    expect(s.said).toEqual(['close', 'open c2', 'close', 'open null']);
    expect(s.seen.slice(-2)).toEqual(['open, c2', 'closed, your plan']);
    await s.unmount();
  });

  test('Make this your plan names the stamp it was shown at; back on the list it leads, with the badge, and focus on its row, and the status says so', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.row('Make this your plan'), 'Make this your plan');
    expect(sent).toEqual([{ method: 'PATCH', main: 'c2', based_on: '2026-10-02T00:00:00.000Z' }]);
    expect(s.title()).toBe('Plans');
    // Your old plan is a copy now, in the order the copies were made.
    expect(s.rows().map((r) => r.split(' | ').filter((p, i) => i !== 1).join(' | '))).toEqual(['Spend more | Your plan | true', 'First plan |  | true', 'Retire at 50 |  | true', 'Save more |  | true']);
    expect(s.focused()).toBe(s.row('Spend more')!);
    expect(s.status()).toEqual(['“Spend more” is your plan now.']);
    // The old plan is a copy now, and can be deleted.
    await level(s, 'First plan');
    expect(s.row('Delete')).not.toBeNull();
    await s.unmount();
  });

  test('refused because it changed elsewhere: said in the level, and the list read again', async () => {
    const { fetcher, ctl } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    ctl.refuse = 'That plan changed on another device, so it wasn’t made your plan: open it again.';
    await s.press(s.row('Make this your plan'), 'Make this your plan');
    expect(s.title()).toBe('Spend more');
    expect(s.alerts()).toEqual(['Critical: That plan changed on another device, so it wasn’t made your plan: open it again.']);
    await s.unmount();
  });

  test('while plans can’t be changed, its actions say why instead of acting', async () => {
    const { fetcher, sent } = store(COPIES);
    const whyNot = 'Your saved plan has values to fix first (at the top of the Plan tab): plans open once it is saved.';
    const s = await mount(fetcher, { shown: { whyNot } });
    expect(s.helpers()).toContain(whyNot);
    expect(s.button('New copy')?.disabled).toBe(true);
    await level(s, 'Spend more');
    for (const action of ['Open it', 'Make this your plan', 'Rename', 'Duplicate']) {
      await s.press(s.row(action), action);
      expect([action, s.title(), s.alerts()]).toEqual([action, 'Spend more', [`Critical: ${whyNot}`]]);
    }
    expect(sent).toEqual([]);
    expect(s.said).toEqual([]);
    await s.unmount();
  });
});

describe('Delete', () => {
  test('its level says what goes and that it can’t be undone, with Cancel and Delete; Cancel goes back to the plan’s level', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.row('Delete'), 'Delete');
    expect(s.title()).toBe('Delete');
    expect(s.helpers()).toEqual(['Delete “Spend more”? Your plan isn’t changed. This can’t be undone.']);
    const footer = s.dialog()!.findAll((e) => e.tagName === 'BUTTON' && ['Cancel', 'Delete'].includes(e.textContent.trim()));
    expect(footer.map((b) => `${b.textContent} ${b.getAttribute('class')}`)).toEqual(['Cancel btn secondary', 'Delete btn danger']);
    await s.press(s.button('Cancel'), 'Cancel');
    expect(s.title()).toBe('Spend more');
    expect(sent).toEqual([]);
    await s.unmount();
  });

  test('confirmed, it names the stamp shown; focus goes to the next row, else the one before', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    const remove = async (name: string) => {
      await level(s, name);
      await s.press(s.row('Delete'), 'Delete');
      await s.press(s.button('Delete'), 'Delete');
    };
    await remove('Spend more');
    expect(sent).toEqual([{ method: 'DELETE', id: 'c2', based_on: '2026-10-02T00:00:00.000Z' }]);
    expect(s.title()).toBe('Plans');
    expect(s.rows().map((r) => r.split(' | ')[0])).toEqual(['First plan', 'Retire at 50', 'Save more']);
    expect(s.focused()).toBe(s.row('Save more')!);
    await remove('Save more');
    expect(s.focused()).toBe(s.row('Retire at 50')!);
    await remove('Retire at 50');
    expect(s.focused()).toBe(s.row('First plan')!);
    expect(s.said).toEqual([]);
    await s.unmount();
  });

  test('refused because it changed elsewhere: said in its level, and the list read again', async () => {
    const { fetcher, ctl } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.row('Delete'), 'Delete');
    ctl.refuse = 'That plan changed on another device, so it wasn’t deleted: open it again.';
    await s.press(s.button('Delete'), 'Delete');
    expect(s.title()).toBe('Delete');
    expect(s.alerts()).toEqual(['Critical: That plan changed on another device, so it wasn’t deleted: open it again.']);
    await s.unmount();
  });
});

describe('names', () => {
  test('Rename: the name as it is, 40 characters at most; none, or one another plan has, is refused there; saved, back to its level under the new name', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'Spend more');
    await s.press(s.row('Rename'), 'Rename');
    expect(s.title()).toBe('Rename');
    expect(s.field()?.value).toBe('Spend more');
    expect(s.field()?.getAttribute('maxLength')).toBe('40');
    expect(s.helpers()).toEqual(['40 characters at most.']);
    await act(async () => type(s.field()!, '  '));
    await s.press(s.button('Save'), 'Save');
    expect(s.alerts()).toEqual(['Critical: Give it a name.']);
    await act(async () => type(s.field()!, 'first PLAN'));
    await s.press(s.button('Save'), 'Save');
    expect(s.alerts()).toEqual(['Critical: Another plan has that name: choose another, so they can be told apart.']);
    expect(sent).toEqual([]);
    await act(async () => type(s.field()!, ' Spend a lot '));
    await s.press(s.button('Save'), 'Save');
    expect(sent).toEqual([{ method: 'PATCH', id: 'c2', name: 'Spend a lot', based_on: '2026-10-02T00:00:00.000Z' }]);
    expect(s.title()).toBe('Spend a lot');
    expect(s.row('Make this your plan')).not.toBeNull();
    await s.unmount();
  });

  test('your plan can be renamed too', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await level(s, 'First plan');
    await s.press(s.row('Rename'), 'Rename');
    await act(async () => type(s.field()!, 'Steady'));
    await s.press(s.button('Save'), 'Save');
    expect(sent).toEqual([{ method: 'PATCH', id: 'main', name: 'Steady', based_on: '2026-10-23T00:00:01.000Z' }]);
    expect(s.title()).toBe('Steady');
    await s.unmount();
  });

  test('Duplicate: “its name (copy)”, cut to 40; made from that plan, then back to the list with focus on its row, the new one last', async () => {
    const long = 'A plan with a name that is forty letters';
    expect(long).toHaveLength(40);
    const { fetcher, sent } = store([...COPIES, { id: 'c4', name: long, over: { spending: 45_000 } }]);
    const s = await mount(fetcher);
    await level(s, long);
    await s.press(s.row('Duplicate'), 'Duplicate');
    expect(s.title()).toBe('Duplicate');
    expect(s.helpers()).toEqual([`A copy of “${long}” as it is now, under a new name.`, '40 characters at most.']);
    expect(s.field()?.value).toBe(`${long} (copy)`.slice(0, 40));
    await s.press(s.button('Cancel'), 'Cancel');
    expect(s.title()).toBe(long);

    await s.press(s.button('Back'), 'Back');
    await level(s, 'Spend more');
    await s.press(s.row('Duplicate'), 'Duplicate');
    expect(s.field()?.value).toBe('Spend more (copy)');
    await s.press(s.button('Make it'), 'Make it');
    expect(sent.map((b) => [b.method, b.from, b.name, (b.plan as FirePlanV2).spending, b.currency])).toEqual([['POST', 'c2', 'Spend more (copy)', 50_000, 'USD']]);
    expect(s.title()).toBe('Plans');
    expect(s.rows().map((r) => r.split(' | ')[0])).toEqual(['First plan', 'Retire at 50', 'Spend more', 'Save more', long, 'Spend more (copy)']);
    expect(s.focused()).toBe(s.row('Spend more')!);
    expect(s.said).toEqual([]);
    await s.unmount();
  });

  test('New copy: made from your plan as it is, the sheet closes, and the copy opens', async () => {
    const { fetcher, sent } = store(COPIES);
    const s = await mount(fetcher);
    await s.press(s.button('New copy'), 'New copy');
    expect(s.title()).toBe('New copy');
    expect(s.helpers()).toEqual(['A copy starts as your plan. Open it, and every change you make there is saved to it, never to your plan.', '40 characters at most.']);
    expect(s.field()?.value).toBe('');
    await act(async () => type(s.field()!, 'Sabbatical'));
    await s.press(s.button('Make it'), 'Make it');
    expect(sent.map((b) => [b.method, b.from, b.name, JSON.stringify(b.plan) === JSON.stringify(PLAN)])).toEqual([['POST', 'main', 'Sabbatical', true]]);
    expect([...s.said].sort()).toEqual(['close', 'open new1']);
    expect(s.seen[s.seen.length - 1]).toBe('closed, new1');
    await s.unmount();
  });

  test('a name level’s Cancel goes back where it was opened from: New copy to the list, with focus on New copy', async () => {
    const { fetcher } = store(COPIES);
    const s = await mount(fetcher);
    await s.press(s.button('New copy'), 'New copy');
    await s.press(s.button('Cancel'), 'Cancel');
    expect(s.title()).toBe('Plans');
    expect(s.focused()).toBe(s.button('New copy')!);
    await s.unmount();
  });
});

describe('Compare', () => {
  test('the first four are chosen until the person chooses; one that would leave fewer than two, or make five, stays focusable with the note; each plan chosen is its own simulation', async () => {
    const { fetcher } = store([...COPIES, { id: 'c4', name: 'Coast', over: { withdrawalRate: 0.035 } }]);
    const s = await mount(fetcher);
    expect(s.jobs).toEqual([]);
    await s.press(s.button('Compare'), 'Compare');
    expect(s.title()).toBe('Compare');
    expect(s.helpers()).toEqual(['Choose two to four plans.']);
    expect(s.picks()).toEqual(['Your plan: true', 'Retire at 50: true', 'Spend more: true', 'Save more: true', 'Coast: false (locked)']);
    expect(s.button('Coast')?.getAttribute('aria-describedby')).toBe('plan-compare-note');
    expect(s.jobs.map((j) => j.kind)).toEqual(['simulate', 'simulate', 'simulate', 'simulate']);
    await s.press(s.button('Retire at 50'), 'Retire at 50');
    await s.press(s.button('Spend more'), 'Spend more');
    expect(s.picks()).toEqual(['Your plan: true (locked)', 'Retire at 50: false', 'Spend more: false', 'Save more: true (locked)', 'Coast: false']);
    // Pressing a locked one changes nothing.
    await s.press(s.button('Save more'), 'Save more');
    expect(s.picks()).toEqual(['Your plan: true (locked)', 'Retire at 50: false', 'Spend more: false', 'Save more: true (locked)', 'Coast: false']);
    await s.unmount();
  });

  test('opened again, the sheet is at its list, and the plans chosen are kept', async () => {
    const { fetcher } = store([...COPIES, { id: 'c4', name: 'Coast', over: { withdrawalRate: 0.035 } }]);
    const s = await mount(fetcher);
    await s.press(s.button('Compare'), 'Compare');
    await s.press(s.button('Retire at 50'), 'Retire at 50');
    await s.press(s.button('Close'), 'Close');
    await settle(400);
    expect(s.dialog()).toBeNull();
    await s.reopen();
    expect(s.title()).toBe('Plans');
    await s.press(s.button('Compare'), 'Compare');
    expect(s.picks()).toEqual(['Your plan: true', 'Retire at 50: false', 'Spend more: true', 'Save more: true', 'Coast: false']);
    await s.unmount();
  });

  test('with your plan alone there is nothing to compare', async () => {
    const { fetcher } = store([]);
    const s = await mount(fetcher);
    expect(s.rows()).toHaveLength(1);
    expect(s.button('Compare')?.disabled).toBe(true);
    await s.unmount();
  });
});

describe('a save that ends while the sheet slides out', () => {
  for (const kind of ['Rename', 'Duplicate', 'Delete'] as const) {
    test(`${kind}: focus stays on the button that opened the sheet, where the sheet gave it back`, async () => {
      const { fetcher, sent, release } = store(COPIES, { hold: true });
      const s = await mount(fetcher, { closed: true });
      const opener = s.opener();
      opener.focus();
      await act(async () => click(opener));
      await settle();
      await level(s, 'Spend more');
      await s.press(s.row(kind), kind);
      if (kind === 'Rename') await act(async () => type(s.field()!, 'Spend a lot'));
      await s.press(s.button(kind === 'Delete' ? 'Delete' : kind === 'Rename' ? 'Save' : 'Make it'), 'its save');
      expect(sent.length).toBe(1);
      // Closed while it saves: the sheet gives focus back as it starts to slide out.
      await s.press(s.button('Close'), 'Close');
      expect(s.focused()).toBe(opener);
      // The save ends 50ms into the 320ms slide-out.
      await settle(50);
      await act(async () => release());
      await settle(20);
      expect(s.focused()).toBe(opener);
      await settle(400);
      expect(s.anySheet()).toBeNull();
      expect(s.focused()).toBe(opener);
      await s.unmount();
    });
  }
});
