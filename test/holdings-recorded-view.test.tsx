import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HoldingsRecordedLine,
  HoldingsRecordedView,
  RepairConfirm,
  afterRepair,
  recordedDay,
  requestRepair,
  summaryState,
  type RecordedSpan,
  type SummaryState,
} from '@/components/HoldingsRecorded';

// The line under an investment account's chart that says since when its
// holdings have been kept. It must never claim more than is known: not that
// they are still being recorded once recording has stopped, not "daily", not
// a day the viewer would call another, and never nothing when what is stored
// can't be read and recording has stopped.

const noop = () => {};
/** The text a person reads, apostrophes and all. */
const read = (html: string) => html.replaceAll('&#x27;', "'");
const line = (span: RecordedSpan, today = '2026-10-08', timeZone = 'UTC') =>
  read(renderToStaticMarkup(<HoldingsRecordedLine span={span} today={today} timeZone={timeZone} />));
const days = (first: string | null, last: string | null) => ({ first_recorded: first, last_recorded: last });
const view = (state: SummaryState, damagedMonths = 0) =>
  read(renderToStaticMarkup(<HoldingsRecordedView state={state} today="2026-10-08" damagedMonths={damagedMonths} onRepair={noop} />));

describe('HoldingsRecordedLine', () => {
  test('says since when, while recording is current, and never "daily"', () => {
    expect(line({ ...days('2026-09-12', '2026-10-08'), first_recorded_at: '2026-09-12T13:00:00.000Z' })).toBe('<div class="as-of">Holdings recorded since Sep 12, 2026.</div>');
    // Before today's snapshot has run, yesterday's record is current.
    expect(line(days('2026-09-12', '2026-10-07'))).toContain('since');
    expect(line(days('2026-09-12', '2026-10-07'))).not.toContain('daily');
  });

  test('says when it stopped, once it has', () => {
    const stopped = { ...days('2026-09-12', '2026-10-06'), first_recorded_at: '2026-09-12T13:00:00.000Z', last_recorded_at: '2026-10-06T13:00:00.000Z' };
    expect(line(stopped)).toBe('<div class="as-of">Holdings recorded from Sep 12, 2026 to Oct 6, 2026.</div>');
    // Across a month and a year.
    expect(line(days('2025-12-01', '2025-12-31'), '2026-01-02')).toContain('to Dec 31, 2025 (UTC)');
    expect(line(days('2025-12-01', '2025-12-31'), '2026-01-01')).toContain('since');
  });

  test('says plainly when nothing has been recorded, promising nothing', () => {
    // An institution that doesn't offer holdings will never have any: no "yet".
    expect(line(days(null, null))).toBe('<div class="as-of">No holdings have been recorded for this account.</div>');
  });

  test("shows the viewer's own day of the first recording, wherever they are", () => {
    // Recorded at 7pm on August 31 in Los Angeles: already September 1 in UTC.
    const span = { ...days('2026-09-01', '2026-10-08'), first_recorded_at: '2026-09-01T02:00:00.000Z' };
    for (const [tz, shown] of [
      ['America/Los_Angeles', 'Aug 31, 2026'],
      ['Pacific/Auckland', 'Sep 1, 2026'],
      ['UTC', 'Sep 1, 2026'],
    ]) {
      expect([tz, line(span, '2026-10-08', tz)]).toEqual([tz, `<div class="as-of">Holdings recorded since ${shown}.</div>`]);
    }
  });

  test('a day whose moment is not known is shown as the UTC day it is, and says so', () => {
    for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', undefined]) {
      expect(recordedDay('2026-09-01', undefined, tz)).toBe('Sep 1, 2026 (UTC)');
      expect(recordedDay('2026-09-01', null, tz)).toBe('Sep 1, 2026 (UTC)');
      // A moment of another day (a restored copy's) is not taken for this one's.
      expect(recordedDay('2026-09-01', '2026-08-15T02:00:00.000Z', tz)).toBe('Sep 1, 2026 (UTC)');
      expect(recordedDay('2026-09-01', 'not a time', tz)).toBe('Sep 1, 2026 (UTC)');
    }
  });
});

