import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import BudgetsTab, { PastMonthPending } from '@/components/BudgetsTab';
import BudgetsCard, { NoBudgets } from '@/components/BudgetsCard';
import AccountSheet from '@/components/AccountSheet';
import { REFUND_NOTE } from '@/components/BudgetSheet';
import { IncomePoolHeader, IncomeSetting } from '@/components/IncomePool';
import { NOT_LOADED, UNREADABLE_MONTHS } from '@/components/budget-month-state';
import { KIND_WORDS, monthNotice, pastMonthNotes } from '@/components/budget-notes';
import { addMonths, gapText, monthName, type MonthGap } from '@/lib/rollover';
import before from './budget-words-before-6a2.json';
import {
  CARD,
  FOOD,
  GROCERIES,
  INCOMPLETE,
  NOW,
  POOL,
  POOL_BEFORE,
  POOL_EMPTY,
  RESTAURANTS,
  STOPPED,
  TAB,
  TAB_SCENES,
  VIEW,
  WITHOUT,
  filled,
  monthPanel,
  notesIn,
  ready,
} from './budget-notes-fixture';

// Budgets > Month's notes after rollout phase 6a2 moved them: one notice at
// the top of the segment for what may leave the month short (design-system.md
// "Status and honesty" rule 3), the Spent card's notes for what explains its
// figures, errors in the card and in the sheet they arose in, a group's notes
// in its opened rows, the rollover and suggestion notes in a budget's sheet,
// the setting's words in its own. Every note the month said before, recorded
// from main's own components in test/budget-words-before-6a2.json, is still
// said, in its words and at its level; the one level that changes is Over's,
// red to amber, with its word.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

type Recorded = Record<string, { text: string; level: string }[]>;
const recorded = before as Recorded;

const tab = (props: object) => renderToStaticMarkup(<BudgetsTab {...TAB} {...props} />);
const card = (props: object = {}) => renderToStaticMarkup(<BudgetsCard {...CARD} onRollover={async () => null} {...props} />);
const income = (on: boolean) =>
  renderToStaticMarkup(
    <IncomeSetting setting={on ? { version: 1, enabled: true, start: addMonths(NOW, -3) } : null} today={NOW} earliest={null} disabled={false} onChange={async () => null} open />
  );

/** Each scene as the views draw it now. A budget's sheet is drawn at its
 *  first level and at its rollover, where its notes went; the setting with
 *  its sheet open. */
const now: Record<string, () => string> = {
  ...Object.fromEntries(Object.entries(TAB_SCENES).map(([name, props]) => [`tab: ${name}`, () => monthPanel(tab(props))])),
  card: () => card(),
  'a category’s sheet': () => card({ edit: { kind: 'category', id: RESTAURANTS } }) + card({ edit: { kind: 'category', id: RESTAURANTS }, editLevel: 'rollover' }),
  'the group’s sheet': () => card({ edit: { kind: 'group', id: FOOD } }),
  // Said in the Spent card now (a past month's in its card too: NoBudgets).
  'no budgets': () => monthPanel(tab({ budgets: { categories: {}, groups: {} } })),
  'no budgets in a past month': () => renderToStaticMarkup(<NoBudgets month={addMonths(NOW, -1)} />),
  pool: () => renderToStaticMarkup(<IncomePoolHeader pool={POOL} currency="USD" month={NOW} today={NOW} />),
  'pool before it began': () => renderToStaticMarkup(<IncomePoolHeader pool={POOL_BEFORE} currency="USD" month={addMonths(NOW, -1)} today={NOW} />),
  'pool with nothing to count': () => renderToStaticMarkup(<IncomePoolHeader pool={POOL_EMPTY} currency="USD" month={addMonths(NOW, -1)} today={NOW} />),
  'income on': () => income(true),
  'income off': () => income(false),
  'past month not loaded': () => renderToStaticMarkup(<PastMonthPending state={{ status: 'error', view: null, error: NOT_LOADED, reload: () => {} }} name="March" />),
  'past month unreadable': () => renderToStaticMarkup(<PastMonthPending state={{ status: 'error', view: null, error: UNREADABLE_MONTHS, reload: () => {} }} name="March" />),
  'past month loading': () => renderToStaticMarkup(<PastMonthPending state={{ status: 'loading', view: null, error: null, reload: () => {} }} name="March" />),
};

/** The setting's words, said in its sheet now rather than under the
 *  budgets (the sheet's own scenes hold them). */
const IN_THE_SETTING = new Set([...recorded['income on'], ...recorded['income off']].map((n) => n.text));

