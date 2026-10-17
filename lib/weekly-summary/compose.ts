// lib/weekly-summary/compose.ts
//
// The weekly summary in words: its subject and its plain text (lib/mail.ts
// sends plain text), from the facts (content.ts). Pure. The one place that
// decides what a summary says, so the rule is kept here.
//
// NEVER A FIGURE. Resend sees every email, and email is not encrypted, so a
// summary never carries a balance, an amount or an account number, and says
// what changed and what needs attention without figures, with a link to the
// app for them. The only numbers it writes are days of the month, a year
// where a date is in another year than the day the summary comes, and counts
// of things ("2 bills due"), written as "over 99" from a hundred.
//
// NAMES. The person's own (their budgets and categories, their goals, their
// planned expenses, and the merchants their bills are from, as they come or
// as the person renamed them) are personal, and /privacy says the email
// service sees them. Any of them can spell out an amount ("Rent 1500",
// "Fifty dollars a week", "Ten thousand for the car") or an account number
// ("Transfer to 4821"), so one is counted instead of named ("Groceries and 1
// other") when it has (safeName):
//   - a digit of any script, a currency sign or a percent sign;
//   - a number or a currency written as a word in English (NUMBER_WORDS,
//     MONEY_WORDS: in any case, plural, or run together, as in "Thousands",
//     "fivehundred" or "tenk"). Widely: refusing a name only means it is
//     counted. "Real" and "won" are left out of the list, as common words
//     that say no amount on their own ("Real estate"); "reais" is in it;
//   - a letter outside the Latin alphabet, since no list of words can tell
//     whether "五百元" or "пятьдесят рублей" spells an amount.
// A bank's name (safeBankName) comes from Plaid or SimpleFIN, never from the
// person, so it can't carry their amount, and the connection notices have
// always named it: it is held to the first rule only, so "Capital One" and
// "Five Star Bank" are named. Every name is tidied first: control and format
// characters out (a bidi override or a zero-width space can reorder or hide
// what is around it), spaces collapsed.
//
// THE CHECK. Before anything goes, figuresIn reads the whole subject and text
// again, against what the summary itself writes: it takes out its links, its
// dates as it writes them (a weekday that is that date's, and a year only
// near the send day's), its counts (a number before one of its own nouns),
// the week in the subject, its one phrase with a number word ("the next seven
// days") and the banks' names it wrote. Anything left that is a digit, a
// currency or percent sign, a number or currency word, or a letter outside
// the Latin alphabet is a figure, and the senders refuse a summary with one
// (job.ts, send-now.ts): a bug that let a figure through stops the email
// rather than sending it.
//
// SHORT. A section is there only when it has something to say, the spending
// line always: what changed this week, against a usual week, or why it isn't
// compared. A section whose data couldn't be read is left out, and one line
// says some of the data couldn't be read, rather than guessing. No em or en
// dashes, no marketing, and a footer that says why it came and how to stop it.

import { monthName } from '../rollover';
import type { MonthGap } from '../rollover';
import { subjectFor } from '../connection-notices';
import { dayIn } from '../report/period';
import { WEEKDAY_NAMES, type Weekday } from './settings';
import { weekBefore } from './week';
import { isUnread, type BillFact, type ConnectionFact, type Level, type SpendingFact, type WeeklyFacts } from './content';

/** From this many on, a count is written "over 99". */
export const COUNT_CAP = 100;
/** The most names a list writes before counting the rest. */
export const NAMES_LISTED = 5;
/** A name longer than this is cut, on a word where it can be. */
export const NAME_CHARS = 60;
/** The most bills listed; the rest are counted. */
export const BILLS_LISTED = 8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---- Names ----

/** Numbers written as English words (see NAMES). */
export const NUMBER_WORDS: readonly string[] = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fourty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'lakh', 'crore',
  'grand', 'half', 'halves', 'quarter', 'dozen', 'percent', 'fiver', 'tenner',
];

