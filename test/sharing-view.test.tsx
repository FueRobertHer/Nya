import { describe, expect, test, afterEach, setSystemTime } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharingPanelView, SharedWithMeView, PreviewView, SharedAccountItem, shortDate, sharedTxnAmount } from '@/components/Sharing';
import { formatMoney } from '@/lib/format';
import {
  endAfterDays,
  endOfDay,
  taxSeasonEnd,
  endLabel,
  endLabelWithYear,
  lastDay,
  ended,
  endFor,
  describeLevels,
  deviceTimeZone,
  timesText,
  shownText,
  localDay,
  RENEW_DAYS,
} from '@/components/SharingDates';

const noop = () => {};
type PanelOpts = {
  current?: any;
  draft?: Record<string, any>;
  invite?: any;
  error?: string;
  endChoice?: any;
  endDay?: string;
  records?: any;
  recordsFailed?: boolean;
  damaged?: any;
};
const panel = (data: any, opts: PanelOpts = {}) =>
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
      records={opts.records ?? null}
      recordsFailed={opts.recordsFailed ?? false}
      onShowAll={noop}
      damaged={opts.damaged ?? null}
      onClearRecord={noop}
      onClearDamaged={noop}
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
};
/** How many accounts at each level. */
const lv = (exists = 0, balance = 0, transactions = 0) => ({ exists, balance, transactions });
/** One day of a record, as the server sends it. */
const day = (d: string, times: number, levels = lv(0, 1, 0)) => ({ day: d, times, levels });
const empty = { days: [], total_days: 0 };
/** Both records on Pat's connection, as the drawer gets them when it opens. */
const recs = (them: any = empty, me: any = empty, extra: Record<string, unknown> = {}) => ({
  connection: 'c1',
  record_id: 'f'.repeat(32),
  record_since: '2026-09-28T10:00:00.000Z',
  shown_to_them: them,
  shown_to_me: me,
  ...extra,
});
const accounts = [{ id: 'a', label: 'Chase Checking ••1111' }];
/** The page as text, tags dropped and the apostrophes React escapes put back. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// Some tests set the time zone. Through Bun.env, the process's own: other
// files replace process.env with a plain copy, which Bun no longer reads TZ
// from. Put back afterwards, or taken away again. The same for the clock.
const savedTz = Bun.env.TZ;
const inZone = (tz: string) => {
  Bun.env.TZ = tz;
};
afterEach(() => {
  if (savedTz === undefined) delete Bun.env.TZ;
  else Bun.env.TZ = savedTz;
  setSystemTime();
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
    const damaged = { damaged: ['a'.repeat(32)], maybe_connected: false };
    const html =
      panel({ enabled: true, connections: [pat], blocked: [{ id: 'c9', label: 'Ex' }], accounts }, { current: pat, records: recs({ days: [day('2026-10-04', 1)], total_days: 9 }) }) +
      panel({ enabled: true, connections: [pat], accounts }, { damaged });
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
                { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, currency: 'USD', as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false, currency: 'USD' }] },
                { id: 'b', label: 'House', level: 'balance', balance: null, currency: 'USD', as_of: null, debt: false },
                { id: 'c', label: 'Visa ••9999', level: 'balance', balance: 250, currency: 'USD', as_of: '2026-09-26', debt: true },
                { id: 'd', label: 'Savings', level: 'exists', balance: null, currency: null, as_of: null, debt: false },
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

  test('a manual account’s transactions are shared like a bank’s; one with none in the window, or one that can’t be read, says so', () => {
    const at = '2026-09-27T14:00:00.000Z';
    const html = text(
      renderToStaticMarkup(
        <SharedWithMeView
          data={{
            shared: [
              {
                connection: 'c1',
                label: 'Olive',
                accounts: [
                  { id: 'manual_0b6f', label: 'Wallet', level: 'transactions', balance: 80, currency: 'USD', as_of: at, debt: false, transactions: [{ date: '2026-09-26', name: 'Farmers market', amount: 23, pending: false, currency: 'USD' }] },
                  { id: 'manual_1c7a', label: 'Cash abroad', level: 'transactions', balance: 40, currency: 'USD', as_of: at, debt: false, transactions: [] },
                  { id: 'manual_2d8b', label: 'Old book', level: 'transactions', balance: 10, currency: 'USD', as_of: at, debt: false, transactions_unreadable: true },
                  { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, currency: 'USD', as_of: '2026-09-27', debt: false, transactions: [] },
                ],
                expires_at: null,
              },
            ],
          }}
        />
      )
    );
    expect(html).toContain('Wallet');
    expect(html).toContain('Recent transactions (1)');
    // None in the window, a bank's or entered by hand: said so, not an empty list.
    expect(html.match(/No transactions in the last 30 days\./g)).toHaveLength(2);
    expect(html).not.toContain('Recent transactions (0)');
    // A book that can't be read is never shown as having none.
    expect(html).toContain('Old book');
    expect(html).toContain("Its transactions can't be read, so they aren't shown.");
    expect(html).not.toContain("aren't shared yet");
  });

  test('each figure is shown in its own currency, nothing converted: the balance in its account’s, each row in its own', () => {
    const toggle = () => {};
    const pounds = {
      id: 'a',
      label: 'Monzo ••3000',
      level: 'transactions' as const,
      balance: 640,
      currency: 'GBP',
      as_of: '2026-09-27',
      debt: false,
      transactions: [{ date: '2026-09-26', name: 'Pret', amount: 12, pending: false, currency: 'GBP' }],
    };
    const opened = text(renderToStaticMarkup(<SharedAccountItem a={pounds} open onToggle={toggle} />));
    expect(opened).toContain('£640.00');
    expect(opened).toContain('Pret');
    expect(opened).toContain('-£12.00');
    expect(opened).not.toContain('$');
    // Closed, as a card first shows it: the balance, and how many rows.
    const closed = text(renderToStaticMarkup(<SharedAccountItem a={pounds} open={false} onToggle={toggle} />));
    expect(closed).toContain('£640.00');
    expect(closed).toContain('Recent transactions (1)');
    expect(closed).not.toContain('Pret');
    // Nothing names a currency (a bank's row stored before its currency was
    // kept, an account its institution never gave one for): the main one.
    const unnamed = { ...pounds, currency: null, debt: true, transactions: [{ ...pounds.transactions[0], amount: -5, currency: null }] };
    const plain = text(renderToStaticMarkup(<SharedAccountItem a={unnamed} open onToggle={toggle} />));
    expect(plain).toContain('$640.00 owed');
    expect(plain).toContain('$5.00');
    expect(plain).not.toContain('£');
    expect(sharedTxnAmount({ amount: 1200, currency: 'JPY' })).toBe(formatMoney(-1200, 'JPY'));
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
    // Chosen a minute before midnight: through the seventh day after it, whole.
    const late = new Date('2026-10-08T23:59:00-04:00');
    expect(endLabel(endAfterDays(7, late), late)).toBe('Oct 15');
  });

  test('tax season is offered from January through April only, and runs through Apr 30 of that year', () => {
    inZone('America/Los_Angeles');
    expect(taxSeasonEnd(new Date(2027, 0, 1))).toBe(new Date(2027, 4, 1).toISOString());
    expect(taxSeasonEnd(new Date(2027, 0, 10))).toBe(new Date(2027, 4, 1).toISOString());
    expect(taxSeasonEnd(new Date(2027, 3, 30, 23, 30))).toBe(new Date(2027, 4, 1).toISOString());
    // From May on, it would run most of a year: not offered.
    for (const d of [new Date(2027, 4, 1), new Date(2026, 9, 8), new Date(2026, 11, 31, 23, 59)]) expect(taxSeasonEnd(d)).toBeNull();
    expect(endFor('tax', '', new Date(2026, 9, 8))).toBeUndefined();
    expect(endLabelWithYear(taxSeasonEnd(new Date(2027, 0, 10))!)).toBe('Apr 30, 2027');
  });

  test('the tax season choice shows the exact day it ends, and only in its months', () => {
    inZone('America/New_York');
    setSystemTime(new Date(2027, 0, 10, 12));
    const html = panel({ enabled: true, connections: [pat], accounts }, { current: pat });
    expect(html).toContain('<option value="tax">Tax season, until Apr 30, 2027</option>');
    setSystemTime(new Date(2027, 4, 1, 12));
    expect(panel({ enabled: true, connections: [pat], accounts }, { current: pat })).not.toContain('Tax season');
    // Chosen earlier and not saved yet, it reads as no end once May comes, and sends none.
    expect(panel({ enabled: true, connections: [pat], accounts }, { current: pat, endChoice: 'tax' })).toContain('<option value="none" selected="">No end date</option>');
  });

  test('a date picked runs through that day, and a day that doesn’t exist is none', () => {
    inZone('Europe/Berlin');
    expect(endOfDay('2027-04-30')).toBe('2027-04-30T22:00:00.000Z');
    expect(endOfDay('2027-02-30')).toBeNull();
    expect(endOfDay('')).toBeNull();
    expect(endOfDay('30/04/2027')).toBeNull();
  });

  test('where the clocks skip midnight, a date picked still reads as that day', () => {
    // Chile moves its clocks from midnight to 1 AM on Sep 6, 2026: that day
    // starts at 1 AM, and a share through Sep 5 ends then.
    inZone('America/Santiago');
    const end = endOfDay('2026-09-05')!;
    expect(end).toBe('2026-09-06T04:00:00.000Z');
    expect(lastDay(end)).toBe('2026-09-05');
    expect(endLabel(end, new Date('2026-08-20T12:00:00'))).toBe('Sep 5');
  });

  test('reads as the last day it is shown here, never with a time, wherever it was chosen', () => {
    inZone('America/New_York');
    const now = new Date('2026-10-08T12:00:00-04:00');
    expect(endLabel('2027-05-01T04:00:00.000Z', now)).toBe('Apr 30, 2027');
    // The same end, chosen in New York, comes at 6 AM on May 1 in Berlin: shown there through part of May 1.
    inZone('Europe/Berlin');
    expect(endLabel('2027-05-01T04:00:00.000Z', now)).toBe('May 1, 2027');
    // And in Kolkata, at half past nine in the morning.
    inZone('Asia/Kolkata');
    expect(endLabel('2027-05-01T04:00:00.000Z', now)).toBe('May 1, 2027');
    for (const zone of ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Chatham']) {
      inZone(zone);
      expect(endLabel('2027-05-01T04:00:00.000Z', now)).not.toMatch(/\d:\d\d|AM|PM/);
    }
    expect(endLabel('soon')).toBe('soon');
  });

  test('has ended from the end itself on', () => {
    const end = '2026-10-10T04:00:00.000Z';
    expect(ended(end, Date.parse(end) - 1)).toBe(false);
    expect(ended(end, Date.parse(end))).toBe(true);
    expect(ended(null)).toBe(false);
  });

  test('what saving sends for each choice', () => {
    const now = new Date(2027, 1, 8, 15);
    expect(endFor('keep', '', now)).toBeUndefined();
    expect(endFor('none', '', now)).toBeNull();
    expect(endFor('7', '', now)).toBe(endAfterDays(7, now));
    expect(endFor('30', '', now)).toBe(endAfterDays(30, now));
    expect(endFor('tax', '', now)).toBe(taxSeasonEnd(now)!);
    expect(endFor('date', '2027-12-31', now)).toBe(endOfDay('2027-12-31')!);
    expect(endFor('date', '', now)).toBeUndefined(); // not picked yet: Save waits
  });
});

describe('when it was shown', () => {
  test('says how many times, and what, widest first', () => {
    expect([1, 2, 3, 10].map(timesText)).toEqual(['once', 'twice', '3 times', '10 times']);
    expect(describeLevels(lv(0, 2, 0))).toBe('balances of 2 accounts');
    expect(describeLevels(lv(0, 0, 1))).toBe('the balance and transactions of 1 account');
    expect(describeLevels(lv(2, 1, 1))).toBe('the balance and transactions of 1 account, the balance of 1 account and that 2 accounts exist');
    expect(describeLevels(lv(1, 0, 0))).toBe('that 1 account exists');
    expect(describeLevels(lv())).toBe('');
    const now = new Date('2026-10-08T12:00:00');
    expect(shownText(day('2026-10-04', 3, lv(0, 2, 0)), now)).toBe('Shown 3 times on Oct 4, balances of 2 accounts.');
    expect(shownText(day('2026-10-04', 1, lv()), now)).toBe('Shown once on Oct 4.');
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  test('the drawer asks for the days of this device’s own time zone', () => {
    inZone('Asia/Kolkata');
    expect(deviceTimeZone()).toBe('Asia/Kolkata');
    inZone('America/St_Johns');
    expect(deviceTimeZone()).toBe('America/St_Johns');
  });
});

describe('a connection’s end, preview and records in the drawer', () => {
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

  test('how long they can see it: no end, 7 or 30 days, or a date', () => {
    const html = panel({ enabled: true, connections: [pat], accounts }, { current: pat });
    expect(html).toContain('<option value="none" selected="">No end date</option>');
    for (const option of ['7 days, until', '30 days, until', 'Until a date you choose']) expect(html).toContain(option);
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

  test('both records: what was shown to them, by day, newest first, and what was shown to me', () => {
    const records = recs(
      { days: [day('2026-10-04', 3, lv(0, 2, 0)), day('2026-10-02', 1, lv(0, 0, 1))], total_days: 2 },
      { days: [day('2026-10-03', 4, lv(1, 0, 0))], total_days: 1 }
    );
    const html = text(panel({ enabled: true, connections: [pat], accounts }, { current: pat, records }));
    const toThem = html.slice(html.indexOf('Shown to them'), html.indexOf('Shown to you'));
    const toMe = html.slice(html.indexOf('Shown to you'));
    const oct4 = `Shown 3 times on ${shortDate('2026-10-04')}, balances of 2 accounts.`;
    const oct2 = `Shown once on ${shortDate('2026-10-02')}, the balance and transactions of 1 account.`;
    expect(toThem).toContain(oct4);
    expect(toThem).toContain(oct2);
    expect(toThem.indexOf(oct4)).toBeLessThan(toThem.indexOf(oct2));
    expect(toThem).toContain(
      'Counted each time their app loads what you share, which it does when that part of their Accounts tab comes into view. Kept 90 days at most, and only while you’re connected. They see this same record.'
    );
    expect(toMe).toContain(`Shown 4 times on ${shortDate('2026-10-03')}, that 1 account exists.`);
    expect(toMe).toContain('Pat’s record of each time what they share was shown to you: the same one they see.');
    expect(toMe).not.toContain(oct4);
    // Five days came, of eight: "Show all" asks for the rest, and says whether they are open.
    const many = recs({ days: Array.from({ length: 5 }, (_, i) => day(`2026-09-0${8 - i}`, 1)), total_days: 8 });
    const long = panel({ enabled: true, connections: [pat], accounts }, { current: pat, records: many });
    expect(text(long).match(/Shown once/g)).toHaveLength(5);
    expect(long).toContain('<button class="link-btn" aria-expanded="false">Show all 8 days</button>');
    // Five or fewer in all: nothing more to show.
    expect(panel({ enabled: true, connections: [pat], accounts }, { current: pat, records })).not.toContain('Show all');
  });

  test('the connection and its controls are there before its records, and whether they load or not', () => {
    for (const opts of [{}, { recordsFailed: true }]) {
      const html = text(panel({ enabled: true, connections: [pat], accounts }, { current: pat, ...opts }));
      for (const control of ['What you call them', 'Chase Checking ••1111', 'How long they can see it', 'Save', 'See what Pat sees', 'Remove', 'Block']) {
        expect(html).toContain(control);
      }
      const shownToThem = html.slice(html.indexOf('Shown to them'), html.indexOf('Shown to you'));
      if ('recordsFailed' in opts) expect(shownToThem).toContain('This record couldn’t be loaded. Try again later.');
      else expect(shownToThem).toContain('Loading…');
    }
  });

  test('a record with nothing in it says nothing was recorded, and since when, never that they haven’t looked', () => {
    const none = (record_since: string | null) => text(panel({ enabled: true, connections: [pat], accounts }, { current: pat, records: recs(empty, empty, { record_since }) }));
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    expect(none(since).match(new RegExp(`Nothing recorded since ${shortDate(since)}\\.`, 'g'))).toHaveLength(2);
    expect(none('2025-01-01T00:00:00.000Z').match(/Nothing recorded in the last 90 days\./g)).toHaveLength(2);
    // A connection from before records: none has begun yet.
    expect(none(null).match(/Nothing recorded yet\./g)).toHaveLength(2);
    for (const t of [none(since), none(null)]) expect(t).not.toMatch(/hasn’t looked|haven’t looked|not looked/);
  });

  test('a record that can’t be shown says why, and only my own damaged one can be cleared', () => {
    const problem = (p: string) => ({ days: null, problem: p });
    const shown = (records: any) => text(panel({ enabled: true, connections: [pat], accounts }, { current: pat, records }));
    const damaged = shown(recs(problem('unreadable')));
    expect(damaged).toContain('This record can’t be read, so new showings aren’t being recorded. Clearing it starts a new one; nothing readable is lost.');
    expect(damaged).toContain('Clear the record');
    const theirs = shown(recs(empty, problem('unreadable')));
    expect(theirs).toContain('Pat’s record of this can’t be read, so new showings aren’t being recorded.');
    const odd = shown(recs(problem('unrecognised')));
    expect(odd).toContain('This record was saved by another version of Nya and can’t be shown here. It is kept as it is, and new showings aren’t recorded until it can be read.');
    const away = shown(recs(problem('unavailable'), problem('unavailable')));
    expect(away.match(/This record couldn’t be loaded\. Try again later\./g)).toHaveLength(2);
    // The connection's record id can't be read: what is true, and nothing to clear that wouldn't help.
    const noId = shown(recs(problem('record_id_unreadable'), problem('record_id_unreadable'), { record_id: null, record_since: null }));
    expect(noId).toContain(
      'The id this connection’s records are kept under can’t be read, so they can’t be shown, and new showings aren’t recorded. Removing Pat and connecting again starts new records.'
    );
    expect(noId).toContain('Pat’s record of this can’t be shown either.');
    for (const t of [theirs, odd, away, noId]) expect(t).not.toContain('Clear the record');
    // Never "nothing recorded" for a record that can't be shown.
    const toThem = (t: string) => t.slice(t.indexOf('Shown to them'), t.indexOf('Shown to you'));
    const toMe = (t: string) => t.slice(t.indexOf('Shown to you'), t.indexOf('Connection Remove'));
    for (const t of [damaged, odd, away, noId]) expect(toThem(t)).not.toContain('Nothing recorded');
    for (const t of [theirs, away, noId]) expect(toMe(t)).not.toContain('Nothing recorded');
    expect(toMe(damaged)).toContain('Nothing recorded');
  });

  test('records of mine that can’t be read and that no connection is matched to can be cleared, said as truly as Nya knows it', () => {
    const list = (damaged: any) => text(panel({ enabled: true, connections: [pat], accounts }, { damaged }));
    const one = list({ damaged: ['a'.repeat(32)], maybe_connected: false });
    expect(one).toContain('A record of showings from someone you’re no longer connected with can’t be read.');
    expect(one).toContain('Clear it');
    const two = list({ damaged: ['a'.repeat(32), 'b'.repeat(32)], maybe_connected: false });
    expect(two).toContain('2 records of showings from people you’re no longer connected with can’t be read.');
    expect(two).toContain('Clear them');
    // One of my connections has a record id that can't be read: it could be that one's.
    expect(list({ damaged: ['a'.repeat(32)], maybe_connected: true })).toContain(
      'A record of showings can’t be read, and Nya can’t tell whose it is: someone you’re no longer connected with, or someone whose record id can’t be read.'
    );
    for (const nothing of [{ damaged: [], maybe_connected: false }, null]) expect(list(nothing)).not.toContain('can’t be read');
  });
});

describe('what they see: the preview', () => {
  const view = {
    accounts: [
      { id: 'a', label: 'Joint ••1111', level: 'transactions' as const, balance: 500, currency: 'USD', as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false, currency: 'USD' }] },
      { id: 'd', label: 'Savings', level: 'exists' as const, balance: null, currency: null, as_of: null, debt: false },
    ],
    expires_at: endAfterDays(10),
  };
  const previewHtml = (props: Partial<Parameters<typeof PreviewView>[0]> = {}) =>
    renderToStaticMarkup(<PreviewView who="Pat" expiresAt={view.expires_at} preview={{ connection: 'c1', view }} error="" unsaved={false} {...props} />);
  /** A card's accounts, as rendered. */
  const rows = (html: string) => html.slice(html.indexOf('<div class="incoming-account">'), html.lastIndexOf('<p class="panel-note">'));

  test('is the card they get, accounts, dates and end and all, with "you" for their name for me, and says whose time zone its dates are in', () => {
    const html = previewHtml();
    expect(text(html)).toContain(
      'Exactly what Pat sees of yours right now, read-only, on their Accounts tab. Their card carries their name for you, and shows its dates in their own time zone, so one can fall a day apart from here.'
    );
    expect(text(html)).toContain('Shared by you');
    expect(text(html)).toContain(`Shared until ${endLabel(view.expires_at)}. You see each time this is shown to them, and so do they, in Sharing.`);
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
    const failed = text(previewHtml({ preview: null, error: 'Could not show what they see' }));
    expect(failed).toContain('Could not show what they see');
    expect(failed).not.toContain('sees nothing');
    expect(text(previewHtml({ unsaved: true }))).toContain('You have changes you haven’t saved. This shows what is saved.');
  });
});

describe('what others share with me, until when', () => {
  const shared = (expires_at: string | null) => (
    <SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Olive', accounts: [{ id: 'd', label: 'Savings', level: 'exists', balance: null, currency: null, as_of: null, debt: false }], expires_at }] }} />
  );

  test('says until when, in my own days, and that both of us see each time it is shown to me', () => {
    const end = endAfterDays(10);
    expect(text(renderToStaticMarkup(shared(end)))).toContain(`Shared until ${endLabel(end)}. Olive sees each time this is shown to you, and so do you, in Sharing.`);
    expect(text(renderToStaticMarkup(shared(null)))).toContain('Olive sees each time this is shown to you, and so do you, in Sharing.');
    expect(text(renderToStaticMarkup(shared(null)))).not.toContain('Shared until');
  });

  test('a share whose end has come is not shown, without waiting for the next load', () => {
    expect(renderToStaticMarkup(shared(new Date(Date.now() - 1000).toISOString()))).toBe('');
    expect(renderToStaticMarkup(shared(new Date(Date.now() + 60_000).toISOString()))).toContain('Shared by Olive');
  });
});