/** Loading words that are now a skeleton's status (components/LoadingSkeletons.tsx):
 *  no longer a line on screen, said once to a screen reader instead. Not a
 *  warning, so not a note whose words must stay on screen. */
const NOW_A_STATUS: Record<string, string> = { 'Loading budgets…': 'Loading budgets' };

/** The one empty line that is now an empty state's title and line
 *  (components/EmptyState.tsx, the screen review after step 5): the old
 *  sentence split, its "Add one below" gone with the button now in the same
 *  card. Not a warning, so its words may change; both parts must still be
 *  there, the line as helper text. Every warning is checked as before. */
const NOW_AN_EMPTY_STATE: Record<string, { title: string; line: string }> = {
  'No budgets yet. Add one below to track spending against a monthly limit, for a category or a whole group.': {
    title: 'No budgets yet',
    line: 'Track spending against a monthly limit, for a category or a whole group.',
  },
};
const inEmptyState = (html: string, text: string) => {
  const e = NOW_AN_EMPTY_STATE[text];
  return !!e && html.includes(`>${e.title}</h3><p class="helper">${e.line}</p>`) && html.includes('class="empty-state"');
};

describe('every note the month said is still said, in its words and at its level', () => {
  test('the recording covers every scene drawn now', () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(now).sort());
  });

  for (const [scene, notes] of Object.entries(recorded)) {
    test(scene, () => {
      const html = now[scene]();
      const said = notesIn(html);
      const missing = notes
        .filter((n) => !(scene.startsWith('tab:') && IN_THE_SETTING.has(n.text)))
        .filter((n) => !(n.text in NOW_A_STATUS && html.includes(`role="status">${NOW_A_STATUS[n.text]}</p>`)))
        .filter((n) => !inEmptyState(html, n.text))
        .map((n) => ({ text: filled(n.text), level: n.level }))
        .filter((n) => !said.some((s) => s.level === n.level && s.text.includes(n.text)));
      expect(missing).toEqual([]);
    });
  }

  test('what couldn’t be drawn before without a tap, in the words main had for it', () => {
    // The reset's question (main's components/BudgetsCard.tsx), now a level
    // of the budget's sheet.
    const t = text(card({ edit: { kind: 'category', id: GROCERIES }, editLevel: 'reset' }));
    expect(t).toMatch(new RegExp(`Groceries’s carryover goes to zero from ${monthName(NOW)}: this month starts from its budget alone, and what is carried now \\(\\+\\$120\\.00 rolled over \\(may be off: \\w+( \\d{4})? is incomplete\\)\\) is set aside\\. Earlier months keep theirs\\.`));
    expect(t).toContain(REFUND_NOTE);
    // A past month's own reasons (main's components/BudgetsTab.tsx), now in
    // the month's notice.
    const gaps: MonthGap[] = [{ kind: 'stopped', institution: 'Chase', since: null }, { kind: 'exclusions', count: 1 }];
    const reason = (g: MonthGap) => {
      const s = gapText(g, (at) => at);
      return `${s[0].toUpperCase()}${s.slice(1)}`;
    };
    expect(pastMonthNotes('March', gaps, reason).map((n) => n.text)).toEqual(['March may be incomplete: Chase isn’t syncing.', 'March may be incomplete: Whether you excluded 1 transaction couldn’t be read.']);
  });

  test('Over is amber now, as nearly over is, and says so in a word; elsewhere a meter past its limit stays red', () => {
    const html = card({ spent: { [GROCERIES]: 500 } });
    expect(html).not.toContain('over-tag');
    expect(html).not.toContain('meter-fill over');
    expect(html).toContain('<span class="meter-fill warn" style="width:100%">');
    expect(html).toContain('<span class="badge warn">Over</span>');
    // A card used to 90% of its limit, in its account's sheet: red, as before.
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\r/g, '');
    expect(css).toContain('.meter-fill.over {\n  background: var(--down);');
    const noop = () => {};
    const card90 = { account_id: 'card', name: 'Sapphire', official_name: null, mask: '1234', type: 'credit', subtype: 'credit card', balance: 900, limit: 1000, currency: 'USD' };
    const sheet = renderToStaticMarkup(
      <AccountSheet
        open
        account={card90}
        inst={{ institution_name: 'Chase', item_id: 'item_chase', accounts: [card90], holdings: [], error: null, needs_reauth: false }}
        shownCurrency="USD"
        saving={false}
        hiding={false}
        lifecycleBusy={false}
        onDismiss={noop}
        onHide={noop}
        onEnd={noop}
        onUpdate={noop}
        onAddTransaction={noop}
        onImport={noop}
        onImportHistory={noop}
        onDelete={noop}
      />
    );
    expect(sheet).toContain('<div class="meter-fill over" style="width:90%">');
  });
});

