import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Txn } from '@/components/MonthBreakdown';
import CardMode, { CardCategoryPicker, cardsToDeal } from '@/components/CardMode';
import CategoryPicker from '@/components/CategoryPicker';
import ReviewBar, { ActivityKeysHelp, barAction, listedToReview } from '@/components/ReviewBar';
import ReviewNote from '@/components/ReviewNote';
import ReviewSettingsCard, { nearFull, startChoices } from '@/components/ReviewSettingsCard';
import { FLING, SPEED_WINDOW, STOPPED, swipeEnd, swipeMove, swipeOffset, swipeRelease, swipeSpeed, swipeStart, SLOP, type Point } from '@/components/swipe';
import { activityKey, cardKey, isTyping, pickerKey } from '@/components/review-keys';
import {
  ACTIVITY_KEYS_KEY,
  activityKeysNow,
  forgetActivityKeysForTests,
  readActivityKeys,
  setActivityKeys,
  subscribeActivityKeys,
  writeActivityKeys,
} from '@/components/activity-keys';
import { cardCounts, cardPosition, currentCard, dealSkipped, openCards, pickerOn, undoStep, withoutStep, withStep } from '@/components/card-mode-state';
import { withApproved, withUndone, reviewViewOf, type ReviewControls } from '@/components/review-state';
import { approvedAsImported, changedSinceWords, changedWords, defaultListWords, defaultWords, doneWords, endWords, suggestionWords, toReviewWords } from '@/components/review-text';
import { merchantOf, recategorizedRow } from '@/components/transaction-edits';
import { searchEntries } from '@/components/txn-search';
import { localDate } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';

// The review queue's views: Card Mode's swipe by pointer, worked out by hand
// (components/swipe.ts), its keys and the Activity tab's (never with a
// modifier, never while typing), its cards dealt, done, undone and ended
// ("All caught up", with a count), the buttons every swipe has, the bar's
// count and filter, a transaction's detail saying what its review is, the
// list approved and undone at once, and the words.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Every element in a tree a component without hooks returns, to read how
 *  its parts are wired (no DOM here to click them). */
function elementsIn(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement(node)) return [];
  return [node, ...elementsIn((node.props as { children?: ReactNode }).children)];
}

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'household'] });
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const today = localDate();

