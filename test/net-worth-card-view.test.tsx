import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthCard from '@/components/NetWorthCard';
import type { Caveat } from '@/components/TotalCaveats';
import { MASK, setAmountsHidden } from '@/lib/format';

// Home's one Net worth card (rollout phase 4a): the total, its caveats, the
// chart's notes, the nightly jobs (the instruction only for the admin), and
// the foot row.

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
      admin={false}
      asOf="2026-10-23T09:14:00Z"
      refreshing={false}
      notesCount={0}
      onNotes={noop}
      {...over}
    />
  );

const caveat = (key: string, severity: Caveat['severity'], summary: string): Caveat => ({ key, severity, summary, body: `${summary} in full` });

describe('the card', () => {
  test('a heading, the total, and the foot row', () => {
    const html = render();
    expect(html).toContain('<h2 id="net-worth-title" class="total-label">Net worth</h2>');
    expect(html).toContain('$125,000.50');
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
    } finally {
      setAmountsHidden(false);
      if (none) delete g.window;
    }
  });
});

describe('the nightly jobs: the fact to everyone, the instruction only to the admin', () => {
  const backup = { last_ok: '2026-10-20T03:00:00Z', reason: 'timeout' };

  test('a failed backup', () => {
    const everyone = text(render({ backupProblem: backup }));
    expect(everyone).toContain('The nightly backup failed; the last one saved was on Oct 20. (timeout)');
    expect(everyone).not.toContain('Vercel');
    expect(text(render({ backupProblem: backup, admin: true }))).toContain('The nightly backup failed; the last one saved was on Oct 20. (timeout) Check the backup cron in Vercel.');
  });

  test('no backup yet', () => {
    expect(text(render({ backupProblem: { last_ok: null, reason: null, none: true }, admin: true }))).toContain('No nightly backup has been recorded yet. Check the backup cron in Vercel.');
  });

  test('the receipt clean-up: held back names where to look, only for the admin; paused has no instruction', () => {
    const held = { last_ok: null, reason: null, held: true };
    expect(text(render({ filesProblem: held }))).not.toContain('Vercel');
    expect(text(render({ filesProblem: held, admin: true }))).toContain('so it removed none of them there. Its log in Vercel names the account.');
    const paused = { last_ok: null, reason: null, held: false, paused: true as const };
    expect(text(render({ filesProblem: paused, admin: true }))).toBe(
      text(render({ filesProblem: paused, admin: false }))
    );
    expect(text(render({ filesProblem: { last_ok: '2026-10-19T03:00:00Z', reason: 'quota', held: false }, admin: true }))).toContain(
      'The nightly clean-up of receipts and documents failed; the last one finished on Oct 19. (quota) Check the clean-up cron in Vercel.'
    );
  });
});
