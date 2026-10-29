import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, outline, FakeElement, FakeEvent } from './mini-dom';

// The Scenarios sheet (components/PlanScenarios.tsx ScenariosSheet, rollout
// phase 6b), used as a person would (react-dom/client over test/mini-dom.ts),
// with the real scenario client over a store answered here: its second level
// (New scenario, Rename, Duplicate, Delete) goes back to the list with focus
// on the button that opened it, by Cancel, the back arrow, Escape or a save;
// where focus goes once a row is deleted; each way out of the sheet closes it
// in the one commit with what it opens or leaves; it opens again at its list,
// with the plans picked for Compare kept; and while the Plan loads nothing is
// listed, and until it has loaded nothing is compared. The Plan tab around it
// is test/plan-bar-view.test.tsx's.
//
// A rendered element never goes into toEqual or another matcher that diffs
// (test/plan-tab-scenarios.test.tsx says why): elements are outlined first.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useEffect, useMemo, useState } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { ScenariosSheet } = await import('@/components/PlanScenarios');
const { INITIAL_SCENARIOS, createScenarioClient } = await import('@/components/plan-scenarios');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { planFigures } = await import('@/lib/fire/plan-figures');
const { NO_CHANGES } = await import('@/lib/fire/scenarios');
const { wholeMoney } = await import('@/components/plan-text');
type Entry = import('@/components/plan-scenarios').ScenarioEntry;
type ScenariosState = import('@/components/plan-scenarios').ScenariosState;
type PlanFigures = import('@/lib/fire/plan-figures').PlanFigures;
type PlanJob = import('@/lib/fire/jobs').PlanJob;
type PlanJobResult = import('@/lib/fire/jobs').PlanJobResult;
type SimResult = import('@/lib/fire/simulate').SimResult;

const PLAN = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 };
const MEASURED = { spending: 40_000, savings: 30_000, assets: 300_000 };
const FIGURES = planFigures(PLAN, MEASURED, []) as PlanFigures;
const money = (n: number) => wholeMoney(n, 'USD');
const entry = (id: string, name: string, over: Partial<Entry> = {}): Entry => ({
  id,
  version: 1,
  name,
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00.000Z',
  savedAt: '2026-10-01T00:00:00.000Z',
  rev: 'r1',
  ...NO_CHANGES,
  set: { targetAge: 50 },
  ...over,
});

/** The scenarios' store, answered here as app/api/plan-scenarios would.
 *  With `hold`, a save is answered only once `release` is called. */
function store(initial: Entry[], unreadable: string[] = [], { hold = false } = {}) {
  let list = [...initial];
  let bad = [...unreadable];
  let made = 0;
  const sent: string[] = [];
  let held: (() => void)[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') sent.push(`${method} ${body.id ?? body.scenario.name}`);
    if (hold && method !== 'GET') await new Promise<void>((r) => held.push(r));
    const answer = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (method === 'POST') {
      const created = { ...entry(`new${++made}`, body.scenario.name), ...body.scenario };
      list = [...list, created];
      return answer({ scenario: created });
    }
    if (method === 'PUT') {
      const now = { ...list.find((s) => s.id === body.id)!, ...body.scenario, rev: 'r2' };
      list = list.map((s) => (s.id === body.id ? now : s));
      return answer({ scenario: now });
    }
    if (method === 'DELETE') {
      list = list.filter((s) => s.id !== body.id);
      bad = bad.filter((id) => id !== body.id);
      return answer({ ok: true });
    }
    return answer({ scenarios: list, unreadable_ids: bad, unrecognised_ids: [] });
  };
  const release = () => {
    const now = held;
    held = [];
    for (const r of now) r();
  };
  return { fetcher, sent, release };
}

/** The time a sheet takes to slide in (one frame) and a request to be answered. */
const settle = (ms = 10) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

type Shown = { planState?: 'loading' | 'ready' | 'error'; whyNot?: string | null; canOpen?: boolean };

/** The sheet as PlanTab holds it, open (and `openId` the scenario shown), or
 *  `closed` until its opener, a button outside it as the Plan bar's
 *  Scenarios is, is pressed: the calls out of it in order (`said`), each
 *  commit's open and open scenario (`seen`), and the compare jobs asked of
 *  the worker (`jobs`, never answered). */
