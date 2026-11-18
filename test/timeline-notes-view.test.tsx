import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, type FakeElement } from './mini-dom';

// The chart notes sheet (components/TimelineNotes.tsx TimelineNotesSheet),
// used as a person would (react-dom/client over test/mini-dom.ts), for what
// it shows after Save and Delete (docs/design/guidelines.md#after-save): the
// list, opening on a done notice with focus on it that says what changed; an
// Undo only for a note just added, which removes it as if never added; and a
// refusal said beside the buttons it came from.

const dom = installDom();
type Sent = { method: string; body: unknown };
const sent: Sent[] = [];
let answer: (s: Sent) => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({}) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: { method?: string; body?: string }) => {
  const s = { method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null };
  sent.push(s);
  return answer(s);
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { TimelineNotesSheet } = await import('@/components/TimelineNotes');
type TimelineNote = import('@/components/TimelineNotes').TimelineNote;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
const refused = (error: string) => async () => ({ ok: false, status: 400, json: async () => ({ error }) });
const HOUSE: TimelineNote = { id: 'n1', date: '2025-03-12', text: 'Bought the house', kind: 'user' };

async function mount(notes: TimelineNote[] = [HOUSE]) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  let changed = 0;
  const draw = (open: boolean) => root.render(<TimelineNotesSheet open={open} onClose={() => {}} notes={notes} problem={null} onChanged={() => void changed++} />);
  act(() => draw(true));
  await pass(5);
  const body = dom.document.body as unknown as FakeElement;
  const dialog = () => body.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const field = (label: string) => dialog()?.findAll((e) => e.tagName === 'LABEL' && (e.textContent ?? '').startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const doneLine = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'notice done')[0] ?? null;
  return {
    dialog,
    button,
    field,
    footer,
    doneLine,
    changed: () => changed,
    reopen: async () => {
      act(() => draw(false));
      await pass(400);
      act(() => draw(true));
      await pass(5);
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe('after Save and Delete', () => {
  test('added: said on the list with focus on its line, and Undo removes it as if never added', async () => {
    answer = ok({ id: 'n2', note: {} });
    const v = await mount();
    act(() => click(v.button('Add a note')!));
    await pass(5);
    act(() => type(v.field('Note')!, 'Rolled over the 401(k)'));
    act(() => type(v.field('Day')!, '2025-06-01'));
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ method: 'POST', body: { date: '2025-06-01', text: 'Rolled over the 401(k)' } });
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Chart notes');
    const line = v.doneLine()!;
    expect(line.getAttribute('role')).toBe('status');
    // Focusable by script only, which a browser needs to take the focus.
    expect(line.getAttribute('tabindex')).toBe('-1');
    expect(line.textContent).toContain('Added "Rolled over the 401(k)", for Jun 1, 2025.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.changed()).toBe(1);
    answer = ok({ id: 'n2', removed: true });
    act(() => click(v.button('Undo')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ method: 'DELETE', body: { id: 'n2' } });
    expect(v.doneLine()!.textContent).toContain('Undone: "Rolled over the 401(k)" is no longer on the chart.');
    expect(dom.document.activeElement).toBe(v.doneLine());
    expect(v.button('Undo')).toBeNull();
    expect(v.changed()).toBe(2);
    v.unmount();
  });

  test('on the day it opens on: said for today', async () => {
    answer = ok({ id: 'n3', note: {} });
    const v = await mount();
    act(() => click(v.button('Add a note')!));
    await pass(5);
    act(() => type(v.field('Note')!, 'Paid off the car'));
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.doneLine()!.textContent).toContain('Added "Paid off the car", for today.');
    v.unmount();
  });

  test('an Undo that can’t reach the server: said as an Undo, not a save', async () => {
    answer = ok({ id: 'n2', note: {} });
    const v = await mount();
    act(() => click(v.button('Add a note')!));
    await pass(5);
    act(() => type(v.field('Note')!, 'Rolled over the 401(k)'));
    act(() => click(v.button('Save')!));
    await pass(5);
    answer = async () => {
      throw new Error('offline');
    };
    act(() => click(v.button('Undo')!));
    await pass(5);
    const alert = v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
    expect(alert.textContent).toContain('That note couldn’t be taken back: the server couldn’t be reached.');
    v.unmount();
  });

  test('an Undo refused: said on the list, the Undo still there to try again', async () => {
    answer = ok({ id: 'n2', note: {} });
    const v = await mount();
    act(() => click(v.button('Add a note')!));
    await pass(5);
    act(() => type(v.field('Note')!, 'Rolled over the 401(k)'));
    act(() => click(v.button('Save')!));
    await pass(5);
    answer = refused('That note is gone');
    act(() => click(v.button('Undo')!));
    await pass(5);
    const alert = v.dialog()!.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
    expect(alert.textContent).toContain('That note is gone');
    expect(v.doneLine()!.textContent).toContain('Added "Rolled over the 401(k)"');
    expect(v.button('Undo')).not.toBeNull();
    v.unmount();
  });

  test('edited: said on the list, with no Undo', async () => {
    answer = ok({ id: 'n1', note: {} });
    const v = await mount();
    act(() => click(v.button('Edit')!));
    await pass(5);
    act(() => type(v.field('Note')!, 'Bought the flat'));
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ method: 'PATCH', body: { id: 'n1', date: '2025-03-12', text: 'Bought the flat' } });
    const line = v.doneLine()!;
    expect(line.textContent).toContain('Saved "Bought the flat", for Mar 12, 2025.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.button('Undo')).toBeNull();
    v.unmount();
  });

  test('deleted: said on the list as the note was kept, with no Undo', async () => {
    answer = ok({ id: 'n1', removed: true });
    const v = await mount();
    act(() => click(v.button('Edit')!));
    await pass(5);
    // The form left with other words: what goes, and is said, is the note kept.
    act(() => type(v.field('Note')!, 'Half typed'));
    act(() => click(v.button('Delete…')!));
    await pass(5);
    act(() => click(v.button('Delete')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ method: 'DELETE', body: { id: 'n1' } });
    const line = v.doneLine()!;
    expect(line.textContent).toContain('Deleted "Bought the house" from Mar 12, 2025.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.button('Undo')).toBeNull();
    v.unmount();
  });

  test('refused: said beside the buttons it came from, which point at it', async () => {
    answer = refused('Notes are kept for days from 1970 to today');
    const v = await mount();
    act(() => click(v.button('Edit')!));
    await pass(5);
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Edit note');
    let note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Notes are kept for days from 1970 to today');
    expect(v.button('Save')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.doneLine()).toBeNull();
    answer = refused('That note is gone');
    act(() => click(v.button('Delete…')!));
    await pass(5);
    act(() => click(v.button('Delete')!));
    await pass(5);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Delete note');
    note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.textContent).toContain('That note is gone');
    expect(v.button('Delete')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    // Its buttons in the footer, none in a row of their own.
    expect(v.footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toEqual(['Keep it', 'Delete']);
    expect(v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '').includes('btn-row'))).toEqual([]);
    v.unmount();
  });

  test('opened again: the list, with nothing said from before', async () => {
    answer = ok({ id: 'n1', note: {} });
    const v = await mount();
    act(() => click(v.button('Edit')!));
    await pass(5);
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.doneLine()).not.toBeNull();
    await v.reopen();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Chart notes');
    expect(v.doneLine()).toBeNull();
    v.unmount();
  });
});
