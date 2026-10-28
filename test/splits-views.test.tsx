import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
import SplitSheet, { leftToSplit, partUnits, startingParts } from '@/components/SplitSheet';
import GroupSheet, { groupCandidates, groupCategoryFor, groupStatus } from '@/components/GroupSheet';
import { entryLabel, entryNotice, groupGoneText, heldInGroupAs, splitActions, splitKeptUnder } from '@/components/SplitRows';
import { disconnectSplitsText } from '@/components/DisconnectSplitsNote';
import { pastPayeeRows } from '@/components/ManualTxnSheet';
import { splitChangedText } from '@/components/SplitChangedNote';
import { searchEntries, searchRows } from '@/components/txn-search';
import { expandSplitsAndGroups, bankRows } from '@/lib/split-rows';
import { indexTaxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';
import Insights from '@/components/Insights';
import { budgetTexts } from './home-attention';
import MonthFlowChart from '@/components/MonthFlowChart';
import { trailingFlows } from '@/lib/fire/inputs';
import { calendarMonth } from '@/lib/calendar';
import { appendixStatus } from '@/lib/report/words';

// Splits and groups on the Activity tab (#39): a split transaction listed
// once, as the bank has it, its parts nested under it with their categories
// and amounts, the day's figure counting the parts; a group's row with its
// transactions under it; the search finding both; the split sheet's running
// remainder, its parts adding up before it saves; and what the group sheet
// offers to add.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household', 'auto', 'restaurants'] });
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const today = localDate();

const txn = (id: string, over: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  date: today,
  name: id,
  amount: 10,
  pending: false,
  account_name: 'Card',
  institution_name: 'Chase',
  category: 'general merchandise',
  category_id: cat('general merchandise'),
  category_name: 'general merchandise',
  category_kind: 'expense',
  iso_currency_code: 'USD',
  vendor_key: `v:${id}`,
  logo_url: null,
  category_icon_url: null,
  subcategory: null,
  category_confidence: null,
  transaction_code: null,
  payment_channel: null,
  datetime: null,
  website: null,
  check_number: null,
  account_owner: null,
  city: null,
  region: null,
  counterparty: null,
  payment_processor: null,
  payment_reference: null,
  ...over,
});

const record = (amount: number, parts: [string, number, string?][]) => ({
  version: 1 as const,
  amount,
  currency: 'USD',
  parts: parts.map(([c, a, note], i) => ({ id: `p${i}`, amount: a, category_id: cat(c), ...(note ? { note } : {}) })),
  updated_at: '2026-10-01T00:00:00.000Z',
});

/** The rows as the bank and the person have them. */
const raw = (): Txn[] => [
  txn('Costco', { amount: 150, note: 'monthly run' }),
  txn('Bistro', { amount: 120, date: today }),
  txn('Venmo from Sam', { amount: -60, date: today, category: 'transfer in', category_id: cat('transfer in'), category_name: 'transfer in', category_kind: 'transfer' }),
  txn('Coffee', { amount: 4.5 }),
];

/** The rows as the server sends them: Costco split three ways, a dinner and
 *  its payback grouped. */
function served({ grouped = true }: { grouped?: boolean } = {}): Txn[] {
  const rows = raw();
  return expandSplitsAndGroups(rows as any, {
    splits: new Map([['Costco', record(150, [['groceries', 100.01, 'food'], ['household', 30], ['auto', 19.99]])]]),
    splitsUnknown: new Set(),
    groups: new Map(
      grouped
        ? [
            [
              'g1',
              { version: 1, name: 'Dinner with Sam', category_id: cat('restaurants'), members: ['Bistro', 'Venmo from Sam'], date: today, currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
            ],
          ]
        : []
    ),
    groupsUnknown: 0,
    ix,
  }).rows as unknown as Txn[];
}

const list = (rows: Txn[]) =>
  text(renderToStaticMarkup(<MonthBreakdown txns={rows} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} />));

// What a transaction's sheet offers for its split or group: its rows' titles, or why none (splitActions).
const actionWords = (t: Txn) => {
  const a = splitActions(t, { onSplit: () => {}, onGroup: () => {}, onUngroup: () => {} });
  return [...a.rows.map((r) => r.title), ...(a.said ? [a.said] : [])].join(' ');
};

