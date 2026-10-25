import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import UpcomingPanel from '@/components/UpcomingPanel';
import TotalCaveats from '@/components/TotalCaveats';
import { useForecast, type ForecastInput, type Forecasting } from '@/components/ForecastCard';
import {
  KIND_WORDS,
  LOADING_TEXT,
  NOT_LOADED_TEXT,
  PLANNED_TEXT,
  loadStates,
  noteInput,
  upcomingBadges,
  useUpcomingNotes,
  type UpcomingBadge,
  type UpcomingNotes,
  type UpcomingStates,
} from '@/components/upcoming-notes';
import { cashPosition, forecastNoteItems, forecastNotes, type ForecastInstitution, type ForecastNote, type ForecastNoteInput } from '@/lib/forecast';
import { EMPTY_PLANNED } from '@/lib/planned';
import { formatMoney, MASK, setAmountsHidden } from '@/lib/format';
import before from './upcoming-words-before-6a3.json';
import { levelOf, notesIn } from './budget-notes-fixture';
import { SCENES, derived, type UpcomingScene } from './upcoming-notes-fixture';

// Budgets > Upcoming's notes after rollout phase 6a3 moved them: one notice at
// the top of the segment for what the bills, income, planned items and
// payments may be missing (design-system.md "Status and honesty" rule 3), the
// notes about where the forecast starts kept on its card, under the figure
// they qualify, and a badge on each card the notice bears on. Every note the
// four cards said before, recorded from main's own components over
// test/upcoming-notes-fixture.ts in test/upcoming-words-before-6a3.json, is
// still said, in its words and at its level, but for the moves listed below,
// each with why.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const NO_STATES: UpcomingStates = { failed: false, loading: false, plannedDrawn: true };

/** A scene's forecast as the panel works it out, its notes as written
 *  (lib/forecast.ts forecastNoteItems), and what the segment says of them
 *  (`said`), with `states` for its load states (the scene's own by default). */