/** Currencies written as words (see NAMES). */
export const MONEY_WORDS: readonly string[] = [
  'dollar', 'buck', 'cent', 'euro', 'pound', 'quid', 'pence', 'penny', 'yen', 'yuan', 'renminbi',
  'peso', 'rupee', 'franc', 'krona', 'kronor', 'krone', 'kroner', 'reais', 'dolar', 'centavo',
  'lira', 'lire', 'rand', 'shekel', 'ruble', 'rouble', 'zloty', 'forint', 'baht', 'ringgit',
  'dinar', 'dirham', 'riyal', 'rial', 'naira', 'cedi', 'paise', 'bitcoin', 'btc',
];

const FIGURE_WORDS = new Set([...NUMBER_WORDS, ...MONEY_WORDS]);

/** A digit of any script, a currency sign, or a percent sign of any form. */
const FIGURE_CHARS = /[\p{N}\p{Sc}%‰‱٪﹪％]/u;
/** A letter outside the Latin alphabet. */
const NOT_LATIN = /[^\P{L}\p{sc=Latin}]/u;

/** One of the words, or its plural ("tens", "twenties", "pennies"). */
function isFigureWord(w: string): boolean {
  if (FIGURE_WORDS.has(w)) return true;
  if (w.endsWith('ies') && FIGURE_WORDS.has(`${w.slice(0, -3)}y`)) return true;
  if (w.endsWith('es') && FIGURE_WORDS.has(w.slice(0, -2))) return true;
  return w.endsWith('s') && FIGURE_WORDS.has(w.slice(0, -1));
}

/** A word made of them run together ("fivehundred", "fiftybucks"), or of them
 *  and a "k" for thousand ("tenk"). */
function runTogether(w: string): boolean {
  const pieces = (s: string): boolean => {
    if (s.length === 0 || s.length > NAME_CHARS) return false;
    const reach = new Array<boolean>(s.length + 1).fill(false);
    reach[0] = true;
    for (let i = 0; i < s.length; i++) {
      if (!reach[i]) continue;
      for (let j = i + 3; j <= s.length; j++) if (!reach[j] && isFigureWord(s.slice(i, j))) reach[j] = true;
    }
    return reach[s.length];
  };
  return pieces(w) || (w.endsWith('k') && pieces(w.slice(0, -1)));
}

/** Whether text spells out a number or a currency in English words (see
 *  NAMES): each word, its accents and case aside. */
export function spellsFigure(text: string): boolean {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u);
  return words.some((w) => w.length > 0 && (isFigureWord(w) || runTogether(w)));
}

/** A name as a summary writes it: its control and format characters out,
 *  one line, spaces collapsed. */
