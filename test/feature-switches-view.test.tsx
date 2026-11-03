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
const { fmtAsOf } = await import('@/components/accounts-format');
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
  row({ key: 'csp', name: 'Content security policy', kind: 'mode', choices: ['off', 'report-only', 'enforce'], defaultChoice: 'report-only', variable: 'CSP_MODE' }),
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
  const rowOf = (name: string) => all('BUTTON').find((b) => b.getAttribute('class') === 'list-row' && words(b).startsWith(name));
  return {
    row: (name: string) => rowOf(name)!,
    rowText: (name: string) => parts(rowOf(name)),
    /** A row's value badge: its words and its class. */
    badge: (name: string) => {
      const b = rowOf(name)!.findAll((e) => e.getAttribute('class') === 'list-row-value')[0].findAll((e) => e.tagName === 'SPAN')[0];
      return [words(b), b.getAttribute('class')];
    },
    cardHelper: () => words(body.findAll((e) => e.tagName === 'P' && e.getAttribute('class') === 'helper')[0]),
    sheet,
    sheetText: () => words(sheet()),
    sheetParts: () => parts(sheet()),
    /** The sheet's key and value lines. */
    details: () => inSheet('DIV').filter((d) => d.getAttribute('class') === 'txn-detail-row').map((d) => d.childNodes.map((c) => words(c as FakeElement))),
    legend: () => words(inSheet('LEGEND')[0]),
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
  test('each switch by its name, what it does under it with badges for what to know, and its value at the end', async () => {
    const page = await mount();
    expect(page.rowText('Bring back a download')).toBe('Bring back a download What restore does. Set by RESTORE_ENABLED Everyone');
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow What lunchflow does. Also on for 2 accounts by name. You');
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan What plan-tax does. Remove by Jun 30, 2027 You');
    expect(page.rowText('Brokerage')).toBe('Brokerage and retirement accounts What brokerage-link does. Can’t be read Off');
    expect(page.rowText('Content security policy')).toBe('Content security policy What csp does. Report only');
    expect(page.rowText('Who may sign in')).toBe('Who may sign in What sign-in does. You and 2 more');
    expect(page.row('Lunch Flow').getAttribute('aria-haspopup')).toBe('dialog');
    page.unmount();
  });

  test('the value badge: accent while on for some but not everyone, warn while the ops routes are open', async () => {
    const ops = row({ key: 'ops', name: 'Ops routes', kind: 'switch', choices: ['off', 'on'], defaultChoice: 'off', stored: 'on', variable: 'OPS_ENABLED' });
    const named = row({ key: 'brokerage-link', name: 'Brokerage and retirement accounts', stored: 'nobody', accounts: 2, containers: [C1, C2] });
    const page = await mount({ rows: [...ROWS.filter((r) => r.key !== 'brokerage-link'), named, ops] });
    expect(page.badge('Lunch Flow')).toEqual(['You', 'badge accent']);
    expect(page.badge('Bring back a download')).toEqual(['Everyone', 'badge']);
    expect(page.badge('Content security policy')).toEqual(['Report only', 'badge']);
    expect(page.badge('Brokerage')).toEqual(['2 accounts', 'badge accent']);
    expect(page.rowText('Brokerage')).toBe('Brokerage and retirement accounts What brokerage-link does. 2 accounts');
    expect(page.badge('Ops routes')).toEqual(['On', 'badge warn']);
    page.unmount();
  });

  test('the card says a fresh sign-in comes before a change, where one is asked for', async () => {
    let page = await mount({ freshSignIn: true, environment: 'Production' });
    expect(page.cardHelper()).toBe(
      'A change reaches the routes that check a switch at once, and pages within 30 seconds. These are Production’s: each environment keeps its own. You’ll confirm it’s you before a change is saved.'
    );
    page.unmount();
    page = await mount();
    expect(page.cardHelper()).toBe('A change reaches the routes that check a switch at once, and pages within 30 seconds. These are Preview’s: each environment keeps its own.');
    page.unmount();
  });

  test('/dev/flags words the admin as the admin', async () => {
    const page = await mount({ rows: DEV_ROWS, place: 'dev', accounts: [], environment: 'local development' });
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow What lunchflow does. Also on for 2 accounts by name. The admin');
    expect(page.cardHelper()).toBe('A change reaches the routes that check a switch at once, and pages within 30 seconds. These are this machine’s, for local development.');
    page.unmount();
  });
});

