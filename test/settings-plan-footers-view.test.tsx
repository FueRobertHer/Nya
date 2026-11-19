import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Buttons in a sheet's footer (docs/design/guidelines.md, Sheets, menus and
// forms), for sheets drawn where a static render can't show them: the admin
// page's Disconnect sheet; the starter sets' preview, a step drawn in two
// sheets it doesn't own (the Categories sheet's level and the offer's own),
// whose Back and Apply go to whichever sheet it is in (SheetFooter), and
// never on another step; and the Plan's opt-in, a level of the Plan's drawer.
// Each has the way out first and the action last, with what the action waits
// on and why it failed beside them as the footer's notes, each the
// action's description. Used as a person would (react-dom/client over
// test/mini-dom.ts).

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: AdminUnusedItems } = await import('@/components/AdminUnusedItems');
const { default: CategoryManager } = await import('@/components/CategoryManager');
const { default: TemplateOffer } = await import('@/components/TemplateOffer');
const { Sheet } = await import('@/components/Sheet');
const { OptInSheet } = await import('@/components/PlanOptIn');
const { planTemplate, archiveCandidates, TEMPLATES } = await import('@/lib/category-templates');
type ShownPlan = import('@/components/CategoryTemplates').ShownPlan;

const body = () => dom.document.body;
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
/** The sheet on the page (not one sliding out). */
const dialog = () => body().findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
/** The open sheet's footer, or null when it draws none: each button's words,
 *  class, whether it waits and what describes it, in order, and each note's
 *  id and words. */
const footer = () => {
  const foot = dialog()?.findAll((e) => classOf(e).includes('sheet-footer'))[0] ?? null;
  if (!foot) return null;
  return {
    buttons: foot.findAll((e) => e.tagName === 'BUTTON').map((b) => [b.textContent, b.getAttribute('class'), b.getAttribute('disabled') !== null, b.getAttribute('aria-describedby')]),
    notes: foot.findAll((e) => classOf(e).includes('sheet-footer-note')).map((n) => [n.getAttribute('id'), n.textContent]),
  };
};
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
};
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};

async function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(node));
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
}

describe('the admin page’s Disconnect sheet', () => {
  test('Cancel, then Disconnect once the name is typed, in the footer; a refusal is said beside them', async () => {
    const row = { container: 'c1', owner: 'sam@example.com', item_id: 'i1', institution_name: 'First Bank', kind: 'refused', since: '2026-09-01T12:00:00.000Z' };
    let refuse = true;
    const deletes: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        deletes.push(JSON.parse(String(init!.body)));
        if (refuse) return Response.json({ error: 'It is in use again, so it was kept.' }, { status: 500 });
        return Response.json({ flag_after_days: 30, items: [] });
      }
      return Response.json({ flag_after_days: 30, items: [row] });
    }) as typeof fetch;
    const v = await mount(<AdminUnusedItems />);
    await press(button(v.host, 'Review and disconnect'));
    expect(dialog()?.getAttribute('aria-label')).toBe('Disconnect First Bank?');
    // The name is typed in the body; the buttons wait on it in the footer.
    expect(footer()).toEqual({
      buttons: [
        ['Cancel', 'btn secondary', false, null],
        ['Disconnect', 'btn danger', true, null],
      ],
      notes: [],
    });
    await act(async () => type(dialog()!.findAll((e) => e.tagName === 'INPUT')[0]!, 'first bank'));
    await settle();
    expect(footer()!.buttons[1][2]).toBe(false);

    await press(button(dialog(), 'Disconnect'));
    expect(deletes).toEqual([{ container: 'c1', item_id: 'i1' }]);
    const refused = footer()!;
    expect(refused.notes).toEqual([[refused.notes[0][0], 'Critical: It is in use again, so it was kept.']]);
    expect(refused.buttons).toEqual([
      ['Cancel', 'btn secondary', false, null],
      ['Disconnect', 'btn danger', false, refused.notes[0][0]],
    ]);

    refuse = false;
    await press(button(dialog(), 'Disconnect'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    expect(dialog()).toBeNull();
    expect(v.host.textContent).toContain('Nothing to review.');
    await v.unmount();
    globalThis.fetch = realFetch;
  });
});

