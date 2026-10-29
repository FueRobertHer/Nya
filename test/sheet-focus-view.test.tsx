import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, FakeElement, FakeEvent } from './mini-dom';

// A sheet keeps Tab inside it (design-system.md, Sheet): from its last control
// to its first, Shift+Tab from its first to its last, and focus that has left
// for the page behind comes back in. Rendered as a person would use it
// (react-dom/client over test/mini-dom.ts).

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { Sheet } = await import('@/components/Sheet');

/** The time a sheet takes to slide in (one frame). */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const outside = dom.document.createElement('button');
  dom.document.body.appendChild(outside);
  const root = createRoot(host as unknown as HTMLElement);
  act(() =>
    root.render(
      <Sheet open title="Edit" onClose={() => {}} footer={<button type="button">Save</button>}>
        <input aria-label="Name" />
        <button type="button" disabled>
          Held
        </button>
        <div hidden>
          <button type="button">Unseen</button>
        </div>
      </Sheet>
    )
  );
  const named = (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0];
  const focused = () => dom.document.activeElement as unknown as FakeElement;
  const tab = (shift = false) => {
    const e = new FakeEvent('keydown') as FakeEvent & { shiftKey: boolean };
    e.key = 'Tab';
    e.shiftKey = shift;
    act(() => {
      (dom.document.defaultView as unknown as FakeElement).dispatchEvent(e);
    });
    return e.defaultPrevented;
  };
  return { named, focused, tab, outside: outside as unknown as FakeElement, unmount: () => act(() => root.unmount()) };
}

describe('a sheet keeps Tab inside it', () => {
  test('Tab on its last control goes to its first, Shift+Tab back again', async () => {
    const v = mount();
    await settle();
    // The close button is first; Save, in the footer, last (Held is disabled
    // and Unseen hidden, so neither counts).
    v.named('Save').focus();
    expect(v.tab()).toBe(true);
    expect(v.focused() === v.named('Close')).toBe(true);
    expect(v.tab(true)).toBe(true);
    expect(v.focused() === v.named('Save')).toBe(true);
    v.unmount();
  });

  test('Tab between its controls is left to the browser', async () => {
    const v = mount();
    await settle();
    v.named('Close').focus();
    expect(v.tab()).toBe(false);
    v.unmount();
  });

  test('focus on the page behind comes back in', async () => {
    const v = mount();
    await settle();
    v.outside.focus();
    expect(v.tab()).toBe(true);
    expect(v.focused() === v.named('Close')).toBe(true);
    v.unmount();
  });
});
