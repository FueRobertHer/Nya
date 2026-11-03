import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, FakeEvent, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// The feature switches card and its sheets (components/FeatureSwitchesCard.tsx,
// components/FlagSheet.tsx), as the admin page and /dev/flags show them: a
// row per switch opening its kind's sheet, choices saved with Save, accounts
// and people added and removed on the admin page, a fresh sign-in where one
// is asked for. Rendered and used as a person would (react-dom/client over
// test/mini-dom.ts), with the routes' answers stood in for.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

// Clerk's useReverification, as Clerk runs it: the request, and when it
// answers with the hint, the person asked to confirm it's them (`confirm`),
// then the request again; or they close the prompt, and it throws.
const { ClerkRuntimeError } = await import('@clerk/shared/error');
let confirm: 'yes' | 'cancel' = 'yes';
let prompts = 0;
const isHint = (v: unknown) => (v as { clerk_error?: { reason?: string } } | null)?.clerk_error?.reason === 'reverification-error';
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification:
    (fetcher: (...a: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      const first = await fetcher(...args);
      if (!isHint(first)) return first;
      prompts += 1;
      if (confirm === 'cancel') throw new ClerkRuntimeError('cancelled', { code: 'reverification_cancelled' });
      return fetcher(...args);
    },
}));
let refreshes = 0;
await mockForFile('next/navigation', () => ({ useRouter: () => ({ refresh: () => void (refreshes += 1) }), notFound: () => {} }));

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: FeatureSwitchesCard } = await import('@/components/FeatureSwitchesCard');
type SwitchRow = import('@/lib/flag-view').SwitchRow;
type Props = Parameters<typeof FeatureSwitchesCard>[0];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const C1 = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
const C2 = '6e2d8f3b-0c4a-4d7e-9f2b-3c4d5e6f7a81';
const GONE = '7a1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const AT = '2026-11-01T12:00:00.000Z';

const row = (over: Partial<SwitchRow> & Pick<SwitchRow, 'key' | 'name'>): SwitchRow => ({
  about: `What ${over.key} does.`,
  offMeans: `What turning ${over.key} off does.`,
  kind: 'audience',
  removeBy: null,
  choices: ['nobody', 'admin', 'admin-and-demo', 'everyone'],
  stored: null,
  defaultChoice: 'nobody',
  variable: null,
  variableSet: false,
  variableChoice: null,
  accounts: null,
  people: null,
  containers: null,
  ids: null,
  emails: null,
  ...over,
});
const ROWS: SwitchRow[] = [
  row({ key: 'restore', name: 'Bring back a download', variable: 'RESTORE_ENABLED', variableSet: true, variableChoice: 'everyone' }),
  row({ key: 'lunchflow', name: 'Lunch Flow', stored: 'admin', accounts: 2, containers: [C1, GONE] }),
  row({ key: 'plan-tax', name: 'Detailed tax in the Plan', removeBy: '2027-06-30', stored: 'admin', accounts: 0, containers: [] }),
  row({ key: 'brokerage-link', name: 'Brokerage and retirement accounts', stored: 'unreadable' }),
  row({ key: 'csp', name: 'Content-Security-Policy', kind: 'mode', choices: ['off', 'report-only', 'enforce'], defaultChoice: 'report-only', variable: 'CSP_MODE' }),
  row({ key: 'sign-in', name: 'Who may sign in', kind: 'list', choices: [], defaultChoice: null, stored: 'list', people: 2, ids: ['user_a'], emails: ['pat@example.com'], variable: 'CLERK_ALLOWED_USER_IDS' }),
];
// /dev/flags's rows: counts, nothing named.
const DEV_ROWS = ROWS.map((r) => ({ ...r, containers: null, ids: null, emails: null }));
const ACCOUNTS = [
  { id: C1, name: 'You', made: AT, active: true },
  { id: C2, name: 'Account 6e2d8f3b', made: AT, active: true },
];

