import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { installDom, click, FakeElement, type FakeNode } from './mini-dom';

// The parts of the dashboard whose code is loaded when first needed, not with
// Home (components/lazy-part.tsx): Home's own code never reaches them by a
// static import, a part loads once and tries again after a failure, a sheet
// waits until it is opened and then stays, and a failure stays in the part's
// place. Rendered with react-dom/client over test/mini-dom.ts.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { lazyPart, onPartShown, useLazyPart, PartBoundary, PartUnavailable } = await import('@/components/lazy-part');
const { LazySheet, SLOW_MS } = await import('@/components/LazySheets');
const { default: BudgetsTabLoader, BudgetsUnavailable } = await import('@/components/BudgetsTabLoader');
const { CardUnavailable, ApiTokens } = await import('@/components/SettingsCardsLoader');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function elements(n: FakeNode): FakeElement[] {
  return n.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...elements(c)] : []));
}
const button = (host: FakeNode, label: string) => elements(host).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label) ?? null;

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  return {
    host,
    render: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      dom.document.body.removeChild(host);
    },
  };
}

/** A part whose import the test settles: `arrive` or `fail` the pending one. */
function controlled<M>() {
  let calls = 0;
  let pending: { resolve: (m: M) => void; reject: (e: Error) => void } | null = null;
  const part = lazyPart<M>(() => {
    calls++;
    return new Promise<M>((res, rej) => (pending = { resolve: res, reject: rej }));
  });
  return {
    part,
    calls: () => calls,
    arrive: (m: M) => act(async () => void pending!.resolve(m)),
    fail: () => act(async () => void pending!.reject(new Error('chunk failed'))),
  };
}

describe("Home's code doesn't reach the parts loaded later", () => {
  const ROOT = join(import.meta.dir, '..');
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };
  const resolveLocal = (from: string, spec: string) => {
    const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (existsSync(p) && statSync(p).isFile()) return p;
    return null;
  };

  test('no static import from app/page.tsx reaches them; only an import() does', () => {
    const seen = new Set<string>();
    const queue = [join(ROOT, 'app/page.tsx')];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const i of transpilers[file.endsWith('.tsx') ? 'tsx' : 'ts'].scanImports(readFileSync(file, 'utf8'))) {
        if (i.kind === 'dynamic-import') continue;
        const target = resolveLocal(file, i.path);
        if (target) queue.push(target);
      }
    }
    const reached = [...seen].map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(reached).toContain('components/Dashboard.tsx');
    const later = [
      'components/BudgetsTab.tsx',
      'components/DebtPayoff.tsx',
      'components/MigrationSheet.tsx',
      'components/ImportSheet.tsx',
      'components/HistoryImportSheet.tsx',
      'components/settings-cards.ts',
      'components/RestoreCard.tsx',
      'components/ApiTokens.tsx',
      'components/WeeklySummaryCard.tsx',
      'components/CurrencyCard.tsx',
      'components/PlanTab.tsx',
    ];
    expect(reached.filter((f) => later.includes(f) || f.startsWith('lib/age/') || f.startsWith('lib/user-restore/') || f.startsWith('lib/import/'))).toEqual([]);
  });
});

describe('a part', () => {
  test('a failed import is forgotten, so trying again imports again; once loaded, it is kept', async () => {
    let calls = 0;
    let fail = true;
    const part = lazyPart(() => {
      calls++;
      return fail ? Promise.reject(new Error('chunk failed')) : Promise.resolve({ n: 1 });
    });
    await expect(part.load()).rejects.toThrow('chunk failed');
    await expect(part.load()).rejects.toThrow('chunk failed');
    expect(part.loaded()).toBeNull();
    fail = false;
    const mod = await part.load();
    expect(part.loaded()).toBe(mod);
    expect(await part.load()).toBe(mod);
    expect(calls).toBe(3);
  });

  test('loads only once wanted, offers to try again after a failure, and says when it arrives', async () => {
    const c = controlled<{ word: string }>();
    let arrivals = 0;
    const stop = onPartShown(() => arrivals++);
    function Probe({ wanted }: { wanted: boolean }) {
      const { mod, failed, retry } = useLazyPart(c.part, wanted);
      if (mod) return <p>{mod.word}</p>;
      if (failed) return <button onClick={retry}>Try again</button>;
      return <p>waiting</p>;
    }
    const m = mount(<Probe wanted={false} />);
    expect(c.calls()).toBe(0);
    m.render(<Probe wanted />);
    expect(c.calls()).toBe(1);
    await c.fail();
    act(() => click(button(m.host, 'Try again')!));
    expect(c.calls()).toBe(2);
    expect(arrivals).toBe(0);
    await c.arrive({ word: 'here' });
    expect(m.host.textContent).toBe('here');
    expect(arrivals).toBe(1);
    stop();
    m.unmount();
  });

  test('a part that stops while it runs says so in its place, and starts afresh on Try again', () => {
    let broken = true;
    function Fragile() {
      if (broken) throw new Error('stopped');
      return <p>working</p>;
    }
    const error = console.error;
    console.error = noop;
    try {
      const m = mount(
        <div>
          <p>beside it</p>
          <PartBoundary name="Fragile" fallback={(again) => <button onClick={again}>Try again</button>}>
            <Fragile />
          </PartBoundary>
        </div>
      );
      expect(m.host.textContent).toContain('beside it');
      broken = false;
      act(() => click(button(m.host, 'Try again')!));
      expect(m.host.textContent).toBe('beside itworking');
      m.unmount();
    } finally {
      console.error = error;
    }
  });

  test('what it says when it is unavailable', () => {
    const load = text(renderToStaticMarkup(<PartUnavailable what="This card" after="The rest of Settings works as before." reason="load" onRetry={noop} />));
    expect(load).toBe("This card couldn't be loaded. It needs a connection the first time it opens after an update. The rest of Settings works as before. Try again Reload the page");
    expect(text(renderToStaticMarkup(<PartUnavailable what="This" reason="crash" onRetry={noop} />))).toContain('This ran into a problem and stopped.');
  });
});