const txn = (id: string, over: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  date: today,
  name: 'Costco',
  amount: 54.2,
  pending: false,
  account_name: 'Card',
  institution_name: 'Chase',
  category: 'general merchandise',
  category_id: cat('general merchandise'),
  category_name: 'general merchandise',
  category_kind: 'expense',
  iso_currency_code: 'USD',
  vendor_key: 'nm:chase::costco',
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

/** The controls as the views see them, doing nothing. */
const controls = (on = true): ReviewControls =>
  ({
    view: { on, since: today, unread: false, unknown: 0 },
    accept: () => {},
    turn: async () => true,
    approve: async () => null,
    undo: async () => true,
    unapprove: async () => true,
    recategorizeAndApprove: async () => null,
    undoRecategorize: async () => true,
    error: null,
    setError: () => {},
    saving: false,
  }) as unknown as ReviewControls;

/** A drag, as pointer events give it, every 16 ms, released as a browser's
 *  pointerup is: where the last move was, a moment later. */
function drag(points: [number, number][], width = 360): 'right' | 'left' | null {
  let s = swipeStart({ x: points[0][0], y: points[0][1], t: 0 });
  points.slice(1).forEach(([x, y], i) => {
    s = swipeMove(s, { x, y, t: (i + 1) * 16 });
  });
  return swipeRelease(s, { ...s.last, t: s.last.t + 8 }, width);
}

describe('the swipe, by pointer', () => {
  test('far enough right approves, far enough left recategorizes, short springs back', () => {
    expect(drag([[100, 300], [130, 302], [170, 303], [230, 305]])).toBe('right');
    expect(drag([[300, 300], [260, 301], [200, 302], [150, 304]])).toBe('left');
    // 60 px of a 360 px card, slowly: back.
    let s = swipeStart({ x: 100, y: 300, t: 0 });
    for (let i = 1; i <= 12; i++) s = swipeMove(s, { x: 100 + i * 5, y: 300, t: i * 100 });
    expect(swipeEnd(s, 360)).toBeNull();
  });

  test('a quick flick decides on its own; one that turns back doesn’t', () => {
    expect(drag([[100, 300], [112, 300], [140, 301]])).toBe('right');
    expect(drag([[100, 300], [140, 300], [120, 300]])).toBeNull();
  });

  test('a flick released where its last move was, as a browser’s pointerup is, still decides by the speed of its last moves', () => {
    // By touch: 60 px in 96 ms on a 358 px card (short of the 107 px a drag needs).
    let s = swipeStart({ x: 100, y: 300, t: 0 });
    for (let i = 1; i <= 6; i++) s = swipeMove(s, { x: 100 + i * 10, y: 300, t: i * 16 });
    expect(swipeRelease(s, { x: 160, y: 300, t: 104 }, 358)).toBe('right');
    // Released later still (events slow to come, as in a driven browser): the same flick.
    expect(swipeRelease(s, { x: 160, y: 300, t: 96 + 49 }, 358)).toBe('right');
    // The speed is the moves' over the last SPEED_WINDOW ms, never the last
    // step alone, which the repeated release point would make one of nothing.
    expect(swipeSpeed(s)).toBeCloseTo(60 / 96, 6);
    expect(swipeSpeed(s)).toBeGreaterThan(FLING);
    // By mouse: 50 px left in 80 ms, released at the same point and time.
    let m = swipeStart({ x: 300, y: 300, t: 0 });
    for (let i = 1; i <= 5; i++) m = swipeMove(m, { x: 300 - i * 10, y: 300, t: i * 16 });
    expect(swipeRelease(m, { x: 250, y: 300, t: 80 }, 358)).toBe('left');
    // Held still before letting go: no flick, so it springs back.
    expect(swipeRelease(s, { x: 160, y: 300, t: 96 + STOPPED + 1 }, 358)).toBeNull();
    // A release where the pointer moved on is one more point of the drag.
    expect(swipeRelease(s, { x: 200, y: 300, t: 112 }, 358)).toBe('right');
    expect([SPEED_WINDOW, STOPPED]).toEqual([100, 100]);
  });

  test('up or down first is the page’s scroll, never a swipe, however far it then goes sideways', () => {
    let s = swipeStart({ x: 100, y: 100, t: 0 });
    s = swipeMove(s, { x: 104, y: 130, t: 16 });
    expect(s.axis).toBe('y');
    s = swipeMove(s, { x: 300, y: 140, t: 32 });
    expect(swipeOffset(s)).toBe(0);
    expect(swipeEnd(s, 360)).toBeNull();
  });

  test('within the slop nothing moves, so a tap is a tap', () => {
    const p: Point = { x: 100, y: 100, t: 0 };
    const s = swipeMove(swipeStart(p), { x: 100 + SLOP, y: 100 + SLOP / 2, t: 16 });
    expect([s.axis, swipeOffset(s), swipeEnd(s, 360)]).toEqual([null, 0, null]);
    const sideways = swipeMove(s, { x: 140, y: 102, t: 32 });
    expect([sideways.axis, swipeOffset(sideways)]).toEqual(['x', 40]);
  });

  test('a narrow card still needs a real distance', () => {
    let s = swipeStart({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 10; i++) s = swipeMove(s, { x: i * 5, y: 0, t: i * 100 });
    expect(swipeEnd(s, 120)).toBeNull();
  });
});

describe('the keys', () => {
  const key = (k: string, over: Record<string, unknown> = {}) => ({ key: k, ...over });
  test('in Card Mode: arrows and letters, Enter only on the card, Escape always; never with a modifier or while choosing', () => {
    expect(cardKey(key('ArrowRight'), false)).toBe('approve');
    expect(cardKey(key('a'), false)).toBe('approve');
    expect(cardKey(key('ArrowLeft'), false)).toBe('recategorize');
    expect(cardKey(key('c'), false)).toBe('recategorize');
    expect(cardKey(key('ArrowDown'), false)).toBe('skip');
    expect(cardKey(key('s'), false)).toBe('skip');
    expect(cardKey(key('u'), false)).toBe('undo');
    expect(cardKey(key('?', { shiftKey: true }), false)).toBe('help');
    expect(cardKey(key('Enter'), true)).toBe('approve');
    // Enter on a button presses the button, as always.
    expect(cardKey(key('Enter'), false)).toBeNull();
    expect(cardKey(key('Escape'), false)).toBe('close');
    expect(cardKey(key('Escape', { target: { tagName: 'SELECT' } }), false)).toBe('close');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) expect(cardKey(key('a', { [mod]: true }), false)).toBeNull();
    expect(cardKey(key('A', { shiftKey: true }), false)).toBeNull();
    expect(cardKey(key('ArrowRight', { target: { tagName: 'select' } }), false)).toBeNull();
    expect(cardKey(key('a', { target: { tagName: 'INPUT' } }), false)).toBeNull();
    expect(cardKey(key('a', { repeat: true }), false)).toBeNull();
  });

  test('on the Activity tab: R, N, Shift+A, U and ?, never with Ctrl, Alt or Command, never in a field', () => {
    expect(activityKey(key('r'))).toBe('review');
    expect(activityKey(key('n'))).toBe('filter');
    expect(activityKey(key('A', { shiftKey: true }))).toBe('approve-listed');
    expect(activityKey(key('a'))).toBeNull();
    expect(activityKey(key('u'))).toBe('undo');
    expect(activityKey(key('?', { shiftKey: true }))).toBe('help');
    expect(activityKey(key('r', { metaKey: true }))).toBeNull();
    expect(activityKey(key('r', { ctrlKey: true }))).toBeNull();
    expect(activityKey(key('n', { target: { tagName: 'TEXTAREA' } }))).toBeNull();
    expect(activityKey(key('n', { target: { isContentEditable: true } }))).toBeNull();
    expect(isTyping({ tagName: 'BUTTON' })).toBe(false);
  });

  test('in Card Mode’s category list: Enter uses the one shown; its arrows only move through it', () => {
    const list = { target: { tagName: 'SELECT' } };
    expect(pickerKey(key('Enter', list))).toBe('choose');
    expect(pickerKey(key('ArrowDown', list))).toBeNull();
    expect(pickerKey(key('Enter', { target: { tagName: 'BUTTON' } }))).toBeNull();
    expect(pickerKey(key('Enter', { ...list, ctrlKey: true }))).toBeNull();
    expect(pickerKey(key('Enter', { ...list, repeat: true }))).toBeNull();
    // Card Mode's own keys leave the list's to it.
    expect(cardKey(key('ArrowDown', list), false)).toBeNull();
  });

  test('on the Activity tab the keys can be turned off, and Shift+A only ever asks first', () => {
    const bar = { keysOn: true, total: 3, waiting: 2, filtering: false };
    expect(barAction('approve-listed', bar)).toBe('confirm');
    expect(barAction('approve-listed', { ...bar, waiting: 0 })).toBeNull();
    expect(barAction('review', bar)).toBe('review');
    expect(barAction('review', { ...bar, total: 0 })).toBeNull();
    expect(barAction('filter', bar)).toBe('filter-on');
    expect(barAction('filter', { ...bar, filtering: true })).toBe('filter-off');
    expect(barAction('undo', bar)).toBe('undo');
    for (const k of ['approve-listed', 'review', 'filter', 'undo', 'help'] as const) expect(barAction(k, { ...bar, keysOn: false })).toBeNull();
    // Kept on this device, read leniently: on unless it says off.
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    expect(readActivityKeys(storage)).toBe(true);
    writeActivityKeys(false, storage);
    expect([kept.get(ACTIVITY_KEYS_KEY), readActivityKeys(storage)]).toEqual(['off', false]);
    writeActivityKeys(true, storage);
    expect([kept.has(ACTIVITY_KEYS_KEY), readActivityKeys(storage)]).toEqual([false, true]);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(readActivityKeys(broken)).toBe(true);
    expect(() => writeActivityKeys(false, broken)).not.toThrow();
    expect(readActivityKeys(null)).toBe(true);
    // The switch, in their help.
    const on = renderToStaticMarkup(<ActivityKeysHelp on onChange={() => {}} />);
    expect(text(on)).toContain('Use these keys on this device');
    expect(on).toMatch(/<input type="checkbox" checked=""/);
    expect(renderToStaticMarkup(<ActivityKeysHelp on={false} onChange={() => {}} />)).not.toContain('checked');
    expect(text(on)).toContain('Approve what is listed (it asks first)');
  });
});

describe('Card Mode’s cards', () => {
  test('the category list is open only on the card it was opened on: a card dealt back under it never takes what was picked for another', () => {
    // Opened on Blue Bottle and moved to Home improvement; then Costco's
    // approval fails and Costco is dealt again under it.
    const picker = { id: 't_blue', draft: 'c-home' };
    expect(pickerOn(picker, 't_blue')).toBe(picker);
    expect(pickerOn(picker, 't_costco')).toBeNull();
    expect(pickerOn(picker, null)).toBeNull();
    expect(pickerOn(null, 't_blue')).toBeNull();
    // And the view closes it whenever the card's id changes (the effect on it),
    // so Blue Bottle coming back shows its own category, not the old pick.
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'CardMode.tsx'), 'utf8');
    expect(source).toMatch(/useEffect\(\(\) => \{\s*acting\.current = null;[\s\S]*?setPicker\(null\);\s*\}, \[id\]\);/);
    expect(source).toMatch(/const open = pickerOn\(picker, id\);/);
  });

  test('dealt, each done in turn, the last undone, the skipped dealt again, and the end', () => {
    const waiting = new Set(['a', 'b', 'c']);
    const waits = (id: string) => waiting.has(id);
    let c = openCards<string>(['a', 'b', 'c', 'a']);
    expect(c.queue).toEqual(['a', 'b', 'c']);
    expect([currentCard(c, waits), cardPosition(c, 'a')]).toEqual(['a', { at: 1, of: 3 }]);
    c = withStep(c, { id: 'a', kind: 'approved', undo: 'ticket-a' });
    c = withStep(c, { id: 'b', kind: 'skipped' });
    expect([currentCard(c, waits), cardPosition(c, 'c')]).toEqual(['c', { at: 3, of: 3 }]);
    // Undo: the last step comes back with what undoes it.
    const undone = undoStep(c);
    expect(undone.step).toEqual({ id: 'b', kind: 'skipped' });
    expect(currentCard(undone.cards, waits)).toBe('b');
    c = withStep(c, { id: 'c', kind: 'recategorized', undo: 'ticket-c' });
    expect(currentCard(c, waits)).toBeNull();
    expect(cardCounts(c)).toEqual({ approved: 1, recategorized: 1, skipped: 1 });
    expect(endWords(cardCounts(c))).toEqual({ title: 'Done for now', detail: 'You approved 2 transactions, 1 of them with a new category. 1 you skipped still needs review.' });
    // The skipped dealt again, the rest of the session kept: the end card
    // counts all of it, and Undo still reaches back into the first round.
    const again = dealSkipped(c);
    expect(currentCard(again, waits)).toBe('b');
    expect(cardCounts(again)).toEqual({ approved: 1, recategorized: 1, skipped: 0 });
    expect(undoStep(again).step).toEqual({ id: 'c', kind: 'recategorized', undo: 'ticket-c' });
    expect(endWords(cardCounts(withStep(again, { id: 'b', kind: 'approved' })))).toEqual({ title: 'All caught up', detail: 'You approved 3 transactions, 1 of them with a new category.' });
    // A card approved elsewhere meanwhile is passed over.
    waiting.delete('b');
    expect(currentCard(openCards(['b', 'c']), waits)).toBe('c');
    // A step that didn't save is taken out, so the card comes back.
    expect(currentCard(withoutStep(c, 'c'), (id) => id === 'c')).toBe('c');
    expect(undoStep(openCards([])).step).toBeNull();
  });

  test('all caught up, with a count', () => {
    expect(endWords({ approved: 3, recategorized: 0, skipped: 0 })).toEqual({ title: 'All caught up', detail: 'You approved 3 transactions.' });
    expect(endWords({ approved: 0, recategorized: 1, skipped: 0 })).toEqual({ title: 'All caught up', detail: 'You approved 1 transaction, 1 of them with a new category.' });
    expect(endWords({ approved: 0, recategorized: 0, skipped: 0 })).toEqual({ title: 'All caught up', detail: 'Nothing is waiting for review.' });
    expect(doneWords('approved', 'Costco', 2)).toBe('Approved Costco. 2 left.');
    expect(doneWords('skipped', 'Costco', 0)).toBe('Skipped Costco. Nothing left to review.');
  });

  test('the cards dealt are transactions: a split one once, whole; each of a group’s on its own; newest first', () => {
    const parts = [
      txn('split:p1', { split_of: 't_split', split_index: 0, split_count: 2, split_parent: { amount: 100 }, amount: 60, needs_review: true }),
      txn('split:p2', { split_of: 't_split', split_index: 1, split_count: 2, split_parent: { amount: 100 }, amount: 40, needs_review: true }),
    ];
    const group = txn('group:g1', { group_id: 'g1', group_members: [txn('t_a', { group_id: 'g1', needs_review: true }), txn('t_b', { group_id: 'g1' })] });
    const rows = [txn('t_new', { needs_review: true }), ...parts, group, txn('t_done', { reviewed_at: '2026-10-01T00:00:00.000Z' })];
    expect(cardsToDeal(rows)).toEqual(['t_new', 't_split', 't_a']);
    expect(listedToReview(rows).map((t) => t.transaction_id)).toEqual(['t_new', 't_split', 't_a']);
  });

  test('a card shows the merchant, the amount, the day, the account, the category, the note and the tags, with a button for every swipe', () => {
    const rows = [txn('t1', { needs_review: true, note: 'bulk paper towels', tags: ['tag-1'], filed_by_default: { id: 'v1', agree: 2 }, review_changed: { amount: 50, currency: 'USD' } })];
    const html = renderToStaticMarkup(
      <CardMode open txns={rows} taxonomy={taxonomy} tags={[{ id: 'tag-1', name: 'House', color: 'blue', created_at: '' } as any]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />
    );
    const t = text(html);
    expect(t).toContain('Costco');
    expect(t).toContain('-$54.20');
    expect(t).toContain('Chase · Card');
    expect(t).toContain('General merchandise');
    expect(t).toContain('bulk paper towels');
    expect(t).toContain('House');
    expect(t).toContain('Filed by your default for Costco (two of your last three)');
    expect(t).toContain('The bank changed the amount since you approved it at $50.00 out.');
    expect(t).toContain('1 of 1');
    // A button for every swipe, and the rest.
    for (const label of ['Recategorize', 'Skip', 'Approve', 'Split', 'Group', 'Undo', 'Close']) expect(html).toContain(label);
    // Undo has nothing to undo yet.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Undo<\/button>/);
    // A dialog a screen reader announces, the card a group it can focus.
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-roledescription="card"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('tabindex="0"');
    // What Enter approves, said before it is: the merchant, the amount and the category.
    expect(html).toContain('aria-label="Costco, -$54.20, General merchandise. Transaction 1 of 1. Enter approves it."');
  });

  test('its category list chooses only on Use: moving through it changes what it shows, never what is saved', () => {
    const drafts: string[] = [];
    let used = 0;
    const el = CardCategoryPicker({ taxonomy, merchant: 'Costco', value: cat('groceries'), useLabel: 'Groceries', onDraft: (c) => drafts.push(c), onUse: () => used++, onCancel: () => {} });
    const all = elementsIn(el);
    const list = all.find((e) => e.type === CategoryPicker)!;
    (list.props as { onChange: (id: string) => void }).onChange(cat('household'));
    expect([drafts, used]).toEqual([[cat('household')], 0]);
    const use = all.find((e) => e.type === 'button' && text(renderToStaticMarkup(e)) === 'Use Groceries')!;
    (use.props as { onClick: () => void }).onClick();
    expect(used).toBe(1);
    expect(text(renderToStaticMarkup(el))).toContain('Use Groceries');
  });

  test('a group’s transaction is grouped, never split, from its card; a split one shows no offer that files nothing', () => {
    const group = txn('group:g1', { group_id: 'g1', name: 'Dinner', group_members: [txn('t_a', { group_id: 'g1', needs_review: true })] });
    const grouped = renderToStaticMarkup(<CardMode open txns={[group]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />);
    expect(grouped).toMatch(/<button[^>]*disabled=""[^>]*>Split<\/button>/);
    expect(grouped).toContain('Edit group');
    const offers = { filed_by_default: { id: 'v1', agree: 2 }, review_suggestion: { category_id: cat('household'), by: 'rule' as const, rule_id: 'r1' }, needs_review: true as const };
    const parts = [
      txn('split:p1', { split_of: 't_split', split_index: 0, split_count: 2, split_parent: { amount: 100 }, amount: 60, category_id: cat('groceries'), category_name: 'groceries', ...offers }),
      txn('split:p2', { split_of: 't_split', split_index: 1, split_count: 2, split_parent: { amount: 100 }, amount: 40, category_id: cat('household'), category_name: 'household', ...offers }),
    ];
    const split = text(renderToStaticMarkup(<CardMode open txns={parts} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />));
    expect(split).not.toContain('Filed by your default');
    expect(split).not.toContain('Your rule would file it');
    // Unsplit, both are said.
    const whole = text(renderToStaticMarkup(<CardMode open txns={[txn('t1', offers)]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />));
    expect(whole).toContain('Filed by your default for Costco (two of your last three)');
    expect(whole).toContain('Your rule would file it under Household.');
  });

  test('a pending one can’t be split or grouped yet; a split one is recategorized by its parts', () => {
    const pending = renderToStaticMarkup(<CardMode open txns={[txn('t1', { needs_review: true, pending: true })]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />);
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>Split<\/button>/);
    expect(text(pending)).toContain('Once it posts, it can be split or grouped with others.');
    const parts = [
      txn('split:p1', { split_of: 't_split', split_index: 0, split_count: 2, split_parent: { amount: 100, category_id: cat('general merchandise'), category_name: 'general merchandise' }, amount: 60, category_id: cat('groceries'), category_name: 'groceries', needs_review: true }),
      txn('split:p2', { split_of: 't_split', split_index: 1, split_count: 2, split_parent: { amount: 100, category_id: cat('general merchandise'), category_name: 'general merchandise' }, amount: 40, category_id: cat('household'), category_name: 'household', needs_review: true }),
    ];
    const split = renderToStaticMarkup(<CardMode open txns={parts} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />);
    expect(text(split)).toContain('-$100.00');
    expect(text(split)).toContain('Groceries -$60.00');
    expect(split).toMatch(/<button[^>]*disabled=""[^>]*>Recategorize<\/button>/);
    expect(split).toContain('Edit split');
  });

  test('with nothing to review, the end card at once', () => {
    const html = renderToStaticMarkup(<CardMode open txns={[txn('t1')]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />);
    expect(text(html)).toContain('All caught up Nothing is waiting for review.');
    expect(renderToStaticMarkup(<CardMode open={false} txns={[txn('t1')]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />)).toBe('');
  });
});

describe('the Activity tab', () => {
  test('the bar counts transactions, offers Card Mode and the filter, and approving what is listed; nothing while the queue is off', () => {
    const rows = [txn('t1', { needs_review: true }), txn('t2', { needs_review: true }), txn('t3')];
    const html = renderToStaticMarkup(<ReviewBar review={controls()} all={rows} listed={rows.slice(0, 1)} filtering={false} onFilter={() => {}} onReview={() => {}} />);
    expect(text(html)).toContain('2 to review');
    expect(text(html)).toContain('Review one at a time');
    expect(html).toContain('aria-pressed="false"');
    expect(text(html)).toContain('Approve the 1 listed');
    expect(renderToStaticMarkup(<ReviewBar review={controls(false)} all={rows} listed={rows} filtering={false} onFilter={() => {}} onReview={() => {}} />)).toBe('');
    expect(toReviewWords(0)).toBe('Nothing to review');
    // Where focus comes back when Card Mode closes with nothing left (its way in disabled).
    expect(html).toMatch(/<span class="review-count"[^>]*tabindex="-1"[^>]*data-review-return=""/);
  });

  test('approvals near the most kept: the Review queue card offers to make room, before approving is refused', () => {
    expect(nearFull(null)).toBe(false);
    expect(nearFull({ kept: 39_999, max: 50_000, room: 10_000 })).toBe(false);
    expect(nearFull({ kept: 40_000, max: 50_000, room: 10_000 })).toBe(true);
    expect(nearFull({ kept: 50_000, max: 50_000, room: 10_000 })).toBe(true);
  });

  test('the keys’ switch is on the Review queue card too, always within reach, and both places show one value', () => {
    // On the card while the queue is on, whatever the device: "?" and the
    // help's link aren't there once the keys are off, or on a touch screen.
    const card = renderToStaticMarkup(<ReviewSettingsCard review={controls()} toReview={2} />);
    expect(text(card)).toContain('Keyboard shortcuts on the Activity tab (R, N, Shift+A, U), on this device');
    expect(card).toMatch(/<label class="review-keys-switch"><input type="checkbox" checked=""/);
    // One value for the page: turned off in one place, every place that shows it hears.
    forgetActivityKeysForTests();
    const heard: boolean[] = [];
    const stop = subscribeActivityKeys(() => heard.push(activityKeysNow()));
    try {
      expect(activityKeysNow()).toBe(true);
      setActivityKeys(false);
      setActivityKeys(true);
      expect(heard).toEqual([false, true]);
    } finally {
      stop();
      forgetActivityKeysForTests();
    }
  });

  test('Card Mode’s live region is left at one pixel, so the page never scrolls sideways', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8');
    expect(css).toContain('.card-mode > :where(:not(.visually-hidden)) {');
    expect(css).not.toMatch(/\.card-mode > \* \{/);
  });

  test('the Needs review filter is one more filter of the list: a split transaction whole, a group by its transactions', () => {
    const rows = [
      txn('t1', { needs_review: true }),
      txn('t2'),
      txn('split:p1', { split_of: 't_s', needs_review: true }),
      txn('split:p2', { split_of: 't_s', needs_review: true }),
      txn('group:g', { group_members: [txn('t_m', { needs_review: true })] }),
    ];
    expect(searchEntries(rows, { query: '', tag: '', review: true }, []).map((t) => t.transaction_id)).toEqual(['t1', 'split:p1', 'split:p2', 'group:g']);
    expect(searchEntries(rows, { query: 'zzz', tag: '', review: true }, []).length).toBe(0);
    expect(searchEntries(rows, { query: '', tag: '' }, []).length).toBe(5);
  });

  test('a transaction’s detail says what its review is, and what can be done', () => {
    const say = (t: Txn) => text(renderToStaticMarkup(<ReviewNote t={t} taxonomy={taxonomy} review={controls()} onChanged={() => {}} />));
    expect(say(txn('t1', { needs_review: true }))).toBe('Waiting for you to approve it as it is. Approve');
    expect(say(txn('t1', { needs_review: true, review_changed: { amount: 50, currency: 'USD' } }))).toContain('The bank changed the amount since you approved it at $50.00 out.');
    const approved = say(txn('t1', { reviewed_at: '2026-10-11T09:00:00.000Z', approved_name: 'COSTCO WHSE', review_suggestion: { category_id: cat('household'), by: 'rule', rule_id: 'r1' } }));
    expect(approved).toContain('as “COSTCO WHSE”. Its category stays as you approved it until you change it. Review again');
    expect(approved).toContain('Your rule would file it under Household. It stays where you approved it until you choose. Use Household');
    expect(say(txn('t1', { filed_by_default: { id: 'v1', agree: 3 } }))).toBe('Filed by your default for Costco (three of your last three). Clear default');
    expect(say(txn('t1', { review_unknown: true }))).toContain('Whether you approved this couldn\'t be read');
    // Back in the queue since the bank changed its amount: still offered what would file it elsewhere.
    const waiting = say(txn('t1', { needs_review: true, review_changed: { amount: 50, currency: 'USD' }, review_suggestion: { category_id: cat('household'), by: 'rule', rule_id: 'r1' } }));
    expect(waiting).toContain('The bank changed the amount since you approved it at $50.00 out. Approve');
    expect(waiting).toContain('Your rule would file it under Household. It stays where you approved it until you choose. Use Household');
    // A split one: what would file the whole files nothing that counts, so it isn't offered.
    const parts = [txn('split:p1', { split_of: 't_s', split_index: 0, split_count: 1, split_parent: { amount: 54.2 } })];
    expect(say({ ...txn('t_s', { reviewed_at: '2026-10-11T09:00:00.000Z', filed_by_default: { id: 'v1', agree: 2 }, review_suggestion: { category_id: cat('household'), by: 'rule', rule_id: 'r1' } }), split_parts: parts } as Txn)).not.toMatch(/Use Household|Filed by/);
    // A default that moved since filed this day under the category it had then.
    expect(say(txn('t1', { filed_by_default: { id: 'v1', agree: 2, earlier: true } }))).toBe('Filed by your default for Costco, in the category it had on this day (it has moved since). Clear default');
    // A row from a file changed by an edit that couldn't carry its approval: never put on the bank.
    expect(changedSinceWords({ amount: 64.5, currency: 'USD' }, { source: 'import:ofx' }, true)).toBe('The amount changed since you approved it at $64.50 out.');
    expect(changedSinceWords({ amount: 64.5, currency: 'USD' }, { source: 'simplefin' }, true)).toBe('The bank changed the amount since you approved it at $64.50 out.');
    expect(say(txn('group:g', { group_members: [txn('t_a', { needs_review: true }), txn('t_b', { needs_review: true })] }))).toBe('2 of its transactions need review. Approve them');
    expect(say(txn('t1'))).toBe('');
  });

  test('a bank row standing for one imported from its file, approved at the file’s amount, says the bank changed it once', () => {
    // As the read layer leaves it once the bank changed its amount (#52's kept pair).
    const twin = txn('b_costco', { amount: 160.5, needs_review: true, review_changed: { amount: 150, currency: 'USD' }, imported_amount: 150 });
    expect(approvedAsImported(twin.review_changed!, twin)).toBe(true);
    // On the Activity tab the row's own note says it (lib/history-import/view.ts
    // importedChangedNote): the detail adds only the approval.
    const detail = text(renderToStaticMarkup(<ReviewNote t={twin} taxonomy={taxonomy} review={controls()} onChanged={() => {}} />));
    expect(detail).toBe('You approved it at the amount it was imported at, before the bank changed it. Approve');
    // Card Mode, without the row's note, says the two in one.
    const card = (t: Txn) => text(renderToStaticMarkup(<CardMode open txns={[t]} taxonomy={taxonomy} tags={[]} currency="USD" review={controls()} onClose={() => {}} onSplit={() => {}} onGroup={() => {}} />));
    const one = card(twin);
    expect(one).toContain('You approved it at $150.00 out, the amount it was imported at. The bank has changed its amount since, so it counts once, at the bank’s amount.');
    expect(one.match(/changed (?:its|the) amount/g)).toHaveLength(1);
    // Approved since at another amount the bank changed again: two things,
    // each with its own figure.
    const again = { ...twin, review_changed: { amount: 158.25, currency: 'USD' } };
    expect(approvedAsImported(again.review_changed, again)).toBe(false);
    expect(changedSinceWords(again.review_changed, again, true)).toBe('The bank changed the amount since you approved it at $158.25 out.');
    const two = card(again);
    expect(two).toContain('The bank changed the amount since you approved it at $158.25 out.');
    expect(two).toContain('This is the transaction you imported from a file at $150.00. The bank has changed its amount since, so it counts once, at the bank’s amount.');
    // Never approved: the card says what the row says; another currency is another amount.
    expect(card({ ...twin, review_changed: undefined })).toContain('This is the transaction you imported from a file at $150.00.');
    expect(approvedAsImported({ amount: 150, currency: 'CAD' }, twin)).toBe(false);
    expect(approvedAsImported({ amount: 150, currency: 'USD' }, { ...twin, imported_amount: undefined })).toBe(false);
    expect(changedSinceWords({ amount: 50, currency: 'USD' }, txn('t1'), false)).toBe(changedWords({ amount: 50, currency: 'USD' }));
  });

  test('approved at once, and undone at once, a split one’s parts and a group’s transactions with it', () => {
    const rows = [
      txn('t1', { needs_review: true, review_changed: { amount: 1, currency: 'USD' } }),
      txn('split:p1', { split_of: 't_s', needs_review: true }),
      txn('group:g', { group_members: [txn('t_m', { needs_review: true })] }),
    ];
    const at = '2026-10-17T10:00:00.000Z';
    const approved = withApproved(rows, new Set(['t1', 't_s', 't_m']), at);
    expect(approved.map((t) => [t.needs_review, t.reviewed_at, t.review_changed])).toEqual([
      [undefined, at, undefined],
      [undefined, at, undefined],
      [undefined, undefined, undefined],
    ]);
    expect(approved[2].group_members![0]).toMatchObject({ reviewed_at: at });
    const undone = withUndone(approved, { items: [{ transaction_id: 't1', approved_at: at, previous: null }, { transaction_id: 't_s', approved_at: at, previous: { version: 1, approved_at: '2026-10-01T00:00:00.000Z', amount: 1, currency: 'USD', category_id: null, name: 'x' } }] });
    expect([undone[0].needs_review, undone[0].reviewed_at]).toEqual([true, undefined]);
    expect(undone[1].reviewed_at).toBe('2026-10-01T00:00:00.000Z');
  });

  test('the queue’s state, as each load sends it', () => {
    expect(reviewViewOf({ on: true, since: '2026-10-01', unread: false, unknown: 2 })).toEqual({ on: true, since: '2026-10-01', unread: false, unknown: 2 });
    expect(reviewViewOf({ on: true, since: '2026-10-01', unread: false })).toEqual({ on: true, since: '2026-10-01', unread: false, unknown: 0 });
    expect(reviewViewOf({ on: 'yes' })).toBeNull();
    expect(reviewViewOf(undefined)).toBeNull();
  });
});

describe('a merchant’s default', () => {
  test('a recategorization says which merchant, when the row has one; an own category clears what a default or an offer said', () => {
    expect(merchantOf(txn('t1'))).toEqual({ vendor_key: 'nm:chase::costco', name: 'Costco', today });
    expect(merchantOf(txn('t1', { vendor_key: '' }))).toEqual({});
    expect(merchantOf(txn('t1', { vendor_key: `nm:${'x'.repeat(300)}` }))).toEqual({});
    expect(merchantOf(txn('t1', { name: 'x'.repeat(150) })).name).toHaveLength(100);
    expect(recategorizedRow(undefined, { category_id: cat('groceries') }, taxonomy)).toMatchObject({ category_name: 'groceries', filed_by_default: undefined, review_suggestion: undefined });
  });

  test('the words', () => {
    expect(defaultWords('Costco', 2)).toBe('Filed by your default for Costco (two of your last three)');
    expect(defaultWords('Costco', 1)).toBe('Filed by your default for Costco (set when two of your last three agreed)');
    expect(defaultListWords({ since: '2026-10-03', agree: 3 }, (d) => d)).toBe('Since 2026-10-03, three of your last three agree');
    expect(suggestionWords({ category_id: 'x', by: 'default' }, 'Groceries', 'Costco')).toBe('Your default for Costco would file it under Groceries. It stays where you approved it until you choose.');
    expect(suggestionWords({ category_id: 'x', by: 'bank' }, 'Shopping', 'Costco')).toBe('Your bank now files it under Shopping. It stays where you approved it until you choose.');
    expect(changedWords({ amount: -20, currency: 'USD' })).toBe('The bank changed the amount since you approved it at $20.00 in.');
  });
});

describe('the settings under Manage', () => {
  test('off: where it starts from, never further back than a month; on: since when, and how many wait', () => {
    expect(startChoices('2026-10-17').map((c) => c.value)).toEqual(['2026-10-17', '2026-10-10', '2026-09-17']);
    const off = text(renderToStaticMarkup(<ReviewSettingsCard review={controls(false)} toReview={0} />));
    expect(off).toContain('Approve new transactions as they arrive');
    expect(off).toContain('New transactions from today');
    expect(off).toContain('Turn on');
    const on = text(renderToStaticMarkup(<ReviewSettingsCard review={controls(true)} toReview={3} />));
    expect(on).toContain('3 waiting now');
    expect(on).toContain('Turn off');
    expect(on).toContain('Turning it off keeps your approvals.');
  });
});
