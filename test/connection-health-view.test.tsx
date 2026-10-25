import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { affectedText, badgeOf, healthText, sideText, endsText, lastSyncedText, type HealthInstitution } from '@/components/ConnectionHealth';
import { ConnectionStatus, statusBadge } from '@/components/ConnectionStatus';
import type { Account, Institution } from '@/components/accounts-format';
import { totalNotes } from '@/components/total-notes';
import { reconnectAlerts } from '@/components/Insights';
import { monthGapNotes, monthGaps, stoppedConnections, joinNames } from '@/lib/month-coverage';
import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';
import { localDate } from '@/lib/local-date';

// What the person sees of connection health (#51): on each institution's
// card since rollout phase 3b (components/ConnectionStatus.tsx: what is
// wrong, whose side, the one action, a connection that ends soon), the Home
// total's notes, the Home alert, and Activity's months. Every sentence the
// Connection health card said is held on the cards by
// test/connection-words.test.tsx. An instant the views show as a day is noon on that
// day in the machine's time zone (noon), so the day shown is the one written
// in any zone: no one instant is the same day everywhere (Pacific/Kiritimati
// is 14 hours ahead of UTC).

/** Noon on `day` in the machine's time zone, as an ISO instant. */
const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
const noop = () => {};
const health = (cause: Cause, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  ...CAUSES[cause],
  cause,
  side: 'bank',
  last_ok_at: noon('2026-09-12'),
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
const NOW = Date.parse(noon('2026-10-08'));
/** Each connection as its card heads and says it: name, badge, then its status. */
const view = (rows: (HealthInstitution & { health: ConnectionHealth })[]) =>
  rows
    .map((row) => {
      const card = row as unknown as Institution;
      return (
        `<h2>${row.institution_name} ${statusBadge(card, NOW) ?? ''}</h2>` +
        renderToStaticMarkup(
          <ConnectionStatus
            inst={card}
            allRows={row.accounts as unknown as Account[]}
            place={null}
            fx={null}
            connecting={false}
            unallowed={false}
            lifecycle={{ busy: false, open: noop, stillOpen: async () => null, confirmEnd: async () => null, reopen: async () => {} }}
            onReconnect={noop}
            onRemove={noop}
            onManageAccounts={noop}
            onAllowTransactions={noop}
            onConnector={noop}
            now={NOW}
          />
        )
      );
    })
    .join('');
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b.trim() !== '');

