import { describe, expect, test, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharingPanelView, SharedWithMeView, PreviewView, shortDate } from '@/components/Sharing';
import {
  endAfterDays,
  endOfDay,
  taxSeasonEnd,
  endLabel,
  ended,
  endFor,
  lookedDays,
  describeRead,
  timesText,
  lookedText,
  localDay,
  RENEW_DAYS,
  type LoggedHour,
} from '@/components/SharingDates';

const noop = () => {};
const panel = (data: any, opts: { current?: any; draft?: Record<string, any>; invite?: any; error?: string; endChoice?: any; endDay?: string } = {}) =>
  renderToStaticMarkup(
    <SharingPanelView
      data={data}
      current={opts.current ?? null}
      draft={opts.draft ?? {}}
      labelDraft={opts.current?.label ?? ''}
      endChoice={opts.endChoice ?? (opts.current?.expires_at ? 'keep' : 'none')}
      endDay={opts.endDay ?? ''}
      invite={opts.invite ?? null}
      busy={false}
      error={opts.error ?? ''}
      notice=""
      onOpen={noop}
      onChoose={noop}
      onLabel={noop}
      onEndChoice={noop}
      onEndDay={noop}
      onInvite={noop}
      onSave={noop}
      onRenew={noop}
      onPreview={noop}
      onClearViews={noop}
      onRemove={noop}
    />
  );