describe('a kind for each reason', () => {
  test('a kind for each of the server’s reasons, in a few words with no amount', () => {
    const all: MonthGap[] = [
      { kind: 'missing', institution: 'A' },
      { kind: 'importing', institution: 'A' },
      { kind: 'stopped', institution: 'A', since: null },
      { kind: 'begins', institution: 'A', first: `${NOW}-03` },
      { kind: 'without', institution: 'A', reason: 'refused' },
      { kind: 'without', institution: 'A', reason: 'no_consent' },
      { kind: 'held', institution: 'A' },
      { kind: 'unread', what: 'your own categories' },
      { kind: 'exclusions', count: 2 },
    ];
    const kinds = pastMonthNotes('March', all, (g) => gapText(g, (at) => at)).map((n) => n.kind);
    expect(kinds).toEqual(['missing', 'importing', 'stopped', 'begins', 'refused', 'no_consent', 'held', 'unread', 'exclusions']);
    for (const k of kinds) expect([k, /\d|\$/.test(KIND_WORDS[k])]).toEqual([k, false]);
  });
});

/** The Month panel's markup before the Spent card (the notice, when there
 *  is one), and the Spent card's, each from a whole tag. */
const beforeSpent = (html: string) => {
  const panel = monthPanel(html);
  return panel.slice(panel.indexOf('>') + 1, panel.lastIndexOf('<', panel.indexOf('aria-labelledby="budgets-spent-title"')));
};
const spentCard = (html: string) => {
  const panel = monthPanel(html);
  return panel.slice(panel.lastIndexOf('<', panel.indexOf('aria-labelledby="budgets-spent-title"')));
};

describe('the month’s one notice', () => {
  // The notice is the panel's first thing, before the Spent card.
  const notice = beforeSpent;

  test('one thing missing: said in full, a caution, at the top of the month', () => {
    const html = tab({ incomplete: [{ institution_name: 'Chase', coverage: 'missing' }], budgetMonth: ready(null) });
    const top = notice(html);
    expect(top).toContain('<div class="notice caution">');
    expect(top).not.toContain('notice-summary');
    expect(text(top)).toBe("Caution: Doesn't include Chase: its transactions couldn't be loaded, so this month may be incomplete.");
  });

  test('several: one line in amber naming how many and of what kinds, opening in place to each in full', () => {
    const html = tab({ ...TAB_SCENES['this month'], budgetsSaveError: null });
    const top = notice(html);
    expect(top).toContain('<details class="notice-summary"><summary class="notice caution">');
    // Six of the month's own, then the carry's: seven kinds, the first three named.
    expect(text(top)).toContain('Caution: 7 notes: transactions not loaded, a bank not syncing, older transactions still importing and 4 more');
    for (const n of recorded['tab: this month'].filter((r) => r.level === 'caution' && !r.text.startsWith('May be off') && !r.text.startsWith('Could not save'))) {
      expect(text(top)).toContain(filled(n.text));
    }
    expect(text(top)).toContain('Rollover may be off where a month is incomplete:');
  });

  test('why a carry may be off is in it, and only that: no badge on the month’s own figures', () => {
    const html = tab({ budgetMonth: ready(VIEW) });
    expect(text(notice(html))).toMatch(/^Caution: Rollover may be off where a month is incomplete: Chase hasn’t synced since .+; Whether you excluded 2 transactions couldn’t be read/);
    expect(html).not.toContain('May be incomplete');
  });

  test('the Spent card says "May be incomplete" when the month itself may be', () => {
    const spent = spentCard(tab({ incomplete: INCOMPLETE }));
    expect(spent).toContain('<span class="badge warn">May be incomplete</span>');
    // On the number, under the card's title, before its meter.
    expect(spent.indexOf('May be incomplete')).toBeLessThan(spent.indexOf('meter-track'));
  });

  test('nothing missing: no notice and no badge', () => {
    const html = tab({ budgetMonth: ready({ ...VIEW, carries: { categories: {}, groups: {} }, pool: null }) });
    expect(notice(html)).not.toContain('notice');
    expect(html).not.toContain('May be incomplete');
  });

  test('with no spending to count, nothing can be missing from it: only the carry notes', () => {
    const html = tab({ txns: [], withoutTransactions: { without: [{ institution_name: 'Empower', reason: 'investment_accounts' }], connections: 1 }, incomplete: INCOMPLETE });
    expect(notice(html)).not.toContain('notice');
    expect(html).toContain('so there&#x27;s no spending to count against budgets');
  });

  test('a past month’s own reasons, and why its carry may be off, gathered the same way', () => {
    const name = monthName(addMonths(NOW, -1), NOW);
    const own = pastMonthNotes(name, VIEW.gaps[0].gaps, (g) => gapText(g, (at) => at));
    const items = monthNotice(own, ['Chase hasn’t synced since Mar 5 (March)']);
    expect(items.map((c) => [c.severity, c.summary])).toEqual([
      ['caution', 'a bank not syncing'],
      ['caution', 'exclusions that couldn’t be read'],
      ['caution', 'rollover may be off'],
    ]);
    expect(items[2].body).toBe('Rollover may be off where a month is incomplete: Chase hasn’t synced since Mar 5 (March).');
  });
});

