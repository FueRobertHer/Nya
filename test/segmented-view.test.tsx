import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, click, FakeEvent, type FakeElement } from './mini-dom';

// The underline switch (look and feel, step 2a): components/Segmented.tsx,
// a radio group setting a value or tabs over one panel, one tab stop, the
// arrows either way round, Home and End; and the switches drawn with it (the
// net worth chart's range, Allocation's two views), used as a person would
// (react-dom/client over test/mini-dom.ts).

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { Segmented } = await import('@/components/Segmented');
const { default: NetWorthChart } = await import('@/components/NetWorthChart');

const DAYS = [
  ['30', '30 days'],
  ['60', '60 days'],
  ['90', '90 days'],
] as const;

let chosen: string[] = [];

function Harness({ tabs, disabled }: { tabs?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState<string>('30');
  return (
    <Segmented
      label="How far ahead"
      value={value}
      onChange={(v) => {
        chosen.push(v);
        setValue(v);
      }}
      options={DAYS}
      disabled={disabled}
      tabs={tabs ? { id: (v) => `t-${v}`, panel: 'p' } : undefined}
    />
  );
}

function mount(node: React.ReactNode) {
  chosen = [];
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const group = () => host.querySelectorAll('div')[0] as FakeElement;
  const items = () => host.querySelectorAll('button') as FakeElement[];
  return { host, group, items, unmount: () => act(() => root.unmount()) };
}

const key = (el: FakeElement, k: string) => {
  const e = new FakeEvent('keydown');
  e.key = k;
  act(() => {
    el.dispatchEvent(e);
  });
};

describe('Segmented as a radio group', () => {
  test('a named radio group of radios, the chosen one checked and the one tab stop', () => {
    const v = mount(<Harness />);
    expect(v.group().getAttribute('class')).toBe('segmented');
    expect(v.group().getAttribute('role')).toBe('radiogroup');
    expect(v.group().getAttribute('aria-label')).toBe('How far ahead');
    expect(v.items().map((b) => b.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(v.items().map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(v.items().map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(v.items().some((b) => b.getAttribute('aria-selected') !== null)).toBe(false);
    v.unmount();
  });

  test('a press chooses, and the arrows choose either way round, with Home and End, focus going along', () => {
    const v = mount(<Harness />);
    act(() => click(v.items()[2]));
    expect(chosen).toEqual(['90']);
    key(v.group(), 'ArrowRight');
    expect(v.items()[0].getAttribute('aria-checked')).toBe('true');
    expect(dom.document.activeElement).toBe(v.items()[0]);
    key(v.group(), 'ArrowDown');
    key(v.group(), 'ArrowUp');
    key(v.group(), 'ArrowLeft');
    key(v.group(), 'End');
    key(v.group(), 'Home');
    // End on the last one chooses nothing anew: a choice may load something again.
    expect(chosen).toEqual(['90', '30', '60', '30', '90', '30']);
    expect(v.items().map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(dom.document.activeElement).toBe(v.items()[0]);
    v.unmount();
  });

  test('disabled: every item is, and the keys choose nothing', () => {
    const v = mount(<Harness disabled />);
    expect(v.items().every((b) => b.disabled)).toBe(true);
    key(v.group(), 'ArrowRight');
    expect(chosen).toEqual([]);
    v.unmount();
  });
});

describe('Segmented as tabs', () => {
  test('a named tablist of tabs, each controlling the panel, the chosen one selected', () => {
    const v = mount(<Harness tabs />);
    expect(v.group().getAttribute('role')).toBe('tablist');
    expect(v.items().map((b) => b.getAttribute('role'))).toEqual(['tab', 'tab', 'tab']);
    expect(v.items().map((b) => b.getAttribute('id'))).toEqual(['t-30', 't-60', 't-90']);
    expect(v.items().map((b) => b.getAttribute('aria-controls'))).toEqual(['p', 'p', 'p']);
    expect(v.items().map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(v.items().some((b) => b.getAttribute('aria-checked') !== null)).toBe(false);
    key(v.group(), 'ArrowRight');
    expect(v.items().map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    v.unmount();
  });
});

describe('the net worth chart’s range', () => {
  const points = Array.from({ length: 400 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 7, 3) + i * 86_400_000).toISOString().slice(0, 10);
    return { date: d, value: 100 + i };
  });

  test('a compact radio group named Time range, one tab stop, opening on 6M', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(html).toContain('<div class="segmented compact chart-range-switch" role="radiogroup" aria-label="Time range">');
    expect(html).not.toContain('aria-pressed="true">6M<');
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0">6M</);
    expect([...html.matchAll(/role="radio"[^>]*tabindex="0"/g)].length).toBe(1);
  });

  test('an arrow moves the range, and the readout says the new one', () => {
    const v = mount(<NetWorthChart points={points} />);
    const group = v.host.findAll((e) => e.getAttribute('aria-label') === 'Time range')[0]!;
    expect(v.host.textContent).toContain('Past 6 months');
    key(group, 'ArrowRight');
    const checked = group.findAll((e) => e.getAttribute('aria-checked') === 'true')[0]!;
    expect(checked.textContent).not.toBe('6M');
    expect(v.host.textContent).not.toContain('Past 6 months');
    v.unmount();
  });
});
