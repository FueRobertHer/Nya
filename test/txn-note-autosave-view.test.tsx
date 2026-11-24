import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, FakeEvent, type FakeElement } from './mini-dom';

// A transaction's note (components/TxnTagsNote.tsx) is saved when its field
// loses focus, and when the sheet closes with it changed, as the category is
// saved as it is chosen: closing the sheet never drops what was typed. Save
// note still saves it in place, once. Used as a person would
// (react-dom/client over test/mini-dom.ts).

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: TxnTagsNote } = await import('@/components/TxnTagsNote');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = { transaction_id: 't1', name: 'Tartine Bakery', pending: false, tags: [], note: null as string | null };

function mount(saved: string[], answer = true) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const onSaveNote = async (note: string) => {
    saved.push(note);
    return answer;
  };
  act(() => root.render(<TxnTagsNote t={row} tags={[]} onChangeTags={async () => true} onSaveNote={onSaveNote} />));
  const field = () => host.findAll((e) => e.tagName === 'TEXTAREA')[0];
  const button = (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  return {
    field,
    button,
    write: (text: string) => act(() => type(field(), text)),
    blur: () => act(() => void field().dispatchEvent(new FakeEvent('focusout'))),
    close: () => {
      act(() => root.unmount());
      host.parentNode?.removeChild(host);
    },
  };
}

describe('a transaction’s note', () => {
  test('is saved when its field loses focus', async () => {
    const saved: string[] = [];
    const v = mount(saved);
    v.write('  Birthday cake for Sam  ');
    expect(saved).toEqual([]);
    v.blur();
    await act(async () => {});
    expect(saved).toEqual(['Birthday cake for Sam']);
    v.close();
  });

  test('is saved when the sheet closes with it typed and not yet saved', () => {
    const saved: string[] = [];
    const v = mount(saved);
    v.write('Split with Priya');
    v.close();
    expect(saved).toEqual(['Split with Priya']);
  });

  test('nothing is sent when nothing changed', () => {
    const saved: string[] = [];
    const v = mount(saved);
    v.blur();
    v.write('   ');
    v.close();
    expect(saved).toEqual([]);
  });

  test('Save note, pressed while the blur’s save is out, sends it once', () => {
    const saved: string[] = [];
    const v = mount(saved);
    v.write('Gift');
    v.blur();
    act(() => click(v.button('Save note')!));
    expect(saved).toEqual(['Gift']);
    v.close();
  });
});
