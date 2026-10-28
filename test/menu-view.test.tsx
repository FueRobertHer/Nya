import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, FakeEvent, type FakeElement } from './mini-dom';

// The primitives rollout phase 3 brings with their first users: an object's
// ⋯ menu, the "Why?" disclosure and a sheet's footer. The menu is rendered
// and used as a person would (react-dom/client over test/mini-dom.ts): it
// opens on its first item, moves with the keys, closes on Escape without
// closing the sheet it is in, and gives focus back to its button.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { Menu, menuOrder, menuPlacement, nextIndex } = await import('@/components/Menu');
const { Why } = await import('@/components/Why');
const { Sheet } = await import('@/components/Sheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

const find = (host: FakeElement, test: (e: FakeElement) => boolean) => host.findAll(test);
const key = (el: FakeElement, k: string) => {
  const e = new FakeEvent('keydown');
  e.key = k;
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

describe('the ⋯ menu', () => {
  test('a destructive item is always drawn last', () => {
    const order = menuOrder([
      { label: 'Disconnect…', onSelect: () => {}, danger: true },
      { label: 'Connection details', onSelect: () => {} },
      { label: 'Add or remove accounts', onSelect: () => {} },
    ]).map((i) => i.label);
    expect(order).toEqual(['Connection details', 'Add or remove accounts', 'Disconnect…']);
  });

  test('the keys move between enabled items and wrap', () => {
    const enabled = [true, false, true, true];
    expect(nextIndex('ArrowDown', 0, enabled)).toBe(2);
    expect(nextIndex('ArrowDown', 3, enabled)).toBe(0);
    expect(nextIndex('ArrowUp', 0, enabled)).toBe(3);
    expect(nextIndex('ArrowUp', -1, enabled)).toBe(3);
    expect(nextIndex('Home', 3, enabled)).toBe(0);
    expect(nextIndex('End', 0, enabled)).toBe(3);
    expect(nextIndex('a', 0, enabled)).toBeNull();
  });

  test('placed under its button and aligned to its right edge, or above it and moved in to stay on a 320px screen', () => {
    const phone = { width: 320, height: 800 };
    const menu = { width: 220, height: 98 };
    // A card's ⋯ at the right edge, near the top: below, right-aligned.
    expect(menuPlacement({ top: 100, bottom: 144, left: 260, right: 304 }, menu, phone)).toEqual({ up: false, left: null });
    // A sheet footer's ⋯ in the middle of the bottom row (as measured at
    // 320px): above it, and moved in from the left edge, 8px from it.
    expect(menuPlacement({ top: 740, bottom: 784, left: 169, right: 213 }, menu, phone)).toEqual({ up: true, left: 8 - 169 });
    // Never past the right edge either.
    expect(menuPlacement({ top: 100, bottom: 144, left: 300, right: 344 }, menu, phone)).toEqual({ up: false, left: 320 - 8 - 220 - 300 });
    // A screen narrower than the menu: it starts at the left margin.
    expect(menuPlacement({ top: 100, bottom: 144, left: 150, right: 194 }, menu, { width: 200, height: 800 })).toEqual({ up: false, left: 8 - 150 });
  });

  test('with every item disabled, focus stays on its button, and Escape there still closes only the menu', () => {
    const { host, unmount } = mount(<Menu label="More for Cash" items={[{ label: 'Delete…', onSelect: () => {}, danger: true, disabled: true }]} />);
    const [trigger] = find(host, (e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(trigger));
    act(() => trigger.focus());
    let sheetHeard = 0;
    (dom.document.defaultView as unknown as { addEventListener: (t: string, f: () => void) => void }).addEventListener('keydown', () => sheetHeard++);
    const esc = key(trigger, 'Escape');
    expect(esc.propagationStopped).toBe(true);
    expect(sheetHeard).toBe(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    unmount();
  });

  test('closed, it is one labelled button that says it opens a menu', () => {
    const html = renderToStaticMarkup(<Menu label="Options for Chase" items={[{ label: 'Rename', onSelect: () => {} }]} />);
    expect(html).toContain('class="icon-btn"');
    expect(html).toContain('aria-label="Options for Chase"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  test('opens on its first item, moves with the keys, and Escape closes it without reaching the sheet', () => {
    const chosen: string[] = [];
    const { host, unmount } = mount(
      <Menu
        label="Options for Chase"
        items={[
          { label: 'Disconnect…', onSelect: () => chosen.push('disconnect'), danger: true },
          { label: 'Connection details', onSelect: () => chosen.push('details') },
          { label: 'Enable payment details', onSelect: () => chosen.push('enable'), disabled: true },
          { label: 'Add or remove accounts', onSelect: () => chosen.push('accounts') },
        ]}
      />
    );
    const [trigger] = find(host, (e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(trigger));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const [menu] = find(host, (e) => e.getAttribute('role') === 'menu');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.getAttribute('id'));
    const items = find(host, (e) => e.getAttribute('role') === 'menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Connection details', 'Enable payment details', 'Add or remove accounts', 'Disconnect…']);
    expect(items[3].getAttribute('class')).toBe('menu-item danger');
    expect(dom.document.activeElement).toBe(items[0]);

    // Down skips the disabled item; End goes to the last.
    key(dom.document.activeElement as unknown as FakeElement, 'ArrowDown');
    expect(dom.document.activeElement).toBe(items[2]);
    key(dom.document.activeElement as unknown as FakeElement, 'End');
    expect(dom.document.activeElement).toBe(items[3]);
    key(dom.document.activeElement as unknown as FakeElement, 'Home');
    expect(dom.document.activeElement).toBe(items[0]);

    // A sheet listens for Escape on the window: the menu keeps it.
    let sheetHeard = 0;
    const onWindowKey = () => sheetHeard++;
    (dom.document.defaultView as unknown as { addEventListener: (t: string, f: () => void) => void }).addEventListener('keydown', onWindowKey);
    const esc = key(dom.document.activeElement as unknown as FakeElement, 'Escape');
    expect(esc.propagationStopped).toBe(true);
    expect(sheetHeard).toBe(0);
    expect(find(host, (e) => e.getAttribute('role') === 'menu')).toHaveLength(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(dom.document.activeElement).toBe(trigger);
    expect(chosen).toEqual([]);
    unmount();
  });

  test('choosing an item closes it, gives focus back to its button, then acts', () => {
    const order: string[] = [];
    const { host, unmount } = mount(<Menu label="Account options" items={[{ label: 'Import history from a file', onSelect: () => order.push(`chosen, focus on ${dom.document.activeElement.getAttribute('aria-label')}`) }]} />);
    const [trigger] = find(host, (e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(trigger));
    const [item] = find(host, (e) => e.getAttribute('role') === 'menuitem');
    act(() => click(item));
    expect(order).toEqual(['chosen, focus on Account options']);
    expect(find(host, (e) => e.getAttribute('role') === 'menu')).toHaveLength(0);
    unmount();
  });

  test('a file to save is a link item: reached by the keys, it closes the menu and gives focus back as it is chosen', () => {
    const { host, unmount } = mount(
      <Menu
        label="More for this report"
        items={[
          { label: 'Download as CSV', href: '/api/reports?kind=year&year=2025&format=csv', download: true },
          { label: 'Mark categories', onSelect: () => {} },
        ]}
      />
    );
    const [trigger] = find(host, (e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(trigger));
    const items = find(host, (e) => e.getAttribute('role') === 'menuitem');
    expect(items.map((i) => [i.tagName, i.textContent, i.getAttribute('class')])).toEqual([
      ['A', 'Download as CSV', 'menu-item'],
      ['BUTTON', 'Mark categories', 'menu-item'],
    ]);
    expect(items[0].getAttribute('href')).toBe('/api/reports?kind=year&year=2025&format=csv');
    expect(items[0].getAttribute('download')).not.toBeNull();
    expect(items[0].getAttribute('tabindex')).toBe('-1');
    // Opening focuses it, first and enabled; the keys move off it and back.
    expect(dom.document.activeElement).toBe(items[0]);
    key(items[0], 'ArrowDown');
    expect(dom.document.activeElement).toBe(items[1]);
    key(items[1], 'ArrowUp');
    expect(dom.document.activeElement).toBe(items[0]);
    act(() => click(items[0]));
    expect(find(host, (e) => e.getAttribute('role') === 'menu')).toHaveLength(0);
    expect(dom.document.activeElement).toBe(trigger);
    unmount();
  });

  test('a press outside closes it', () => {
    const { host, unmount } = mount(<Menu label="Options" items={[{ label: 'Rename', onSelect: () => {} }]} />);
    const [trigger] = find(host, (e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(trigger));
    expect(find(host, (e) => e.getAttribute('role') === 'menu')).toHaveLength(1);
    act(() => {
      dom.document.body.dispatchEvent(new FakeEvent('pointerdown'));
    });
    expect(find(host, (e) => e.getAttribute('role') === 'menu')).toHaveLength(0);
    unmount();
  });
});

describe('the "Why?" disclosure', () => {
  test('is a closed <details> whose summary is the ghost button', () => {
    const html = renderToStaticMarkup(<Why label="Which should I use?">SimpleFIN reaches banks in the US and Canada.</Why>);
    expect(html).toBe('<details class="why"><summary>Which should I use?</summary><div class="why-body">SimpleFIN reaches banks in the US and Canada.</div></details>');
    expect(renderToStaticMarkup(<Why>x</Why>)).toContain('<summary>Why?</summary>');
  });
});

describe('a sheet footer', () => {
  test('holds its buttons after the scrolling body, only when given', () => {
    const withFooter = renderToStaticMarkup(
      <Sheet open title="Total Checking" onClose={() => {}} footer={<button className="btn secondary">Hide</button>}>
        <p>Body</p>
      </Sheet>
    );
    expect(withFooter).toContain('<div class="sheet-body"><p>Body</p></div><div class="sheet-footer"><button class="btn secondary">Hide</button></div>');
    const without = renderToStaticMarkup(
      <Sheet open title="Total Checking" onClose={() => {}}>
        <p>Body</p>
      </Sheet>
    );
    expect(without).not.toContain('sheet-footer');
  });
});