describe('a connection’s status on its card', () => {
  test('every connection, with its state, last good sync, whose side, and the one action for it', () => {
    const rows = [
      inst('Chase', health('login', { side: 'you', code: 'ITEM_LOGIN_REQUIRED' })),
      inst('Amex', health('revoked', { side: 'you' })),
      inst('Ally', health('institution_down')),
      inst('Citi', health('ok', { side: 'none', last_ok_at: noon('2026-10-08') })),
    ];
    const html = view(rows);
    const t = text(html);
    expect(t).toContain('Chase Needs reconnecting');
    expect(t).toContain('Chase needs you to sign in again. Reconnect: it takes a minute.');
    expect(t).toContain('Last synced Sep 12 · On your side: your sign-in at Chase · Plaid code ITEM_LOGIN_REQUIRED');
    expect(t).toContain("Access to Amex was withdrawn, so this connection can't be repaired. Remove it, then connect Amex again: link its new accounts to the old ones and their history carries over.");
    expect(t).toContain("Ally isn't answering. Nothing to do: it usually recovers on its own.");
    expect(t).toContain("On Ally's side");
    // A working connection carries no badge, only when it last synced.
    expect(t).toContain('Citi Last synced Oct 8');
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
    expect(t).toContain(
      "1 account E used to report isn't in its latest answer. Until you say whether it closed, it is counted at its last known balance and no total is saved. If nobody answers, Nya assumes it closed after three days, and you can say otherwise."
    );
    expect(t).toContain("F Can't be repaired");
    expect(t).toContain("Plaid can no longer reach F, so reconnecting won't help.");
  });

  test('reconnect soon, with the date Plaid gave, or around the one it implied', () => {
    const exact = inst('Chase', health('consent_ending', { ends_at: noon('2026-10-15'), ends_estimated: false, last_ok_at: noon('2026-10-08') }));
    const about = inst('Amex', health('disconnect_pending', { ends_at: noon('2026-10-14'), ends_estimated: true, last_ok_at: noon('2026-10-08') }));
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
      unshown_accounts: [{ account_id: 'acct_savings', name: 'Savings', mask: '7777' }],
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
    // Held at last known balances until answered (#50), or not counted when too old.
    const held = inst('E', health('vanished'), {
      unconfirmed_missing: 2,
      accounts: [
        { name: 'Checking', mask: '4821', type: 'depository', balance: 5000, currency: 'USD', stale: true, held: { as_of: '2026-10-05' }, question: { kind: 'missing' } },
        { name: 'Old card', mask: null, type: 'credit', balance: null, currency: 'USD', stale: true, held: { as_of: null, too_old: '2026-08-01' }, question: { kind: 'missing' } },
      ],
    });
    expect(affectedText(held, (n) => `$${n}`)).toEqual(['Shown at last known balances from Oct 5, not measured now: Checking ••4821, together $5000 of net worth.', 'Not counted in net worth: Old card.']);
    // Answered Still open: what that holds, and for how long, not "if nobody answers".
    const answered = inst('E', health('vanished'), {
      unconfirmed_missing: 1,
      accounts: [{ name: 'Checking', mask: '4821', type: 'depository', balance: 5000, currency: 'USD', stale: true, held: { as_of: '2026-10-05' }, question: { kind: 'missing', still_open: true } }],
    });
    expect(healthText('E', answered.health, answered)).toBe(
      'You said the account E stopped reporting is still open. Until it comes back, it is counted at its last known balance and no total is saved, for two weeks from your answer at most; then Nya asks again. Reconnecting may bring it back.'
    );
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

  test('working connections say only when they last synced; unreadable health is said, never shown as working', () => {
    const ok = text(view([inst('Citi', health('ok')), inst('Ally', health('ok'))]));
    expect(ok).toContain('Citi Last synced Sep 12');
    expect(ok).not.toContain("couldn't be read");
    // Said for the whole tab, above the cards (components/Dashboard.tsx):
    // a card can't say what is missing from it.
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("Plaid&apos;s warnings and the last sync times couldn&apos;t be read just now, so a connection that is about to end may not say so here.");
    expect(dashboard).toContain("{`Some of what Nya keeps about ${unreadConnections === 1 ? 'one connection' : `${unreadConnections} connections`} couldn't be read, so a warning that one is about to end may be missing here.`}");
  });

  test('a connection whose records could not be read says a warning may be missing, in amber', () => {
    const html = view([inst('Citi', health('ok', { unread: true }))]);
    expect(html).toContain('<div class="notice caution">');
    expect(text(html)).toContain("Some of what Nya keeps about this connection couldn't be read, so a warning from Plaid may be missing here.");
  });

  // Blocking finding of the review: Plaid refusing Nya's own access token or
  // settings is what a PLAID_ENV or PLAID_SECRET mix-up looks like, for every
  // connection at once. Nothing there is the person's to do.
  test("a problem on Nya's side asks nothing of the person, and offers no Remove", () => {
    const html = view([
      inst('Chase', health('token', { side: 'nya', code: 'INVALID_ACCESS_TOKEN' })),
      inst('Amex', health('setup', { side: 'nya', code: 'INVALID_API_KEYS' })),
      inst('Ally', health('credentials', { side: 'nya' })),
    ]);
    const t = text(html);
    expect(t).toContain("Plaid doesn't accept the access Nya keeps for Chase, which usually means Nya's own Plaid settings changed. Nothing for you to do: whoever runs Nya puts them back, and the connection then works as before.");
    expect(t).toContain("Plaid refused Nya's own settings, so it can't reach Amex just now. Nothing for you to do");
    expect(t).toContain("On Nya's side · Plaid code INVALID_API_KEYS");
    expect(t).toContain("Nya can't read the sign-in it keeps for Ally. Nothing for you to do: whoever runs Nya restores its encryption keys");
    expect(t).toContain("On Nya's side");
    expect(t).not.toMatch(/remove|connect (Chase|Amex|Ally) again/i);
    expect(buttons(html)).toEqual([]);
    expect(badgeOf(health('token', { side: 'nya' }))).toBe('Not updating');
  });

  test('each Reconnect names its institution for a screen reader', () => {
    const html = view([inst('Chase', health('login')), inst('Amex', health('locked'))]);
    expect(html).toContain('aria-label="Reconnect Chase"');
    expect(html).toContain('aria-label="Reconnect Amex"');
  });

  test('a last sync never recorded says so', () => {
    expect(lastSyncedText(health('login', { last_ok_at: null }))).toBe('Last synced: not recorded yet');
    expect(sideText('Chase', health('unknown', { side: 'unknown' }))).toBe('Whose side: not known');
    expect(sideText('Chase', health('credentials', { side: 'nya' }))).toBe("On Nya's side");
    expect(healthText('Chase', health('unknown', { code: 'NEW_CODE' }), {})).toBe("Chase couldn't be updated (Plaid: NEW_CODE). This usually clears on its own.");
  });
});

describe('a connection Plaid says will end, on its card', () => {
  const now = NOW;
  test('the badge with the date, the sentence, and one Reconnect, only while Plaid says it will end', () => {
    const soon = inst('Chase', health('consent_ending', { ends_at: noon('2026-10-15') }));
    const html = view([soon]);
    expect(text(html)).toContain('Chase Reconnect soon · Oct 15');
    expect(text(html)).toContain('Plaid says this connection ends on Oct 15. Reconnect before then to keep it syncing.');
    const about = inst('Amex', health('disconnect_pending', { ends_at: noon('2026-10-15'), ends_estimated: true }));
    expect(text(view([about]))).toContain('Amex Reconnect soon · about Oct 15');
    expect(text(view([about]))).toContain('Plaid says this connection ends around Oct 15.');
    expect(buttons(html)).toEqual(['Reconnect']);
    expect(html).toContain('aria-label="Reconnect Chase"');
    // Amber: nothing is broken yet.
    expect(html).toContain('<div class="notice caution">');
    for (const other of [health('ok'), health('login')]) expect(text(view([inst('X', other)]))).not.toContain('Plaid says this connection ends');
    // Accounts typed by hand have no connection to end.
    expect(statusBadge({ ...soon, manual: true } as unknown as Institution, now)).toBeNull();
  });

  // Review nit: a consent end already past (on a connection that still
  // answered, or in a payload made before it) said "Reconnect before then".
  test('past its date, it says it was due then, and to reconnect now', () => {
    const past = health('consent_ending', { ends_at: noon('2026-10-05') });
    expect(endsText(past, now)).toBe('Plaid said this connection would end on Oct 5');
    expect(healthText('Chase', past, {}, now)).toBe('Plaid said this connection would end on Oct 5. Reconnect now to keep it syncing: it takes a minute.');
    expect(badgeOf(past, now)).toBe('Reconnect now');
    const note = text(view([inst('Chase', past)]));
    expect(note).toContain('Chase Reconnect now');
    expect(note).toContain('Plaid said this connection would end on Oct 5. Reconnect now to keep it syncing.');
    expect(note).not.toContain('before then');
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
      '1 account at Ally stopped reporting, so this total is short by it · history is paused until you answer',
    ]);
    // Held at its last known balance until answered (#50).
    const ally = (accounts: { balance: number | null; held?: unknown }[]) => [{ institution_name: 'Ally', error: null, needs_reauth: false, unconfirmed_missing: accounts.length, accounts }];
    expect(totalNotes(ally([{ balance: 900, held: { as_of: '2026-10-05' } }]), day)).toEqual([
      '1 account at Ally stopped reporting; it is counted at its last known balance until you say whether it closed · history is paused until you answer',
    ]);
    expect(totalNotes(ally([{ balance: 900, held: {} }, { balance: null, held: {} }]), day)).toEqual([
      '2 accounts at Ally stopped reporting, so this total is short by 1 of them · history is paused until you answer',
    ]);
    // Answered Still open: the hold waits for the account, two weeks at most.
    expect(totalNotes([{ ...ally([])[0], unconfirmed_missing: 1, accounts: [{ balance: 900, held: {}, question: { still_open: true } }] }], day)).toEqual([
      '1 account at Ally stopped reporting; you said it is still open, so it is counted at its last known balance · history is paused until it comes back, two weeks at most',
    ]);
    expect(totalNotes([{ institution_name: 'Ally', error: null, needs_reauth: false }], day)).toEqual([]);
  });

  test('a bank SimpleFIN feeds, held for a card or loan reported as money held, says it waits for the person, not that it failed', () => {
    const held = { institution_name: 'My Bank', ...base, stale_as_of: '2026-09-12', health: { last_ok_at: null, detail: { issue: 'sign' } } };
    expect(totalNotes([held], day)).toEqual(['My Bank has a card or loan waiting for your answer; its balances are from snap 2026-09-12']);
  });
});