describe('the Activity tab’s list', () => {
  test('a split transaction is listed once, its parts under it; a group’s row with its transactions under it', () => {
    const page = list(served());
    expect(page).toContain('Costco Split into 3 · Card Note -$150.00');
    expect(page.match(/Costco/g)).toHaveLength(1);
    expect(page).toContain('Groceries food -$100.01 Household -$30.00 Auto -$19.99');
    expect(page).toContain('Dinner with Sam Group of 2 · Restaurants · Card -$60.00 Bistro');
    // A group's transaction: its day and its account, by its name.
    expect(page).toMatch(/Bistro [A-Z][a-z]{2} \d{1,2} · Card /);
    expect(page).toContain('Venmo from Sam');
    // The day's figure counts the parts and the net: 150 + 60 + 4.50 out.
    expect(page).toContain('-$214.50');
  });

  test('a split transaction left out of budgets is one transaction left out, however many parts it has', () => {
    const rows = served().map((t) => (t.split_of ? { ...t, excluded: true as const } : t));
    expect(list(rows)).toContain('and 1 transaction you left out');
  });

  test('a search that finds one part of a split transaction keeps all of them, so its split is edited from every part', () => {
    const rows = served();
    const kept = searchEntries(rows, { query: 'groceries', tag: '' }, []);
    expect(kept.map((t) => t.transaction_id)).toEqual(rows.filter((t) => t.split_of === 'Costco').map((t) => t.transaction_id));
    const whole = bankRows(kept, { groups: 'keep' })[0] as Txn;
    expect(entryLabel(whole)).toBe('Split into 3');
    expect(startingParts(whole, taxonomy.uncategorized).map((d) => [d.amount, d.note])).toEqual([
      ['100.01', 'food'],
      ['30.00', ''],
      ['19.99', ''],
    ]);
    // Nothing found, nothing kept; a row not split, alone.
    expect(searchEntries(rows, { query: 'nothing like it', tag: '' }, [])).toEqual([]);
    expect(searchEntries(rows, { query: 'coffee', tag: '' }, []).map((t) => t.name)).toEqual(['Coffee']);
  });

  test('the list counts transactions, not rows: a split one is one, a group as many as it holds', () => {
    expect(list(served())).toContain('Transactions 4 ');
  });

  test('the search finds a part by its transaction’s note, and a group by one of its transactions', () => {
    const rows = served();
    expect(searchRows(rows, { query: 'monthly run', tag: '' }, []).map((t) => t.split_of)).toEqual(['Costco', 'Costco', 'Costco']);
    expect(searchRows(rows, { query: 'venmo', tag: '' }, []).map((t) => t.name)).toEqual(['Dinner with Sam']);
  });

  test('what a split or a group says in place of its category, and when something changed', () => {
    const whole = bankRows(served(), { groups: 'keep' });
    expect(whole.map((t) => entryLabel(t))).toEqual(['Split into 3', null, 'Group of 2']);
    const changed = expandSplitsAndGroups([txn('Costco', { amount: 160 })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    expect(entryNotice(bankRows(changed)[0] as Txn)).toBe('The bank changed this amount since you split it.');
    // The difference the bank made isn't one of the parts the person made.
    expect(entryLabel(bankRows(changed)[0] as Txn)).toBe('Split into 2');
    // One entered by hand changes when it is edited, not by the bank.
    const edited = expandSplitsAndGroups([txn('Costco', { amount: 160, source: 'manual' })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    expect(entryNotice(bankRows(edited)[0] as Txn)).toBe('This amount changed since you split it.');
    expect(entryNotice(txn('x', { split_unread: true }))).toBe('How you split this couldn’t be read, so it shows whole.');
    // One of a group that no longer applies says which, and offers to ungroup it.
    const stale = txn('x', { group_unapplied: { id: 'g9', name: 'Trip' } });
    expect(entryNotice(stale)).toBe('It is in the group “Trip”, whose transactions are in more than one currency now, so it counts on its own. Ungroup it to split this or group it again.');
    expect(actionWords(stale)).toBe('Ungroup “Trip”');
    expect(entryNotice(txn('x', { group_members: [txn('a')], group_removed: 1 }))).toContain('1 of its transactions isn’t here');
  });

  test('a group says why one of its transactions isn’t counted in it, where Nya knows: pending at the bank, or in another group', () => {
    const group = (over: Partial<Txn>) => txn('group:g1', { group_members: [txn('a'), txn('b')], ...over });
    expect(entryNotice(group({ group_missing: 1, group_away: [{ why: 'pending' }] }))).toBe('1 of its transactions is pending at the bank, so it counts on its own until it posts.');
    expect(entryNotice(group({ group_missing: 1, group_away: [{ why: 'grouped', group: 'Errand' }] }))).toBe('1 of its transactions counts in the group “Errand” instead.');
    // With others gone for a reason it can't tell, it says those after.
    expect(entryNotice(group({ group_missing: 3, group_removed: 1, group_away: [{ why: 'pending' }, { why: 'pending' }, { why: 'grouped', group: 'Errand' }] }))).toBe(
      '2 of its transactions are pending at the bank, so they count on their own until they post. 1 of its transactions counts in the group “Errand” instead. 1 more isn’t here (the bank removed it, its account is hidden or ended, or it couldn’t be loaded), so it isn’t counted.'
    );
    // Without a reason it knows, as it always said.
    expect(entryNotice(group({ group_missing: 2 }))).toBe('2 of its transactions aren’t here (the bank removed them, their account is hidden or ended, or they couldn’t be loaded), so they aren’t counted.');

    // The group sheet, which lists the ones counted, says it of the rest.
    expect(groupGoneText({ group_missing: 2, group_away: [{ why: 'pending' }, { why: 'grouped', group: 'Errand' }] }, 'sheet')).toBe(
      '1 more transaction is in it, and is pending at the bank, so it counts on its own until it posts. 1 more transaction is in it, and counts in the group “Errand” instead.'
    );
    const sheet = text(
      renderToStaticMarkup(<GroupSheet start={null} group={group({ group_missing: 2, group_away: [{ why: 'pending' }] })} txns={[]} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />)
    );
    expect(sheet).toContain(
      '1 more transaction is in it, and is pending at the bank, so it counts on its own until it posts. 1 more transaction was in it and isn’t here: the bank removed it, its account is hidden or ended, or it couldn’t be loaded.'
    );
    expect(groupGoneText({}, 'sheet')).toBeNull();
  });

  test('a transaction of a group counted before the year shown is listed, saying so, and counted nowhere here', () => {
    const outside = { id: 'g7', name: 'Trip', date: '2025-09-20', category_id: cat('restaurants'), here: 1, missing: 1 };
    const rows = [txn('Venmo from Sam', { amount: -60, group_id: 'g7', group_outside: outside }), txn('Coffee', { amount: 4.5 })];
    const page = list(rows);
    expect(page).toContain('It is in the group “Trip”, which counts on');
    expect(page).toContain('before the transactions shown here begin, so it isn’t counted here.');
    // Its amount dimmed, as an excluded one's is; the coffee's not.
    const html = renderToStaticMarkup(<MonthBreakdown txns={rows} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} onSplitsChanged={() => {}} />);
    expect(html).toMatch(/<span class="list-row-value money txn-amount inflow excluded">[^<]*60\.00<\/span>/);
    expect(html).toMatch(/<span class="list-row-value money txn-amount">[^<]*4\.50<\/span>/);
    // The day's figure is the coffee's alone; the month's money in, nothing.
    expect(page).toContain('-$4.50');
    expect(page).not.toContain('+$55.50');
    expect(actionWords(rows[0])).toBe('Ungroup “Trip”');
    // Nor offered to join another group.
    expect(groupCandidates(rows, { currency: 'USD', near: today, exclude: new Set(), query: '' }).map((t) => t.name)).toEqual(['Coffee']);
    // The calendar lists it, outside the day's figure, and the Plan leaves it out.
    const day = calendarMonth({ month: today.slice(0, 7), today, txns: rows, series: [], planned: [], currency: 'USD' }).days.get(today)!;
    expect(day.entries.find((e) => e.name === 'Venmo from Sam')).toMatchObject({ uncounted: true, group: { name: 'Trip', date: '2025-09-20' } });
    expect(day.posted).toBe(-4.5);
    const rent = txn('Rent', { amount: 1000, date: new Date(Date.parse(`${today}T12:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10) });
    const plan = trailingFlows([...rows, rent] as any, today)!;
    expect([plan.income, plan.count]).toEqual([0, 2]);
    // A report's appendix says why it isn't counted.
    expect(appendixStatus({ not_counted: 'group', pending: false, exclusion_unknown: false, currency: 'USD' })).toBe('Not counted: in a group counted before this period');
  });

  test('nothing is offered to split or group without somewhere to save it', () => {
    const page = renderToStaticMarkup(<MonthBreakdown txns={served()} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />);
    expect(page).not.toContain('Split transaction');
    expect(page).not.toContain('Group transactions');
  });
});

describe('what else the dashboard counts from the same rows', () => {
  test('Home’s budget alerts meter the parts: the groceries in a Costco run, not the whole charge as general merchandise', () => {
    const budgets = { categories: { [cat('groceries')]: { amount: 100 }, [cat('general merchandise')]: { amount: 100 } }, groups: {} };
    const home = (rows: Txn[]) => budgetTexts({ txns: rows, budgets, taxonomy });
    expect(home(raw())).toContain('Over your general merchandise budget');
    const split = home(served());
    expect(split).toContain('Over your groceries budget: $100.01 of $100.00');
    expect(split).not.toContain('general merchandise budget');
    // The biggest purchase is the whole charge, as the bank made it, never its largest part.
    expect(text(renderToStaticMarkup(<Insights txns={served()} accounts={[]} />))).toContain('Biggest purchase this month: Costco, $150.00');
  });

  test('the Budgets calendar lists a split charge once, whole, and counts its parts; a group as its net', () => {
    const day = (rows: Txn[]) => calendarMonth({ month: today.slice(0, 7), today, txns: rows, series: [], planned: [], currency: 'USD' }).days.get(today)!;
    const shown = day(served());
    expect(shown.entries.filter((e) => e.kind === 'posted').map((e) => [e.name, e.amount, e.parts ?? null, e.counted ?? null])).toEqual([
      ['Costco', -150, 3, null],
      ['Coffee', -4.5, null, null],
      ['Dinner with Sam', -60, null, null],
    ]);
    expect(shown.posted).toBe(-214.5);
    // A part left out on its own: listed whole, the day's figure without it.
    const partOut = served().map((t) => (t.transaction_id === 'split:p2' ? { ...t, excluded: true as const, split_excluded: true as const } : t));
    const out = day(partOut);
    expect(out.entries.find((e) => e.name === 'Costco')).toMatchObject({ amount: -150, parts: 3, counted: -130.01 });
    expect(out.posted).toBe(-194.51);
    // The whole transaction excluded: listed, excluded, not in the figure.
    const all = day(served().map((t) => (t.split_of ? { ...t, excluded: true as const } : t)));
    expect(all.entries.find((e) => e.name === 'Costco')).toMatchObject({ excluded: true, uncounted: true });
    expect(all.posted).toBe(-64.5);
  });

  test('the month’s flow chart: a split moves nothing, a group counts its net', () => {
    const flow = (rows: Txn[]) => renderToStaticMarkup(<MonthFlowChart txns={rows} month={today.slice(0, 7)} />).match(/aria-label="([^"]*)"/)![1];
    expect(flow(raw())).toContain('Income $0.00, spending $274.50.');
    expect(flow(served({ grouped: false }))).toContain('Income $0.00, spending $274.50.');
    expect(flow(served())).toContain('Income $0.00, spending $214.50.');
  });

  test('the Plan’s year of spending: a split moves nothing, a group counts its net', () => {
    const before = new Date(Date.parse(`${today}T12:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
    const rent = txn('Rent', { amount: 1000, date: before });
    const whole = trailingFlows([...raw(), rent] as any, today)!;
    expect(trailingFlows([...served({ grouped: false }), rent] as any, today)!.spending).toBeCloseTo(whole.spending, 8);
    // The payback was a transfer in on its own; in the group it takes $60 off
    // the dinner. Both are scaled up to a year alike.
    const grouped = trailingFlows([...served(), rent] as any, today)!;
    expect(grouped.spending / whole.spending).toBeCloseTo((1000 + 150 + 60 + 4.5) / (1000 + 150 + 120 + 4.5), 10);
    expect([whole.income, grouped.income]).toEqual([0, 0]);
    // Counted as transactions: Costco is one, split or not; the payback counts through its group.
    expect(whole.count).toBe(4);
    expect(trailingFlows([...served({ grouped: false }), rent] as any, today)!.count).toBe(4);
    expect(grouped.count).toBe(5);
    const excluded = served({ grouped: false }).map((t) => (t.split_of ? { ...t, excluded: true as const } : t));
    expect(trailingFlows([...excluded, rent] as any, today)!.excludedCount).toBe(1);
    // A refund split in two is one refund, named whole.
    const refund = expandSplitsAndGroups([txn('Return', { amount: -40 })] as any, {
      splits: new Map([
        [
          'Return',
          {
            version: 1 as const,
            amount: -40,
            currency: 'USD',
            parts: [
              { id: 'r1', amount: -25, category_id: cat('general merchandise') },
              { id: 'r2', amount: -15, category_id: cat('food and drink') },
            ],
            updated_at: '2026-10-01T00:00:00.000Z',
          },
        ],
      ]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows;
    expect(trailingFlows([...refund, rent] as any, today)!.largestRefund).toEqual({ amount: 40, date: today, name: 'Return' });
  });
});

describe('the Budgets tab', () => {
  test('says when a split transaction’s amount changed since it was split, as its parts count as split until it is edited', () => {
    const changed = expandSplitsAndGroups([txn('Costco', { amount: 120 })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    expect(splitChangedText(changed, today.slice(0, 7))).toBe(
      'A split transaction’s amount changed since it was split. Its parts count as you split them, and the difference on its own, until you edit the split on the Activity tab.'
    );
    expect(splitChangedText(changed, '2020-01')).toBeNull();
    expect(splitChangedText(served(), today.slice(0, 7))).toBeNull();
    const budgets = readFileSync(new URL('../components/BudgetsTab.tsx', import.meta.url), 'utf8');
    // Among the Spent card's notes, for the month shown (rollout 6a2).
    expect(budgets).toContain('const splitChanged = hasTotal && txns ? splitChangedText(txns, shownMonth) : null;');
    expect(budgets).toContain("if (splitChanged) spentNotes.push({ key: 'split-changed', severity: 'info', summary: 'split amounts changed', body: splitChanged });");
  });
});

describe('the quick-add form', () => {
  test('suggests payees from transactions as entered: a split one whole, under its own category, and never a group’s name', () => {
    const typed = expandSplitsAndGroups(
      [
        txn('Farmers market', { source: 'manual', amount: 30, category: 'groceries', category_id: cat('groceries'), category_name: 'groceries' }),
        txn('Bake sale', { source: 'manual', amount: 12 }),
        txn('Cash from Sam', { source: 'manual', amount: -12 }),
      ] as any,
      {
        splits: new Map([['Farmers market', record(30, [['household', 10], ['auto', 20]])]]),
        splitsUnknown: new Set(),
        groups: new Map([
          ['g2', { version: 1, name: 'Bake sale, paid back', category_id: cat('restaurants'), members: ['Bake sale', 'Cash from Sam'], date: today, currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
        ]),
        groupsUnknown: 0,
        ix,
      }
    ).rows as unknown as Txn[];
    const rows = pastPayeeRows(typed);
    expect(rows.map((t) => t.name).sort()).toEqual(['Bake sale', 'Cash from Sam', 'Farmers market']);
    expect(rows.find((t) => t.name === 'Farmers market')?.category_id).toBe(cat('groceries'));
  });
});

describe('the disconnect confirmation', () => {
  test('says how many of its transactions lose their splits and groups, which adding it back doesn’t bring back', () => {
    expect(disconnectSplitsText({ split: 0, grouped: 0 })).toBeNull();
    expect(disconnectSplitsText({ split: 1, grouped: 0 })).toBe(
      'You split 1 of its transactions. Disconnecting removes that split, and adding it back later doesn’t bring it back.'
    );
    expect(disconnectSplitsText({ split: 12, grouped: 0 })).toBe(
      'You split 12 of its transactions. Disconnecting removes those splits, and adding it back later doesn’t bring them back.'
    );
    expect(disconnectSplitsText({ split: 0, grouped: 2 })).toBe(
      '2 of its transactions are in groups. Disconnecting takes them out, and adding it back later doesn’t put them back.'
    );
    expect(disconnectSplitsText({ split: 3, grouped: 1 })).toBe(
      'You split 3 of its transactions, and 1 is in a group. Disconnecting removes the splits and takes the grouped one out of its group, and adding it back later doesn’t bring either back.'
    );
    // Counts that couldn't be read: said without numbers, never as none.
    expect(disconnectSplitsText(null)).toBe('Splits of its transactions, and their places in groups, go with it, and adding it back later doesn’t bring them back.');
  });

  test('the dashboard asks for the connection being disconnected', () => {
    const dashboard = readFileSync(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8');
    expect(dashboard).toContain('<DisconnectSplitsNote itemId={shownDisconnectTarget.item_id} />');
  });
});

describe('the split sheet', () => {
  test('starts from the split’s own parts, what the bank changed since left to split', () => {
    const rows = expandSplitsAndGroups([txn('Costco', { amount: 160 })] as any, {
      splits: new Map([['Costco', record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    const whole = bankRows(rows)[0] as Txn;
    const drafts = startingParts(whole, taxonomy.uncategorized);
    expect(drafts.map((d) => [d.id, d.amount, d.category_id])).toEqual([
      ['p0', '100.00', cat('groceries')],
      ['p1', '50.00', cat('household')],
    ]);
    expect(leftToSplit(whole.amount, drafts, 'USD').left).toBe(1000);
    const html = renderToStaticMarkup(<SplitSheet t={whole} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    // Each part's fields and its button say which part they are.
    for (const label of ['Part 1 amount', 'Part 2 category', 'Put the rest in part 1', 'Put the rest in part 2']) expect(html).toContain(`aria-label="${label}"`);
    const page = text(html);
    expect(page).toContain('Edit split');
    expect(page).toContain('The bank changed this amount from $150.00 to $160.00 since you split it.');
    expect(page).toContain('$10.00 left to split');
    expect(page).toContain('Unsplit');
  });

  test('a row imported from a file, split at the amount of the bank’s transaction that stood for it, says so once none does, never that its amount changed', () => {
    const id = 'imported-txn:0b7e1f5c-1d2e-4f3a-9b8c-7d6e5f4a3b2c';
    const rows = expandSplitsAndGroups([txn(id, { amount: 150, source: 'import:ofx' })] as any, {
      splits: new Map([[id, record(160.5, [['groceries', 110.5], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map(),
      groupsUnknown: 0,
      ix,
    }).rows as unknown as Txn[];
    const whole = bankRows(rows)[0] as Txn;
    expect(entryNotice(whole)).toBe(
      'You split this at the amount of the bank’s transaction that stood for it. None does now, so it counts at your file’s amount, with the difference as a part of its own until you edit the split.'
    );
    const page = text(renderToStaticMarkup(<SplitSheet t={whole} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(page).toContain('You split this at $160.50, the amount of the bank’s transaction that stood for it. None does now, so it counts at your file’s $150.00. Place the difference below.');
    expect(page).not.toContain('This amount changed');
  });

  test('a part is read in the currency’s own units: eight places for one without an ISO code, whole yen, cents', () => {
    expect(partUnits('0.00000001', 'BTC')).toBe(1);
    expect(partUnits('0.000000001', 'BTC')).toBeNull();
    expect(partUnits('0.020123450', 'BTC')).toBe(2012345);
    expect(partUnits('1000', 'JPY')).toBe(1000);
    expect(partUnits('1000.00', 'JPY')).toBe(1000);
    expect(partUnits('1000.5', 'JPY')).toBeNull();
    expect(partUnits('49,99', 'USD')).toBe(4999);
    expect(partUnits('1,234.56', 'USD')).toBe(123456);
    expect(partUnits('1.234', 'USD')).toBeNull();
    expect(partUnits('0', 'USD')).toBeNull();
    expect(partUnits('ten', 'USD')).toBeNull();
    // A 0.05012345 BTC transaction splits to the last place, and Put the rest here places it.
    expect(leftToSplit(0.05012345, [{ amount: '0.03' }, { amount: '' }], 'BTC').left).toBe(2012345);
    const done = leftToSplit(0.05012345, [{ amount: '0.03' }, { amount: '0.02012345' }], 'BTC');
    expect(done.left).toBe(0);
    expect(done.parsed).toEqual([0.03, 0.02012345]);
    expect(leftToSplit(0.0042, [{ amount: '0.0021' }, { amount: '0.0021' }], 'ETH').left).toBe(0);
  });

  test('a new split starts with two empty parts under the transaction’s category, and nothing saves until they add up', () => {
    const t = txn('Costco', { amount: 150 });
    const drafts = startingParts(t, taxonomy.uncategorized);
    expect(drafts.map((d) => [d.amount, d.category_id])).toEqual([
      ['', cat('general merchandise')],
      ['', cat('general merchandise')],
    ]);
    expect(leftToSplit(150, [{ amount: '100.01' }, { amount: '49,99' }], 'USD').left).toBe(0);
    expect(leftToSplit(150, [{ amount: '100' }, { amount: '' }], 'USD').left).toBe(5000);
    expect(leftToSplit(-40, [{ amount: '30' }, { amount: '20' }], 'USD').left).toBe(-1000);
    expect(leftToSplit(3000, [{ amount: '1000' }, { amount: '2000' }], 'JPY').left).toBe(0);
    const page = renderToStaticMarkup(<SplitSheet t={t} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    expect(text(page)).toContain('Split transaction');
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Save split<\/button>/);
  });
});

describe('a bank row standing for a row imported from a file (#52)', () => {
  test('is split and grouped as that row was, and an edit names that row, where they are kept', () => {
    const imported = 'imported-txn:0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
    const lunch = 'imported-txn:1c0d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e';
    const rows = expandSplitsAndGroups(raw() as any, {
      splits: new Map([[imported, record(150, [['groceries', 100], ['household', 50]])]]),
      splitsUnknown: new Set(),
      groups: new Map([
        [
          'g1',
          { version: 1, name: 'Dinner with Sam', category_id: cat('restaurants'), members: [lunch, 'Venmo from Sam'], date: today, currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' },
        ],
      ]),
      groupsUnknown: 0,
      ix,
      stands: new Map([
        ['Costco', [imported]],
        ['Bistro', [lunch]],
      ]),
    }).rows as unknown as Txn[];
    const entries = bankRows(rows, { groups: 'keep' }) as Txn[];
    const costco = entries.find((t) => t.transaction_id === 'Costco')!;
    expect([entryLabel(costco), splitKeptUnder(costco)]).toEqual(['Split into 2', imported]);
    const group = entries.find((t) => t.group_members)!;
    expect(group.group_members!.map(heldInGroupAs)).toEqual([lunch, 'Venmo from Sam']);
    // Its own split, and its own place: named by its own id.
    const own = bankRows(served()) as Txn[];
    expect(splitKeptUnder(own.find((t) => t.transaction_id === 'Costco')!)).toBe('Costco');
    expect(own.filter((t) => t.group_id).map(heldInGroupAs)).toEqual(['Bistro', 'Venmo from Sam']);
    // The list shows it as any split transaction and group.
    const page = list(rows);
    expect(page).toContain('Split into 2');
    expect(page).toContain('Group of 2');
  });
});

describe('the group sheet', () => {
  test('offers posted transactions in the same currency, as the bank has them, nearest first', () => {
    const rows = [
      ...served(),
      txn('Pending', { pending: true }),
      txn('Paris', { iso_currency_code: 'EUR' }),
      txn('Far', { date: '2025-01-01' }),
      txn('Near', { date: today }),
    ];
    const offered = groupCandidates(rows, { currency: 'USD', near: today, exclude: new Set(['Coffee']), query: '' });
    // Not the pending one, the one in euros, the one already in, Costco's
    // parts or the group's row: nearest in date first.
    expect(offered.map((t) => t.name)).toEqual(['Near', 'Far']);
    expect(groupCandidates(rows, { currency: 'USD', near: today, exclude: new Set(), query: 'far' }).map((t) => t.name)).toEqual(['Far']);
  });

  test('opened on a transaction, it starts a group with it; on a group, it edits it and offers to ungroup', () => {
    const rows = served();
    const start = text(renderToStaticMarkup(<GroupSheet start={txn('Coffee', { amount: 4.5 })} group={null} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(start).toContain('Group transactions');
    expect(start).toContain('Choose at least 2 transactions.');
    const group = rows.find((t) => t.group_members)!;
    const edit = text(renderToStaticMarkup(<GroupSheet start={null} group={group} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />));
    expect(edit).toContain('Edit group');
    expect(edit).toContain('2 transactions, counted as $60.00 out under Restaurants.');
    expect(edit).toContain('Ungroup');
  });

  test('a new group is filed with the dinner, never under the payback’s transfer category, until the person picks one', () => {
    const [dinner, payback] = [raw()[1], raw()[2]];
    expect(payback.category_kind).toBe('transfer');
    // Opened from the payback, the newest, which a bank files as a transfer in.
    expect(groupCategoryFor([payback, dinner], ix, taxonomy.uncategorized)).toBe(cat('general merchandise'));
    expect(groupCategoryFor([payback, txn('Dinner', { amount: 120, category_id: cat('restaurants'), category: 'restaurants', category_name: 'restaurants' })], ix, taxonomy.uncategorized)).toBe(
      cat('restaurants')
    );
    // The largest outflow decides among the rest; a refund alone, the first.
    expect(groupCategoryFor([txn('Small', { amount: 5, category_id: cat('auto') }), txn('Big', { amount: 50, category_id: cat('household') })], ix, taxonomy.uncategorized)).toBe(
      cat('household')
    );
    expect(groupCategoryFor([payback, txn('Refund', { amount: -20, category_id: cat('household') })], ix, taxonomy.uncategorized)).toBe(cat('household'));
    // Two sides of a move: a transfer, as both are.
    expect(groupCategoryFor([payback, txn('Out', { amount: 60, category_id: cat('transfer out'), category_kind: 'transfer' })], ix, taxonomy.uncategorized)).toBe(cat('transfer in'));
    // Opened from the payback, nothing is offered to save until there are two.
    const sheet = renderToStaticMarkup(<GroupSheet start={payback} group={null} txns={raw()} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    expect(text(sheet)).toContain('Choose at least 2 transactions.');
    expect(sheet).toMatch(/<button[^>]*disabled=""[^>]*>Group them<\/button>/);
  });

  test('what it says before saving: never "counted" under a transfer category, and nothing for a net of nothing', () => {
    const transferIn = { name: 'transfer in', kind: 'transfer' as const };
    const restaurants = { name: 'restaurants', kind: 'expense' as const };
    expect(groupStatus({ count: 2, net: 60, currency: 'USD', category: transferIn })).toBe('2 transactions. Transfer in is a transfer category, so this group isn’t counted in spending.');
    expect(groupStatus({ count: 2, net: 60, currency: 'USD', category: restaurants })).toBe('2 transactions, counted as $60.00 out under Restaurants.');
    expect(groupStatus({ count: 3, net: -12.5, currency: 'USD', category: restaurants })).toBe('3 transactions, counted as $12.50 in under Restaurants.');
    expect(groupStatus({ count: 2, net: 0, currency: 'USD', category: restaurants })).toBe('2 transactions, netting to nothing, under Restaurants.');
    expect(groupStatus({ count: 1, net: 60, currency: 'USD', category: restaurants })).toBe('Choose at least 2 transactions.');
    // A group filed under a transfer category says so when opened.
    const rows = served();
    const group = { ...rows.find((t) => t.group_members)!, category_id: cat('transfer in'), category: 'transfer in', category_name: 'transfer in', category_kind: 'transfer' as const };
    expect(text(renderToStaticMarkup(<GroupSheet start={null} group={group} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />))).toContain(
      'Transfer in is a transfer category, so this group isn’t counted in spending.'
    );
  });

  test('a group’s edit saves only a change, and says which transactions count through it although left out on their own', () => {
    const rows = served();
    const group = rows.find((t) => t.group_members)!;
    const edit = renderToStaticMarkup(<GroupSheet start={null} group={group} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />);
    expect(edit).toMatch(/<button[^>]*disabled=""[^>]*>Save group<\/button>/);
    const hidden = { ...group, group_members: group.group_members!.map((m, i) => (i === 1 ? { ...m, excluded: true as const, excluded_by_rule: true as const } : m)) };
    expect(text(renderToStaticMarkup(<GroupSheet start={null} group={hidden} txns={rows} taxonomy={taxonomy} onClose={() => {}} onSaved={() => {}} />))).toContain(
      'A rule hides it: in the group, it counts through the group.'
    );
  });
});