describe('what the summary answer means', () => {
  const recorded = { first_recorded: '2026-09-12', last_recorded: '2026-10-08', first_recorded_at: '2026-09-12T13:00:00.000Z', last_recorded_at: '2026-10-08T13:00:00.000Z' };

  test('an answer is the line, moments and all', () => {
    expect(summaryState(200, recorded)).toEqual({ kind: 'recorded', span: recorded });
    // An answer from before the moments were kept still reads.
    expect(summaryState(200, days('2026-09-12', '2026-10-08'))).toEqual({
      kind: 'recorded',
      span: { ...days('2026-09-12', '2026-10-08'), first_recorded_at: null, last_recorded_at: null },
    });
    expect(summaryState(200, { first_recorded: null, last_recorded: null, first_recorded_at: null, last_recorded_at: null })).toEqual({
      kind: 'recorded',
      span: { first_recorded: null, last_recorded: null, first_recorded_at: null, last_recorded_at: null },
    });
  });

  test('a passing failure, or an answer it does not understand, says nothing', () => {
    for (const [status, body] of [
      [500, { error: 'Failed to read holdings history' }],
      [503, { error: 'No container exists yet.' }],
      [200, null],
      [200, { first_recorded: 'Sep 12', last_recorded: null }],
      [200, { ...recorded, first_recorded_at: 'yesterday' }],
      [409, { error: 'Something else' }],
    ] as const) {
      expect(summaryState(status, body)).toEqual({ kind: 'quiet' });
    }
  });

  test("what can't be read stops recording, and is said; only a damaged index is offered a repair", () => {
    const body = { error: 'Your saved holdings records could not be read, so they were left untouched.', unreadable: true };
    expect(summaryState(409, { ...body, unreadable_ids: [], unrecognised_ids: ['index'] })).toEqual({ kind: 'unreadable', repairable: false });
    expect(summaryState(409, { ...body, unreadable_ids: ['index'], unrecognised_ids: [], repairable: true })).toEqual({ kind: 'unreadable', repairable: true });
  });

  test('an index gone missing beside the months is told apart, and offered the repair only where the server offers it', () => {
    const body = { error: 'Your saved holdings records could not be read, so they were left untouched.', unreadable: true, index_missing: true };
    expect(summaryState(409, { ...body, repairable: true })).toEqual({ kind: 'unreadable', repairable: true, indexMissing: true });
    expect(summaryState(409, body)).toEqual({ kind: 'unreadable', repairable: false, indexMissing: true });
  });
});

describe('HoldingsRecordedView', () => {
  test('says nothing while loading, or after a passing failure', () => {
    expect(view({ kind: 'loading' })).toBe('');
    expect(view({ kind: 'quiet' })).toBe('');
  });

  test("says recording has stopped when what is stored can't be read", () => {
    const stopped = "Holdings history can't be read, so it isn't being recorded.";
    expect(view({ kind: 'unreadable', repairable: false })).toBe(`<div class="as-of stale">${stopped}</div>`);
    expect(view({ kind: 'unreadable', repairable: true })).toBe(`<div class="as-of stale">${stopped} <button class="link-btn">Repair it</button></div>`);
  });

  test("months whose index went missing can't be read, and it says that, never that nothing was recorded nor that recording stopped", () => {
    const missing = "Holdings history can't be read: the list of where its months are kept is missing.";
    expect(view({ kind: 'unreadable', repairable: true, indexMissing: true })).toBe(`<div class="as-of stale">${missing} <button class="link-btn">Repair it</button></div>`);
    expect(view({ kind: 'unreadable', repairable: false, indexMissing: true })).toBe(`<div class="as-of stale">${missing}</div>`);
  });

  test('after a repair, says which months were too damaged to read', () => {
    const state: SummaryState = { kind: 'recorded', span: days('2026-09-12', '2026-10-08') };
    expect(view(state)).not.toContain('damaged');
    expect(view(state, 1)).toContain("1 month of holdings history is damaged and can't be read, so it was left as it was.");
    expect(view(state, 3)).toContain("3 months of holdings history are damaged and can't be read, so they were left as they were.");
  });
});