export function tidyName(raw: string): string {
  return raw.replace(/\p{Cf}+/gu, '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** A tidied name cut to NAME_CHARS, on a word where it can be. */
function cut(one: string): string {
  const chars = Array.from(one);
  if (chars.length <= NAME_CHARS) return one;
  const head = chars.slice(0, NAME_CHARS).join('');
  const space = head.lastIndexOf(' ');
  return (space > NAME_CHARS / 2 ? head.slice(0, space) : head).trim();
}

/** One of the person's names as a summary may carry it, or null when it
 *  can't be (see NAMES). */
export function safeName(raw: string): string | null {
  const one = tidyName(raw);
  if (!one || FIGURE_CHARS.test(one) || NOT_LATIN.test(one) || spellsFigure(one)) return null;
  return cut(one);
}

/** A bank's name as a summary may carry it, or null: one from Plaid or
 *  SimpleFIN is held to digits and currency and percent signs only (see
 *  NAMES). */
export function safeBankName(raw: string): string | null {
  const one = tidyName(raw);
  if (!one || FIGURE_CHARS.test(one)) return null;
  return cut(one);
}

/** A count as a summary writes it. */
export const countText = (n: number): string => (n >= COUNT_CAP ? `over ${COUNT_CAP - 1}` : String(n));

const plural = (n: number, one: string, many = `${one}s`) => `${countText(n)} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
function joined(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Names as a list: those that can be carried, at most NAMES_LISTED, and the
 *  rest counted ("Groceries and 2 others"); none that can, counted whole ("2
 *  budgets"). Each name once, as it reads tidied, in any case. */
export function namesText(raw: readonly string[], noun: string): string {
  const byKey = new Map<string, string>();
  for (const r of raw) {
    const name = tidyName(r);
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  const names = [...byKey.values()];
  const safe = [...new Set(names.map(safeName).filter((n): n is string => n !== null))];
  if (safe.length === 0) return plural(names.length, noun);
  const shown = safe.slice(0, NAMES_LISTED);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${plural(rest, 'other')}` : joined(shown);
}

// ---- Days ----

/** "Tuesday, October 13" for a calendar day, with its year when it isn't in
 *  `year` (given). */
export function dayText(day: string, year?: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const text = `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return year !== undefined && day.slice(0, 4) !== year ? `${text}, ${day.slice(0, 4)}` : text;
}

/** The week, "Monday, October 5 to Sunday, October 11", with each year when
 *  it crosses into another. */
export function weekText(first: string, last: string): string {
  if (first.slice(0, 4) === last.slice(0, 4)) return `${dayText(first)} to ${dayText(last)}`;
  return `${dayText(first)}, ${first.slice(0, 4)} to ${dayText(last)}, ${last.slice(0, 4)}`;
}

/** The week in a subject: "October 5 to 11", "September 28 to October 4". */
function shortWeek(first: string, last: string): string {
  const [a, b] = [new Date(`${first}T00:00:00Z`), new Date(`${last}T00:00:00Z`)];
  const from = `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`;
  return a.getUTCMonth() === b.getUTCMonth() ? `${from} to ${b.getUTCDate()}` : `${from} to ${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}`;
}

// ---- The words ----

const LEVEL_TEXT: Record<Level, string> = {
  much_higher: 'You spent much more this week than in a usual week.',
  higher: 'You spent more this week than in a usual week.',
  same: 'You spent about as much this week as in a usual week.',
  lower: 'You spent less this week than in a usual week.',
  much_lower: 'You spent much less this week than in a usual week.',
};

/** The names a summary writes, each as it may be carried, or what to call it
 *  instead; and the banks' names it wrote, which the check leaves to their
 *  own rule (see THE CHECK). */
type Namer = { name: (raw: string, instead: string) => string; bank: (raw: string, instead: string) => string; banks: Set<string> };

function namer(): Namer {
  const banks = new Set<string>();
  return {
    name: (raw, instead) => safeName(raw) ?? instead,
    bank: (raw, instead) => {
      const n = safeBankName(raw);
      if (n) banks.add(n);
      return n ?? instead;
    },
    banks,
  };
}

function spendingText(s: SpendingFact, year: string, n: Namer): string {
  switch (s.kind) {
    case 'compared': {
      if (s.left_out.length === 0) return LEVEL_TEXT[s.level];
      const codes = s.left_out.map((c) => (/^[A-Z]{3,5}$/.test(c) ? c : null));
      const named = codes.filter((c): c is string => c !== null);
      const which = named.length === codes.length ? joined(named) : 'other currencies';
      return `${LEVEL_TEXT[s.level]} Transactions in ${which} aren't counted in that.`;
    }
    case 'no_transactions':
      return 'No transactions this week.';
    case 'too_early':
      return s.why === 'importing'
        ? "Nya is still bringing in older transactions, so this week's spending isn't compared with a usual week yet."
        : "Nya doesn't have enough weeks of transactions yet to say how this week's spending compares with a usual week.";
    case 'behind': {
      // Each that came in on a day, by itself; those that never did, together.
      const dated = s.sources.filter((src) => src.since).map((src) => `${n.bank(src.name, 'a bank')}'s last came in on ${dayText(src.since!, year)}`);
      const never = [...new Set(s.sources.filter((src) => !src.since).map((src) => `${n.bank(src.name, 'a bank')}'s`))];
      const parts = [...dated, ...(never.length > 0 ? [`${joined(never)} haven't come in`] : [])];
      return `This week's spending isn't compared, as not all of its transactions are in: ${joined(parts)}.`;
    }
    case 'none_come_in':
      return "None of your connected accounts brings in bank or card transactions, so there's no spending to compare.";
  }
}

