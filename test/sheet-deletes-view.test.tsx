import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Deleting from a sheet (docs/design/design-system.md, Destructive action
// row): a goal's, a rule's, the target allocation and a split. Each is the
// sheet's last action row, never a button that acts at once; it opens a
// level of the same sheet that says what goes and that it can't be undone,
// with Cancel then Delete in the footer. The level's Cancel takes focus;
// Cancel goes back to the form as it was typed, focus on the row; a refused
// delete is said beside Delete; once deleted the sheet closes. Used as a
// person would (react-dom/client over test/mini-dom.ts).

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act, useState } = React;
// React's client reads what the document supports once, when it loads.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: GoalSheet } = await import('@/components/GoalSheet');
const { default: RulesCard } = await import('@/components/RulesCard');
const { default: RuleSheet } = await import('@/components/RuleSheet');
const { useRules } = await import('@/components/rules-state');
const { default: AllocationCard } = await import('@/components/AllocationCard');
const { addRule, deleteRule, emptyRuleSet } = await import('@/lib/rules');
const { indexTaxonomy } = await import('@/lib/categories');
const { allocate, planMix } = await import('@/lib/allocation/allocation');
const { EMPTY_SETTINGS } = await import('@/lib/allocation/settings');
const { initialListState } = await import('@/lib/whole-list-store');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { localDate } = await import('@/lib/local-date');
type Goal = import('@/lib/goal-model').Goal;
type GoalAccount = import('@/lib/goal-view').GoalAccount;
type AllocationSettings = import('@/lib/allocation/settings').AllocationSettings;
type AllocInstitution = import('@/lib/allocation/allocation').AllocInstitution;

const body = () => dom.document.body;
const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
const dialog = (title: string) => body().findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('aria-label') === title)[0] ?? null;
const footerOf = (d: FakeElement | null) => d?.findAll((e) => classOf(e).includes('sheet-footer'))[0] ?? null;
const buttons = (within: FakeElement | null) => (within?.findAll((e) => e.tagName === 'BUTTON') ?? []).map((b) => [b.textContent, b.getAttribute('class')]);
const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
/** An action row, by its title. */
const row = (within: FakeElement | null, title: string) =>
  within?.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row') && e.findAll((t) => classOf(t).includes('list-row-title'))[0]?.textContent === title)[0] ?? null;
const rowTitles = (within: FakeElement | null) => (within?.findAll((e) => classOf(e).includes('list-row-title')) ?? []).map((t) => t.textContent);
const field = (within: FakeElement | null, label: string) =>
  within?.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
const valueOf = (el: FakeElement | null) => (el as unknown as { value: string } | null)?.value;
const focused = () => dom.document.activeElement;
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

/** The level that asks, as every one of these draws it: its question, then
 *  Cancel (with focus) and Delete in the footer. */