const pat = {
  id: 'c1',
  label: 'Pat',
  introduced_as: 'Patricia',
  since: '2026-09-28',
  sharing: { a: 'exists', hidden_one: 'balance' },
  expires_at: null,
  views: [],
};
const accounts = [{ id: 'a', label: 'Chase Checking ••1111' }];
/** The page as text, tags dropped and the apostrophes React escapes put back. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// Some tests set the time zone. Through Bun.env, the process's own: other
// files replace process.env with a plain copy, which Bun no longer reads TZ
// from. Put back afterwards, or taken away again.
const savedTz = Bun.env.TZ;
const inZone = (tz: string) => {
  Bun.env.TZ = tz;
};
afterEach(() => {
  if (savedTz === undefined) delete Bun.env.TZ;
  else Bun.env.TZ = savedTz;
});

describe('dates', () => {
  test('month and day, with the year only when it is not this one', () => {
    const now = new Date('2026-09-28T12:00:00');
    expect(shortDate('2026-09-28', now)).toBe('Sep 28');
    expect(shortDate('2025-12-31', now)).toBe('Dec 31, 2025');
    expect(shortDate('not a date', now)).toBe('not a date');
  });

  test('shows an instant as the day it was in the viewer local time, not its UTC day', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    // 03:19 UTC on the 29th is still the 28th anywhere west of UTC-3:20, and the
    // 29th anywhere east of it: the label must follow the machine zone.
    const at = '2026-09-29T03:19:00.000Z';
    const local = new Date(at);
    expect(shortDate(at, now)).toBe(local.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    // A bare date is a calendar day and is never shifted.
    expect(shortDate('2026-09-29', now)).toBe('Sep 29');
  });
});

describe('the sharing drawer', () => {
  test('shows a load error rather than nothing, and a spinner while loading', () => {
    expect(panel(null, { error: 'Could not load sharing.' })).toContain('Could not load sharing.');
    expect(panel(null)).toContain('role="status"');
  });

  test('says sharing needs accounts with the shared password', () => {
    expect(panel({ enabled: false })).toContain('Sharing needs accounts');
  });

  test('with no connections: the way to invite someone, and nobody listed', () => {
    const html = panel({ enabled: true, connections: [], blocked: [], accounts });
    expect(html).toContain('Create invite link');
    expect(html).toContain('No one yet.');
    expect(html).not.toContain('Chase Checking');
  });

  test('a new link, to send yourself, with when it stops working', () => {
    const html = panel({ enabled: true, connections: [], accounts: [] }, { invite: { url: 'https://nya.test/connect/abc', expires_at: '2026-10-01T00:00:00Z' } });
    expect(html).toContain('https://nya.test/connect/abc');
    expect(html).toContain('It works once, until');
    expect(html).toContain('>Copy<'); // no touch share menu here
  });

  test('the list: each person, what they see of mine (paused shares not counted), and the blocked', () => {
    const html = panel({ enabled: true, connections: [pat], blocked: [{ id: 'c9', label: 'Ex' }], accounts });
    expect(html).toContain('Pat');
    expect(html).toContain(`Sees 1 of your accounts · since ${shortDate('2026-09-28')}`);
    expect(html).toContain('Ex');
    expect(html).toContain('>Unblock<');
    expect(html).not.toContain('Chase Checking'); // the choices are one level in
  });

  test('a connection: their introduction, each account with its level, remove and block', () => {
    const html = panel({ enabled: true, connections: [pat], accounts }, { current: pat, draft: { a: 'exists' } });
    expect(html).toContain(`They introduced themselves as “Patricia”. Connected ${shortDate('2026-09-28')}.`);
    expect(html).toContain('Pat can see 1 of your accounts');
    expect(html).toContain('Chase Checking ••1111');
    expect(html).toContain('<option value="exists" selected="">That it exists</option>');
    expect(html).toContain('>Remove<');
    expect(html).toContain('>Block<');
    expect(html).not.toContain('Create invite link');
  });

  test('a connection’s accounts are grouped by institution, each by its own name', () => {
    const grouped = [
      { id: 'a', label: 'Chase Checking ••1111', institution: 'Chase', name: 'Checking ••1111' },
      { id: 'b', label: 'Chase Card ••2222', institution: 'Chase', name: 'Card ••2222' },
      { id: 'c', label: 'Manual House', institution: 'Manual', name: 'House' },
    ];
    const html = panel({ enabled: true, connections: [pat], accounts: grouped }, { current: pat });
    expect(html.match(/class="institution-name"/g)).toHaveLength(2);
    expect(html).toMatch(/Chase<\/p>.*Checking ••1111.*Card ••2222.*Manual<\/p>.*House/s);
  });

  test('says when a connection sees nothing of mine', () => {
    const none = { ...pat, sharing: {} };
    expect(panel({ enabled: true, connections: [none], accounts: [] }, { current: none })).toContain('Pat can’t see any of your accounts.');
  });

  test('uses no class an ad blocker hides', () => {
    const html = panel({ enabled: true, connections: [pat], blocked: [{ id: 'c9', label: 'Ex' }], accounts }, { current: pat }) + panel({ enabled: true, connections: [pat], accounts });
    expect(html).not.toMatch(/class="[^"]*\bshare/);
  });
});

describe('what others share with me', () => {
  test('renders nothing when nothing is shared', () => {
    expect(renderToStaticMarkup(<SharedWithMeView data={{ shared: [] }} />)).toBe('');
  });

  test('shows whose it is, each account and its balance, and transactions only behind a tap', () => {
    const html = renderToStaticMarkup(
      <SharedWithMeView
        data={{
          shared: [
            {
              connection: 'c1',
              label: 'Olive',
              accounts: [
                { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false }] },
                { id: 'b', label: 'House', level: 'balance', balance: null, as_of: null, debt: false },
                { id: 'c', label: 'Visa ••9999', level: 'balance', balance: 250, as_of: '2026-09-26', debt: true },
                { id: 'd', label: 'Savings', level: 'exists', balance: null, as_of: null, debt: false },
              ],
              expires_at: null,
            },
          ],
        }}
      />
    );
    expect(html).toContain('Shared by Olive');
    expect(html).toContain('Joint ••1111');
    expect(html).toContain('No balance yet');
    expect(html).toContain('Recent transactions (1)');
    expect(html).not.toMatch(/class="[^"]*\bshare/);
    expect(html).not.toContain('Blue Bottle');
    expect(html).toContain(shortDate('2026-09-27'));
    expect(html).toMatch(/250\.00 owed/);
    expect(html).toContain('Balance not shared');
    expect(html).not.toMatch(/500\.00 owed/);
  });
});

const DAY = 86_400_000;

describe('when a share ends', () => {
  test('a share runs through its last day here: its end is the start of the next one', () => {
    inZone('America/New_York');
    const now = new Date('2026-10-08T15:00:00-04:00');
    expect(endAfterDays(7, now)).toBe('2026-10-16T04:00:00.000Z');
    expect(endLabel(endAfterDays(7, now), now)).toBe('Oct 15');
    // After the clocks go back on Nov 1: still the start of a day here.
    expect(endAfterDays(30, now)).toBe('2026-11-08T05:00:00.000Z');
    expect(endLabel(endAfterDays(30, now), now)).toBe('Nov 7');
  });

  test('tax season runs through Apr 30: this year’s until it has passed, then next year’s', () => {
    inZone('America/Los_Angeles');
    expect(taxSeasonEnd(new Date(2027, 0, 10))).toBe(new Date(2027, 4, 1).toISOString());
    expect(taxSeasonEnd(new Date(2027, 3, 30, 23, 30))).toBe(new Date(2027, 4, 1).toISOString());
    expect(taxSeasonEnd(new Date(2027, 4, 1))).toBe(new Date(2028, 4, 1).toISOString());
    expect(endLabel(taxSeasonEnd(new Date(2026, 9, 8)), new Date(2026, 9, 8))).toBe('Apr 30, 2027');
  });

  test('a date picked runs through that day, and a day that doesn’t exist is none', () => {
    inZone('Europe/Berlin');
    expect(endOfDay('2027-04-30')).toBe('2027-04-30T22:00:00.000Z');
    expect(endOfDay('2027-02-30')).toBeNull();
    expect(endOfDay('')).toBeNull();
    expect(endOfDay('30/04/2027')).toBeNull();
  });

  test('reads as the last day it runs through, or, chosen in another time zone, when it ends here', () => {
    inZone('America/New_York');
    const now = new Date('2026-10-08T12:00:00-04:00');
    expect(endLabel('2027-05-01T04:00:00.000Z', now)).toBe('Apr 30, 2027');
    // The same end, chosen in New York, comes at 6 AM in Berlin.
    inZone('Europe/Berlin');
    expect(endLabel('2027-05-01T04:00:00.000Z', now)).toBe('May 1, 2027, 6:00 AM');
    expect(endLabel('soon')).toBe('soon');
  });

  test('has ended from the end itself on', () => {
    const end = '2026-10-10T04:00:00.000Z';
    expect(ended(end, Date.parse(end) - 1)).toBe(false);
    expect(ended(end, Date.parse(end))).toBe(true);
    expect(ended(null)).toBe(false);
  });

  test('what saving sends for each choice', () => {
    const now = new Date(2026, 9, 8, 15);
    expect(endFor('keep', '', now)).toBeUndefined();
    expect(endFor('none', '', now)).toBeNull();
    expect(endFor('7', '', now)).toBe(endAfterDays(7, now));
    expect(endFor('30', '', now)).toBe(endAfterDays(30, now));
    expect(endFor('tax', '', now)).toBe(taxSeasonEnd(now));
    expect(endFor('date', '2026-12-31', now)).toBe(endOfDay('2026-12-31'));
    expect(endFor('date', '', now)).toBeUndefined(); // not picked yet: Save waits
  });
});

describe('when they looked', () => {
  const hours: LoggedHour[] = [
    { hour: '2026-10-04T06:00:00.000Z', views: 2, read: { a: 'balance' } },
    { hour: '2026-10-04T15:00:00.000Z', views: 1, read: { a: 'transactions', b: 'balance' } },
    { hour: '2026-10-04T20:00:00.000Z', views: 2, read: { a: 'balance', c: 'exists' } },
  ];

  test('hours become the owner’s own days, newest first, each account at the widest level that day', () => {
    inZone('America/Los_Angeles'); // 11 PM on Oct 3, then 8 AM and 1 PM on Oct 4
    expect(lookedDays(hours)).toEqual([
      { day: '2026-10-04', views: 3, read: { a: 'transactions', b: 'balance', c: 'exists' } },
      { day: '2026-10-03', views: 2, read: { a: 'balance' } },
    ]);
    inZone('Asia/Tokyo'); // 3 PM on Oct 4, then midnight and 5 AM on Oct 5
    expect(lookedDays(hours).map((d) => [d.day, d.views])).toEqual([
      ['2026-10-05', 3],
      ['2026-10-04', 2],
    ]);
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  test('says how many times, and what, widest first', () => {
    expect([1, 2, 3, 10].map(timesText)).toEqual(['once', 'twice', '3 times', '10 times']);
    expect(describeRead({ a: 'balance', b: 'balance' })).toBe('balances of 2 accounts');
    expect(describeRead({ a: 'transactions' })).toBe('the balance and transactions of 1 account');
    expect(describeRead({ a: 'exists', b: 'balance', c: 'transactions', d: 'exists' })).toBe(
      'the balance and transactions of 1 account, the balance of 1 account and that 2 accounts exist'
    );
    expect(describeRead({ a: 'exists' })).toBe('that 1 account exists');
    expect(describeRead({})).toBe('');
    const now = new Date('2026-10-08T12:00:00');
    expect(lookedText({ day: '2026-10-04', views: 3, read: { a: 'balance', b: 'balance' } }, now)).toBe('Viewed 3 times on Oct 4, balances of 2 accounts.');
    expect(lookedText({ day: '2026-10-04', views: 1, read: {} }, now)).toBe('Viewed once on Oct 4.');
  });
});

describe('a connection’s end, preview and looks in the drawer', () => {
  test('a share with an end says until when, in the list and on the connection', () => {
    const c = { ...pat, expires_at: endAfterDays(10) };
    const list = text(panel({ enabled: true, connections: [c], accounts }));
    expect(list).toContain(`Sees 1 of your accounts until ${endLabel(c.expires_at)} · since ${shortDate('2026-09-28')}`);
    const html = panel({ enabled: true, connections: [c], accounts }, { current: c, draft: { a: 'exists' } });
    expect(text(html)).toContain(`Pat can see 1 of your accounts, read-only, until ${endLabel(c.expires_at)}.`);
    expect(html).toContain(`<option value="keep" selected="">Until ${endLabel(c.expires_at)}, as saved</option>`);
    expect(html).not.toContain('Renew');
  });

  test('an ended share says so, keeps the choices, and renews in one tap', () => {
    const past = new Date(Date.now() - DAY).toISOString();
    const c = { ...pat, expires_at: past };
    expect(text(panel({ enabled: true, connections: [c], accounts }))).toContain(`Ended ${endLabel(past)} · since`);
    const html = panel({ enabled: true, connections: [c], accounts }, { current: c, draft: { a: 'exists' } });
    expect(text(html)).toContain(`Ended ${endLabel(past)}: Pat sees none of your accounts now. Your choices below are kept.`);
    expect(html).toContain(`>Renew until ${endLabel(endAfterDays(RENEW_DAYS))}</button>`);
    expect(html).toContain('<option value="exists" selected="">That it exists</option>');
    expect(text(html)).not.toContain('Pat can see 1 of your accounts');
  });

  test('how long they can see it: no end, 7 or 30 days, tax season, or a date', () => {
    const html = panel({ enabled: true, connections: [pat], accounts }, { current: pat });
    expect(html).toContain('<option value="none" selected="">No end date</option>');
    for (const option of ['7 days, until', '30 days, until', 'Tax season, until', 'Until a date you choose']) expect(html).toContain(option);
    expect(html).not.toContain('value="keep"'); // no end saved to keep
    expect(html).not.toContain('type="date"');
    const picking = panel({ enabled: true, connections: [pat], accounts }, { current: pat, endChoice: 'date' });
    expect(picking).toContain('type="date"');
    expect(picking).toMatch(/<button disabled=""[^>]*>Save<\/button>/); // until a day is picked
    expect(panel({ enabled: true, connections: [pat], accounts }, { current: pat, endChoice: 'date', endDay: '2026-12-31' })).toMatch(/<button style="[^"]*">Save<\/button>/);
  });

  test('a way to see exactly what they see', () => {
    expect(panel({ enabled: true, connections: [pat], accounts }, { current: pat })).toContain('See what Pat sees');
  });

  test('when they looked, by the owner’s days, newest first, and how long that is kept', () => {
    inZone('UTC');
    const c = {
      ...pat,
      views: [
        { hour: '2026-10-02T09:00:00.000Z', views: 1, read: { a: 'transactions' } },
        { hour: '2026-10-04T13:00:00.000Z', views: 2, read: { a: 'balance', b: 'balance' } },
        { hour: '2026-10-04T18:00:00.000Z', views: 1, read: { a: 'balance' } },
      ],
    };
    const html = text(panel({ enabled: true, connections: [c], accounts }, { current: c }));
    const oct4 = `Viewed 3 times on ${shortDate('2026-10-04')}, balances of 2 accounts.`;
    const oct2 = `Viewed once on ${shortDate('2026-10-02')}, the balance and transactions of 1 account.`;
    expect(html).toContain(oct4);
    expect(html).toContain(oct2);
    expect(html.indexOf(oct4)).toBeLessThan(html.indexOf(oct2));
    expect(html).toContain('Kept for 90 days. Only you see this, and their card tells them you can.');
    // Many days: the latest five, then the rest on request.
    const many = { ...pat, views: Array.from({ length: 8 }, (_, i) => ({ hour: `2026-09-0${i + 1}T12:00:00.000Z`, views: 1, read: { a: 'balance' } })) };
    const long = text(panel({ enabled: true, connections: [many], accounts }, { current: many }));
    expect(long.match(/Viewed once/g)).toHaveLength(5);
    expect(long).toContain('Show all 8 days');
  });

  test('says when they haven’t looked, and never that for a record that can’t be shown', () => {
    const fresh = { ...pat, since: new Date().toISOString(), views: [] };
    expect(text(panel({ enabled: true, connections: [fresh], accounts }, { current: fresh }))).toContain('Pat hasn’t looked yet.');
    const old = { ...pat, since: '2025-01-01T00:00:00.000Z', views: [] };
    expect(text(panel({ enabled: true, connections: [old], accounts }, { current: old }))).toContain('Pat hasn’t looked in the last 90 days.');
    const shown = (views_problem: string | undefined, views: unknown = null) => {
      const c = { ...pat, views, views_problem };
      return text(panel({ enabled: true, connections: [c], accounts }, { current: c }));
    };
    const damaged = shown('unreadable');
    expect(damaged).toContain('The record of when Pat looked can’t be read, so new looks aren’t being recorded.');
    expect(damaged).toContain('Clear the record');
    const odd = shown('unrecognised');
    expect(odd).toContain('saved by another version of Nya');
    const away = shown('unavailable');
    expect(away).toContain('couldn’t be loaded');
    const missing = shown(undefined, undefined); // a server that sent nothing about it
    expect(missing).toContain('couldn’t be loaded');
    for (const t of [odd, away, missing]) expect(t).not.toContain('Clear the record');
    for (const t of [damaged, odd, away, missing]) expect(t).not.toContain('hasn’t looked');
  });
});

describe('what they see: the preview', () => {
  const view = {
    accounts: [
      { id: 'a', label: 'Joint ••1111', level: 'transactions' as const, balance: 500, as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false }] },
      { id: 'd', label: 'Savings', level: 'exists' as const, balance: null, as_of: null, debt: false },
    ],
    expires_at: endAfterDays(10),
  };
  const previewHtml = (props: Partial<Parameters<typeof PreviewView>[0]> = {}) =>
    renderToStaticMarkup(<PreviewView who="Pat" expiresAt={view.expires_at} preview={{ connection: 'c1', view }} error="" unsaved={false} {...props} />);
  /** A card's accounts, as rendered. */
  const rows = (html: string) => html.slice(html.indexOf('<div class="incoming-account">'), html.lastIndexOf('<p class="panel-note">'));

  test('is the card they get, accounts, dates and end and all, with "you" for their name for me', () => {
    const html = previewHtml();
    expect(text(html)).toContain('Exactly what Pat sees of yours right now, read-only, on their Accounts tab, with the dates they see.');
    expect(text(html)).toContain('Shared by you');
    expect(text(html)).toContain(`Shared until ${endLabel(view.expires_at)}. You can see when they look.`);
    const theirs = renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Olive', ...view }] }} />);
    expect(rows(html)).toBe(rows(theirs));
    expect(rows(html)).toContain(shortDate('2026-09-27'));
    expect(text(html)).not.toContain('changes you haven’t saved');
  });

  test('when they see nothing, says so, and why', () => {
    const none = (preview: any, expiresAt: string | null = null) => text(previewHtml({ preview, expiresAt }));
    expect(none({ connection: 'c1', view: null })).toContain('Pat sees nothing of yours.');
    const past = new Date(Date.now() - DAY).toISOString();
    expect(none({ connection: 'c1', view: null }, past)).toContain(`Your share ended ${endLabel(past)}, so Pat sees nothing of yours.`);
    expect(none({ connection: 'c1', view: null, unreadable: true })).toContain('Some of what you share can’t be read right now, so Pat sees nothing of yours.');
    expect(none({ connection: 'c1', view: null })).not.toContain('Shared by');
  });

  test('while it loads, when it fails, and when the settings have changes not saved', () => {
    expect(previewHtml({ preview: null })).toContain('role="status"');
    expect(previewHtml({ preview: null, error: 'Could not show what they see.' })).toContain('Could not show what they see.');
    expect(text(previewHtml({ unsaved: true }))).toContain('You have changes you haven’t saved. This shows what is saved.');
  });
});

describe('what others share with me, until when', () => {
  test('says until when, and that they can see when I look', () => {
    const shared = (expires_at: string | null) =>
      text(renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Olive', accounts: [{ id: 'd', label: 'Savings', level: 'exists', balance: null, as_of: null, debt: false }], expires_at }] }} />));
    const end = endAfterDays(10);
    expect(shared(end)).toContain(`Shared until ${endLabel(end)}. Olive can see when you look.`);
    expect(shared(null)).toContain('Olive can see when you look.');
    expect(shared(null)).not.toContain('Shared until');
  });
});