function billLine(b: BillFact, year: string, n: Namer): string {
  const name = n.name(b.name, b.planned ? 'Something you planned' : 'A bill');
  const label = b.planned && safeName(b.name) ? `${name} (planned)` : name;
  return b.late ? `- ${label}: due ${dayText(b.day, year)}, not in yet` : `- ${label}: ${dayText(b.day, year)}`;
}

/**
 * A connection that needs the person, in a few words: as the subject of a
 * notice about it says it (lib/connection-notices.ts subjectFor), but for one
 * that can't be repaired. A notice tells "needs connecting again" from "can
 * no longer be updated" (a bank Plaid no longer reaches, where connecting
 * again won't help) by its cause, which the record the summary reads doesn't
 * keep, so it says only what is true of both.
 */
function connectionHeadline(name: string, c: ConnectionFact, now: number): string {
  if (c.state === 'relink') return `${name}'s connection can't be repaired`;
  return subjectFor(name, { state: c.state, cause: 'unknown', ends_at: c.ends_at ?? undefined }, now);
}

/** A connection that needs the person, and for one Plaid says will end,
 *  around which day (on their calendar). */
function connectionLine(c: ConnectionFact, zone: string, now: number, year: string, n: Namer): string {
  const headline = connectionHeadline(n.bank(c.name, 'A bank'), c, now);
  const day = c.state === 'reconnect_soon' && c.ends_at ? dayIn(c.ends_at, zone) : null;
  if (!day) return `${headline}.`;
  return Date.parse(c.ends_at!) <= now ? `${headline}: Plaid said its connection would end around ${dayText(day, year)}.` : `${headline}: Plaid says its connection ends around ${dayText(day, year)}.`;
}

/** Why a month may be incomplete, in the Budgets tab's words, with names only
 *  as a summary may carry them. What couldn't be read is said as that. */
function gapText(g: MonthGap, zone: string, year: string, n: Namer): string {
  const inst = 'institution' in g ? n.bank(g.institution, 'a bank') : 'a bank';
  switch (g.kind) {
    case 'missing':
      return `${inst}'s transactions couldn't be loaded`;
    case 'importing':
      return `${inst} is still bringing in older transactions`;
    case 'stopped': {
      const day = g.since ? dayIn(g.since, zone) : null;
      return day ? `${inst} hasn't synced since ${dayText(day, year)}` : `${inst} isn't syncing`;
    }
    case 'begins':
      return `${inst}'s transactions in Nya begin on ${dayText(g.first, year)}`;
    case 'without':
      return g.reason === 'refused'
        ? `Plaid doesn't provide transactions for the bank or card accounts at ${inst}`
        : `you didn't allow Nya to see transactions from the bank or card accounts at ${inst}`;
    case 'unread':
      return "some of what Nya keeps couldn't be read";
    case 'exclusions':
      return `whether you excluded ${plural(g.count, 'transaction')} couldn't be read`;
  }
}

export type ComposeOptions = {
  /** The app's address (lib/app-url.ts), for "open Nya"; null without one. */
  link: string | null;
  /** The address that turns the summary off with one click, or null. */
  unsubscribe: string | null;
  /** Asked for with "Send me one now", rather than sent by the daily job. */
  requested: boolean;
  /** The day the summary comes on, as saved, while it is on; null while it
   *  is off. What the footer says of when the next one comes: never the
   *  sheet's day before it is saved. */
  schedule: Weekday | null;
  now: number;
};

/** A summary as composed: what the email says, the day it is for, and the
 *  banks' names in it, which the check reads by their own rule. */
export type ComposedSummary = { subject: string; text: string; send_day: string; banks: string[] };

/** "reconnect Chase soon" after a colon; a name keeps its capital. */
const lowerFirst = (s: string) => (s.startsWith('Reconnect ') ? `r${s.slice(1)}` : s);