async function mount(fetcher: ReturnType<typeof store>['fetcher'], { openId = null as string | null, shown = {} as Shown, closed = false } = {}) {
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
  function Harness({ planState = 'ready', whyNot = null, canOpen = true }: Shown) {
    const [state, setState] = useState<ScenariosState>(INITIAL_SCENARIOS);
    const client = useMemo(() => createScenarioClient(setState, fetcher), []);
    useEffect(() => void client.load(), [client]);
    const [open, setOpen] = useState(!closed);
    const [shownId, setShownId] = useState<string | null>(openId);
    ctl.setOpen = setOpen;
    useEffect(() => {
      const now = `${open ? 'open' : 'closed'}, ${shownId ?? 'your plan'}`;
      if (seen[seen.length - 1] !== now) seen.push(now);
    });
    return (
      <>
        <button className="btn" onClick={() => setOpen(true)}>
          Scenarios
        </button>
        <ScenariosSheet
        open={open}
        onClose={() => {
          said.push('close');
          setOpen(false);
        }}
        state={state}
        client={client}
        base={PLAN}
        baseFigures={FIGURES}
        measured={MEASURED}
        planCurrency="USD"
        canOpen={canOpen}
        planState={planState}
        whyNot={whyNot}
        openId={shownId}
        onOpen={(id) => {
          said.push(`open ${id}`);
          setShownId(id);
        }}
        onLeave={() => {
          said.push('leave');
          setShownId(null);
        }}
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

  /** The sheet on the page (not one sliding out). */
  const dialog = () => host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  /** The sheet, open or sliding out. */
  const anySheet = () => host.findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null;
  /** The button outside the sheet that opens it. */
  const opener = () => host.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'btn' && e.textContent.trim() === 'Scenarios')[0]!;
  /** A button in the sheet, by its words or its label. */
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0] ?? null;
  const press = async (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no ${label} in ${dialog() ? outline(dialog()!) : 'no sheet'}`);
    b.focus();
    await act(async () => click(b));
    await settle();
  };
  const key = async (k: string) => {
    const e = new FakeEvent('keydown');
    e.key = k;
    await act(async () => void (dom.document.defaultView as unknown as FakeElement).dispatchEvent(e));
    await settle();
  };
  const focused = () => outline(dom.document.activeElement as unknown as FakeElement);
  return {
    said,
    seen,
    jobs,
    dialog,
    anySheet,
    opener,
    button,
    press,
    key,
    focused,
    /** The sheet's title. */
    title: () => dialog()?.getAttribute('aria-label') ?? null,
    field: () => dialog()?.findAll((e) => e.tagName === 'INPUT')[0] ?? null,
    picks: () => dialog()?.findAll((e) => e.getAttribute('aria-pressed') !== null).map((e) => `${e.textContent}: ${e.getAttribute('aria-pressed')}`) ?? [],
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

const SCENARIOS = [entry('a', 'Retire at 50'), entry('b', 'Part time', { set: {} }), entry('c', 'Spend more', { set: { spending: 50_000 } })];

describe('the second level', () => {
  test('Cancel, the back arrow and Escape go back to the list, with focus on the button that opened it', async () => {
    const { fetcher, sent } = store(SCENARIOS);
    const s = await mount(fetcher);
    expect(s.title()).toBe('Scenarios');

    await s.press('Rename Retire at 50');
    expect(s.title()).toBe('Rename');
    await s.press('Cancel');
    expect(s.title()).toBe('Scenarios');
    expect(s.focused()).toBe('<button aria-label="Rename Retire at 50">Rename</button>');

    await s.press('Duplicate Part time');
    expect(s.title()).toBe('Duplicate');
    await s.press('Back');
    expect(s.title()).toBe('Scenarios');
    expect(s.focused()).toBe('<button aria-label="Duplicate Part time">Duplicate</button>');

    await s.press('Delete Spend more');
    expect(s.title()).toBe('Delete');
    await s.key('Escape');
    expect(s.title()).toBe('Scenarios');
    expect(s.focused()).toBe('<button aria-label="Delete Spend more">Delete</button>');

    await s.press('New scenario');
    expect(s.title()).toBe('New scenario');
    await s.key('Escape');
    expect(s.focused()).toBe('<button>New scenario</button>');

    // None of it saved anything, or left the sheet.
    expect(sent).toEqual([]);
    expect(s.said).toEqual([]);
    await s.unmount();
  });

  test('a rename or a copy saved goes back to the list, with focus on the button that opened it', async () => {
    const { fetcher, sent } = store(SCENARIOS);
    const s = await mount(fetcher);
    await s.press('Rename Part time');
    await act(async () => type(s.field()!, 'Half time'));
    await s.press('Save');
    expect(sent).toEqual(['PUT b']);
    expect(s.title()).toBe('Scenarios');
    expect(s.focused()).toBe('<button aria-label="Rename Half time">Rename</button>');

    await s.press('Duplicate Retire at 50');
    await s.press('Save');
    expect(sent).toEqual(['PUT b', 'POST Retire at 50 (copy)']);
    expect(s.title()).toBe('Scenarios');
    expect(s.button('Open Retire at 50 (copy)')).not.toBeNull();
    expect(s.focused()).toBe('<button aria-label="Duplicate Retire at 50">Duplicate</button>');
    expect(s.said).toEqual([]);
    await s.unmount();
  });

  test('once a row is deleted, focus goes to the next one’s Open, else the one before’s, else New scenario; deleting the open one leaves it, and the sheet stays', async () => {
    const { fetcher, sent } = store(SCENARIOS);
    const s = await mount(fetcher, { openId: 'b' });
    // The open one's row says the way back instead of Open.
    expect(s.button('Open Part time')).toBeNull();
    await s.press('Delete Part time');
    await s.press('Delete');
    expect(sent).toEqual(['DELETE b']);
    expect(s.said).toEqual(['open null']);
    expect(s.title()).toBe('Scenarios');
    expect(s.focused()).toBe('<button aria-label="Open Spend more">Open</button>');

    await s.press('Delete Spend more');
    await s.press('Delete');
    expect(s.focused()).toBe('<button aria-label="Open Retire at 50">Open</button>');

    await s.press('Delete Retire at 50');
    await s.press('Delete');
    expect(s.focused()).toBe('<button>New scenario</button>');
    expect(s.said).toEqual(['open null']);
    expect(s.seen[s.seen.length - 1]).toBe('open, your plan');
    await s.unmount();
  });

  test('an unreadable one deleted: focus goes to the next one’s Delete it, else the row before it', async () => {
    const { fetcher } = store([entry('a', 'Retire at 50')], ['bad1', 'bad2']);
    const s = await mount(fetcher);
    const deleteIts = () => s.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Delete it');
    expect(deleteIts().length).toBe(2);
    await s.press('Delete it');
    expect(s.title()).toBe('Delete');
    await s.press('Delete');
    expect(deleteIts().length).toBe(1);
    expect(dom.document.activeElement === (deleteIts()[0] as unknown)).toBe(true);
    await s.press('Delete it');
    await s.press('Delete');
    expect(deleteIts().length).toBe(0);
    expect(s.focused()).toBe('<button aria-label="Open Retire at 50">Open</button>');
    await s.unmount();
  });
});

describe('focus never goes to a button that can’t take it', () => {
  test('with no scenario to open (the Plan waiting on a repair), a delete’s focus goes to the next row’s Delete, else the one before’s, else stays on the sheet', async () => {
    const { fetcher } = store(SCENARIOS);
    const s = await mount(fetcher, { shown: { canOpen: false, whyNot: 'Your saved plan has values to fix first (at the top of the Plan tab): scenarios open once it is saved.' } });
    expect(s.button('Open Retire at 50')?.disabled).toBe(true);
    expect(s.button('New scenario')?.disabled).toBe(true);
    await s.press('Delete Part time');
    await s.press('Delete');
    expect(s.focused()).toBe('<button aria-label="Delete Spend more">Delete</button>');
    await s.press('Delete Spend more');
    await s.press('Delete');
    expect(s.focused()).toBe('<button aria-label="Delete Retire at 50">Delete</button>');
    await s.press('Delete Retire at 50');
    await s.press('Delete');
    // Nothing on the list can take it: it stays on the sheet, where the list began.
    expect(dom.document.activeElement === (s.dialog() as unknown)).toBe(true);
    await s.unmount();
  });

  test('a copy that makes the tenth: its Duplicate can’t be pressed now, so focus goes to the row’s Rename', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => entry(`s${i}`, `Plan ${i + 1}`));
    const { fetcher } = store(nine);
    const s = await mount(fetcher);
    await s.press('Duplicate Plan 3');
    await s.press('Save');
    expect(s.title()).toBe('Scenarios');
    expect(s.button('Duplicate Plan 3')?.disabled).toBe(true);
    expect(s.focused()).toBe('<button aria-label="Rename Plan 3">Rename</button>');
    await s.unmount();
  });
});

describe('a save that ends while the sheet slides out', () => {
  for (const kind of ['Rename', 'Duplicate', 'Delete'] as const) {
    test(`${kind}: focus stays on the button that opened the sheet, where the sheet gave it back`, async () => {
      const { fetcher, sent, release } = store(SCENARIOS, [], { hold: true });
      const s = await mount(fetcher, { closed: true });
      const opener = s.opener();
      opener.focus();
      await act(async () => click(opener));
      await settle();
      await s.press(`${kind} Part time`);
      if (kind === 'Rename') await act(async () => type(s.field()!, 'Half time'));
      await s.press(kind === 'Delete' ? 'Delete' : 'Save');
      expect(sent.length).toBe(1);
      // Closed while it saves: the sheet gives focus back as it starts to slide out.
      await s.press('Close');
      expect(dom.document.activeElement === (opener as unknown)).toBe(true);
      // The save ends 50ms into the 320ms slide-out.
      await settle(50);
      await act(async () => release());
      await settle(20);
      expect(s.focused()).toBe('<button>Scenarios</button>');
      expect(dom.document.activeElement === (opener as unknown)).toBe(true);
      await settle(400);
      expect(s.anySheet()).toBeNull();
      expect(dom.document.activeElement === (opener as unknown)).toBe(true);
      await s.unmount();
    });
  }
});

describe('leaving the sheet', () => {
  test('a row’s Open closes the sheet and opens it in one commit', async () => {
    const { fetcher } = store(SCENARIOS);
    const s = await mount(fetcher);
    await s.press('Open Part time');
    expect(s.said).toEqual(['close', 'open b']);
    // Never a commit with the sheet closed on the plan it was opened from.
    expect(s.seen).toEqual(['open, your plan', 'closed, b']);
    await s.unmount();
  });

  test('the open one’s “Back to your plan” closes the sheet and leaves it in one commit', async () => {
    const { fetcher } = store(SCENARIOS);
    const s = await mount(fetcher, { openId: 'a' });
    await s.press('Back to your plan');
    expect(s.said).toEqual(['close', 'leave']);
    expect(s.seen).toEqual(['open, a', 'closed, your plan']);
    await s.unmount();
  });

  test('a new scenario saved closes the sheet and opens it in one commit', async () => {
    const { fetcher, sent } = store(SCENARIOS);
    const s = await mount(fetcher);
    await s.press('New scenario');
    await act(async () => type(s.field()!, 'Sabbatical'));
    await s.press('Save');
    expect(sent).toEqual(['POST Sabbatical']);
    expect(s.said).toEqual(['close', 'open new1']);
    expect(s.seen).toEqual(['open, your plan', 'closed, new1']);
    await s.unmount();
  });

  test('opened again, it is at its list, and the plans picked for Compare are kept', async () => {
    const { fetcher } = store([...SCENARIOS, entry('d', 'Coast', { set: { withdrawalRate: 0.035 } })]);
    const s = await mount(fetcher);
    // The Plan and the first three, until the person chooses.
    expect(s.picks()).toEqual(['Your plan: true', 'Retire at 50: true', 'Part time: true', 'Spend more: true', 'Coast: false']);
    await s.press('Retire at 50');
    expect(s.picks()).toEqual(['Your plan: true', 'Retire at 50: false', 'Part time: true', 'Spend more: true', 'Coast: false']);
    await s.press('Rename Part time');
    await s.press('Close');
    await settle(400);
    expect(s.dialog()).toBeNull();
    await s.reopen();
    expect(s.title()).toBe('Scenarios');
    expect(s.picks()).toEqual(['Your plan: true', 'Retire at 50: false', 'Part time: true', 'Spend more: true', 'Coast: false']);
    await s.unmount();
  });
});

describe('what it waits for', () => {
  test('while the Plan loads, the list is only why and its rows as placeholders, said once; nothing is compared until it has loaded, so not while it can’t be read either', async () => {
    const { fetcher } = store(SCENARIOS);
    const s = await mount(fetcher, { shown: { planState: 'loading', whyNot: 'Your plan is still loading: scenarios open, and are compared, once it has.', canOpen: false } });
    const loading = s.dialog()!;
    expect(loading.textContent).toContain('Your plan is still loading: scenarios open, and are compared, once it has.');
    // Not a spinner: the rows as they will be, hidden, the card busy, and one status.
    expect(loading.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('spinner'))).toHaveLength(0);
    expect(loading.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent)).toEqual(['Loading your plan']);
    expect(loading.findAll((e) => e.getAttribute('aria-busy') === 'true')).toHaveLength(1);
    expect(loading.findAll((e) => (e.getAttribute('class') ?? '') === 'plan-rows')[0].getAttribute('aria-hidden')).toBe('true');
    for (const absent of ['New scenario', 'What-ifs beside your plan', 'Retire at 50', 'Retirement age: 50', 'Choose two to four plans.']) expect(loading.textContent).not.toContain(absent);
    expect(s.jobs).toEqual([]);

    await s.show({ planState: 'error', whyNot: 'Your saved plan couldn’t be read, so scenarios can’t be worked out against it: try again at the top of the Plan tab.', canOpen: false });
    expect(s.dialog()!.textContent).toContain('Retire at 50');
    expect(s.button('Open Retire at 50')?.disabled).toBe(true);
    expect(s.dialog()!.textContent).not.toContain('Choose two to four plans.');
    expect(s.jobs).toEqual([]);

    await s.show({ planState: 'ready', whyNot: null, canOpen: true });
    expect(s.dialog()!.textContent).toContain('Choose two to four plans.');
    // The Plan and the three scenarios, each its own simulation.
    expect(s.jobs.map((j) => j.kind)).toEqual(['simulate', 'simulate', 'simulate', 'simulate']);
    await s.unmount();
  });
});
