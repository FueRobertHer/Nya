import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, type FakeElement } from './mini-dom';

// The form behind Classify a holding and Target allocation (AllocationCard's
// SplitForm), used as a person would (react-dom/client over
// test/mini-dom.ts). The screen review: both sheets opened with "Adds up to
// 0%: it needs to be 100%." under empty fields, an error before anything was
// typed. Now a running total, and what is wrong said once Save is pressed.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { SplitForm } = await import('@/components/AllocationCard');
type Split = import('@/lib/allocation/classes').Split;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(initial: Split | null = null) {
  const saved: (Split | null)[] = [];
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() =>
    root.render(
      <SplitForm
        intro="How this holding divides."
        initial={initial}
        canRemove={false}
        editable
        onSave={async (s) => {
          saved.push(s);
          return true;
        }}
        onCancel={() => {}}
      />
    )
  );
  const field = (label: string) => host.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]!.findAll((e) => e.tagName === 'INPUT')[0] as FakeElement;
  const total = () => host.findAll((e) => e.getAttribute('aria-live') === 'polite')[0]!;
  // What Save found wrong, said under the fields (FieldError).
  const said = () => host.findAll((e) => e.getAttribute('class') === 'field-error')[0];
  const error = () => said()?.textContent ?? null;
  const save = () => act(() => click(host.findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Save')[0]!));
  return { saved, field, total, error, said, save, unmount: () => act(() => root.unmount()) };
}

describe('a split’s percents', () => {
  test('empty, it says a running total, in the helper style, and no error', () => {
    const v = mount();
    expect(v.total().textContent).toBe('0% of 100%');
    expect(v.total().getAttribute('class')).toBe('helper');
    expect(v.error()).toBeNull();
    v.unmount();
  });

  test('Save says what is wrong; a change takes the message away, and the total follows what is typed', () => {
    const v = mount();
    v.save();
    expect(v.error()).toBe('Give at least one class a share.');
    act(() => type(v.field('US stocks'), '60'));
    expect(v.error()).toBeNull();
    act(() => type(v.field('Bonds'), '30'));
    expect(v.total().textContent).toBe('90% of 100%');
    v.save();
    expect(v.error()).toBe('These add up to 90%: they need to add up to 100%.');
    // About the shares together: every field is marked, and names what is wrong.
    expect(v.field('Bonds').getAttribute('aria-invalid')).toBe('true');
    expect(v.field('US stocks').getAttribute('aria-describedby')).toBe(v.said()!.getAttribute('id'));
    expect(v.saved).toEqual([]);
    act(() => type(v.field('Bonds'), '40'));
    expect(v.error()).toBeNull();
    expect(v.field('Bonds').getAttribute('aria-invalid')).toBe('false');
    expect(v.total().textContent).toBe('100% of 100%');
    v.unmount();
  });

  test('a split already set opens at its total', () => {
    const v = mount({ 'us-stocks': 70, bonds: 30 });
    expect(v.total().textContent).toBe('100% of 100%');
    expect(v.error()).toBeNull();
    v.unmount();
  });
});
