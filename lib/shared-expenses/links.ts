// lib/shared-expenses/links.ts
//
// The handoff (#49): a link that opens a payment app with a request (or a
// payment) filled in, and a message to copy or share for anything else. Nya
// never sends, receives or holds money, and Venmo has no API for people to
// pay each other: all it does is compose. Pure, safe in the browser.
//
// WHAT IS DOCUMENTED, AND WHAT ISN'T (checked 2026-10-23, through a search:
// this machine can't reach venmo.com or cash.app). Venmo's payment links page
// documents https://venmo.com/<username>?txn=charge&amount=1&note=for+a+typo
// (`txn` is pay or charge, the note URL-escaped). The form without a
// username, the `recipients` parameter and the app scheme venmo://paycharge
// come from third parties only, and Cash App makes its payment links in the
// app; its https://cash.app/$<cashtag>/<amount> is from third-party guides
// only. So only the documented form is built, and the others only while
// UNCONFIRMED_LINKS is on: off until the owner has checked them on an iPhone
// and an Android phone from the installed app (docs/operations.md).
//
// FIGURES. A link carries its amount as a plain decimal ("35.00"), and the
// message its amounts written out ("$35.00"): what the other person reads,
// whatever this screen hides. So this module writes figures without the
// formatters of lib/format.ts, by name exempt from the scan that holds a page
// to them (test/hide-amounts.test.tsx); the sheet shows the message through
// hideAmountsIn, so nothing it draws shows a figure while amounts are hidden.
//
// SAFE BY CONSTRUCTION. The hosts are fixed, a handle is checked as a handle
// (letters, digits, "-" and "_") before it becomes a path segment, and every
// part goes through encodeURIComponent, so no link can point anywhere else.

import { isHandle, type Direction, type RequestVia } from './model';
import { unitScale } from '../split-rows';

/** The switch for the forms nobody documented (see the header). Off. */
export const UNCONFIRMED_LINKS: boolean = false;

/** A Venmo note's length, in characters (code points): cut before encoding. */
export const NOTE_CHARS = 200;

/** A link is offered only for an amount in this currency: Venmo and Cash App
 *  move US dollars. */
export const LINK_CURRENCY = 'USD';

/** An amount as a link carries it: two places, a dot, no separators. */
export function linkAmount(amount: number): string {
  return (Math.round(Math.abs(amount) * 100) / 100).toFixed(2);
}

/** A note cut to `max` code points, on a word where there is one, with no
 *  control characters. */
export function cutNote(note: string, max = NOTE_CHARS): string {
  const clean = note.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = [...clean];
  if (points.length <= max) return clean;
  const cut = points.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** A link to a payment app, and whether it is a form nobody documented. */
export type Handoff = { via: RequestVia; app: 'Venmo' | 'Cash App'; href: string; unconfirmed: boolean };

export type HandoffInput = {
  /** to_you: ask them for it; by_you: pay them. */
  direction: Direction;
  amount: number;
  currency: string;
  note: string;
  /** Theirs. */
  venmo?: string;
  cashtag?: string;
  /** The switch, for a test: UNCONFIRMED_LINKS by default. */
  unconfirmed?: boolean;
};

/** The documented Venmo link, or null without a username, for another
 *  currency, or for nothing to ask. */
export function venmoLink(input: Pick<HandoffInput, 'direction' | 'amount' | 'currency' | 'note' | 'venmo'>): string | null {
  if (input.currency !== LINK_CURRENCY || !(input.amount > 0) || !input.venmo || !isHandle(input.venmo)) return null;
  const txn = input.direction === 'to_you' ? 'charge' : 'pay';
  return `https://venmo.com/${encodeURIComponent(input.venmo)}?txn=${txn}&amount=${linkAmount(input.amount)}&note=${encodeURIComponent(cutNote(input.note))}`;
}

/** Every link to offer, the documented one first. */
export function handoffLinks(input: HandoffInput): Handoff[] {
  const out: Handoff[] = [];
  const documented = venmoLink(input);
  if (documented) out.push({ via: 'venmo', app: 'Venmo', href: documented, unconfirmed: false });
  if (!(input.unconfirmed ?? UNCONFIRMED_LINKS) || input.currency !== LINK_CURRENCY || !(input.amount > 0)) return out;
  const txn = input.direction === 'to_you' ? 'charge' : 'pay';
  const amount = linkAmount(input.amount);
  const note = encodeURIComponent(cutNote(input.note));
  if (input.venmo && isHandle(input.venmo)) {
    out.push({ via: 'venmo-app', app: 'Venmo', href: `venmo://paycharge?txn=${txn}&recipients=${encodeURIComponent(input.venmo)}&amount=${amount}&note=${note}`, unconfirmed: true });
  } else if (!documented) {
    out.push({ via: 'venmo', app: 'Venmo', href: `https://venmo.com/?txn=${txn}&amount=${amount}&note=${note}`, unconfirmed: true });
  }
  // Cash App pays a cashtag: only for what you owe them.
  if (input.direction === 'by_you' && input.cashtag && isHandle(input.cashtag)) {
    out.push({ via: 'cashapp', app: 'Cash App', href: `https://cash.app/$${encodeURIComponent(input.cashtag)}/${amount}`, unconfirmed: true });
  }
  return out;
}

// ---- The message ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day as the message writes it: "Oct 3". */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1] ?? ''} ${d}`.trim();
}

