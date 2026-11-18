import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, type FakeElement } from './mini-dom';

// The Tags card (components/TagsCard.tsx) opened from elsewhere: a
// transaction's Rename or delete tags opens Settings > Transactions with the
// card's drawer open on its list. Played inside Settings' own screen
// (components/Settings.tsx), which puts focus on its heading as it opens, so
// the drawer still gives focus back to Edit tags as it closes, as when Edit
// tags is pressed (react-dom/client over test/mini-dom.ts).

const dom = installDom();
const at = '2026-10-01T00:00:00.000Z';
const TAGS = [
  { id: 'trip', name: 'Vacation', color: 'blue', created_at: at },
  { id: 'work', name: 'Reimbursable', color: 'green', created_at: at },
];
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: true, json: async () => ({ tags: TAGS, counts: { work: 2 } }) })) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act, useCallback, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: TagsCard } = await import('@/components/TagsCard');
const { SettingsScreen } = await import('@/components/Settings');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const noop = () => {};

async function mount(focus: boolean) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  let focused = 0;
  function Screen() {
    const [asked, setAsked] = useState(focus);
    const onFocused = useCallback(() => {
      focused++;
      setAsked(false);
    }, []);
    const content = <TagsCard tags={TAGS} onChanged={noop} focus={asked} onFocused={onFocused} />;
    return <SettingsScreen view="transactions" sections={[{ id: 'transactions', title: 'Transactions', sub: '', content }]} onView={noop} onClose={noop} />;
  }
  act(() => root.render(<Screen />));
  // Two frames: the card's, then the drawer's sliding in.
  await pass(20);
  await pass(20);
  const doc = dom.document.body as unknown as FakeElement;
  const dialog = () => doc.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const editTags = () => doc.findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Edit tags')[0] ?? null;
  return {
    dialog,
    editTags,
    focused: () => focused,
    close: async () => {
      act(() => click(dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0]!));
      await pass(400);
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe('the Tags card opened from a transaction', () => {
  test('its drawer opens on the list, focus on it; closed, focus is on Edit tags, not Settings’ heading', async () => {
    const v = await mount(true);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Tags');
    expect(dom.document.activeElement).toBe(v.dialog()!);
    expect(v.dialog()!.textContent).toContain('Reimbursable');
    expect(v.focused()).toBe(1);
    await v.close();
    expect(v.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(v.editTags()!);
    v.unmount();
  });

  test('opened as Settings > Transactions alone: the drawer stays shut, focus on the heading', async () => {
    const v = await mount(false);
    expect(v.dialog()).toBeNull();
    expect((dom.document.activeElement as FakeElement).getAttribute('id')).toBe('settings-title');
    expect(v.focused()).toBe(0);
    v.unmount();
  });
});