/** The subject's items, most pressing first (see composeWeekly). */
function subjectItems(f: WeeklyFacts, now: number, n: Namer): string[] {
  const items: string[] = [];
  const short = (name: string | null) => (name && name.length <= 30 ? name : null);
  if (!isUnread(f.connections) && f.connections.length > 0) {
    const c = f.connections[0];
    const bank = f.connections.length === 1 ? short(safeBankName(c.name)) : null;
    if (bank) n.bank(c.name, 'A bank');
    items.push(bank ? lowerFirst(connectionHeadline(bank, c, now)) : `${plural(f.connections.length, 'connection')} ${f.connections.length === 1 ? 'needs' : 'need'} you`);
  }
  if (!isUnread(f.budgets) && f.budgets && f.budgets.over.length > 0) {
    const over = [...new Set(f.budgets.over.map(tidyName))];
    const name = over.length === 1 ? short(safeName(over[0])) : null;
    items.push(name ? `${name} over budget` : `${plural(over.length, 'budget')} over`);
  }
  if (!isUnread(f.bills) && f.bills.length > 0) items.push(`${plural(f.bills.length, 'bill')} due`);
  if (!isUnread(f.goals) && f.goals.behind.length > 0) {
    const behind = [...new Set(f.goals.behind.map(tidyName))];
    const name = behind.length === 1 ? short(safeName(behind[0])) : null;
    items.push(name ? `${name} behind` : `${plural(behind.length, 'goal')} behind`);
  }
  if (!isUnread(f.spending)) {
    if (f.spending.kind === 'compared' && (f.spending.level === 'much_higher' || f.spending.level === 'higher')) items.push('more spending than usual');
    else if (f.spending.kind === 'compared' && (f.spending.level === 'much_lower' || f.spending.level === 'lower')) items.push('less spending than usual');
    else if (f.spending.kind === 'no_transactions') items.push('no transactions');
  }
  return items;
}

/** Whether the week's spending is known: compared with a usual week, or none
 *  at all. Only then is a week without anything else a quiet one, and only
 *  then does a summary asked for now stand for the week's (send-now.ts). */
export function spendingKnown(f: Pick<WeeklyFacts, 'spending'>): boolean {
  return !isUnread(f.spending) && (f.spending.kind === 'compared' || f.spending.kind === 'no_transactions');
}

/**
 * The summary's subject and plain text (see the header): "Your week in Nya: 2
 * bills due, Groceries over budget", then the week, the spending line, each
 * section with something to say, a line for what couldn't be read, the link
 * to the app, and why it came and how to stop it.
 */
