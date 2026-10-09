import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharingPanelView, SharedWithMeView, shortDate } from '@/components/Sharing';

const noop = () => {};
const panel = (data: any, opts: { current?: any; draft?: Record<string, any>; invite?: any; error?: string } = {}) =>
  renderToStaticMarkup(
    <SharingPanelView
      data={data}
      current={opts.current ?? null}
      draft={opts.draft ?? {}}
      labelDraft={opts.current?.label ?? ''}
      invite={opts.invite ?? null}
      busy={false}
      error={opts.error ?? ''}
      notice=""
      onOpen={noop}
      onChoose={noop}
      onLabel={noop}
      onInvite={noop}
      onSave={noop}
      onRemove={noop}
    />
  );
const pat = { id: 'c1', label: 'Pat', introduced_as: 'Patricia', since: '2026-09-28', sharing: { a: 'exists', hidden_one: 'balance' } };
const accounts = [{ id: 'a', label: 'Chase Checking ••1111' }];

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

  test('a manual account shared with its transactions says those entered by hand aren’t shared yet, never that it has none', () => {
    const html = renderToStaticMarkup(
      <SharedWithMeView
        data={{
          shared: [
            {
              connection: 'c1',
              label: 'Olive',
              accounts: [
                { id: 'manual_0b6f', label: 'Wallet', level: 'transactions', balance: 80, as_of: '2026-09-27T14:00:00.000Z', debt: false, transactions: [] },
                { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, as_of: '2026-09-27', debt: false, transactions: [] },
              ],
            },
          ],
        }}
      />
    );
    expect(html).toContain('Transactions entered by hand aren&#x27;t shared yet.');
    // A bank's account with none in the last 30 days still says so.
    expect(html.match(/Recent transactions \(0\)/g)).toHaveLength(1);
  });
});