/** An amount as the other person reads it: "$35.00", "€12.00", "¥1,200",
 *  "BTC 0.0004", to the currency's own unit (lib/split-rows.ts unitScale:
 *  eight places for a code without an ISO currency), or the figures and the
 *  code for a currency Intl doesn't take. */
export function messageMoney(amount: number, currency: string): string {
  const places = Math.round(Math.log10(unitScale(currency)));
  // Intl writes any well-formed code at two places: a code it doesn't know
  // (a cryptocurrency) takes its own, its trailing zeros left off.
  const digits = places === UNKNOWN_PLACES ? { minimumFractionDigits: 2, maximumFractionDigits: places } : {};
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, ...digits }).format(Math.abs(amount));
  } catch {
    return `${Math.abs(amount).toFixed(places)} ${currency}`;
  }
}

/** The places lib/split-rows.ts unitScale gives a code it doesn't know. */
const UNKNOWN_PLACES = 8;

export type MessageLine = { what: string; date: string; amount: number; direction: Direction };

export type MessageInput = {
  name: string;
  /** Who pays the total: to_you, they pay you. */
  direction: Direction;
  amount: number;
  currency: string;
  lines: readonly MessageLine[];
  /** Theirs, to say where to pay them. */
  venmo?: string;
  cashtag?: string;
  /** The person's own, to say where to pay them. */
  ownVenmo?: string;
  ownCashtag?: string;
};

/** The message to copy or share (see the header). */
export function messageText(m: MessageInput): string {
  const total = messageMoney(m.amount, m.currency);
  const head = m.direction === 'to_you' ? `Hi ${m.name}, ${total} is left for you to pay me:` : `Hi ${m.name}, I owe you ${total}:`;
  // Each item from the payer's side: what adds to the total, and what is
  // taken off it.
  const lines = m.lines.map((l) => {
    const adds = l.direction === m.direction;
    return `${l.what}, ${shortDay(l.date)}: ${adds ? '' : 'less '}${messageMoney(l.amount, m.currency)}`;
  });
  const where: string[] = [];
  if (m.direction === 'to_you') {
    if (m.ownVenmo) where.push(`Venmo: @${m.ownVenmo}`);
    if (m.ownCashtag) where.push(`Cash App: $${m.ownCashtag}`);
  }
  return [head, ...lines, ...(where.length > 0 ? [where.join(' · ')] : [])].join('\n');
}

/** The note a Venmo link carries: what each item was for, in order. */
export function noteOf(lines: readonly Pick<MessageLine, 'what'>[]): string {
  return cutNote(lines.map((l) => l.what).join(', '));
}
