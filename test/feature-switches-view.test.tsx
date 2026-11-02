import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, click, type, type FakeElement } from './mini-dom';

// The feature switches card (components/FeatureSwitchesCard.tsx), as
// /dev/flags shows it: a card per switch, what it does, whether the
// environment still decides it, and a choice saved with Save
// (/api/dev/flags). Rendered and used as a person would (react-dom/client
// over test/mini-dom.ts), with the route's answers stood in for.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: FeatureSwitchesCard } = await import('@/components/FeatureSwitchesCard');
type SwitchRow = import('@/components/FeatureSwitchesCard').SwitchRow;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<SwitchRow> & Pick<SwitchRow, 'key'>): SwitchRow => ({
  about: `What ${over.key} does.`,
  kind: 'audience',
  removeBy: null,
  choices: ['nobody', 'admin', 'admin-and-demo', 'everyone'],
  stored: null,
  defaultChoice: 'nobody',
  variable: null,
  variableSet: false,
  people: null,
  ...over,
});
const ROWS: SwitchRow[] = [
  row({ key: 'restore', variable: 'RESTORE_ENABLED', variableSet: true }),
  row({ key: 'plan-tax', removeBy: '2027-06-30', stored: 'admin' }),
  row({ key: 'csp', kind: 'mode', choices: ['off', 'report-only', 'enforce'], defaultChoice: 'report-only', variable: 'CSP_MODE' }),
  row({ key: 'lunchflow', stored: 'unreadable' }),
  row({ key: 'sign-in', kind: 'list', choices: [], defaultChoice: null, stored: 'list', people: 3, variable: 'CLERK_ALLOWED_USER_IDS' }),
];

let puts: unknown[] = [];
let answer: (body: { key: string; choice: string }) => Response = (b) => new Response(JSON.stringify({ key: b.key, choice: b.choice }));
beforeEach(() => {
  puts = [];
  answer = (b) => new Response(JSON.stringify({ key: b.key, choice: b.choice }));
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    puts.push({ method: init?.method, ...body });
    return answer(body);
  }) as unknown as typeof fetch;
});

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount(demos = true) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(<FeatureSwitchesCard rows={ROWS} demos={demos} />);
    await settle();
  });
  const body = dom.document.body as unknown as FakeElement;
  const card = (key: string) => body.findAll((e) => e.tagName === 'SECTION').find((s) => s.textContent.startsWith(key))!;
  return {
    text: (key: string) => card(key).textContent.replace(/\s+/g, ' ').trim(),
    select: (key: string) => card(key).findAll((e) => e.tagName === 'SELECT')[0] as FakeElement | undefined,
    button: (key: string) => card(key).findAll((e) => e.tagName === 'BUTTON')[0] as FakeElement | undefined,
    options: (key: string) => card(key).findAll((e) => e.tagName === 'OPTION').map((o) => o.textContent),
    act,
    unmount: () => {
      act(() => root.unmount());
      host.parentNode?.removeChild(host);
    },
  };
}

describe('the feature switches card', () => {
  test('a card per switch: what it does, its removal date, and the environment still deciding one', async () => {
    const page = await mount();
    expect(page.text('restore')).toContain('What restore does.');
    expect(page.text('restore')).toContain('Set by the environment (RESTORE_ENABLED); your choice takes over when it is removed.');
    expect(page.text('plan-tax')).toContain('to be removed by 2027-06-30');
    expect(page.text('csp')).not.toContain('Set by the environment');
    expect(page.text('restore')).toContain('Not set: its default, Nobody, applies.');
    expect(page.options('plan-tax')).toEqual(['Nobody', 'The admin', 'The admin and the demo accounts', 'Everyone']);
    expect(page.options('csp')).toEqual(['Off', 'Report only', 'Enforce']);
    page.unmount();
  });

  test('the admin and the demo accounts only where there are demo accounts', async () => {
    const page = await mount(false);
    expect(page.options('restore')).toEqual(['Nobody', 'The admin', 'Everyone']);
    page.unmount();
  });

  test('a value that can’t be read says so and offers no choice; the list is shown, not set', async () => {
    const page = await mount();
    expect(page.text('lunchflow')).toContain('can’t be read, so its default applies');
    expect(page.select('lunchflow')).toBeUndefined();
    expect(page.text('sign-in')).toContain('3 people on the stored list. Who may sign in is set on the admin page.');
    expect(page.select('sign-in')).toBeUndefined();
    page.unmount();
  });

  test('a choice is saved by Save alone, and then shown as stored', async () => {
    const page = await mount();
    expect(page.button('plan-tax')).toBeUndefined(); // nothing to save yet
    await page.act(async () => {
      type(page.select('plan-tax')!, 'admin-and-demo');
      type(page.select('plan-tax')!, 'everyone');
      await settle();
    });
    expect(puts).toEqual([]); // choosing sends nothing
    await page.act(async () => {
      click(page.button('plan-tax')!);
      await settle();
    });
    expect(puts).toEqual([{ method: 'PUT', key: 'plan-tax', choice: 'everyone' }]);
    expect(page.button('plan-tax')).toBeUndefined();
    page.unmount();
  });

  test('a save that fails says so, and the stored value stays shown as stored', async () => {
    answer = () => new Response(JSON.stringify({ error: 'The stored value of this switch can’t be read, so it was left as it is.' }), { status: 409 });
    const page = await mount();
    await page.act(async () => {
      type(page.select('plan-tax')!, 'everyone');
      await settle();
    });
    await page.act(async () => {
      click(page.button('plan-tax')!);
      await settle();
    });
    expect(page.text('plan-tax')).toContain('The stored value of this switch can’t be read');
    expect(page.button('plan-tax')).toBeDefined(); // still not saved
    page.unmount();
  });
});