describe('the repair', () => {
  const confirm = (phase: Parameters<typeof RepairConfirm>[0]['phase']) =>
    read(renderToStaticMarkup(<RepairConfirm phase={phase} onCancel={noop} onConfirm={noop} />));

  test('says what it does before anything is done, and asks', () => {
    const html = confirm({ kind: 'confirming' });
    expect(html).toContain("is damaged and can't be read, so no holdings are being recorded");
    expect(html).toContain('Nya can rebuild it from the months themselves');
    expect(html).toContain('Nothing that can be read is lost');
    expect(html).toContain('<button class="secondary">Cancel</button>');
    expect(html).toContain('<button>Rebuild it</button>');
  });

  test('for a missing list, says it is missing, not damaged, and that nothing is lost', () => {
    const html = read(renderToStaticMarkup(<RepairConfirm phase={{ kind: 'confirming' }} missing onCancel={noop} onConfirm={noop} />));
    expect(html).toContain("is missing, so what was recorded can't be read");
    expect(html).toContain('Nya can rebuild it from the months themselves');
    expect(html).toContain('Nothing is lost');
    expect(html).not.toContain('damaged');
    expect(html).not.toContain('no holdings are being recorded');
    expect(html).toContain('<button>Rebuild it</button>');
  });

  test('while it works nothing can be pressed, and a refusal is shown in the server\'s words', () => {
    const busy = confirm({ kind: 'repairing' });
    expect(busy).toContain('<button class="secondary" disabled="">Cancel</button>');
    expect(busy).toContain('<button disabled="">Rebuilding…</button>');
    expect(confirm({ kind: 'failed', error: 'Your holdings records need no repair.' })).toContain('<div class="error">Your holdings records need no repair.</div>');
  });

  test('asks the server only with the confirmation, and passes on what it says', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    expect(await requestRepair(answer(200, { repaired: true, months: 3 }))).toEqual({ ok: true, damagedMonths: 0 });
    expect(sent[0].url).toBe('/api/holdings-history');
    expect([sent[0].init.method, JSON.parse(String(sent[0].init.body))]).toEqual(['POST', { action: 'repair', confirm: true }]);
    expect(await requestRepair(answer(200, { repaired: true, months: 3, damaged_months: 2 }))).toEqual({ ok: true, damagedMonths: 2 });
    const unreadable = { error: 'Your saved holdings records could not be read, so they were left untouched.', unreadable: true, unreadable_ids: [], unrecognised_ids: ['m1'] };
    expect(await requestRepair(answer(409, unreadable))).toEqual({ ok: false, error: unreadable.error, readAgain: false });
    expect(await requestRepair(answer(500, {}))).toEqual({ ok: false, error: 'Could not repair holdings history. Try again.', readAgain: false });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await requestRepair(offline)).toEqual({ ok: false, error: 'Could not reach Nya. Try again.', readAgain: false });
  });

  test('refused with nothing left to repair (a recording derived the index first), the line is read again, never shown as a failure', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const none = await requestRepair(answer(409, { error: 'Your holdings records need no repair.' }));
    expect(none).toEqual({ ok: false, error: 'Your holdings records need no repair.', readAgain: true });
    expect(afterRepair(none)).toEqual({ phase: { kind: 'closed' }, readAgain: true, damagedMonths: 0 });
    // As after a repair that went through.
    expect(afterRepair({ ok: true, damagedMonths: 2 })).toEqual({ phase: { kind: 'closed' }, readAgain: true, damagedMonths: 2 });
    // Any other refusal stays on the sheet, in the server's words.
    for (const failed of [
      { ok: false as const, error: 'Your saved holdings records could not be read, so they were left untouched.', readAgain: false },
      { ok: false as const, error: 'Could not reach Nya. Try again.', readAgain: false },
    ]) {
      expect(afterRepair(failed)).toEqual({ phase: { kind: 'failed', error: failed.error }, readAgain: false, damagedMonths: 0 });
    }
  });
});