let puts: { url: string; body: Record<string, unknown> }[] = [];
let answer: (url: string, body: Record<string, any>) => Response;
const rowAnswer = (key: string, over: Partial<SwitchRow> = {}) => new Response(JSON.stringify({ row: { ...ROWS.find((r) => r.key === key)!, ...over } }));
beforeEach(() => {
  puts = [];
  refreshes = 0;
  prompts = 0;
  confirm = 'yes';
  answer = (url, b) => (url === '/api/dev/flags' ? new Response(JSON.stringify({ key: b.key, choice: b.choice })) : rowAnswer(b.key));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    puts.push({ url, body });
    return answer(url, body);
  }) as unknown as typeof fetch;
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const words = (e: FakeElement | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** Text with a space between elements, as a row reads: its title, then its line. */
const spaced = (n: { nodeType: number; textContent: string; childNodes?: ArrayLike<unknown> }): string =>
  n.nodeType === 3 ? n.textContent : Array.from((n.childNodes ?? []) as ArrayLike<typeof n>).map(spaced).join(' ');
const parts = (e: FakeElement | undefined) => (e ? spaced(e as never) : '').replace(/\s+/g, ' ').trim();

async function mount(over: Partial<Props> = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const props: Props = { rows: ROWS, place: 'admin', demos: true, environment: 'Preview', freshSignIn: false, clerk: true, accounts: ACCOUNTS, changes: {}, ...over };
  await act(async () => {
    root.render(<FeatureSwitchesCard {...props} />);
    await settle();
  });
  const body = dom.document.body as unknown as FakeElement;
  const all = (tag: string) => body.findAll((e) => e.tagName === tag);
  const sheet = () => body.findAll((e) => e.getAttribute('role') === 'dialog')[0];
  const inSheet = (tag: string) => sheet()?.findAll((e) => e.tagName === tag) ?? [];
  const button = (text: string) => inSheet('BUTTON').find((b) => words(b) === text);
  return {
    row: (name: string) => all('BUTTON').find((b) => b.getAttribute('class') === 'list-row' && words(b).startsWith(name))!,
    rowText: (name: string) => parts(all('BUTTON').find((b) => b.getAttribute('class') === 'list-row' && words(b).startsWith(name))),
    sheet,
    sheetText: () => words(sheet()),
    sheetParts: () => parts(sheet()),
    radios: () => inSheet('LABEL').filter((l) => l.getAttribute('class') === 'radio-row').map(parts),
    radioNames: () => inSheet('SPAN').filter((l) => l.getAttribute('class') === 'radio-row-name').map(words),
    button,
    buttons: () => inSheet('BUTTON').map(words),
    open: async (name: string) => {
      await act(async () => {
        click(all('BUTTON').find((b) => b.getAttribute('class') === 'list-row' && words(b).startsWith(name))!);
        await settle();
      });
    },
    choose: async (text: string) => {
      const radio = inSheet('LABEL').find((l) => l.getAttribute('class') === 'radio-row' && words(l).startsWith(text))!.findAll((e) => e.tagName === 'INPUT')[0];
      await act(async () => {
        radio.checked = true;
        click(radio);
        await settle();
      });
    },
    press: async (text: string) => {
      await act(async () => {
        click(button(text)!);
        await settle();
      });
      await act(settle);
    },
    fill: async (label: string, value: string) => {
      const field = inSheet('LABEL').find((l) => words(l).startsWith(label))!.findAll((e) => e.tagName === 'INPUT')[0];
      await act(async () => type(field, value));
    },
    submit: async () => {
      await act(async () => {
        inSheet('FORM')[0].dispatchEvent(new FakeEvent('submit'));
        await settle();
      });
      await act(settle);
    },
    rerender: async (rows: SwitchRow[]) => {
      await act(async () => {
        root.render(<FeatureSwitchesCard {...props} rows={rows} />);
        await settle();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.parentNode?.removeChild(host);
    },
  };
}

describe('the rows', () => {
  test('each switch by its name, its value in words, and badges for what to know', async () => {
    const page = await mount();
    expect(page.rowText('Bring back a download')).toBe('Bring back a download Everyone Set by RESTORE_ENABLED');
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow You, and 2 accounts by name');
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan You Remove by 2027-06-30');
    expect(page.rowText('Brokerage')).toBe('Brokerage and retirement accounts Off Can’t be read');
    expect(page.rowText('Content-Security-Policy')).toBe('Content-Security-Policy Report only');
    expect(page.rowText('Who may sign in')).toBe('Who may sign in 2 people on the stored list');
    expect(page.row('Lunch Flow').getAttribute('aria-haspopup')).toBe('dialog');
    page.unmount();
  });

  test('/dev/flags words the admin as the admin', async () => {
    const page = await mount({ rows: DEV_ROWS, place: 'dev', accounts: [], environment: 'local development' });
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow The admin, and 2 accounts by name');
    page.unmount();
  });
});

describe('a choice', () => {
  test('a row opens its kind’s sheet: what it does, what off does, its key and variable, and its choices', async () => {
    const page = await mount();
    await page.open('Content-Security-Policy');
    expect(page.sheetText()).toContain('What csp does.');
    expect(page.sheetText()).toContain('Turned off: What turning csp off does.');
    expect(page.sheetText()).toContain('Its key is csp, and CSP_MODE decides it while that is set.');
    expect(page.radios()).toEqual([
      'Enforce Pages refuse what the policy doesn’t allow.',
      'Report only Pages report what the policy would refuse, and refuse nothing.',
      'Off Pages carry no policy.',
    ]);
    expect(page.sheetText()).toContain('Not set: its default, Report only, applies.');
    page.unmount();
  });

  test('saved by Save alone, to the admin’s route, and the row shows the answer and the page reads again', async () => {
    const page = await mount();
    await page.open('Detailed tax in the Plan');
    expect(page.button('Save')).toBeUndefined(); // nothing to save yet
    await page.choose('You and the demo accounts');
    await page.choose('Everyone');
    expect(puts).toEqual([]); // choosing sends nothing
    answer = (_url, b) => rowAnswer(b.key, { stored: 'everyone' });
    await page.press('Save');
    expect(puts).toEqual([{ url: '/api/admin/flags', body: { key: 'plan-tax', change: { op: 'choose', choice: 'everyone' } } }]);
    expect(refreshes).toBe(1);
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan Everyone Remove by 2027-06-30');
    expect(page.button('Save')).toBeUndefined();
    page.unmount();
  });

  test('the admin and the demo accounts only where there are demo accounts, or while it is the stored choice', async () => {
    let page = await mount({ demos: false });
    await page.open('Detailed tax in the Plan');
    expect(page.radioNames()).toEqual(['Off', 'You', 'Everyone']);
    page.unmount();
    page = await mount({ demos: false, rows: ROWS.map((r) => (r.key === 'plan-tax' ? { ...r, stored: 'admin-and-demo' } : r)) });
    await page.open('Detailed tax in the Plan');
    expect(page.radioNames()).toEqual(['Off', 'You', 'You and the demo accounts', 'Everyone']);
    page.unmount();
  });

  test('a variable still set says it decides, and the choice takes over once it is removed', async () => {
    const page = await mount();
    await page.open('Bring back a download');
    expect(page.sheetText()).toContain('RESTORE_ENABLED is set, so it decides: Everyone. Your choice takes over when it is removed.');
    page.unmount();
  });

  test('a value that can’t be read says so, and offers nothing to change', async () => {
    const page = await mount();
    await page.open('Brokerage');
    expect(page.sheetText()).toContain('Its stored value can’t be read, so its default applies, and it is left as it is.');
    expect(page.radios()).toEqual([]);
    // The sheet's own close button alone, which has no words but its label.
    expect(page.buttons()).toEqual(['']);
    page.unmount();
  });

  test('a change refused says why, in a critical notice, and nothing is shown as saved', async () => {
    answer = () => new Response(JSON.stringify({ error: 'The stored value of this switch can’t be read, so it was left as it is.' }), { status: 409 });
    const page = await mount();
    await page.open('Detailed tax in the Plan');
    await page.choose('Everyone');
    await page.press('Save');
    expect(page.sheetText()).toContain('Critical: The stored value of this switch can’t be read');
    expect(page.button('Save')).toBeDefined();
    expect(refreshes).toBe(0);
    page.unmount();
  });
});

describe('accounts', () => {
  test('each named, one gone said so, removed in place; added from a second level of the accounts in use', async () => {
    const page = await mount();
    await page.open('Lunch Flow');
    expect(page.sheetText()).toContain('Also on for');
    expect(page.sheetParts()).toContain('You Made');
    expect(page.sheetText()).toContain('An account that is gone');
    // Remove is a button of its own, beside the row, never inside a row that is one.
    expect(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')).toHaveLength(2);
    await act(async () => {
      click(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')[1]);
      await settle();
    });
    expect(puts.at(-1)).toEqual({ url: '/api/admin/flags', body: { key: 'lunchflow', change: { op: 'remove-account', container: GONE } } });
    await act(async () => {
      click(page.button('Add an account')!);
      await settle();
    });
    expect(page.sheetText()).toContain('Add an account');
    // You are on it already: only the other account in use is offered.
    const offered = page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row');
    expect(offered.map(parts)).toEqual([`Account 6e2d8f3b Made ${parts(offered[0]).slice('Account 6e2d8f3b Made '.length)}`]);
    expect(parts(offered[0])).not.toContain('2026-11-01'); // the reader's own day, in the browser
    await act(async () => {
      click(offered[0]);
      await settle();
    });
    await act(settle);
    expect(puts.at(-1)).toEqual({ url: '/api/admin/flags', body: { key: 'lunchflow', change: { op: 'add-account', container: C2 } } });
    // Back on the switch's own sheet.
    expect(page.sheetText()).toContain('Who it is on for, in Preview');
    page.unmount();
  });

  test('the last changes to the switch, worded, with when and who', async () => {
    const page = await mount({ changes: { lunchflow: [{ at: AT, key: 'lunchflow', what: 'Lunch Flow: added Account 6e2d8f3b', by: 'You' }] } });
    await page.open('Lunch Flow');
    expect(page.sheetText()).toContain('Last changes');
    expect(page.sheetText()).toContain('Lunch Flow: added Account 6e2d8f3b');
    expect(page.sheetText()).toContain(', by You');
    page.unmount();
  });
});

describe('who may sign in', () => {
  test('the owner, always let in, then each person with Remove, confirmed at a second level', async () => {
    const page = await mount();
    await page.open('Who may sign in');
    expect(page.sheetParts()).toContain('You, the owner Always let in');
    expect(page.sheetText()).toContain('user_a');
    expect(page.sheetText()).toContain('pat@example.com');
    expect(page.radios()).toEqual([]);
    const removes = page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove');
    expect(removes).toHaveLength(2); // none for the owner
    await act(async () => {
      click(removes[1]);
      await settle();
    });
    expect(puts).toEqual([]); // asked first
    expect(page.sheetText()).toContain('Remove pat@example.com from who may sign in?');
    expect(page.sheetText()).toContain('They are refused at their next request');
    await page.press('Remove');
    expect(puts).toEqual([{ url: '/api/admin/flags', body: { key: 'sign-in', change: { op: 'remove-person', entry: 'pat@example.com' } } }]);
    page.unmount();
  });

  test('someone added by email or user id; a refusal says why', async () => {
    const page = await mount();
    await page.open('Who may sign in');
    await page.fill('Add someone', 'jane@example.com');
    await page.submit();
    expect(puts).toEqual([{ url: '/api/admin/flags', body: { key: 'sign-in', change: { op: 'add-person', entry: 'jane@example.com' } } }]);
    answer = () => new Response(JSON.stringify({ error: 'Type an email address, or a Clerk user id (it starts with user_).' }), { status: 400 });
    await page.fill('Add someone', 'jane');
    await page.submit();
    expect(page.sheetText()).toContain('Critical: Type an email address, or a Clerk user id');
    page.unmount();
  });

  test('without Clerk the list isn’t used, and it says so', async () => {
    const page = await mount({ clerk: false });
    await page.open('Who may sign in');
    expect(page.sheetText()).toContain('Without Clerk, signing in is the app password, so this list isn’t used.');
    page.unmount();
  });
});

describe('a fresh sign-in', () => {
  test('with Clerk: the person is asked to confirm it’s them, and the change is sent again', async () => {
    let first = true;
    answer = (_url, b) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ clerk_error: { type: 'forbidden', reason: 'reverification-error' } }), { status: 403 });
      }
      return rowAnswer(b.key, { stored: 'everyone' });
    };
    const page = await mount({ freshSignIn: true, environment: 'Production' });
    await page.open('Detailed tax in the Plan');
    await page.choose('Everyone');
    await page.press('Save');
    expect(prompts).toBe(1);
    expect(puts).toHaveLength(2);
    expect(page.rowText('Detailed tax in the Plan')).toContain('Everyone');
    page.unmount();
  });

  test('with Clerk: closing the prompt is silent; a hint that survives says to sign in again', async () => {
    answer = () => new Response(JSON.stringify({ clerk_error: { type: 'forbidden', reason: 'reverification-error' } }), { status: 403 });
    confirm = 'cancel';
    const page = await mount({ freshSignIn: true });
    await page.open('Detailed tax in the Plan');
    await page.choose('Everyone');
    await page.press('Save');
    expect(page.sheetText()).not.toContain('Critical');
    confirm = 'yes';
    await page.press('Save');
    expect(page.sheetText()).toContain('Nya couldn’t confirm it’s you. Sign out and in again, then try again.');
    page.unmount();
  });

  test('with the app password: one field at the top, sent with every change, a choice or an account', async () => {
    const page = await mount({ freshSignIn: true, clerk: false, environment: 'Production' });
    await page.open('Lunch Flow');
    expect(page.sheetText()).toContain('Your app password, to confirm it’s you');
    await page.choose('Everyone');
    expect(page.button('Save')!.disabled).toBe(true); // no password yet
    await page.fill('Your app password', 'hunter2');
    await page.press('Save');
    expect(puts.at(-1)!.body).toEqual({ key: 'lunchflow', change: { op: 'choose', choice: 'everyone' }, password: 'hunter2' });
    await act(async () => {
      click(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')[0]);
      await settle();
    });
    expect(puts.at(-1)!.body).toEqual({ key: 'lunchflow', change: { op: 'remove-account', container: C1 }, password: 'hunter2' });
    page.unmount();
  });

  test('the confirm of a removal says the password comes first, while it is empty', async () => {
    const page = await mount({ freshSignIn: true, clerk: false, environment: 'Production' });
    await page.open('Who may sign in');
    await act(async () => {
      click(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')[0]);
      await settle();
    });
    expect(page.button('Remove')!.disabled).toBe(true);
    expect(page.sheetText()).toContain('Type your app password on the switch’s sheet first.');
    page.unmount();
  });

  test('a failure stays with the level it happened at: another level of the sheet starts without it', async () => {
    answer = () => new Response(JSON.stringify({ error: 'That isn’t a choice this switch takes.' }), { status: 400 });
    const page = await mount();
    await page.open('Lunch Flow');
    await page.choose('Everyone');
    await page.press('Save');
    expect(page.sheetText()).toContain('That isn’t a choice this switch takes.');
    await act(async () => {
      click(page.button('Add an account')!);
      await settle();
    });
    expect(page.sheetText()).toContain('Add an account');
    expect(page.sheetText()).not.toContain('That isn’t a choice this switch takes.');
    page.unmount();
  });

  test('none asked for: no field, and no password sent', async () => {
    const page = await mount({ clerk: false });
    await page.open('Detailed tax in the Plan');
    expect(page.sheetText()).not.toContain('app password');
    await page.choose('Everyone');
    await page.press('Save');
    expect(puts[0].body).toEqual({ key: 'plan-tax', change: { op: 'choose', choice: 'everyone' } });
    page.unmount();
  });
});

describe('/dev/flags', () => {
  test('choices alone, to the dev route; accounts and people counted, set on the admin page', async () => {
    const page = await mount({ rows: DEV_ROWS, place: 'dev', accounts: [], environment: 'local development', clerk: false });
    await page.open('Lunch Flow');
    expect(page.radioNames()).toEqual(['Off', 'The admin', 'The admin and the demo accounts', 'Everyone']);
    expect(page.sheetText()).toContain('Also on for 2 accounts by name, set on the admin page.');
    expect(page.sheetText()).not.toContain('Add an account');
    expect(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')).toHaveLength(0);
    await page.choose('Everyone');
    await page.press('Save');
    expect(puts).toEqual([{ url: '/api/dev/flags', body: { key: 'lunchflow', choice: 'everyone' } }]);
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow Everyone');
    expect(refreshes).toBe(1);
    page.unmount();
  });

  test('the sign-in list counted, never named or set', async () => {
    const page = await mount({ rows: DEV_ROWS, place: 'dev', accounts: [], environment: 'local development' });
    await page.open('Who may sign in');
    expect(page.sheetText()).toContain('2 people on the stored list. Who may sign in is set on the admin page.');
    expect(page.sheet()!.findAll((e) => e.tagName === 'INPUT')).toHaveLength(0);
    page.unmount();
  });

  test('the page’s rows, read again, replace the ones answered', async () => {
    const page = await mount({ rows: DEV_ROWS, place: 'dev', accounts: [] });
    await page.open('Detailed tax in the Plan');
    await page.choose('Everyone');
    await page.press('Save');
    expect(page.rowText('Detailed tax in the Plan')).toContain('Everyone');
    await page.rerender(DEV_ROWS.map((r) => (r.key === 'plan-tax' ? { ...r, stored: 'nobody' } : r)));
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan Off Remove by 2027-06-30');
    page.unmount();
  });
});
