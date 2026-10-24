import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NeedsAttention, { AdminAttention } from '@/components/NeedsAttention';
import { attentionItems, type AttentionItem } from '@/components/attention';
import { paymentAlerts } from '@/components/Insights';
import { NOTHING } from './home-attention';
import { CurrencyOfferSheet } from '@/components/CurrencyNotes';
import { MASK, setAmountsHidden } from '@/lib/format';

// Home's Needs attention card (rollout phase 4b): only when something asks
// the person to act; each row a button with its level as an icon and a word,
// and what a budget row's month may be missing right after the budget rows.

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const none = { leftOut: null, missing: [] };
const item = (key: string, severity: AttentionItem['severity'], title: string, over: Partial<AttentionItem> = {}): AttentionItem => ({ key, severity, title, go: { to: 'review' }, ...over });
const render = (items: AttentionItem[], notes: { leftOut: string | null; missing: string[] } = none) => renderToStaticMarkup(<NeedsAttention items={items} notes={notes} onGo={() => {}} />);

describe('the card', () => {
  test('nothing at all when nothing needs the person', () => {
    expect(render([])).toBe('');
  });

  test('a heading that holds the count, then a row per item, each a button', () => {
    const html = render([item('a', 'critical', 'Chase', { sub: 'Needs reconnecting' }), item('b', 'info', 'Transactions to review', { sub: '12 to review' })]);
    expect(html).toContain('<h2 id="needs-attention-title" tabindex="-1">Needs attention <span class="meta">2</span><span class="visually-hidden"> items</span></h2>');
    expect(html.match(/<button type="button" class="list-row">/g)).toHaveLength(2);
    expect(text(html)).toContain('Critical: Chase Needs reconnecting');
    expect(text(html)).toContain('Information: Transactions to review 12 to review');
  });

  test('its level is a shape and a word as well as a color: never color alone', () => {
    const html = render([item('a', 'critical', 'A'), item('b', 'caution', 'B'), item('c', 'info', 'C')]);
    for (const level of ['critical', 'caution', 'info']) expect(html).toContain(`<span class="list-row-icon ${level}"><svg`);
    expect(html.match(/class="visually-hidden">(Critical|Caution|Information): </g)).toHaveLength(3);
    // Three icons, each its own path.
    const paths = [...html.matchAll(/class="list-row-icon [a-z]+"><svg[^>]*><path d="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(paths).size).toBe(3);
  });

  test('what the month may be missing follows the last budget row, not the foot of the list', () => {
    const notes = { leftOut: '2 transactions in EUR aren’t in these figures, which are in USD.', missing: ["Chase hasn't synced since Sep 12, so this month may be missing some of its transactions."] };
    const html = render([item('budget-a', 'caution', 'Over your Food budget', { spending: true }), item('review', 'info', 'Transactions to review')], notes);
    const t = text(html);
    expect(t.indexOf('Over your Food budget')).toBeLessThan(t.indexOf("Chase hasn't synced"));
    expect(t.indexOf("Chase hasn't synced")).toBeLessThan(t.indexOf('Transactions to review'));
    expect(html).toContain('<div class="notice caution">');
    expect(html).toContain('<div class="notice info">');
    // With no budget row, nothing is said.
    expect(text(render([item('review', 'info', 'Transactions to review')], notes))).not.toContain('synced');
  });

  test('hide amounts masks the figures in a row’s words', () => {
    const g = globalThis as Record<string, unknown>;
    const blank = g.window === undefined;
    if (blank) g.window = {};
    try {
      setAmountsHidden(true);
      const due = new Date(Date.now() + 86_400_000);
      const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
      const payments = paymentAlerts([
        { item_id: 'i', account_id: 'a', name: 'Amex', type: 'credit', balance: 500, currency: 'USD', liability: { minimum_payment: 35.12, next_due_date: day, is_overdue: false } },
      ]);
      const html = render(attentionItems({ ...NOTHING, payments }));
      expect(html).not.toContain('35.12');
      expect(html).toContain(MASK);
      expect(text(html)).toContain('due tomorrow');
    } finally {
      setAmountsHidden(false);
      if (blank) delete g.window;
    }
  });
});

describe('the admin’s card: what to do about the nightly jobs', () => {
  test('the fact, then where to look; nothing while the clean-up only waits for a backup', () => {
    const backup = text(renderToStaticMarkup(<AdminAttention backup={{ last_ok: '2026-10-20T03:00:00Z', reason: 'timeout' }} files={null} />));
    expect(backup).toContain('Admin');
    expect(backup).toContain('The nightly backup failed; the last one saved was on Oct 20. (timeout) Check the backup cron in Vercel.');
    expect(text(renderToStaticMarkup(<AdminAttention backup={null} files={{ last_ok: null, reason: null, held: true }} />))).toContain(
      'so it removed none of them there. Its log in Vercel names the account.'
    );
    expect(text(renderToStaticMarkup(<AdminAttention backup={null} files={{ last_ok: '2026-10-19T03:00:00Z', reason: 'quota', held: false }} />))).toContain(
      'Check the clean-up cron in Vercel.'
    );
    expect(renderToStaticMarkup(<AdminAttention backup={null} files={{ last_ok: null, reason: null, held: false, paused: true }} />)).toBe('');
    expect(renderToStaticMarkup(<AdminAttention backup={null} files={null} />)).toBe('');
  });

  test('plain rows: the fix is in Vercel, so nothing to tap', () => {
    const html = renderToStaticMarkup(<AdminAttention backup={{ last_ok: null, reason: null, none: true }} files={null} />);
    expect(html).not.toContain('<button');
    expect(html).toContain('<div class="list-row">');
  });
});

describe('the offer of a home currency, in a sheet', () => {
  test('closed, nothing; its words are the card’s, tested in currency-views', () => {
    expect(renderToStaticMarkup(<CurrencyOfferSheet open={false} offer={{ budgets: 'USD', accounts: 'EUR' }} onClose={() => {}} onChoose={() => {}} onDismiss={() => {}} />)).toBe('');
  });
});
