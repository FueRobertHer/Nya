import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import RulesCard from '@/components/RulesCard';
import RuleSheet, { RuleSample } from '@/components/RuleSheet';
import MonthBreakdown, { exclusionOffer, nameForRules, type Txn } from '@/components/MonthBreakdown';
import { colorAfterKey } from '@/components/TagsCard';
import TxnTagsNote from '@/components/TxnTagsNote';
import { changedFields, editStart } from '@/components/ManualTxnSheet';
import { recategorizedRow, withLayersOf } from '@/components/transaction-edits';
import { buildReport, type ReportInput } from '@/lib/report/build';
import { resolvePeriod } from '@/lib/report/period';
import { appendixStatus, totalsNote } from '@/lib/report/words';
import { spendingLeftOut } from '@/lib/fire/progress';
import { trailingFlows } from '@/lib/fire/inputs';
import { blankCondition, draftComplete, draftFromRule, draftInput, newDraft, type RulesState } from '@/components/rules-state';
import { addRule, emptyRuleSet, sortedRules, type RuleSet } from '@/lib/rules';
import { indexTaxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import type { Tag } from '@/lib/tags';
import { categoriesFor } from './category-fixture';

// The rules on screen (#36): the Rules screen under Manage, the rule drawer,
// the form's drafts and what they send, and a transaction a rule hid.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const { taxonomy } = categoriesFor({}, { words: ['shopping', 'coffee'] });
const shopping = taxonomy.categories.find((c) => c.name === 'shopping')!.id;
const TAGS: Tag[] = [{ id: 'work', name: 'Work', color: 'green', created_at: '2026-10-01T00:00:00.000Z' }];
let n = 0;
const rulesOf = (...inputs: unknown[]): RuleSet => {
  let set = emptyRuleSet();
  for (const input of [...inputs].reverse()) set = addRule(set, input, { ix: indexTaxonomy(taxonomy), tags: { version: 1, tags: TAGS } }, () => `r${++n}`).set;
  return set;
};
const state = (set: RuleSet | null, over: Partial<RulesState> = {}): RulesState => ({
  set,
  problems: {},
  error: null,
  load: async () => {},
  accept: () => {},
  draft: null,
  open: () => {},
  close: () => {},
  ...over,
});

describe('the form’s drafts', () => {
  test('a saved rule’s form sends the rule back as it was', () => {
    const set = rulesOf({
      conditions: [
        { field: 'name', op: 'contains', value: 'amzn' },
        { field: 'amount', op: 'between', value: 10, value2: 99.5, direction: 'out' },
      ],
      actions: { set_category: shopping, add_tags: ['work'], hide: true },
    });
    const rule = set.rules[0];
    const input = draftInput(draftFromRule(rule));
    expect(input).toEqual({ conditions: rule.conditions, actions: rule.actions, enabled: true });
  });

  test('amounts typed are read as numbers; a form with a blank value or nothing to do isn’t ready', () => {
    const d = newDraft({ conditions: [{ ...blankCondition('amount'), value: '1,250.50' }], hide: true });
    expect(draftInput(d).conditions[0]).toEqual({ field: 'amount', op: 'gt', value: 1250.5, direction: 'out' });
    expect(draftComplete(d)).toBe(true);
    expect(draftComplete(newDraft({ hide: true }))).toBe(false);
    expect(draftComplete(newDraft({ conditions: [{ ...blankCondition(), value: 'x' }] }))).toBe(false);
    expect(draftComplete(newDraft({ conditions: [{ ...blankCondition('amount'), value: 'lots' }], hide: true }))).toBe(false);
  });
});

describe('the Rules screen', () => {
  test('each rule in a sentence, in the order they run, with what keeps one from working', () => {
    const set = rulesOf(
      { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { set_category: shopping } },
      { conditions: [{ field: 'amount', op: 'gt', value: 500, direction: 'out' }], actions: { add_tags: ['work'] } }
    );
    const [first, second] = sortedRules(set);
    const t = text(
      renderToStaticMarkup(
        <RulesCard
          rules={state({ ...set, rules: set.rules.map((r) => (r.id === second.id ? { ...r, enabled: false } : r)) }, { problems: { [first.id]: 'A category it names was deleted, so it does nothing until you choose another.' } })}
          taxonomy={taxonomy}
          tags={TAGS}
          accounts={[]}
          onChanged={() => {}}
        />
      )
    );
    expect(t).toContain('2 rules, in the order they run');
    expect(t.indexOf('If name contains “amzn”: file under Shopping.')).toBeLessThan(t.indexOf('If money out more than 500: tag Work.'));
    expect(t).toContain('A category it names was deleted');
    expect(t).toContain('New rule');
  });

  test('with no rules, it says what one does', () => {
    expect(text(renderToStaticMarkup(<RulesCard rules={state(emptyRuleSet())} taxonomy={taxonomy} tags={TAGS} accounts={[]} onChanged={() => {}} />))).toContain(
      'A rule files, renames, tags or hides every transaction that matches it, past and future.'
    );
  });
});

describe('the rule drawer', () => {
  // The screen review: "2026-10-24 Uber · PLAID CHECKING".
  test('a matching transaction reads as the rows do: its day, its name readable, its account', () => {
    const year = localDate().slice(0, 4);
    const sample = (over: object) => text(renderToStaticMarkup(<ul><RuleSample s={{ transaction_id: 't', date: `${year}-10-24`, name: 'Uber', amount: 12.5, currency: 'USD', account_name: 'Plaid Checking', ...over }} /></ul>));
    expect(sample({})).toBe('Oct 24 Uber · Plaid Checking -$12.50');
    expect(sample({ name: 'CREDIT CARD 3333 PAYMENT *//', name_from_bank: true })).toBe('Oct 24 Credit Card 3333 Payment · Plaid Checking -$12.50');
    // A day of another year says its year.
    expect(sample({ date: '2024-10-24' })).toBe('Oct 24, 2024 Uber · Plaid Checking -$12.50');
  });

  test('a rule made from a transaction opens with its name to match and its category, and says a choice on one transaction wins', () => {
    const draft = newDraft({ conditions: [{ field: 'name', op: 'equals', value: 'Blue Bottle', value2: '', direction: '' }], set_category: shopping });
    const html = renderToStaticMarkup(<RuleSheet rules={state(emptyRuleSet(), { draft })} taxonomy={taxonomy} tags={TAGS} accounts={[]} onChanged={() => {}} />);
    const t = text(html);
    expect(t).toContain('New rule');
    expect(html).toContain('value="Blue Bottle"');
    expect(html).toMatch(new RegExp(`<option value="${shopping}" selected`));
    expect(t).toContain('What you set on one transaction always wins over a rule.');
    expect(t).toContain('Make rule');
  });

  test('closed, it shows nothing', () => {
    expect(renderToStaticMarkup(<RuleSheet rules={state(emptyRuleSet())} taxonomy={taxonomy} tags={TAGS} accounts={[]} onChanged={() => {}} />)).toBe('');
  });
});

describe('on the Activity tab', () => {
  test('a transaction a rule hid says so, apart from one excluded by hand', () => {
    const base = {
      date: localDate(),
      amount: 10,
      pending: false,
      account_name: 'Checking',
      institution_name: 'Chase',
      category: 'shopping',
      iso_currency_code: 'USD',
      vendor_key: 'v',
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
    };
    const txns = [
      { ...base, transaction_id: 'a', name: 'Hidden by rule', excluded: true, excluded_by_rule: true, rule_ids: ['r1'] },
      { ...base, transaction_id: 'b', name: 'Excluded by hand', excluded: true },
    ] as Txn[];
    const t = text(renderToStaticMarkup(<MonthBreakdown txns={txns} notes={[]} loading={false} taxonomy={taxonomy} onRecategorize={() => {}} onRename={() => {}} />));
    expect(t).toContain('and 1 transaction you left out, and 1 transaction a rule hides.');
    // Each row's badge says which; its sheet says it in full.
    expect(t).toContain('Hidden by rule Shopping · Chase · Checking Hidden by a rule -$10.00');
    expect(t).toContain('Excluded by hand Shopping · Chase · Checking Excluded -$10.00');
  });
});

/** A row as the Activity tab lists it. */
const listedRow = (id: string, over: Partial<Txn> = {}): Txn =>
  ({
    transaction_id: id,
    date: localDate(),
    name: id,
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'shopping',
    iso_currency_code: 'USD',
    vendor_key: 'v',
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
  }) as Txn;

describe('editing a row a rule files or names', () => {
  const ruled = listedRow('manual-txn:a', {
    source: 'import:csv',
    account_id: 'manual_x',
    name: 'Amazon',
    name_before_rules: 'POS AMZN 4421',
    category: 'shopping',
    category_id: shopping,
    category_name: 'Shopping',
    category_by_rule: true,
    note: 'gift',
  });

  test('the form starts from the row’s own name and category, and sends them only when changed', () => {
    const start = editStart(ruled);
    expect(start).toEqual({ name: 'POS AMZN 4421', category_id: '', category: '' });
    const unchanged = { date: ruled.date, amount: 10, currency: 'USD', name: 'POS AMZN 4421', category_id: null, category: null, note: 'gift, wrapped' };
    expect(changedFields(unchanged, start)).toEqual({ date: ruled.date, amount: 10, currency: 'USD', note: 'gift, wrapped' });
    expect(changedFields({ ...unchanged, name: 'Birthday', category_id: shopping, category: 'shopping' }, start)).toMatchObject({ name: 'Birthday', category_id: shopping });
    // Without a rule, the form starts from what the row shows, as before.
    expect(editStart(listedRow('manual-txn:b', { category_id: shopping, category_name: 'Shopping' }))).toEqual({ name: 'manual-txn:b', category_id: shopping, category: 'shopping' });
    expect(nameForRules(ruled)).toBe('POS AMZN 4421');
  });

  test('a category chosen on the Activity tab is the row’s own at once: the form starts from it', () => {
    const chosen = { ...ruled, ...recategorizedRow(ruled, { category_id: shopping }, taxonomy) };
    expect(chosen.category_by_rule).toBeUndefined();
    expect(editStart(chosen)).toMatchObject({ category_id: shopping, category: 'shopping' });
  });

  test('a saved row keeps what the read layer put on it until the list is read again', () => {
    const saved = listedRow('manual-txn:a', { source: 'import:csv', name: 'POS AMZN 4421', category: null, category_name: null, note: 'gift, wrapped' });
    const shown = withLayersOf(saved, { ...ruled, tags: ['work'], rule_ids: ['r1'], excluded: true, excluded_by_rule: true });
    expect(shown).toMatchObject({ name: 'Amazon', name_before_rules: 'POS AMZN 4421', category_id: shopping, category_by_rule: true, tags: ['work'], rule_ids: ['r1'], excluded: true, excluded_by_rule: true, note: 'gift, wrapped' });
    // A name and a category of its own, once given, are its own.
    const own = withLayersOf({ ...saved, name: 'Birthday', category: 'coffee', category_name: 'Coffee' }, ruled);
    expect([own.name, own.name_before_rules, own.category_name, own.category_by_rule]).toEqual(['Birthday', undefined, 'Coffee', undefined]);
  });
});

describe('what a rule hides, in reports and the Plan', () => {
  const p = resolvePeriod({ kind: 'range', start: '2026-09-01', end: '2026-09-30' }, 'UTC', Date.parse('2026-10-10T12:00:00.000Z'));
  if ('error' in p) throw new Error(p.error);
  const rows = [
    listedRow('kept', { date: '2026-09-02', amount: 40 }),
    listedRow('mine', { date: '2026-09-03', amount: 50, excluded: true }),
    listedRow('ruled', { date: '2026-09-04', amount: 60, excluded: true, excluded_by_rule: true }),
    listedRow('ruled2', { date: '2026-09-05', amount: 70, excluded: true, excluded_by_rule: true }),
  ];
  const input = (rows: Txn[], marked: string[] | null = null): ReportInput =>
    ({
      period: p,
      generatedAt: '2026-10-10T12:00:00.000Z',
      rows,
      currency: null,
      sources: [],
      notes: [],
      manual: [],
      removed: [],
      removedUnreadable: 0,
      manualUnread: [],
      liveAccounts: [],
      links: new Map(),
      ownRead: { categories: true, names: true, exclusions: true },
      marked,
      markedUnreadable: false,
      hidden: false,
      healthUnread: false,
    }) as unknown as ReportInput;

  test('the totals say what you excluded and what a rule hides, as the Activity tab does', () => {
    const report = buildReport(input(rows));
    expect([report.totals.excluded, report.totals.hidden_by_rule]).toEqual([3, 2]);
    expect(totalsNote(report)).toContain('and 1 transaction you excluded from budgets and reports and 2 a rule hides are left out.');
    expect(totalsNote(buildReport(input(rows.filter((t) => t.transaction_id !== 'mine'))))).toContain('and 2 transactions a rule hides are left out.');
    expect(totalsNote(buildReport(input(rows.filter((t) => !t.excluded_by_rule))))).toContain('and 1 transaction you excluded from budgets and reports is left out.');
  });

  test('an appendix row a rule hides says so', () => {
    expect(appendixStatus({ not_counted: 'hidden', pending: false, exclusion_unknown: false, currency: 'USD' })).toBe('Not counted: hidden by a rule');
    const report = buildReport(input(rows, ['shopping']));
    const status = new Map(report.appendix!.rows.map((r) => [r.name, r.not_counted]));
    expect([status.get('mine'), status.get('ruled'), status.get('kept')]).toEqual(['excluded', 'hidden', null]);
  });

  test('the Plan says so too', () => {
    // Spread over two months, as the Plan needs a few weeks of history.
    const today = localDate();
    const daysBefore = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const flows = trailingFlows(rows.map((t, i) => ({ ...t, date: daysBefore(i * 20) })), today);
    expect(flows).not.toBeNull();
    expect(flows!.hiddenCount).toBe(2);
    expect(spendingLeftOut(flows).excluded).toBe('Leaves out 1 transaction you excluded from budgets and reports and 2 a rule hides.');
    expect(spendingLeftOut({ ...flows!, excludedCount: 2, hiddenCount: 0 }).excluded).toBe('Leaves out 2 transactions you excluded from budgets and reports.');
  });
});

describe('the screens, for a keyboard and a screen reader', () => {
  test('each control on a rule names the rule it acts on', () => {
    const set = rulesOf({ conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { hide: true } });
    const html = renderToStaticMarkup(<RulesCard rules={state(set)} taxonomy={taxonomy} tags={TAGS} accounts={[]} onChanged={() => {}} />);
    const id = set.rules[0].id;
    for (const label of ['Rule 1 on', 'Run rule 1 earlier', 'Run rule 1 later', 'Edit rule 1']) expect(html).toContain(`aria-label="${label}" aria-describedby="rule-${id}"`);
    expect(html).toContain(`id="rule-${id}"`);
  });

  test('the arrow keys move a tag’s color around the choices', () => {
    expect([colorAfterKey('gray', 'ArrowRight'), colorAfterKey('gray', 'ArrowLeft'), colorAfterKey('pink', 'ArrowDown'), colorAfterKey('red', 'ArrowUp'), colorAfterKey('red', 'a')]).toEqual([
      'red',
      'pink',
      'gray',
      'gray',
      null,
    ]);
  });

  test('the tag editor’s suggestions are a named group', () => {
    const html = renderToStaticMarkup(
      <TxnTagsNote t={{ transaction_id: 'x', name: 'Taxi', pending: false, tags: [], note: null } as any} tags={TAGS} onChangeTags={() => {}} onSaveNote={() => {}} />
    );
    expect(html).toContain('class="tag-suggestions" role="group" aria-label="Your tags"');
  });

  test('a pending row a rule hides offers no include that would lapse when it posts', () => {
    expect(exclusionOffer({ pending: true, excluded: true, excluded_by_rule: true })).toBe('wait-rule');
    expect(exclusionOffer({ pending: true, excluded: undefined })).toBe('wait');
    // Excluded by hand (carried to it), and any posted row: the button.
    expect(exclusionOffer({ pending: true, excluded: true })).toBe('toggle');
    expect(exclusionOffer({ pending: false, excluded: true, excluded_by_rule: true })).toBe('toggle');
  });
});
