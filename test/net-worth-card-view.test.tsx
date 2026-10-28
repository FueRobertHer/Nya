import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthCard, { HeroDelta } from '@/components/NetWorthCard';
import { allHiddenCaveats, type Caveat } from '@/components/TotalCaveats';
import { MASK, setAmountsHidden } from '@/lib/format';

// Home's one Net worth card (rollout phase 4a): the total, its caveats, the
// chart's notes, the nightly jobs (the fact; what to do is the admin's, in
// Needs attention since 4b), and the foot row.

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

type Props = ComponentProps<typeof NetWorthCard>;
const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <NetWorthCard
      worth={125000.5}
      currency="USD"
      delta={null}
      caveats={[]}
      chart={<div className="chart-placeholder" />}
      pausedSince={null}
      notesProblem={null}
      backupProblem={null}
      filesProblem={null}
      asOf="2026-10-23T09:14:00Z"
      refreshing={false}
      notesCount={0}
      onNotes={noop}
      {...over}
    />
  );

const caveat = (key: string, severity: Caveat['severity'], summary: string): Caveat => ({ key, severity, summary, body: `${summary} in full` });

describe('the card', () => {
  // Look and feel, step 5: the hero stands on the page, not in a card; what
  // it holds, and in what order, is as it was.
  test('on the page, not in a card: the total, its change line, what qualifies it, the chart, the foot', () => {
    const html = render({ caveats: [caveat('rates', 'info', 'Converted at old rates')], delta: <div className="hero-delta up">past 30 days</div> });
    expect(html).toContain('<section class="stack net-worth-hero" aria-labelledby="net-worth-title">');
    expect(html).not.toMatch(/class="[^"]*\bcard\b/);
    const order = ['net-worth-title', 'total-value', 'class="hero-line"', 'past 30 days', 'Converted at old rates', 'chart-placeholder', 'net-worth-foot'].map((s) => html.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('a heading, the total, and the foot row', () => {
    const html = render();
    expect(html).toContain('<h2 id="net-worth-title" class="total-label" tabindex="-1">Net worth</h2>');
    // Said whole, drawn with its cents apart (look and feel, step 3).
    expect(html).toContain('<span class="visually-hidden">$125,000.50</span>');
    expect(html).toContain('<span aria-hidden="true">$125,000<span class="cents">.50</span></span>');
    expect(text(html)).toContain('Updated');
    expect(html).toContain('>Chart notes</button>');
    expect(html).not.toContain('History paused');
  });

  test('chart notes are counted on their button', () => {
    expect(render({ notesCount: 2 })).toContain('>Chart notes (2)</button>');
  });

  test('history paused: its sentence under the chart and a badge in the foot row', () => {
    const html = render({ pausedSince: '2026-10-20' });
    expect(html).toContain('<span class="badge warn">History paused</span>');
    expect(text(html)).toContain('No net-worth total has been saved since Oct 20. A day is only saved when every institution refreshes with all of its accounts, so it picks up again once they do.');
    expect(html.indexOf('chart-placeholder')).toBeLessThan(html.indexOf('No net-worth total'));
  });

  test('what qualifies the total sits under it, before the chart', () => {
    const html = render({ caveats: [caveat('a', 'critical', 'Chase not counted')] });
    expect(html.indexOf('Chase not counted in full')).toBeLessThan(html.indexOf('chart-placeholder'));
    expect(html).toContain('<div class="notice critical">');
  });

  test('chart notes that couldn’t be read are said on the card, in amber', () => {
    expect(text(render({ notesProblem: 'Your notes couldn’t be read just now, so the chart shows none.' }))).toContain('Your notes couldn’t be read just now, so the chart shows none.');
  });

  test('hide amounts masks the total', () => {
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    try {
      setAmountsHidden(true);
      const html = render();
      expect(html).not.toContain('125,000');
      expect(html).toContain(MASK);
      // No cents to draw apart, and the mask is said as "hidden".
      expect(html).not.toContain('class="cents"');
      expect(text(html)).toContain('hidden');
    } finally {
      setAmountsHidden(false);
      if (none) delete g.window;
    }
  });
});

// The header's line under the name went (look and feel, step 2a); with every
// account hidden, the total says why it counts nothing.
describe('every account hidden', () => {
  test('said under the total, as information, and where to unhide one', () => {
    const t = text(render({ worth: 0, caveats: allHiddenCaveats(0, 3) }));
    expect(t).toContain('All 3 accounts are hidden, so the total counts nothing. Unhide one from Hidden on the Accounts tab.');
    expect(allHiddenCaveats(0, 1)[0].body).toBe('Your one account is hidden, so the total counts nothing. Unhide one from Hidden on the Accounts tab.');
    expect(allHiddenCaveats(0, 3)[0].severity).toBe('info');
  });

  test('nothing while an account is shown, or with none hidden', () => {
    expect(allHiddenCaveats(1, 3)).toEqual([]);
    expect(allHiddenCaveats(0, 0)).toEqual([]);
  });
});

describe('the nightly jobs: the fact, to everyone, with no instruction on the card', () => {
  test('a failed backup, and none yet', () => {
    const failed = text(render({ backupProblem: { last_ok: '2026-10-20T03:00:00Z', reason: 'timeout' } }));
    expect(failed).toContain('The nightly backup failed; the last one saved was on Oct 20. (timeout)');
    expect(failed).not.toContain('Vercel');
    expect(text(render({ backupProblem: { last_ok: null, reason: null, none: true } }))).toContain('No nightly backup has been recorded yet.');
  });

  test('the receipt clean-up: failed, held back, paused', () => {
    const failed = text(render({ filesProblem: { last_ok: '2026-10-19T03:00:00Z', reason: 'quota', held: false } }));
    expect(failed).toContain('The nightly clean-up of receipts and documents failed; the last one finished on Oct 19. (quota)');
    const held = text(render({ filesProblem: { last_ok: null, reason: null, held: true } }));
    expect(held).toContain('so it removed none of them there.');
    for (const t of [failed, held]) expect(t).not.toContain('Vercel');
    expect(text(render({ filesProblem: { last_ok: null, reason: null, held: false, paused: true } }))).toContain('is paused until a nightly backup is recorded');
  });
});

describe('the change line', () => {
  const line = (value: number, more: { endedIn?: number; fromRates?: string; currency?: string; days?: number } = {}) =>
    renderToStaticMarkup(<HeroDelta delta={{ value, pct: (Math.abs(value) / 1000) * 100, days: more.days ?? 30 }} currency={more.currency ?? 'USD'} endedIn={more.endedIn ?? 0} fromRates={more.fromRates ?? ''} />);

  test('a gain is green with an up arrow, a loss red with a down arrow, each with how much', () => {
    expect(line(10)).toStartWith('<div class="hero-delta up">');
    expect(text(line(10))).toBe('▲ $10.00 (1.0%) · past 30 days');
    expect(line(-10)).toStartWith('<div class="hero-delta down">');
    expect(text(line(-10))).toBe('▼ $10.00 (1.0%) · past 30 days');
  });

  // The screen review: "▲ $0.00 (0.0%)" in green read as a gain.
  test('no change, or one that rounds to nothing in the currency, is said in words, with no arrow and not in a gain’s color', () => {
    for (const value of [0, 0.004, -0.004]) {
      const html = line(value);
      expect(html).toStartWith('<div class="hero-delta flat">');
      expect(text(html)).toBe('No change in 30 days');
      expect(html).not.toMatch(/[▲▼]/);
    }
    // A yen is the smallest unit: half of one rounds to nothing, a whole one doesn't.
    expect(text(line(0.4, { currency: 'JPY' }))).toBe('No change in 30 days');
    expect(line(1, { currency: 'JPY' })).toContain('hero-delta up');
    // What else the change holds is still said.
    expect(text(line(0, { endedIn: 2, fromRates: 'rates moved it' }))).toBe('No change in 30 days · includes 2 accounts that ended · rates moved it');
  });

  test('one day is a day', () => {
    expect(text(line(0, { days: 1 }))).toBe('No change in 1 day');
    expect(text(line(10, { days: 1 }))).toBe('▲ $10.00 (1.0%) · past 1 day');
  });

  test('with amounts hidden: the figure is masked, and no change is still said in words', () => {
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    try {
      setAmountsHidden(true);
      expect(line(10)).not.toContain('10.00');
      expect(line(10)).toContain(MASK);
      expect(text(line(0))).toBe('No change in 30 days');
    } finally {
      setAmountsHidden(false);
      if (none) delete g.window;
    }
  });
});
