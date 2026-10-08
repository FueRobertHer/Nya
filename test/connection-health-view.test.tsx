import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionHealthView, ReconnectSoonNote, affectedText, healthText, sideText, endsText, lastSyncedText, type HealthInstitution } from '@/components/ConnectionHealth';
import { totalNotes } from '@/components/total-notes';
import { reconnectAlerts } from '@/components/Insights';
import { monthGapNotes, monthGaps, stoppedConnections, joinNames } from '@/lib/month-coverage';
import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';

// What the person sees of connection health (#51): the health view, the
// "Reconnect soon" note on a card, the Home total's notes, the Home alert,
// and Activity's months. Instants sit at noon UTC, so the local day is the
// same in any time zone a test machine is likely to have.

const noop = () => {};
const health = (cause: Cause, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  ...CAUSES[cause],
  cause,
  side: 'bank',
  last_ok_at: '2026-09-12T12:00:00.000Z',
  ...over,
});
const inst = (name: string, h: ConnectionHealth, over: Partial<HealthInstitution> = {}): HealthInstitution & { health: ConnectionHealth } => ({
  institution_name: name,
  item_id: `item_${name.toLowerCase()}`,
  error: h.state === 'healthy' || h.state === 'reconnect_soon' || h.state === 'partial' ? null : 'Could not fetch balances',
  accounts: [],
  health: h,
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ');
const view = (rows: (HealthInstitution & { health: ConnectionHealth })[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <ConnectionHealthView rows={rows} open={true} onToggle={noop} unavailable={false} connecting={false} onReconnect={noop} onRemove={noop} onManageAccounts={noop} now={Date.parse('2026-10-08T12:00:00Z')} {...over} />
  );
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b.trim() !== '');

describe('the connection health view', () => {
  test('every connection, with its state, last good sync, whose side, and the one action for it', () => {
    const rows = [
      inst('Chase', health('login', { side: 'you', code: 'ITEM_LOGIN_REQUIRED' })),
      inst('Amex', health('revoked', { side: 'you' })),
      inst('Ally', health('institution_down')),
      inst('Citi', health('ok', { side: 'none', last_ok_at: '2026-10-08T12:00:00.000Z' })),
    ];
    const html = view(rows);
    const t = text(html);
    expect(t).toContain('Connection health');
    expect(t).toContain('3 of 4 need attention');
    expect(t).toContain('Chase Needs reconnecting');
    expect(t).toContain('Chase needs you to sign in again. Reconnect: it takes a minute.');
    expect(t).toContain('Last synced Sep 12 · On your side: your sign-in at Chase · Plaid code ITEM_LOGIN_REQUIRED');
    expect(t).toContain("Access to Amex was withdrawn, so this connection can't be repaired. Remove it, then connect Amex again: link its new accounts to the old ones and their history carries over.");
    expect(t).toContain("Ally isn't answering. Nothing to do: it usually recovers on its own.");
    expect(t).toContain("On Ally's side");
    expect(t).toContain('Citi Working');
    expect(t).toContain('Last synced Oct 8');
    // Reconnect for the sign-in, Remove for the one that can't be repaired,
    // nothing to tap for an outage or a working connection.
    expect(buttons(html)).toEqual(['Reconnect', 'Remove Amex']);
  });

  test('the four failures each offer their own action', () => {
    const html = view([
      inst('A', health('login')),
      inst('B', health('institution_down')),
      inst('C', health('gone', { side: 'plaid' })),
      inst('D', health('no_accounts')),
      inst('E', health('vanished'), { unconfirmed_missing: 1 }),
      inst('F', health('unsupported')),
    ]);
    expect(buttons(html)).toEqual(['Reconnect', 'Remove C', 'Remove D', 'Add or remove accounts', 'Remove F']);
    const t = text(html);
    expect(t).toContain("1 account E used to report isn't in its latest answer. If you closed it, nothing to do: it is counted as closed after three days.");
    expect(t).toContain("F Can't be repaired");
    expect(t).toContain("Plaid can no longer reach F, so reconnecting won't help.");
  });

  test('reconnect soon, with the date Plaid gave, or around the one it implied', () => {
    const exact = inst('Chase', health('consent_ending', { ends_at: '2026-10-15T12:00:00.000Z', ends_estimated: false, last_ok_at: '2026-10-08T12:00:00.000Z' }));
    const about = inst('Amex', health('disconnect_pending', { ends_at: '2026-10-14T12:00:00.000Z', ends_estimated: true, last_ok_at: '2026-10-08T12:00:00.000Z' }));
    const t = text(view([exact, about]));
    expect(t).toContain('Plaid says this connection ends on Oct 15. Reconnect before then to keep it syncing');
    expect(t).toContain('Plaid says this connection ends around Oct 14.');
    expect(buttons(view([exact]))).toEqual(['Reconnect']);
  });

  test('which accounts are affected, and how much of net worth is last known balances, labeled as such', () => {
    const broken = inst('Chase', health('login'), {
      accounts: [
        { name: 'Checking', mask: '4821', type: 'depository', balance: 5000, currency: 'USD', stale: true },
        { name: 'Sapphire', mask: '1234', type: 'credit', balance: 1200, currency: 'USD', stale: true },
        { name: 'Hidden one', mask: null, type: 'depository', balance: 999, currency: 'USD', stale: true, hidden: true },
      ],
      stale_as_of: '2026-09-12',
      unshown_accounts: [{ name: 'Savings', mask: '7777' }],
    });
    expect(affectedText(broken, (n) => `$${n}`)).toEqual([
      'Shown at last known balances from Sep 12, not measured now: Checking ••4821 and Sapphire ••1234, together $3800 of net worth.',
      'Not counted in net worth: Savings ••7777.',
    ]);
    // Nothing recovered, nothing remembered: still said.
    expect(affectedText(inst('Ally', health('institution_down')))).toEqual(['Not counted in net worth.']);
    expect(affectedText(inst('Old', health('login'), { stale_too_old: '2026-08-01', unshown_accounts: [{ name: 'Card', mask: null }] }))).toEqual([
      'Not counted in net worth: Card.',
      'Its last known balances are from Aug 1, too old to count.',
    ]);
    expect(affectedText(inst('E', health('vanished'), { unconfirmed_missing: 2 }))).toEqual(['2 accounts not in the total.']);
    expect(affectedText(inst('Citi', health('ok')))).toEqual([]);
    // Several currencies are not added up.
    const mixed = inst('Wise', health('login'), {
      accounts: [
        { name: 'USD', mask: null, type: 'depository', balance: 10, currency: 'USD', stale: true },
        { name: 'EUR', mask: null, type: 'depository', balance: 10, currency: 'EUR', stale: true },
      ],
    });
    expect(affectedText(mixed)[0]).toBe('Shown at last known balances, not measured now: USD and EUR.');
  });

  test('all working is one quiet line; unreadable health is said, not shown as healthy', () => {
    const ok = [inst('Citi', health('ok')), inst('Ally', health('ok'))];
    expect(text(view(ok, { open: false }))).toContain('All 2 working');
    expect(view(ok, { open: false })).not.toContain('health-row');
    expect(text(view(ok, { unavailable: true }))).toContain("Plaid's warnings and the last sync times couldn't be read just now");
  });

  test('a last sync never recorded says so', () => {
    expect(lastSyncedText(health('login', { last_ok_at: null }))).toBe('Last synced: not recorded yet');
    expect(sideText('Chase', health('unknown', { side: 'unknown' }))).toBe('Whose side: not known');
    expect(sideText('Chase', health('credentials', { side: 'nya' }))).toBe("On Nya's side");
    expect(healthText('Chase', health('unknown', { code: 'NEW_CODE' }), {})).toBe("Chase couldn't be updated (Plaid: NEW_CODE). This usually clears on its own.");
  });
});

describe('the Reconnect soon note on a card', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  test('the badge, the date and a Reconnect button, only while Plaid says it will end', () => {
    const soon = { item_id: 'item_chase', health: health('consent_ending', { ends_at: '2026-10-15T12:00:00.000Z' }) };
    const html = renderToStaticMarkup(<ReconnectSoonNote inst={soon} connecting={false} onReconnect={noop} now={now} />);
    expect(text(html)).toContain('Reconnect soon Plaid says this connection ends on Oct 15. Reconnect before then to keep it syncing.');
    expect(buttons(html)).toEqual(['Reconnect']);
    for (const other of [health('ok'), health('login'), undefined]) {
      expect(renderToStaticMarkup(<ReconnectSoonNote inst={{ item_id: 'x', health: other }} connecting={false} onReconnect={noop} now={now} />)).toBe('');
    }
    expect(renderToStaticMarkup(<ReconnectSoonNote inst={{ ...soon, manual: true }} connecting={false} onReconnect={noop} now={now} />)).toBe('');
  });

  test('past its date, it says it was due then', () => {
    expect(endsText(health('consent_ending', { ends_at: '2026-10-05T12:00:00.000Z' }), now)).toBe('Plaid said this connection would end on Oct 5');
  });
});

describe('the notes under the Home total name what is missing', () => {
  const day = { snapshot: (d: string) => `snap ${d}`, instant: (iso: string) => `day ${iso.slice(5, 10)}` };
  const base = { error: 'Could not fetch balances', needs_reauth: false };

  test('one institution not counted: what is wrong with it, and when it was last seen', () => {
    expect(totalNotes([{ institution_name: 'Chase', ...base, needs_reauth: true, health: { last_ok_at: '2026-09-12T12:00:00Z' } }], day)).toEqual([
      "Chase needs reconnecting, last seen day 09-12, and isn't counted in this total",
    ]);
    expect(totalNotes([{ institution_name: 'Chase', ...base }], day)).toEqual(["Chase couldn't be reached and isn't counted in this total"]);
  });

  test('several are named, not counted', () => {
    expect(
      totalNotes(
        [
          { institution_name: 'Chase', ...base, needs_reauth: true, health: { last_ok_at: '2026-09-12T12:00:00Z' } },
          { institution_name: 'Amex', ...base, health: { last_ok_at: null } },
        ],
        day
      )
    ).toEqual(["Chase (needs reconnecting, last seen day 09-12) and Amex aren't counted in this total"]);
    expect(
      totalNotes(
        [
          { institution_name: 'Chase', ...base, needs_reauth: true, stale_as_of: '2026-09-12' },
          { institution_name: 'Amex', ...base, stale_as_of: '2026-09-12', stale_missing: 2 },
        ],
        day
      )
    ).toEqual([
      "Chase needs reconnecting and Amex couldn't refresh; showing their last known balances from snap 2026-09-12",
      "2 accounts at Amex couldn't be shown, so this total is incomplete",
    ]);
  });

  test('the wording for one recovered institution and for vanished accounts keeps its style, with the names', () => {
    expect(totalNotes([{ institution_name: 'Chase', ...base, stale_as_of: '2026-09-12' }], day)).toEqual([
      "Chase couldn't refresh; its balances are from snap 2026-09-12",
    ]);
    expect(totalNotes([{ institution_name: 'Ally', error: null, needs_reauth: false, unconfirmed_missing: 1 }], day)).toEqual([
      '1 account at Ally stopped reporting, so this total is short by it · history is paused until that settles',
    ]);
    expect(totalNotes([{ institution_name: 'Ally', error: null, needs_reauth: false }], day)).toEqual([]);
  });
});

describe('the Home alert a few days before a connection ends', () => {
  const now = new Date('2026-10-08T12:00:00');
  const soon = (days: number, over = {}) => ({ item_id: `i${days}`, institution_name: `Bank ${days}`, ends_at: new Date(2026, 9, 8 + days, 12).toISOString(), ...over });

  test('within three days only, soonest first, two at most', () => {
    expect(reconnectAlerts([soon(7), soon(4)], now)).toEqual([]);
    expect(reconnectAlerts([soon(3), soon(1), soon(0)], now).map((a) => a.text)).toEqual([
      'Reconnect Bank 0: Plaid says its connection ends today',
      'Reconnect Bank 1: Plaid says its connection ends tomorrow',
    ]);
    expect(reconnectAlerts([soon(2)], now)[0].text).toBe('Reconnect Bank 2: Plaid says its connection ends in 2 days');
    // An estimate is said as one.
    expect(reconnectAlerts([soon(2, { ends_estimated: true })], now)[0].text).toBe('Reconnect Bank 2: Plaid expects its connection to end in about 2 days');
    expect(reconnectAlerts([soon(-2)], now)[0].text).toMatch(/^Reconnect Bank -2: Plaid said its connection would end on /);
    expect(reconnectAlerts([soon(-2, { ends_estimated: true })], now)[0].text).toMatch(/^Reconnect Bank -2: Plaid expected its connection to end around /);
    expect(reconnectAlerts([{ item_id: 'x', institution_name: 'X', ends_at: 'never' }], now)).toEqual([]);
  });
});

describe("Activity's months say when they may be incomplete", () => {
  const day = (iso: string) => iso.slice(5, 10);
  const stopped = [{ institution_name: 'Chase', last_ok_at: '2026-09-12T12:00:00.000Z' }];

  test('a connection that stopped leaves the months after its last sync in question, not those before', () => {
    expect(monthGapNotes('2026-08', [], stopped, day)).toEqual([]);
    expect(monthGapNotes('2026-09', [], stopped, day)).toEqual(["Chase hasn't synced since 09-12, so this month may be missing some of its transactions."]);
    expect(monthGapNotes('2026-10', [], stopped, day)).toHaveLength(1);
    // Never recorded: any month could be short.
    expect(monthGapNotes('2025-01', [], [{ institution_name: 'Amex', last_ok_at: null }], day)).toEqual(["Amex isn't syncing, so this month may be missing some of its transactions."]);
    // December rolls into January.
    expect(monthGaps('2025-12', [], [{ institution_name: 'C', last_ok_at: '2025-12-31T12:00:00.000Z' }]).stopped).toHaveLength(1);
    expect(monthGaps('2025-12', [], [{ institution_name: 'C', last_ok_at: '2026-01-02T12:00:00.000Z' }]).stopped).toHaveLength(0);
  });

  test('an institution missing from the load is in question every month, named once', () => {
    const incomplete = [{ institution_name: 'Chase', coverage: 'missing' as const }, { institution_name: 'Ally', coverage: 'importing' as const }];
    expect(monthGapNotes('2025-01', incomplete, stopped, day)).toEqual([
      "Doesn't include Chase: its transactions couldn't be loaded, so this month may be incomplete.",
      'Ally is still importing older transactions, so this month may be incomplete.',
    ]);
  });

  test('only broken connections count as stopped; manual ones and old payloads never', () => {
    const h = (state: string) => ({ state, last_ok_at: null });
    expect(
      stoppedConnections([
        { institution_name: 'A', health: h('needs_reauth') },
        { institution_name: 'B', health: h('outage') },
        { institution_name: 'C', health: h('reconnect_soon') },
        { institution_name: 'D', health: h('partial') },
        { institution_name: 'E', health: h('healthy') },
        { institution_name: 'F' },
        { institution_name: 'G', manual: true, health: h('outage') },
      ]).map((s) => s.institution_name)
    ).toEqual(['A', 'B']);
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
