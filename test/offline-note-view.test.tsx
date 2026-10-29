import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, FakeEvent, type FakeElement } from './mini-dom';

// Offline (design-system.md, Status and honesty): Nya keeps the last numbers
// and puts a caution on Home's total, "Offline. Showing balances from 9:41
// AM.", following navigator.onLine and the online and offline events, and
// takes it away again once the device is back online.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: NetWorthCard } = await import('@/components/NetWorthCard');
const { offlineCaveats, offlineWords, useOfflineCaveats } = await import('@/components/online');
const { formatDay } = await import('@/lib/format');

const nav = globalThis.navigator as unknown as { onLine?: boolean };
const setOnline = (on: boolean) => {
  nav.onLine = on;
  act(() => {
    (globalThis.window as unknown as FakeElement).dispatchEvent(new FakeEvent(on ? 'online' : 'offline', false));
  });
};

const noop = () => {};
function Home({ asOf }: { asOf: string | null }) {
  return (
    <NetWorthCard
      worth={1234.5}
      currency="USD"
      delta={null}
      caveats={useOfflineCaveats(asOf)}
      chart={null}
      pausedSince={null}
      notesProblem={null}
      backupProblem={null}
      filesProblem={null}
      asOf={asOf}
      refreshing={false}
      notesCount={0}
      onNotes={noop}
    />
  );
}

const mounted = new Set<() => void>();
afterEach(() => {
  for (const unmount of mounted) unmount();
  delete nav.onLine;
});

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const unmount = () => {
    if (mounted.delete(unmount)) act(() => root.unmount());
  };
  mounted.add(unmount);
  const notices = () => host.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('notice'));
  return { host, notices };
}

/** 9:41 this morning, local time: when the numbers shown were loaded. */
const nineFortyOne = () => {
  const d = new Date();
  d.setHours(9, 41, 0, 0);
  return d;
};
const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('the offline note on Home’s total', () => {
  test('online, nothing is said', () => {
    nav.onLine = true;
    const v = mount(<Home asOf={nineFortyOne().toISOString()} />);
    expect(v.notices()).toEqual([]);
    expect(v.host.textContent).not.toContain('Offline');
  });

  test('going offline puts a caution on the total with the time of its numbers, and coming back takes it away', () => {
    nav.onLine = true;
    const loaded = nineFortyOne();
    const v = mount(<Home asOf={loaded.toISOString()} />);
    setOnline(false);
    const [note] = v.notices();
    expect(note.getAttribute('class')).toBe('notice caution');
    expect(note.textContent).toBe(`Caution: Offline. Showing balances from ${timeOf(loaded)}.`);
    setOnline(true);
    expect(v.notices()).toEqual([]);
  });

  test('a page that opens offline says so at once', () => {
    nav.onLine = false;
    const v = mount(<Home asOf={nineFortyOne().toISOString()} />);
    expect(v.notices().map((n) => n.textContent)).toEqual([`Caution: Offline. Showing balances from ${timeOf(nineFortyOne())}.`]);
  });

  test('a browser that doesn’t say whether it is online is taken as online', () => {
    delete nav.onLine;
    expect(mount(<Home asOf={null} />).notices()).toEqual([]);
  });

  test('the server draws it online, so the first paint matches', () => {
    nav.onLine = false;
    expect(renderToStaticMarkup(<Home asOf={nineFortyOne().toISOString()} />)).not.toContain('Offline');
  });
});

describe('what the note says', () => {
  const now = new Date(2026, 9, 29, 15, 0);
  test('the time today, the day and the time before, in the person’s own time', () => {
    const today = new Date(2026, 9, 29, 9, 41);
    expect(offlineWords(today.toISOString(), now)).toBe(`Offline. Showing balances from ${timeOf(today)}.`);
    const yesterday = new Date(2026, 9, 28, 21, 5);
    expect(offlineWords(yesterday.toISOString(), now)).toBe(`Offline. Showing balances from yesterday at ${timeOf(yesterday)}.`);
    const before = new Date(2026, 9, 20, 8, 0);
    expect(offlineWords(before.toISOString(), now)).toBe(`Offline. Showing balances from ${formatDay('2026-10-20', { now })} at ${timeOf(before)}.`);
    const lastYear = new Date(2025, 11, 30, 8, 0);
    expect(offlineWords(lastYear.toISOString(), now)).toContain('2025');
  });

  test('with no time for the numbers, it still says it is offline', () => {
    expect(offlineWords(null, now)).toBe('Offline. Showing the last balances this device saved.');
    expect(offlineWords('not a time', now)).toBe('Offline. Showing the last balances this device saved.');
  });

  test('a caution, never lower, and nothing while online', () => {
    expect(offlineCaveats(true, null, now)).toEqual([]);
    expect(offlineCaveats(false, null, now)).toEqual([{ key: 'offline', severity: 'caution', summary: 'offline', body: 'Offline. Showing the last balances this device saved.' }]);
  });
});
