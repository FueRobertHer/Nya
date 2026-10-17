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
// where the week crosses into another, and counts of things ("2 bills due"),
// written as "over 99" from a hundred. Names are the person's own (their
// budgets and categories, their goals, merchants as they come or as the person
// renamed them, their banks), personal too, and said so on /privacy: one is
// carried only without a digit or a currency sign, since "Rent 1500" or
// "Transfer to 4821" would carry an amount or an account number. One with
// either is counted instead ("Groceries and 1 other"). And before anything
// goes, figuresIn checks the whole subject and text again, and the senders
// refuse a summary it finds one in (job.ts, send-now.ts): a bug that let a
// figure through stops the email rather than sending it.
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
import { WEEKDAY_NAMES } from './settings';
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

/** A name as a summary may carry it: one line, not too long, and with no digit
 *  or currency sign in it (see NEVER A FIGURE); null when it can't be. */
export function safeName(raw: string): string | null {
  const one = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!one || /[\p{N}\p{Sc}]/u.test(one)) return null;
  const chars = Array.from(one);
  if (chars.length <= NAME_CHARS) return one;
  const cut = chars.slice(0, NAME_CHARS).join('');
  const space = cut.lastIndexOf(' ');
  return (space > NAME_CHARS / 2 ? cut.slice(0, space) : cut).trim();
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
 *  budgets"). Each name once. */
export function namesText(raw: readonly string[], noun: string): string {
  const names = [...new Set(raw)];
  const safe = [...new Set(names.map(safeName).filter((n): n is string => n !== null))];
  if (safe.length === 0) return plural(names.length, noun);
  const shown = safe.slice(0, NAMES_LISTED);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${plural(rest, 'other')}` : joined(shown);
}

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

const LEVEL_TEXT: Record<Level, string> = {
  much_higher: 'You spent much more this week than in a usual week.',
  higher: 'You spent more this week than in a usual week.',
  same: 'You spent about as much this week as in a usual week.',
  lower: 'You spent less this week than in a usual week.',
  much_lower: 'You spent much less this week than in a usual week.',
};

/** A name, or what to call it when it can't be carried. */
const nameOr = (raw: string, instead: string) => safeName(raw) ?? instead;

function spendingText(s: SpendingFact, year: string): string {
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
      const parts = s.sources.map((src) => {
        const name = nameOr(src.name, 'a bank');
        return src.since ? `${name}'s last came in on ${dayText(src.since, year)}` : `${name}'s haven't come in`;
      });
      return `This week's spending isn't compared, as not all of its transactions are in: ${joined(parts)}.`;
    }
    case 'none_come_in':
      return "None of your connected accounts brings in bank or card transactions, so there's no spending to compare.";
  }
}

function billLine(b: BillFact, year: string): string {
  const name = nameOr(b.name, b.planned ? 'Something you planned' : 'A bill');
  const label = b.planned && safeName(b.name) ? `${name} (planned)` : name;
  return b.late ? `- ${label}: due ${dayText(b.day, year)}, not in yet` : `- ${label}: ${dayText(b.day, year)}`;
}

/** A connection that needs the person, as a notice's subject says it, and
 *  for one Plaid says will end, around which day (on their calendar). */
function connectionLine(c: ConnectionFact, zone: string, now: number, year: string): string {
  const name = nameOr(c.name, 'A bank');
  const headline = subjectFor(name, { state: c.state, cause: 'unknown', ends_at: c.ends_at ?? undefined }, now);
  const day = c.state === 'reconnect_soon' && c.ends_at ? dayIn(c.ends_at, zone) : null;
  if (!day) return `${headline}.`;
  return Date.parse(c.ends_at!) <= now ? `${headline}: Plaid said its connection would end around ${dayText(day, year)}.` : `${headline}: Plaid says its connection ends around ${dayText(day, year)}.`;
}

/** Why a month may be incomplete, in the Budgets tab's words, with names only
 *  as a summary may carry them. What couldn't be read is said as that. */
function gapText(g: MonthGap, zone: string, year: string): string {
  const inst = 'institution' in g ? nameOr(g.institution, 'a bank') : 'a bank';
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
  /** Whether the summary is on. */
  enabled: boolean;
  now: number;
};

/** The subject's items, most pressing first (see composeWeekly). */
function subjectItems(f: WeeklyFacts, now: number): string[] {
  const items: string[] = [];
  const short = (raw: string) => {
    const n = safeName(raw);
    return n && n.length <= 30 ? n : null;
  };
  if (!isUnread(f.connections) && f.connections.length > 0) {
    const c = f.connections[0];
    const name = f.connections.length === 1 ? short(c.name) : null;
    items.push(name ? lowerFirst(subjectFor(name, { state: c.state, cause: 'unknown', ends_at: c.ends_at ?? undefined }, now)) : `${plural(f.connections.length, 'connection')} ${f.connections.length === 1 ? 'needs' : 'need'} you`);
  }
  if (!isUnread(f.budgets) && f.budgets && f.budgets.over.length > 0) {
    const over = [...new Set(f.budgets.over)];
    const name = over.length === 1 ? short(over[0]) : null;
    items.push(name ? `${name} over budget` : `${plural(over.length, 'budget')} over`);
  }
  if (!isUnread(f.bills) && f.bills.length > 0) items.push(`${plural(f.bills.length, 'bill')} due`);
  if (!isUnread(f.goals) && f.goals.behind.length > 0) {
    const behind = [...new Set(f.goals.behind)];
    const name = behind.length === 1 ? short(behind[0]) : null;
    items.push(name ? `${name} behind` : `${plural(behind.length, 'goal')} behind`);
  }
  if (!isUnread(f.spending)) {
    if (f.spending.kind === 'compared' && (f.spending.level === 'much_higher' || f.spending.level === 'higher')) items.push('more spending than usual');
    else if (f.spending.kind === 'compared' && (f.spending.level === 'much_lower' || f.spending.level === 'lower')) items.push('less spending than usual');
    else if (f.spending.kind === 'no_transactions') items.push('no transactions');
  }
  return items;
}

