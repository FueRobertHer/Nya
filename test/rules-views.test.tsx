import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import RulesCard from '@/components/RulesCard';
import RuleSheet from '@/components/RuleSheet';
import MonthBreakdown, { type Txn } from '@/components/MonthBreakdown';
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
    expect(t).toContain('Hidden by rule Chase · Checking');
    expect(t).toContain('and 1 transaction you left out, and 1 transaction a rule hides.');
    expect(t).toContain('Hidden by a rule: out of budgets and reports');
    expect(t).toContain('Excluded from budgets and reports');
  });
});