export function composeWeekly(f: WeeklyFacts, o: ComposeOptions): ComposedSummary {
  const year = f.send_day.slice(0, 4);
  const n = namer();
  const items = subjectItems(f, o.now, n);
  // A quiet week only when the week is known to be one: its spending
  // compared, or none at all. Otherwise the subject is just the week.
  const subject = `Your week in Nya: ${items.length > 0 ? items.slice(0, 2).join(', ') : spendingKnown(f) ? 'a quiet week' : shortWeek(f.first, f.last)}`;

  const paragraphs: string[] = [`Your week in Nya: ${weekText(f.first, f.last)}.`];
  let unread = false;
  let attention = false;

  if (isUnread(f.spending)) unread = true;
  else {
    paragraphs.push(spendingText(f.spending, year, n));
    if (f.spending.kind === 'behind') attention = true;
  }

  if (isUnread(f.budgets)) unread = true;
  else if (f.budgets) {
    const month = monthName(f.budgets.month, f.send_day.slice(0, 7));
    const lines = [
      ...(f.budgets.over.length > 0 ? [`Over budget in ${month}: ${namesText(f.budgets.over, 'budget')}.`] : []),
      ...(f.budgets.close.length > 0 ? [`Close to the limit in ${month}: ${namesText(f.budgets.close, 'budget')}.`] : []),
    ];
    if (lines.length > 0) {
      paragraphs.push(lines.join('\n'));
      attention = true;
    }
  }

  if (isUnread(f.bills)) unread = true;
  else if (f.bills.length > 0) {
    const shown = f.bills.slice(0, BILLS_LISTED).map((b) => billLine(b, year, n));
    const rest = f.bills.length - shown.length;
    paragraphs.push(['Bills due in the next seven days:', ...shown, ...(rest > 0 ? [`- and ${plural(rest, 'other')}`] : [])].join('\n'));
  }

  if (isUnread(f.goals)) unread = true;
  else {
    const lines = [
      ...(f.goals.reached.length > 0 ? [`Goals at their target: ${namesText(f.goals.reached, 'goal')}.`] : []),
      ...(f.goals.behind.length > 0 ? [`Goals behind their target date: ${namesText(f.goals.behind, 'goal')}.`] : []),
    ];
    if (lines.length > 0) paragraphs.push(lines.join('\n'));
    if (f.goals.behind.length > 0) attention = true;
  }

  if (isUnread(f.connections)) unread = true;
  else if (f.connections.length > 0) {
    paragraphs.push(['Bank connections:', ...f.connections.map((c) => `- ${connectionLine(c, f.time_zone, o.now, year, n)}`)].join('\n'));
    attention = true;
  }

  if (isUnread(f.months)) unread = true;
  else if (f.months.length > 0) {
    paragraphs.push(
      f.months
        .map((m) => {
          const reasons = m.gaps.slice(0, 3).map((g) => gapText(g, f.time_zone, year, n));
          const more = m.gaps.length - reasons.length;
          return `${monthName(m.month, f.send_day.slice(0, 7))} may be missing transactions: ${joined([...reasons, ...(more > 0 ? [`${plural(more, 'other reason')}`] : [])])}.`;
        })
        .join('\n')
    );
    attention = true;
  }

  if (isUnread(f.uncategorized)) unread = true;
  else if (f.uncategorized > 0) {
    const one = f.uncategorized === 1;
    paragraphs.push(
      `${plural(f.uncategorized, 'transaction')} from SimpleFIN this week ${one ? 'has' : 'have'} no category, so ${one ? 'it counts' : 'they count'} as spending or income until you categorize ${one ? 'it' : 'them'}.`
    );
    attention = true;
  }

  if (unread) paragraphs.push("Some of your data couldn't be read, so part of this summary is left out. Open Nya to see it all.");
  else if (!attention) paragraphs.push('Nothing needs your attention this week.');

  paragraphs.push(o.link ? `Open Nya to see the figures: ${o.link}/` : 'Open Nya to see the figures.');
  paragraphs.push(footer(o));
  return { subject, text: paragraphs.join('\n\n') + '\n', send_day: f.send_day, banks: [...n.banks] };
}

/** Why it came and how to stop it, and when the next comes: from the
 *  schedule as saved, never from the day a summary asked for now covers. */
function footer(o: ComposeOptions): string {
  const never = 'It never includes balances, amounts or account numbers.';
  const where = 'under Manage on the Accounts tab';
  const stop = o.unsubscribe
    ? `To stop these summaries, open ${o.unsubscribe} or turn them off in Nya, ${where}.`
    : `To stop these summaries, turn them off in Nya, ${where}.`;
  if (o.schedule === null) return `You asked Nya to send this now. The weekly summary isn't on, so no other comes unless you turn it on in Nya, ${where}. ${never}`;
  const day = WEEKDAY_NAMES[o.schedule];
  if (!o.requested) return `Nya sends you this every ${day} because you turned on the weekly summary. ${never} ${stop}`;
  return `You asked Nya to send this now. It comes every ${day} too, because you turned on the weekly summary. ${never} ${stop}`;
}

// ---- The check before anything goes ----

const LINKS = /https?:\/\/\S+/g;
/** A date as dayText writes it: "Tuesday, October 13", "Saturday, January 2, 2027". */
const FULL_DATE = new RegExp(`\\b(${WEEKDAY_NAMES.join('|')}), (${MONTHS.join('|')}) ([1-9]|[12][0-9]|3[01])(?:, ([0-9]{4}))?\\b`, 'g');
/** A month as monthName writes one in another year: "December 2026". */
const MONTH_YEAR = new RegExp(`\\b(${MONTHS.join('|')}) ([0-9]{4})\\b`, 'g');
/** A count as plural() writes it, before one of the summary's own nouns. */
const COUNTS = /\b(?:[0-9]|[1-9][0-9]|over 99) (?:bills?|budgets?|goals?|connections?|transactions?|other reasons?|others?)\b/g;
/** The summary's own words with a number word in them. */
const OWN_PHRASES = ['the next seven days'];