/** "reconnect Chase soon" after a colon; a name keeps its capital. */
const lowerFirst = (s: string) => (s.startsWith('Reconnect ') ? `r${s.slice(1)}` : s);

/**
 * The summary's subject and plain text (see the header): "Your week in Nya: 2
 * bills due, Groceries over budget", then the week, the spending line, each
 * section with something to say, a line for what couldn't be read, the link
 * to the app, and why it came and how to stop it.
 */
export function composeWeekly(f: WeeklyFacts, o: ComposeOptions): { subject: string; text: string } {
  const year = f.send_day.slice(0, 4);
  const items = subjectItems(f, o.now);
  // A quiet week only when the week is known to be one: its spending
  // compared, or none at all. Otherwise the subject is just the week.
  const known = !isUnread(f.spending) && (f.spending.kind === 'compared' || f.spending.kind === 'no_transactions');
  const subject = `Your week in Nya: ${items.length > 0 ? items.slice(0, 2).join(', ') : known ? 'a quiet week' : shortWeek(f.first, f.last)}`;

  const paragraphs: string[] = [`Your week in Nya: ${weekText(f.first, f.last)}.`];
  let unread = false;
  let attention = false;

  if (isUnread(f.spending)) unread = true;
  else {
    paragraphs.push(spendingText(f.spending, year));
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
    const shown = f.bills.slice(0, BILLS_LISTED).map((b) => billLine(b, year));
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
    paragraphs.push(['Bank connections:', ...f.connections.map((c) => `- ${connectionLine(c, f.time_zone, o.now, year)}`)].join('\n'));
    attention = true;
  }

  if (isUnread(f.months)) unread = true;
  else if (f.months.length > 0) {
    paragraphs.push(
      f.months
        .map((m) => {
          const reasons = m.gaps.slice(0, 3).map((g) => gapText(g, f.time_zone, year));
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
  paragraphs.push(footer(f, o));
  return { subject, text: paragraphs.join('\n\n') + '\n' };
}

/** Why it came and how to stop it. */
function footer(f: WeeklyFacts, o: ComposeOptions): string {
  const never = 'It never includes balances, amounts or account numbers.';
  const where = 'under Manage on the Accounts tab';
  const stop = o.unsubscribe
    ? `To stop these summaries, open ${o.unsubscribe} or turn them off in Nya, ${where}.`
    : `To stop these summaries, turn them off in Nya, ${where}.`;
  const day = WEEKDAY_NAMES[f.weekday];
  if (!o.requested) return `Nya sends you this every ${day} because you turned on the weekly summary. ${never} ${stop}`;
  if (o.enabled) return `You asked Nya to send this now. It comes every ${day} too, because you turned on the weekly summary. ${never} ${stop}`;
  return `You asked Nya to send this now. The weekly summary isn't on, so no other comes unless you turn it on in Nya, ${where}. ${never}`;
}

// ---- The check before anything goes ----

/** Dates as a summary writes them ("October 13", "October 13, 2027",
 *  "October 2025"), and links, are taken out before looking for figures. */
const DATES = new RegExp(`\\b(?:${MONTHS.join('|')})(?: \\d{1,2})?(?:,? \\d{4})?\\b`, 'g');
const LINKS = /https?:\/\/\S+/g;

/** What would be a figure in a summary's text (see NEVER A FIGURE). */
const FIGURES: [string, RegExp][] = [
  ['a currency sign by a number', /\p{Sc}\s?\p{N}|\p{N}\s?\p{Sc}/u],
  ['a currency code by a number', /\b[A-Z]{3}\s?\p{N}|\p{N}\s?[A-Z]{3}\b/u],
  ['a number with a decimal or grouping mark', /\p{N}[.,]\p{N}/u],
  ['a percentage', /\p{N}\s?%/u],
  ['an account mask', /[•*#]\s?\p{N}|\bending in\b|\bx{1,4}\p{N}{2,}/iu],
  ['a number of three digits or more', /\p{N}{3,}/u],
  ['a digit that is not ASCII', /[^\P{N}0-9]/u],
];

/**
 * The kinds of figure found in a summary's subject or text, outside its dates
 * and links: empty when there is none. A summary with any is never sent.
 */
export function figuresIn(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    const bare = t.replace(LINKS, ' ').replace(DATES, ' ');
    for (const [what, re] of FIGURES) if (re.test(bare)) found.add(what);
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

/** The summary, checked: throws FigureError when figuresIn finds one. */
export function checkedSummary(summary: { subject: string; text: string }): { subject: string; text: string } {
  const kinds = figuresIn(summary.subject, summary.text);
  if (kinds.length > 0) throw new FigureError(kinds);
  return summary;
}