describe('the Home alert a few days before a connection ends', () => {
  const now = new Date('2026-10-08T12:00:00');
  const soon = (days: number, over = {}) => ({ item_id: `i${days}`, institution_name: `Bank ${days}`, ends_at: new Date(2026, 9, 8 + days, 12).toISOString(), ...over });

  // Every one since rollout phase 4b: each is its own row in Needs attention.
  test('within three days only, soonest first, every one', () => {
    expect(reconnectAlerts([soon(7), soon(4)], now)).toEqual([]);
    expect(reconnectAlerts([soon(3), soon(1), soon(0)], now).map((a) => a.text)).toEqual([
      'Reconnect Bank 0: Plaid says its connection ends today',
      'Reconnect Bank 1: Plaid says its connection ends tomorrow',
      'Reconnect Bank 3: Plaid says its connection ends in 3 days',
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
  const day = (iso: string) => localDate(new Date(iso)).slice(5);
  const stopped = [{ institution_name: 'Chase', last_ok_at: noon('2026-09-12') }];

  test('a connection that stopped leaves the months after its last sync in question, not those before', () => {
    expect(monthGapNotes('2026-08', [], stopped, day)).toEqual([]);
    expect(monthGapNotes('2026-09', [], stopped, day)).toEqual(["Chase hasn't synced since 09-12, so this month may be missing some of its transactions."]);
    expect(monthGapNotes('2026-10', [], stopped, day)).toHaveLength(1);
    // Never recorded: any month could be short.
    expect(monthGapNotes('2025-01', [], [{ institution_name: 'Amex', last_ok_at: null }], day)).toEqual(["Amex isn't syncing, so this month may be missing some of its transactions."]);
    // December rolls into January.
    expect(monthGaps('2025-12', [], [{ institution_name: 'C', last_ok_at: noon('2025-12-31') }]).stopped).toHaveLength(1);
    expect(monthGaps('2025-12', [], [{ institution_name: 'C', last_ok_at: noon('2026-01-02') }]).stopped).toHaveLength(0);
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
        // Accounts SimpleFIN feeds are kept like manual ones, but have a connection that can stop.
        { institution_name: 'H', manual: true, connector: 'simplefin', health: h('needs_reauth') },
        { institution_name: 'I', manual: true, connector: 'simplefin', health: h('healthy') },
      ]).map((s) => s.institution_name)
    ).toEqual(['A', 'B', 'H']);
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe("the Budgets tab's month says so too", () => {
  test('a gap in this month is said in the month’s notice, a caution, only when there are budgets to total', async () => {
    const { default: BudgetsTab } = await import('@/components/BudgetsTab');
    const props = { txns: [], goals: [], accounts: [], loading: false, onSave: async () => true, onSaveGoals: async () => true };
    const missing = [{ institution_name: 'Chase', coverage: 'missing' as const }];
    const { categoriesFor } = await import('./category-fixture');
    const some = categoriesFor({ groceries: 400 });
    const none = categoriesFor();
    const withBudget = text(renderToStaticMarkup(<BudgetsTab {...props} taxonomy={some.taxonomy} budgets={some.budgets} incomplete={missing} />));
    expect(withBudget).toContain("Caution: Doesn't include Chase: its transactions couldn't be loaded, so this month may be incomplete.");
    expect(text(renderToStaticMarkup(<BudgetsTab {...props} taxonomy={none.taxonomy} budgets={none.budgets} incomplete={missing} />))).not.toContain("Doesn't include Chase");
    expect(text(renderToStaticMarkup(<BudgetsTab {...props} taxonomy={some.taxonomy} budgets={some.budgets} />))).not.toContain('may be incomplete');
  });
});