/** What is left that would be a figure, by kind, for the log: the specific
 *  kinds first, then any digit, sign or letter that is left. */
const KINDS: [string, RegExp][] = [
  ['a currency sign by a number', /\p{Sc}\s?\p{N}|\p{N}\s?\p{Sc}/u],
  ['a currency code by a number', /\b[A-Z]{3}\s?\p{N}|\p{N}\s?[A-Z]{3}\b/u],
  ['a number with a decimal or grouping mark', /\p{N}[.,]\p{N}/u],
  ['a percentage', /\p{N}\s?[%٪﹪％]/u],
  ['an account mask', /[•*#]\s?\p{N}|\bending in\b|\bx{1,4}\p{N}{2,}/iu],
  ['a number of three digits or more', /\p{N}{3,}/u],
  ['a digit that is not ASCII', /[^\P{N}0-9]/u],
  ["a number that isn't one of the summary's days or counts", /\p{N}/u],
  ['a currency sign', /\p{Sc}/u],
  ['a percent sign', /[%‰‱٪﹪％]/u],
  ['a letter outside the Latin alphabet', NOT_LATIN],
];

/** Whether `weekday` is that date's weekday, in `year`. */
function isDate(weekday: string, month: string, day: string, year: number): boolean {
  const m = MONTHS.indexOf(month);
  const d = new Date(Date.UTC(year, m, Number(day)));
  return d.getUTCMonth() === m && WEEKDAY_NAMES[d.getUTCDay()] === weekday;
}

/**
 * The kinds of figure in a summary's subject and text (see THE CHECK), read
 * against the day it is for and the banks' names it wrote: empty when there
 * is none. A summary with any is never sent.
 */
export function figuresIn(texts: readonly string[], context: { sendDay: string; banks?: readonly string[] }): string[] {
  const year = Number(context.sendDay.slice(0, 4));
  const { first, last } = weekBefore(context.sendDay);
  const week = shortWeek(first, last);
  const banks = [...(context.banks ?? [])].filter((b) => b.length > 0).sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (const t of texts) {
    let rest = t.replace(LINKS, ' ');
    for (const bank of banks) rest = rest.split(bank).join(' ');
    rest = rest.replace(FULL_DATE, (match, weekday: string, month: string, day: string, y?: string) => {
      // Written with its year only when that year isn't the send day's; a
      // week within one year is written without, so it may be the year before.
      if (y === undefined) return [year, year - 1, year + 1].some((yy) => isDate(weekday, month, day, yy)) ? ' ' : match;
      const yy = Number(y);
      return yy >= 2000 && yy <= year + 1 && isDate(weekday, month, day, yy) ? ' ' : match;
    });
    rest = rest.replace(MONTH_YEAR, (match, _month: string, y: string) => (Math.abs(Number(y) - year) <= 1 ? ' ' : match));
    rest = rest.split(week).join(' ');
    rest = rest.replace(COUNTS, ' ');
    for (const phrase of OWN_PHRASES) rest = rest.split(phrase).join(' ');
    for (const [what, re] of KINDS) if (re.test(rest)) found.add(what);
    if (spellsFigure(rest)) found.add('a number or a currency written as a word');
  }
  return [...found];
}

/** Thrown, with nothing sent, when a summary would carry a figure. */
export class FigureError extends Error {
  constructor(readonly kinds: string[]) {
    super(`The weekly summary would have carried ${kinds.join(', ')}, so it was not sent.`);
    this.name = 'FigureError';
  }
}

/** The summary, checked: throws FigureError when figuresIn finds a figure. */
export function checkedSummary(summary: ComposedSummary): { subject: string; text: string } {
  const kinds = figuresIn([summary.subject, summary.text], { sendDay: summary.send_day, banks: summary.banks });
  if (kinds.length > 0) throw new FigureError(kinds);
  return { subject: summary.subject, text: summary.text };
}