function expectAsking(title: string, question: string) {
  const ask = dialog(title);
  expect(ask?.getAttribute('data-open')).toBe('true');
  expect(ask!.textContent).toContain(question);
  // A back arrow to the form.
  expect(ask!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back').length).toBe(1);
  const footer = footerOf(ask)!;
  expect(buttons(footer).filter(([words]) => words !== '')).toEqual([
    ['Cancel', 'btn secondary'],
    ['Delete', 'btn danger'],
  ]);
  expect(focused() === button(footer, 'Cancel')).toBe(true);
  return footer;
}

/** A refused delete: still asking, its reason a footer note Delete is
 *  described by. */
function expectRefused(title: string, reason: string) {
  const footer = footerOf(dialog(title))!;
  const note = footer.findAll((e) => classOf(e).includes('sheet-footer-note'))[0]!;
  expect(note.textContent).toContain(reason);
  expect(button(footer, 'Delete')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
}

describe('a goal', () => {
  const ACCOUNTS: GoalAccount[] = [{ account_id: 'sav', name: 'Savings', institution: 'Chase', balance: 10_000, currency: 'USD', type: 'depository' }];
  const trip: Goal = { id: 'trip', name: 'Trip', target: 80_000, account_id: 'sav' };
  const bike: Goal = { id: 'bike', name: 'Bike', target: 900, account_id: 'sav' };

  test('Archive goal then Delete goal, as rows; Delete asks in a level, Cancel keeps what was typed, a refusal is said, then it goes', async () => {
    const saves: Goal[][] = [];
    let refuse = true;
    function Harness() {
      const [open, setOpen] = useState(true);
      const [error, setError] = useState<string | null>(null);
      return (
        <GoalSheet
          open={open}
          goal={trip}
          goals={[trip, bike]}
          accounts={ACCOUNTS}
          flows={null}
          today={localDate()}
          saveError={error}
          onClose={() => setOpen(false)}
          onSave={async (next) => {
            saves.push(next);
            if (!refuse) return true;
            setError('It couldn’t be saved.');
            return false;
          }}
        />
      );
    }
    const v = await mount(<Harness />);
    const edit = dialog('Edit goal')!;
    // No danger-outline button: the actions are rows, Delete last and in --neg.
    expect(edit.findAll((e) => classOf(e).includes('danger-outline')).length).toBe(0);
    expect(rowTitles(edit)).toEqual(['Archive goal', 'Delete goal']);
    expect(row(edit, 'Delete goal')!.getAttribute('class')).toBe('list-row neg');
    expect(row(edit, 'Archive goal')!.getAttribute('class')).toBe('list-row');
    // Archive saves what is typed too: with a name it can't save, its row
    // waits, the note beside the rows saying why.
    await act(async () => type(field(edit, 'Name')!, ' '));
    expect(row(edit, 'Archive goal')!.hasAttribute('disabled')).toBe(true);
    expect(edit.textContent).toContain('Archiving saves your changes too, so it waits until they can be saved.');
    await act(async () => type(field(edit, 'Name')!, 'Trip to Japan'));
    expect(row(edit, 'Archive goal')!.hasAttribute('disabled')).toBe(false);

    await press(row(edit, 'Delete goal'));
    expect(saves).toEqual([]);
    expectAsking('Delete goal', 'Delete Trip for good? It can\'t be undone. Archiving keeps it instead, with its history.');

    // Cancel: back to the form, as typed, focus on the row.
    await press(button(footerOf(dialog('Delete goal')), 'Cancel'));
    const back = dialog('Edit goal')!;
    expect(valueOf(field(back, 'Name'))).toBe('Trip to Japan');
    expect(focused() === row(back, 'Delete goal')).toBe(true);

    // Refused: still asking, saying why beside Delete.
    await press(row(back, 'Delete goal'));
    await press(button(footerOf(dialog('Delete goal')), 'Delete'));
    expect(saves).toEqual([[bike]]);
    expectRefused('Delete goal', 'It couldn’t be saved.');

    // Back to the form, what the delete said stays with the delete.
    await press(button(footerOf(dialog('Delete goal')), 'Cancel'));
    expect(footerOf(dialog('Edit goal'))!.findAll((e) => classOf(e).includes('sheet-footer-note')).length).toBe(0);
    await press(row(dialog('Edit goal'), 'Delete goal'));
    expect(footerOf(dialog('Delete goal'))!.findAll((e) => classOf(e).includes('sheet-footer-note')).length).toBe(0);

    refuse = false;
    await press(button(footerOf(dialog('Delete goal')), 'Delete'));
    expect(saves.at(-1)).toEqual([bike]);
    expect(dialog('Delete goal')?.getAttribute('data-open') ?? 'false').toBe('false');
    await v.unmount();
  });
});

describe('a rule', () => {
  const { taxonomy } = categoriesFor({}, { words: ['shopping'] });
  const ctx = { ix: indexTaxonomy(taxonomy), tags: { version: 1 as const, tags: [] } };
  const made = addRule(emptyRuleSet(), { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { hide: true } }, ctx, () => 'r1');

  test('Delete rule is the drawer’s last row; it asks in a level, says a refusal, and once gone focus goes to New rule', async () => {
    let rules = made.set;
    let refuse = true;
    const sent: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://nya.test').pathname;
      if (path === '/api/rules' && (init?.method ?? 'GET') === 'GET') return Response.json({ rules });
      if (path === '/api/rules') {
        const asked = JSON.parse(String(init!.body));
        sent.push(asked);
        if (refuse) return Response.json({ error: 'It couldn’t be deleted.' }, { status: 500 });
        rules = deleteRule(rules, asked.id);
        return Response.json({ rules });
      }
      return Response.json({ error: 'Not here.' }, { status: 404 });
    }) as typeof fetch;
    function Harness() {
      const state = useRules();
      return (
        <>
          <RulesCard rules={state} taxonomy={taxonomy} tags={[]} accounts={[]} onChanged={() => {}} />
          <RuleSheet rules={state} taxonomy={taxonomy} tags={[]} accounts={[]} onChanged={() => {}} />
        </>
      );
    }
    const v = await mount(<Harness />);
    const edit = v.host.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Edit rule 1')[0]!;
    await act(async () => edit.focus());
    await press(edit);
    const drawer = dialog('Edit rule')!;
    expect(drawer.findAll((e) => classOf(e).includes('danger-outline')).length).toBe(0);
    expect(row(drawer, 'Delete rule')!.getAttribute('class')).toBe('list-row neg');

    await press(row(drawer, 'Delete rule'));
    expect(sent).toEqual([]);
    expectAsking('Delete rule', 'Delete this rule? It can\'t be undone.');

    await press(button(footerOf(dialog('Delete rule')), 'Cancel'));
    expect(focused() === row(dialog('Edit rule'), 'Delete rule')).toBe(true);

    await press(row(dialog('Edit rule'), 'Delete rule'));
    await press(button(footerOf(dialog('Delete rule')), 'Delete'));
    expect(sent).toEqual([{ action: 'delete', id: 'r1' }]);
    expectRefused('Delete rule', 'It couldn’t be deleted.');

    refuse = false;
    await press(button(footerOf(dialog('Delete rule')), 'Delete'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    expect(dialog('Delete rule')).toBeNull();
    // Its row, Edit with it, is gone: focus is on New rule.
    expect(v.host.findAll((e) => e.getAttribute('aria-label') === 'Edit rule 1').length).toBe(0);
    expect(focused() === button(v.host, 'New rule')).toBe(true);
    await v.unmount();
    globalThis.fetch = realFetch;
  });
});

describe('the target allocation', () => {
  const institutions: AllocInstitution[] = [
    { name: 'Vanguard', error: false, staleAsOf: null, missing: 0, accounts: [{ account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balance: 100_000, currency: 'USD' }] },
  ];
  const target = { 'us-stocks': 60, bonds: 40 };

  test('Delete the target asks in a level, Cancel keeps what was typed, a refusal is said, then it goes and focus is back on the card', async () => {
    let refuse = true;
    const saves: AllocationSettings[] = [];
    globalThis.fetch = (async () => Response.json({ error: 'Not here.' }, { status: 404 })) as unknown as typeof fetch;
    function Harness() {
      const [value, setValue] = useState<AllocationSettings | null>({ ...EMPTY_SETTINGS, target });
      const alloc = allocate({ institutions, holdings: [], settings: value, currency: 'USD' });
      return (
        <AllocationCard
          allocation={{
            settings: { ...initialListState<AllocationSettings | null>(null), status: 'ready', value },
            load: async () => {},
            // As the store saves: what is sent is taken at once, and put
            // back if the server refuses it (lib/whole-list-store.ts).
            save: async (next) => {
              saves.push(next);
              const before = value;
              setValue(next);
              await new Promise((r) => setTimeout(r, 1));
              if (refuse) setValue(before);
              return !refuse;
            },
            withSettings: true,
            alloc,
            mix: planMix(alloc),
          }}
          plan={DEFAULT_PLAN}
          onUseMix={() => {}}
          institutions={institutions}
          balancesAsOf={null}
        />
      );
    }
    const v = await mount(<Harness />);
    const change = button(v.host, 'Change target')!;
    await act(async () => change.focus());
    await press(change);
    const form = dialog('Target allocation')!;
    expect(form.findAll((e) => classOf(e).includes('danger-outline')).length).toBe(0);
    expect(row(form, 'Delete the target')!.getAttribute('class')).toBe('list-row neg');
    await act(async () => type(field(form, 'Bonds')!, '35'));

    await press(row(form, 'Delete the target'));
    expect(saves).toEqual([]);
    expectAsking('Delete the target', 'Delete your target allocation? It can’t be undone.');

    await press(button(footerOf(dialog('Delete the target')), 'Cancel'));
    const back = dialog('Target allocation')!;
    expect(valueOf(field(back, 'Bonds'))).toBe('35');
    expect(focused() === row(back, 'Delete the target')).toBe(true);

    await press(row(back, 'Delete the target'));
    await press(button(footerOf(dialog('Delete the target')), 'Delete'));
    expect(saves).toEqual([{ ...EMPTY_SETTINGS, target: null }]);
    expectRefused('Delete the target', 'It was not deleted. Try again in a moment.');

    // The back arrow (as Escape) goes back without what the delete said.
    await press(dialog('Delete the target')!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Back')[0]);
    const again = dialog('Target allocation')!;
    expect(footerOf(again)!.findAll((e) => classOf(e).includes('sheet-footer-note')).length).toBe(0);
    expect(valueOf(field(again, 'Bonds'))).toBe('35');

    refuse = false;
    await press(row(again, 'Delete the target'));
    expectAsking('Delete the target', 'Delete your target allocation? It can’t be undone.');
    await press(button(footerOf(dialog('Delete the target')), 'Delete'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    expect(dialog('Delete the target')).toBeNull();
    // The card's button, now Set a target, has focus back.
    expect(focused() === change).toBe(true);
    expect(change.textContent).toBe('Set a target');
    await v.unmount();
    globalThis.fetch = realFetch;
  });
});