describe('the starter sets’ preview', () => {
  const { taxonomy } = categoriesFor();
  let n = 0;
  const { taxonomy: _t, signature: _s, ...rest } = planTemplate(taxonomy, TEMPLATES.simple, {
    budgets: { categories: {}, groups: {} },
    usage: new Map(archiveCandidates(taxonomy, TEMPLATES.simple).map((id) => [id, { transactions: 0, budget: false, rules: 0, keys: taxonomy.categories.find((c) => c.id === id)!.provider_keys }])),
    recorded: new Set(),
    newId: () => `new${++n}`,
  });
  const shown: ShownPlan = { ...rest, basis: 'b'.repeat(64) };
  expect(shown.unchanged).toBe(false);

  /** The route, as app/api/categories/templates answers: the preview; an
   *  apply refused while `refuse` says so, else applied. */
  const answer = (refuse: { on: boolean }) =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init!.body)) as { action: string };
      if (sent.action === 'preview') return Response.json({ preview: shown });
      if (refuse.on) return Response.json({ error: 'It couldn’t be applied. Try again.' }, { status: 500 });
      return Response.json({ applied: shown, undo: { added: { groups: [], categories: [] } }, categories: taxonomy });
    }) as typeof fetch;

  /** From the list of sets: no footer; the preview: Back, then Apply, and
   *  a refused apply said beside them; applied: no footer again. */
  async function walk() {
    expect(dialog()?.textContent).toContain('See what Simple changes');
    expect(footer()).toBeNull();
    await press(button(dialog(), 'See what Simple changes'));
    expect(footer()).toEqual({
      buttons: [
        ['Back', 'btn secondary', false, null],
        ['Apply Simple', 'btn', false, null],
      ],
      notes: [],
    });
    await press(button(dialog(), 'Apply Simple'));
    const refused = footer()!;
    expect(refused.notes).toEqual([[refused.notes[0][0], 'Critical: It couldn’t be applied. Try again.']]);
    expect(refused.buttons).toEqual([
      ['Back', 'btn secondary', false, null],
      ['Apply Simple', 'btn', false, refused.notes[0][0]],
    ]);
    // Back to the list: the footer goes with the preview.
    await press(button(dialog(), 'Back'));
    expect(footer()).toBeNull();
  }

  test('in the Categories sheet, its level', async () => {
    const refuse = { on: true };
    globalThis.fetch = answer(refuse);
    const v = await mount(<CategoryManager open onClose={() => {}} taxonomy={taxonomy} onTaxonomy={() => {}} />);
    await press(button(dialog(), 'Start from a starter set'));
    expect(dialog()?.getAttribute('aria-label')).toBe('Starter sets');
    await walk();
    await press(button(dialog(), 'See what Simple changes'));
    refuse.on = false;
    await press(button(dialog(), 'Apply Simple'));
    expect(dialog()?.textContent).toContain('Simple is applied.');
    expect(footer()).toBeNull();
    await v.unmount();
    globalThis.fetch = realFetch;
  });

  test('in the offer’s own sheet', async () => {
    const refuse = { on: true };
    globalThis.fetch = answer(refuse);
    const v = await mount(<TemplateOffer taxonomy={taxonomy} onTaxonomy={() => {}} />);
    await press(v.host.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row'))[0]);
    expect(dialog()?.getAttribute('aria-label')).toBe('Starter sets');
    await walk();
    await v.unmount();
    globalThis.fetch = realFetch;
  });
});

describe('the Plan’s opt-in', () => {
  const sheet = (props: Partial<React.ComponentProps<typeof OptInSheet>>) => (
    <Sheet open title="Work out tax from your accounts" onClose={() => {}}>
      <OptInSheet before={null} after={null} working={false} coverageSet={false} money={(x) => `$${x}`} lawYear={2026} onConfirm={async () => true} onDone={() => {}} {...props} />
    </Sheet>
  );

  test('Not now, then Work it out, in the drawer’s footer; a failure is said beside them', async () => {
    const v = await mount(sheet({ onConfirm: async () => 'Your plan wasn’t saved: try again.' }));
    expect(footer()).toEqual({
      buttons: [
        ['Not now', 'btn secondary', false, null],
        ['Work it out', 'btn', false, null],
      ],
      notes: [],
    });
    await press(button(dialog(), 'Work it out'));
    const failed = footer()!;
    expect(failed.notes).toEqual([[failed.notes[0][0], 'Critical: Your plan wasn’t saved: try again.']]);
    expect(failed.buttons[1]).toEqual(['Work it out', 'btn', false, failed.notes[0][0]]);
    await v.unmount();
  });

  test('what it waits on is the footer’s note, and Work it out waits, described by it', async () => {
    const v = await mount(sheet({ paused: 'This can’t be saved yet.' }));
    const waiting = footer()!;
    expect(waiting.notes).toEqual([[waiting.notes[0][0], 'This can’t be saved yet.']]);
    const note = dialog()!.findAll((e) => classOf(e).includes('sheet-footer-note'))[0]!;
    expect(classOf(note)).toEqual(['helper', 'plan-paused', 'sheet-footer-note']);
    expect(waiting.buttons).toEqual([
      ['Not now', 'btn secondary', false, null],
      ['Work it out', 'btn', true, waiting.notes[0][0]],
    ]);
    await v.unmount();
  });
});