describe('the Spent card', () => {
  test('with no budget this month, the month is one card, the empty state, in place of Spent: what budgets are for and Add budget as its primary', () => {
    const html = tab({ budgets: { categories: {}, groups: {} } });
    const panel = monthPanel(html);
    expect(panel).not.toContain('budgets-spent-title');
    expect(panel).not.toContain('budget-rows');
    const empty = panel.slice(panel.lastIndexOf('<section', panel.indexOf('class="empty-state"')));
    const card = empty.slice(0, empty.indexOf('</section>'));
    expect(card).toStartWith('<section class="card"');
    expect(card).toContain('<h3 id=');
    expect(text(card)).toStartWith('No budgets yet Track spending against a monthly limit, for a category or a whole group.');
    // The Spent card's note on what the spending leaves out, kept, before the button.
    expect(text(card)).toEndWith("Note: 1 transaction in EUR isn't in these budgets, which are in USD. Add budget");
    // One button, filled: the screen's first step, not a tonal one outside the card.
    expect(card).toContain('<button type="button" class="btn" aria-haspopup="dialog">Add budget</button>');
    expect(panel.split('>Add budget<').length - 1).toBe(1);
    expect(panel).not.toContain('budget-add-button');
    expect(panel.split('No budgets yet').length - 1).toBe(1);
  });

  test('with no budget, what the Spent card would have said is in the empty state, before its button, in its words', () => {
    const html = tab({ budgets: { categories: {}, groups: {} }, budgetsSaveError: 'Your budgets couldn’t be saved.' });
    const panel = monthPanel(html);
    const card = panel.slice(panel.indexOf('class="empty-state"'));
    const at = (w: string) => card.indexOf(w);
    expect(at('Your budgets couldn’t be saved.')).toBeGreaterThan(-1);
    expect(at('Your budgets couldn’t be saved.')).toBeLessThan(at('>Add budget<'));
    expect(notesIn(card).find((n) => n.text.includes('couldn’t be saved'))?.level).toBe('caution');
  });

  test('a budget on a category since deleted is a budget all the same: its row, the Spent card, never "No budgets yet"', () => {
    const panel = monthPanel(tab({ budgets: { categories: { gone_1: { amount: 25 } }, groups: {} } }));
    expect(panel).not.toContain('empty-state');
    expect(panel).not.toContain('No budgets');
    expect(panel).toContain('aria-labelledby="budgets-spent-title"');
    expect(text(panel)).toContain('A category since deleted');
    expect(panel).toContain('budget-add-button');
  });

  test('a past month with no budget keeps its Spent card and its line', () => {
    expect(renderToStaticMarkup(<NoBudgets month={addMonths(NOW, -1)} />)).toBe(`<p class="empty-note">No budgets in ${monthName(addMonths(NOW, -1))}.</p>`);
  });

  test('its title, what is spent of what is available, and its notes for the figures, each in full or gathered', () => {
    const spent = spentCard(tab({ budgetMonth: ready(VIEW) }));
    expect(spent).toContain('<h3 id="budgets-spent-title">Spent</h3>');
    expect(text(spent)).toMatch(/^Spent \$\d[\d,.]* of \$\d[\d,.]*/);
    // Four notes, none of them about anything wrong: gathered, neutral.
    expect(spent).toContain('<summary class="notice info">');
    expect(text(spent)).toContain('Note: 4 notes: other currencies left out, other currencies left out of rollover, split amounts changed and 1 more');
  });
});