describe('a choice', () => {
  test('a row opens its kind’s sheet: what it does, its environment, default, key and variable, and its choices, Off’s saying what off does', async () => {
    const page = await mount();
    await page.open('Content security policy');
    expect(page.sheetText()).toStartWith('Content security policy');
    expect(page.sheetText()).toContain('What csp does.');
    expect(page.details()).toEqual([
      ['Environment', 'Preview'],
      ['Default', 'Report only'],
      ['Key', 'csp'],
      ['Variable', 'CSP_MODE, not set'],
    ]);
    expect(page.legend()).toBe('Policy');
    expect(page.radios()).toEqual([
      'Enforce Pages refuse what the policy doesn’t allow.',
      'Report only Pages report what the policy would refuse, and refuse nothing.',
      'Off What turning csp off does.',
    ]);
    expect(page.sheetText()).toContain('Not set: its default, Report only, applies.');
    expect(page.sheetText()).not.toContain('Temporary');
    page.unmount();
  });

  test('a release switch says when it goes, and Off says the accounts added still have it', async () => {
    const page = await mount();
    await page.open('Detailed tax in the Plan');
    expect(page.sheetParts()).toContain('Detailed tax in the Plan What plan-tax does. Temporary: to be removed by Jun 30, 2027 . Environment');
    expect(page.sheetText()).toContain('Temporary: to be removed by Jun 30, 2027.');
    expect(page.details()).toEqual([
      ['Environment', 'Preview'],
      ['Default', 'Off'],
      ['Key', 'plan-tax'],
    ]);
    expect(page.legend()).toBe('On for');
    expect(page.radios()[0]).toBe('Off What turning plan-tax off does. Accounts added below still have it.');
    expect(page.radios()[1]).toBe('You The deployment’s owner.');
    expect(page.sheetText()).toContain('No other accounts.');
    page.unmount();
  });

  test('saved by Save alone, quiet until the choice changes, to the admin’s route; the row shows the answer and the page reads again', async () => {
    const page = await mount();
    await page.open('Detailed tax in the Plan');
    expect(page.buttons().slice(-2)).toEqual(['Cancel', 'Save']);
    expect(page.button('Save')!.disabled).toBe(true); // nothing to save yet
    await page.choose('You and the demo accounts');
    expect(page.button('Save')!.disabled).toBe(false);
    await page.choose('Everyone');
    expect(puts).toEqual([]); // choosing sends nothing
    answer = (_url, b) => rowAnswer(b.key, { stored: 'everyone' });
    await page.press('Save');
    expect(puts).toEqual([{ url: '/api/admin/flags', body: { key: 'plan-tax', change: { op: 'choose', choice: 'everyone' } } }]);
    expect(refreshes).toBe(1);
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan What plan-tax does. Remove by Jun 30, 2027 Everyone');
    expect(page.button('Save')!.disabled).toBe(true);
    page.unmount();
  });

  test('Cancel closes the sheet and sends nothing', async () => {
    const page = await mount();
    await page.open('Detailed tax in the Plan');
    await page.choose('Everyone');
    expect(page.sheet()!.getAttribute('data-open')).toBe('true');
    await page.press('Cancel');
    expect(page.sheet()!.getAttribute('data-open')).toBe('false'); // sliding out
    expect(puts).toEqual([]);
    expect(page.rowText('Detailed tax in the Plan')).toEndWith('You');
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
    expect(page.button('Save')!.disabled).toBe(false); // to try again
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
    expect(page.legend()).toBe('On for');
    page.unmount();
  });

  test('the last changes to the switch: each change, then when, in the reader’s time, and who unless it was the admin', async () => {
    const later = '2026-11-02T08:30:00.000Z';
    const page = await mount({
      changes: {
        lunchflow: [
          { at: later, key: 'lunchflow', name: 'Lunch Flow', change: 'Removed Account 6e2d8f3b', by: 'Account deletion' },
          { at: AT, key: 'lunchflow', name: 'Lunch Flow', change: 'Added Account 6e2d8f3b', by: null },
        ],
      },
    });
    await page.open('Lunch Flow');
    expect(page.sheetParts()).toContain(`Last changes Removed Account 6e2d8f3b ${fmtAsOf(later)} · Account deletion Added Account 6e2d8f3b ${fmtAsOf(AT)} Cancel Save`);
    expect(page.sheetText()).not.toContain('2026-11-01');
    page.unmount();
  });
});

describe('who may sign in', () => {
  test('the owner, always let in, then each person with Remove, confirmed at a second level', async () => {
    const page = await mount();
    await page.open('Who may sign in');
    expect(page.details()).toEqual([
      ['Environment', 'Preview'],
      ['Key', 'sign-in'],
      ['Variable', 'CLERK_ALLOWED_USER_IDS, not set'],
    ]);
    expect(page.sheetText()).toContain('What turning sign-in off does.');
    expect(page.buttons()).not.toContain('Save');
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
    expect(page.radios()[0]).toBe('Off What turning lunchflow off does.');
    expect(page.details()[0]).toEqual(['Environment', 'local development']);
    expect(page.sheetText()).toContain('Also on for 2 accounts by name, set on the admin page.');
    expect(page.sheetText()).not.toContain('Add an account');
    expect(page.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Remove')).toHaveLength(0);
    await page.choose('Everyone');
    await page.press('Save');
    expect(puts).toEqual([{ url: '/api/dev/flags', body: { key: 'lunchflow', choice: 'everyone' } }]);
    expect(page.rowText('Lunch Flow')).toBe('Lunch Flow What lunchflow does. Everyone');
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
    expect(page.rowText('Detailed tax in the Plan')).toBe('Detailed tax in the Plan What plan-tax does. Remove by Jun 30, 2027 Off');
    page.unmount();
  });
});