type Probed = Forecasting & { notes: ForecastNote[]; sentences: string[]; said: UpcomingNotes };
function probe(s: UpcomingScene, states: Partial<UpcomingStates> = {}): Probed {
  const d = derived(s);
  let out: Probed | null = null;
  function Probe() {
    const input: ForecastInput = {
      institutions: s.institutions,
      series: s.series,
      planned: s.planned,
      plannedDrawn: states.plannedDrawn ?? s.plannedStatus === 'ready',
      dismissed: d.dismissed,
      today: s.today,
      range: 30,
      txns: s.txns ?? undefined,
      fx: s.fx,
      incomplete: s.incomplete,
      stopped: s.stopped,
      withoutTransactions: s.withoutTransactions,
    };
    const work = useForecast(input);
    const said = useUpcomingNotes(input, work, { failed: states.failed ?? s.failed, loading: states.loading ?? d.loading });
    // The first render's: hide-amounts' backstop renders each again, hidden.
    out ??= { ...work, notes: forecastNoteItems(noteInput(input, work)), sentences: forecastNotes(noteInput(input, work)), said };
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out!;
}

/** A scene as the Budgets tab draws Upcoming (components/BudgetsTab.tsx). */
function panel(s: UpcomingScene): string {
  const d = derived(s);
  return renderToStaticMarkup(
    <UpcomingPanel
      institutions={s.institutions}
      series={s.series}
      planned={s.planned}
      plannedStatus={s.plannedStatus}
      plannedDrawn={s.plannedStatus === 'ready'}
      plannedError={s.plannedError}
      plannedSaveError={s.plannedSaveError}
      onSavePlanned={async () => true}
      dismissed={d.dismissed}
      onDismiss={async () => true}
      txns={s.txns}
      failed={s.failed}
      balancesAsOf={s.balancesAsOf}
      balancesSaved={s.balancesSaved}
      incomplete={s.incomplete}
      stopped={s.stopped}
      withoutTransactions={s.withoutTransactions}
      fx={s.fx}
      today={s.today}
      currency={d.currency}
      plannedCurrency={d.plannedCurrency}
      noSpending={d.noSpending}
    />
  );
}

/** The panel's markup before the forecast's card (the notice), the card's
 *  own, and what follows it, each from a whole tag. */
const FORECAST = 'aria-labelledby="forecast-title"';
const top = (html: string) => html.slice(0, html.lastIndexOf('<', html.indexOf(FORECAST)));
const forecastCard = (html: string) => html.slice(html.lastIndexOf('<', html.indexOf(FORECAST)), html.indexOf('role="tablist"'));
const after = (html: string) => html.slice(html.indexOf('role="tablist"'));

const states = (over: Partial<UpcomingStates> = {}): UpcomingStates => ({ ...NO_STATES, ...over });
const note = (kind: ForecastNote['kind'], of: ForecastNote['of'], words = `A note of kind ${kind}.`): ForecastNote => ({ kind, of, text: words });

describe('each note’s kind and what it bears on', () => {
  test('the bank and account notes: where it starts, or what moves it, in the order they were said', () => {
    const w = probe(SCENES['connections that leave it short']);
    expect(w.notes.map((n) => [n.of, n.kind])).toEqual([
      ['start', 'recovered'],
      ['start', 'unreached'],
      ['start', 'unreached'],
      ['start', 'unshown'],
      ['start', 'held'],
      ['items', 'missing'],
      ['items', 'stopped'],
      ['items', 'importing'],
      ['items', 'refused'],
      ['items', 'no_consent'],
      ['start', 'typed'],
      ['start', 'no_balance'],
      ['start', 'accounts_currency'],
    ]);
  });

  test('a card’s payment due, pay that stopped or varies, and an account of unknown type: what moves it', () => {
    const w = probe(SCENES['pay and bills it leaves out']);
    expect(w.notes.map((n) => [n.of, n.kind])).toEqual([
      ['items', 'card'],
      ['items', 'lapsed'],
      ['items', 'varies'],
      ['items', 'unplaced'],
    ]);
  });

  test('what was left out for its currency: accounts and pending charges where it starts, expected amounts in what moves it', () => {
    const w = probe(SCENES['converted into a home currency']);
    expect(w.notes.map((n) => [n.of, n.kind])).toEqual([['start', 'accounts_currency']]);
    const s = SCENES['as it usually is'];
    const position = { ...w.position, pending: { amount: 0, count: 0, leftOut: [{ currency: 'GBP', count: 1 }] } };
    const input: ForecastNoteInput = { institutions: s.institutions, position, eventsLeftOut: [{ currency: 'EUR', count: 2 }], today: s.today, days: { snapshot: (d) => d, instant: (d) => d, day: (d) => d } };
    expect(forecastNoteItems(input).map((n) => [n.of, n.kind])).toEqual([
      ['start', 'accounts_currency'],
      ['start', 'pending_currency'],
      ['items', 'amounts_currency'],
    ]);
  });

  test('forecastNotes gives the sentences main’s forecast card said, in its order', () => {
    // Every caution the four cards said in these scenes was one of the
    // forecast's notes (test/upcoming-words-before-6a3.json).
    for (const name of ['connections that leave it short', 'pay and bills it leaves out', 'a bill that ended', 'converted into a home currency']) {
      const said = recorded[name].filter((n) => n.level === 'caution').map((n) => n.text);
      expect([name, said.length > 0]).toEqual([name, true]);
      expect([name, probe(SCENES[name]).sentences]).toEqual([name, said]);
    }
  });

  test('a reached bank without some of its accounts, and one whose accounts stopped reporting before holds were kept', () => {
    const institutions: ForecastInstitution[] = [
      {
        institution_name: 'Capital One',
        item_id: 'item_1',
        accounts: [{ account_id: 'c1', name: '360 Checking', type: 'depository', balance: 100, currency: 'USD' }],
        unshown_accounts: [{ name: '360 Savings', type: 'depository' }],
      },
      { institution_name: 'Citi', item_id: 'item_2', accounts: [{ account_id: 'c2', name: 'Citi Checking', type: 'depository', balance: 100, currency: 'USD' }], unconfirmed_missing: 2 },
    ];
    const items = forecastNoteItems({ institutions, position: cashPosition(institutions), eventsLeftOut: [], today: '2026-10-09', days: { snapshot: (d) => d, instant: (d) => d, day: (d) => d } });
    expect(items).toEqual([
      { of: 'start', kind: 'unshown', text: "360 Savings at Capital One couldn't be shown, so its balance isn't in this forecast." },
      { of: 'start', kind: 'held', text: "2 accounts at Citi stopped reporting, so any cash in them isn't in this forecast." },
    ]);
  });

  test('each kind in a few words, with no amount', () => {
    for (const [k, words] of Object.entries(KIND_WORDS)) expect([k, /\d|\$/.test(words)]).toEqual([k, false]);
  });
});

describe('the notice at the top of the segment', () => {
  test('the load states first, critical before caution, then what moves it, each a caution; nothing about where it starts', () => {
    const { said } = probe(SCENES['connections that leave it short'], { failed: true, plannedDrawn: false });
    expect(said.notice.map((c) => [c.severity, c.summary])).toEqual([
      ['critical', 'transactions not loaded'],
      ['caution', 'planned items not loaded'],
      ['caution', 'a bank’s transactions not loaded'],
      ['caution', 'a bank not syncing'],
      ['caution', 'older transactions still importing'],
      ['caution', 'accounts Plaid doesn’t cover'],
      ['caution', 'transactions not allowed'],
    ]);
    expect(loadStates(states({ loading: true })).map((c) => [c.severity, c.key])).toEqual([['caution', 'loading']]);
    // Its words, as the forecast's card said them.
    expect(text(renderToStaticMarkup(<TotalCaveats items={loadStates(states({ failed: true }))} />))).toBe(`Critical: ${NOT_LOADED_TEXT}`);
    expect(text(renderToStaticMarkup(<TotalCaveats items={loadStates(states({ loading: true }))} />))).toBe(`Caution: ${LOADING_TEXT}`);
    expect(text(renderToStaticMarkup(<TotalCaveats items={loadStates(states({ plannedDrawn: false }))} />))).toBe(`Caution: ${PLANNED_TEXT}`);
  });

  test('with no forecast, nothing: the list, the calendar and Recurring say the load states themselves', () => {
    expect(probe(SCENES['no cash to start from'], { failed: true, plannedDrawn: false }).said.notice).toEqual([]);
    const none = SCENES['no cash to start from'];
    const list = (html: string) => html.slice(html.indexOf('id="upcoming-panel-list"'), html.indexOf('id="upcoming-panel-calendar"'));
    const cases: [UpcomingScene, string, string][] = [
      [{ ...none, txns: null, failed: true, series: [] }, 'critical', "Transactions couldn't be loaded, so no bills or income can be found."],
      [{ ...none, txns: null, series: [] }, 'caution', 'Transactions are still loading.'],
      [{ ...none, plannedStatus: 'error', plannedError: SCENES['planned items not read'].plannedError }, 'caution', PLANNED_TEXT],
    ];
    for (const [scene, level, words] of cases) {
      const html = panel(scene);
      expect([words, top(html).includes('notice')]).toEqual([words, false]);
      const said = notesIn(list(html)).filter((n) => n.level === level);
      expect([words, said.some((n) => n.text === `${level === 'critical' ? 'Critical' : 'Caution'}: ${words}`)]).toEqual([words, true]);
    }
  });

  test('a planned item counts against a card’s payment only once the planned items are drawn', () => {
    // Sapphire's statement, $600.00, due Oct 22, and the payment planned for it.
    const pay = { id: 'pay', name: 'Sapphire payment', kind: 'expense' as const, amount: 600, currency: 'USD', date: '2026-10-22', cadence: 'once' as const };
    const scene = { ...SCENES['pay and bills it leaves out'], planned: { ...EMPTY_PLANNED, items: [pay] } };
    const card = (w: Probed) => w.said.notice.filter((c) => c.summary === KIND_WORDS.card).length;
    expect(card(probe(scene))).toBe(0);
    expect(card(probe({ ...scene, plannedStatus: 'error' }))).toBe(1);
    expect(card(probe({ ...scene, plannedStatus: 'loading' }))).toBe(1);
  });

  test('one caution in full; two or more gathered into a line naming their kinds; a critical one never gathered', () => {
    const one = top(panel(SCENES['a bill that ended']));
    expect(one).not.toContain('notice-summary');
    expect(text(one)).toBe("Caution: Payroll hasn't come since Sep 25, so it isn't in this forecast. If it still comes, add it as planned income.");
    const html = top(panel(SCENES['connections that leave it short']));
    expect(html).toContain('<details class="notice-summary"><summary class="notice caution">');
    expect(text(html)).toContain('Caution: 5 notes: a bank’s transactions not loaded, a bank not syncing, older transactions still importing and 2 more');
    const failed = top(panel({ ...SCENES['connections that leave it short'], txns: null, failed: true }));
    expect(failed.indexOf(`<div class="notice critical">`)).toBeLessThan(failed.indexOf('notice-summary'));
    expect(text(failed)).toContain(`Critical: ${NOT_LOADED_TEXT}`);
  });

  test('a card’s payment names amounts, masked where the notice is built', () => {
    // As a browser's page has it with amounts hidden (lib/format.ts refuses
    // the switch where there is no window).
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    setAmountsHidden(true);
    if (none) delete g.window;
    try {
      const { said } = probe(SCENES['pay and bills it leaves out']);
      const card = said.notice.find((c) => c.summary === KIND_WORDS.card)!;
      const html = renderToStaticMarkup(<TotalCaveats items={[card]} />);
      // Seen as the mask, said as "hidden", never the mask read out.
      expect(formatMoney(600, 'USD')).toContain(MASK);
      expect(html).toContain(`<span aria-hidden="true">Sapphire&#x27;s payment, statement balance ${formatMoney(600, 'USD')}, is due Oct 22`);
      expect(html).toContain('<span class="visually-hidden">Sapphire&#x27;s payment, statement balance hidden, is due Oct 22');
    } finally {
      setAmountsHidden(false);
    }
  });
});

describe('the forecast’s start notes, on its card', () => {
  test('where it starts is said under its "Starts from" line, and only there', () => {
    const html = panel(SCENES['connections that leave it short']);
    const card = forecastCard(html);
    const w = probe(SCENES['connections that leave it short']);
    for (const n of w.notes) {
      const where = n.of === 'start' ? card : top(html);
      expect([n.kind, text(where).includes(n.text)]).toEqual([n.kind, true]);
      expect([n.kind, text(n.of === 'start' ? top(html) : card).includes(n.text)]).toEqual([n.kind, false]);
    }
    expect(text(card).indexOf('Starts from')).toBeLessThan(text(card).indexOf(w.notes[0].text));
    expect(w.said.start.map((c) => c.severity)).toEqual(w.notes.filter((n) => n.of === 'start').map(() => 'caution'));
  });
});

describe('which cards carry a badge', () => {
  const short: UpcomingBadge = 'neg';
  const maybe: UpcomingBadge = 'warn';

  test('transactions not loaded: Incomplete, on the forecast, the list and the calendar', () => {
    expect(upcomingBadges(true, states({ failed: true }), [])).toEqual({ forecast: short, list: short, calendar: short });
  });

  test('still loading, or the planned items not loaded: May be incomplete on all three', () => {
    expect(upcomingBadges(true, states({ loading: true }), [])).toEqual({ forecast: maybe, list: maybe, calendar: maybe });
    expect(upcomingBadges(true, states({ plannedDrawn: false }), [])).toEqual({ forecast: maybe, list: maybe, calendar: maybe });
  });

  test('a note that can leave entries out: on all three', () => {
    for (const kind of ['missing', 'stopped', 'importing', 'refused', 'no_consent', 'lapsed'] as const) {
      expect([kind, upcomingBadges(true, states(), [note(kind, 'items')])]).toEqual([kind, { forecast: maybe, list: maybe, calendar: maybe }]);
    }
  });

  test('one the list already shows, or one about where the forecast starts: on the forecast alone', () => {
    for (const n of [note('varies', 'items'), note('unplaced', 'items'), note('amounts_currency', 'items'), note('card', 'items'), note('recovered', 'start'), note('typed', 'start')]) {
      expect([n.kind, upcomingBadges(true, states(), [n])]).toEqual([n.kind, { forecast: maybe, list: null, calendar: null }]);
    }
  });

  test('nothing missing, or no forecast: none', () => {
    expect(upcomingBadges(true, states(), [])).toEqual({ forecast: null, list: null, calendar: null });
    expect(upcomingBadges(false, states({ failed: true }), [note('stopped', 'items')])).toEqual({ forecast: null, list: null, calendar: null });
  });

  test('drawn at the top of the cards they are on, and on no other', () => {
    const html = panel(SCENES['converted into a home currency']);
    expect(forecastCard(html)).toContain('<span class="badge warn">May be incomplete</span>');
    expect(after(html)).not.toContain('May be incomplete');
    const failed = panel(SCENES['transactions not loaded']);
    expect(forecastCard(failed)).toContain('<span class="badge neg">Incomplete</span>');
    expect(after(failed).split('<span class="badge neg">Incomplete</span>').length - 1).toBe(2);
    expect(panel(SCENES['as it usually is'])).not.toMatch(/Incomplete|May be incomplete/);
    // A bank not syncing can leave entries out of the list, the calendar and
    // Recurring alike.
    const short = after(panel(SCENES['connections that leave it short']));
    expect(short.split('<span class="badge warn">May be incomplete</span>').length - 1).toBe(3);
    expect(short.slice(short.indexOf('id="recurring-title"') - 200)).toContain('<span class="badge warn">May be incomplete</span>');
  });
});

// ---------------------------------------------------------------------------
// The recorded words.

type Recorded = Record<string, { text: string; level: string }[]>;
const recorded = before as Recorded;

/** The levels as before (lib's levelOf), with a row's subtitle line before
 *  6a3 (`tag`) and an explanation behind "Why?" (`why`). */
const classify = (cls: string) => {
  const c = new Set(cls.split(/\s+/));
  return c.has('type-tag') ? 'tag' : c.has('why-body') ? 'why' : levelOf(cls);
};

/** What moved on purpose, by its words, and to which level now (null: into
 *  a sheet, which the panel doesn't draw until it is opened). */
const MOVES: { starts: string; was: string; now: string | null; why: string }[] = [
  {
    starts: 'An estimate of what leaves and reaches your checking and savings',
    was: 'info',
    now: 'why',
    why: 'the forecast’s long explanation, behind Why ("How this works"): one line of helper text by default (guidelines.md "Copy")',
  },
  { starts: 'How long your cash would last', was: 'info', now: 'helper', why: 'the runway line, as helper text: nothing is wrong (rollout 6a3, plan A3)' },
  { starts: 'Days gone by show what posted', was: 'info', now: 'helper', why: 'the calendar’s closing note, as helper text (plan A5)' },
  { starts: 'Detected from charges and deposits', was: 'info', now: 'helper', why: 'Recurring’s closing note, as helper text (plan A6)' },
  {
    starts: "Your planned items couldn't be loaded, so this can't be saved now.",
    was: 'caution',
    now: null,
    why: 'Recurring’s "can’t be saved now", said in a series’ sheet beside the button it turns off, at its level (plan A6)',
  },
];

describe('every note the segment said is still said, in its words and at its level', () => {
  test('the recording covers every scene', () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(SCENES).sort());
  });

  for (const [scene, notes] of Object.entries(recorded)) {
    test(scene, () => {
      const html = panel(SCENES[scene]);
      const said = notesIn(html, classify);
      const all = text(html);
      const missing = notes
        .map((n) => {
          // A row's line under its name (`tag`) is its subtitle now: its words.
          if (n.level === 'tag') return all.includes(n.text) ? null : n;
          const move = MOVES.find((m) => n.text.startsWith(m.starts) && n.level === m.was);
          if (move && move.now === null) return null;
          const level = move ? move.now : n.level;
          return said.some((s) => s.level === level && s.text.includes(n.text)) ? null : n;
        })
        .filter((n) => n !== null);
      expect(missing).toEqual([]);
    });
  }
});