describe('the Budgets tab and Settings cards before their code is in', () => {
  test('the Budgets tab draws its skeleton, its bar unavailable', () => {
    const html = renderToStaticMarkup(<BudgetsTabLoader {...({ segment: 'upcoming' } as Parameters<typeof BudgetsTabLoader>[0])} />);
    expect(html).toContain('<div inert="">');
    expect(text(html)).toContain('Cash forecast');
    expect(text(html)).toContain('Loading what is coming');
  });

  test('a Settings card draws a card of rows still to come', () => {
    const html = renderToStaticMarkup(<ApiTokens clerk={false} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="card stack"');
  });

  test('a failure keeps the rest working', () => {
    expect(text(renderToStaticMarkup(<BudgetsUnavailable reason="load" onRetry={noop} />))).toContain(
      "The Budgets tab couldn't be loaded. It needs a connection the first time it opens after an update. The other tabs work as before."
    );
    expect(text(renderToStaticMarkup(<CardUnavailable reason="crash" onRetry={noop} />))).toContain('This card ran into a problem and stopped. The rest of Settings works as before.');
  });
});

describe('a sheet loaded on demand', () => {
  type Mod = { default: (p: { open: boolean }) => React.ReactNode };
  let mounts = 0;
  function RealSheet({ open }: { open: boolean }) {
    const [typed] = useState(() => ++mounts);
    return <p>{open ? `open ${typed}` : `closed ${typed}`}</p>;
  }
  const sheet = (part: ReturnType<typeof controlled<Mod>>['part'], open: boolean) => (
    <LazySheet part={part} open={open} title="Payoff plan" onClose={noop}>
      {(m) => <m.default open={open} />}
    </LazySheet>
  );

  test('nothing until first opened; then it loads, opens, and stays mounted once closed', async () => {
    mounts = 0;
    const c = controlled<Mod>();
    const m = mount(sheet(c.part, false));
    expect(c.calls()).toBe(0);
    expect(m.host.textContent).toBe('');
    m.render(sheet(c.part, true));
    expect(c.calls()).toBe(1);
    await c.arrive({ default: RealSheet });
    expect(m.host.textContent).toBe('open 1');
    m.render(sheet(c.part, false));
    // The same sheet, closed: what was typed into it is kept.
    expect(m.host.textContent).toBe('closed 1');
    m.render(sheet(c.part, true));
    expect(m.host.textContent).toBe('open 1');
    expect(mounts).toBe(1);
    m.unmount();
  });

  test('when its code is slow, it opens without it, its rows still to come', async () => {
    const c = controlled<Mod>();
    const m = mount(sheet(c.part, true));
    expect(m.host.textContent).toBe('');
    await settle(SLOW_MS + 50);
    expect(elements(dom.document.body).some((e) => e.getAttribute('aria-label') === 'Payoff plan' || e.textContent.includes('Payoff plan'))).toBe(true);
    await c.arrive({ default: RealSheet });
    expect(m.host.textContent).toContain('open');
    m.unmount();
  });

  test("when its code can't be loaded, the sheet says so and Try again fetches it again", async () => {
    const c = controlled<Mod>();
    const m = mount(sheet(c.part, true));
    await c.fail();
    const body = dom.document.body;
    expect(body.textContent).toContain("This couldn't be loaded. It needs a connection the first time it opens after an update. The rest of the app works as before.");
    act(() => click(button(body, 'Try again')!));
    expect(c.calls()).toBe(2);
    await c.arrive({ default: RealSheet });
    expect(m.host.textContent).toContain('open');
    m.unmount();
  });
});

describe("the dashboard's focus after a Needs attention row", () => {
  // Dashboard isn't mounted in a test: its source says what it does.
  const dashboard = readFileSync(join(import.meta.dir, '..', 'components/Dashboard.tsx'), 'utf8');

  test("waits past a skeleton's copy of its target, which can't take focus", () => {
    expect(dashboard).toContain("if (!target || target.closest('[inert]')) return;");
  });

  test('looks again when a part arrives, which draws with no render of the dashboard', () => {
    expect(dashboard).toContain('useEffect(() => (focusTarget ? onPartShown(() => setFocusTarget((t) => t && { ...t })) : undefined), [focusTarget]);');
  });
});
