'use client';

// The words for a connection's health (#51): its badge, what is wrong and
// what to do, whose side it is on, which accounts it affects and how much of
// net worth is shown from last known balances, and when it last synced. Rollout
// phase 3b folded the Connection health card into the institution cards
// (components/ConnectionStatus.tsx) and Connection details
// (components/ConnectionDetails.tsx), which say it in these words.
//
// Everything here reads the `health` the server attached to each institution
// (lib/connection-state.ts); a payload from before it existed has none, and
// nothing is said then rather than guessed.

import type { ConnectionHealth as Health, HealthState } from '@/lib/connection-state';
import { formatDay, formatInstantDay, formatMoney, dominantCurrency, onDay } from '@/lib/format';
import { signedContribution } from '@/lib/balance';
import { balancesNow, needsConverting, type PageFx } from '@/lib/fx/view';
import { joinNames } from '@/lib/month-coverage';

/** What the view needs of an institution, as /api/net-worth sends it. */
export type HealthInstitution = {
  institution_name: string;
  item_id: string;
  manual?: boolean;
  /** Accounts a connector the person brought feeds (SimpleFIN): `manual`
   *  too, but with a connection whose health this view shows. */
  connector?: string;
  connection_id?: string;
  error: string | null;
  accounts: {
    account_id?: string;
    name: string;
    mask: string | null;
    type: string;
    balance: number | null;
    currency: string | null;
    hidden?: boolean;
    stale?: boolean;
    /** Held at its last known balance while a question about it is open
     *  (lib/lifecycle-questions.ts). */
    held?: { as_of: string | null; too_old?: string };
    question?: { kind: 'missing' | 'zero' | 'reported'; still_open?: true; again?: true };
  }[];
  /** Accounts that ended that its bank still returns, moved since: asked
   *  about, and counted in nothing (lib/lifecycle-questions.ts). */
  ended_reported?: { question?: { kind: string } }[];
  health?: Health;
  stale_as_of?: string;
  stale_as_of_at?: string;
  stale_too_old?: string;
  stale_too_old_at?: string;
  unconfirmed_missing?: number;
  unshown_accounts?: { account_id?: string; name: string; mask: string | null }[];
};

const BADGES: Record<HealthState, string> = {
  healthy: 'Working',
  reconnect_soon: 'Reconnect soon',
  needs_reauth: 'Needs reconnecting',
  outage: 'Not updating',
  relink: 'Needs connecting again',
  closed: 'No open accounts',
  partial: 'Missing accounts',
};

/** Whether the end Plaid warned of has already come (on a connection that
 *  still answered, or in a payload made before it). */
const endPassed = (h: Health, now: number) => !!h.ends_at && Date.parse(h.ends_at) <= now;

export function badgeOf(h: Health, now: number = Date.now()): string {
  if (h.cause === 'unsupported') return "Can't be repaired";
  if (h.state === 'reconnect_soon' && endPassed(h, now)) return 'Reconnect now';
  return BADGES[h.state] ?? BADGES.outage;
}

/** The local day an instant fell on, mid sentence: "today", "Sep 12". */
const localDay = (iso: string, now?: number) => formatInstantDay(iso, { sentence: true, now }) ?? iso.slice(0, 10);
/** "Sep 12" from a YYYY-MM-DD, read at local midnight, as the cards read dates. */
const calendarDay = (date: string) => formatDay(date, { sentence: true });
/** A stored snapshot's day, in the viewer's own time when its instant is known
 *  and belongs to that UTC day (as fmtStaleDay in components/Dashboard.tsx). */
const snapshotDay = (date: string, at?: string) => (at && at.slice(0, 10) === date ? localDay(at) : calendarDay(date));

/** The day a connection ends, as the badge and the note say it. */
export function endsText(h: Health, now: number = Date.now()): string {
  if (!h.ends_at) return 'Plaid says this connection will end soon';
  const day = localDay(h.ends_at, now);
  const when = h.ends_estimated ? `around ${day}` : onDay(day);
  if (endPassed(h, now)) return `Plaid said this connection would end ${when}`;
  return `Plaid says this connection ends ${when}`;
}

/** What to do about an end Plaid warned of: before it, or now that it has come. */
export function reconnectText(h: Health, now: number = Date.now()): string {
  return endPassed(h, now) ? 'Reconnect now to keep it syncing' : 'Reconnect before then to keep it syncing';
}

/** What is wrong and what to do, in a sentence or two. */
export function healthText(name: string, h: Health, inst: Pick<HealthInstitution, 'unconfirmed_missing'> & Partial<Pick<HealthInstitution, 'accounts'>>, now: number = Date.now()): string | null {
  const again = `connect ${name} again: link its new accounts to the old ones and their history carries over`;
  switch (h.cause) {
    case 'ok':
      return null;
    case 'consent_ending':
    case 'disconnect_pending':
      return `${endsText(h, now)}. ${reconnectText(h, now)}: it takes a minute.`;
    case 'login':
      return `${name} needs you to sign in again. Reconnect: it takes a minute.`;
    case 'access':
      return `${name} isn't sharing everything Nya needs. Reconnect and allow access to your accounts.`;
    case 'locked':
      return `${name} has locked this sign-in. Unlock it with ${name}, then reconnect.`;
    case 'bank_action':
      return `${name} needs something done on its own website first, such as a new password or terms to accept. Then reconnect.`;
    case 'institution_down':
      return `${name} isn't answering. Nothing to do: it usually recovers on its own.`;
    case 'provider':
      return `Plaid, which Nya reaches ${name} through, is having trouble. Nothing to do: it usually recovers on its own.`;
    case 'unreachable':
      return `Nya couldn't get an answer. Nothing to do: it usually recovers on its own.`;
    // On Nya's side: nothing for the person to do, and never removal, which
    // would lose the connection's stored transactions for nothing.
    case 'credentials':
      return `Nya can't read the sign-in it keeps for ${name}. Nothing for you to do: whoever runs Nya restores its encryption keys, and the connection then works as before.`;
    case 'token':
      return `Plaid doesn't accept the access Nya keeps for ${name}, which usually means Nya's own Plaid settings changed. Nothing for you to do: whoever runs Nya puts them back, and the connection then works as before.`;
    case 'setup':
      return `Plaid refused Nya's own settings, so it can't reach ${name} just now. Nothing for you to do: whoever runs Nya puts them right, and the connection then works as before.`;
    case 'revoked':
      return `Access to ${name} was withdrawn, so this connection can't be repaired. Remove it, then ${again}.`;
    case 'gone':
      return `Plaid no longer has this connection, so it can't be repaired. Remove it, then ${again}.`;
    case 'unsupported':
      return `Plaid can no longer reach ${name}, so reconnecting won't help. Remove the connection; its history is kept, and its accounts can be tracked by hand.`;
    case 'no_accounts':
      return `${name} reports no open accounts. If you closed them, remove the connection: their history is kept.`;
    case 'vanished': {
      const n = inst.unconfirmed_missing ?? 0;
      const one = n === 1;
      // Every one held is one the person said is still open: they have
      // answered, so say what that holds, and for how long.
      const held = (inst.accounts ?? []).filter((a) => a.held);
      if (held.length > 0 && held.every((a) => a.question?.still_open)) {
        return `You said ${one ? 'the account' : `the ${n} accounts`} ${name} stopped reporting ${one ? 'is' : 'are'} still open. Until ${one ? 'it comes' : 'they come'} back, ${one ? 'it is' : 'they are'} counted at ${one ? 'its' : 'their'} last known balance and no total is saved, for two weeks from your answer at most; then Nya asks again. Reconnecting may bring ${one ? 'it' : 'them'} back.`;
      }
      return `${n} account${one ? '' : 's'} ${name} used to report ${one ? "isn't" : "aren't"} in its latest answer. Until you say whether ${one ? 'it' : 'they'} closed, ${one ? 'it is' : 'they are'} counted at ${one ? 'its' : 'their'} last known balance and no total is saved. If nobody answers, Nya assumes ${one ? 'it' : 'them'} closed after three days, and you can say otherwise. Removed ${one ? 'it' : 'them'} on purpose? Check with Add or remove accounts.`;
    }
    default:
      return `${name} couldn't be updated${h.code ? ` (Plaid: ${h.code})` : ''}. This usually clears on its own.`;
  }
}

/** Whose side the problem is on: the support question to answer first. */
export function sideText(name: string, h: Health): string | null {
  switch (h.side) {
    case 'you':
      return `On your side: your sign-in at ${name}`;
    case 'bank':
      return `On ${name}'s side`;
    case 'plaid':
      return "On Plaid's side";
    case 'nya':
      return "On Nya's side";
    case 'unknown':
      return 'Whose side: not known';
    default:
      return null;
  }
}

const label = (a: { name: string; mask: string | null }) => (a.mask ? `${a.name} ••${a.mask}` : a.name);

type Row = HealthInstitution['accounts'][number];

/** ", together $3,800 of net worth", unless several currencies would be
 *  added unconverted. With a home currency chosen (`fx`), in it, converted
 *  at the newest rates as the hero is (lib/fx/view.ts), unless a currency
 *  among them has no rate. */
function together(rows: Row[], money: (n: number, currency: string | null) => string, fx: PageFx | null = null): string {
  const main = dominantCurrency(rows.map((a) => ({ iso_currency_code: a.currency })));
  const signed = rows.map((a) => ({ amount: signedContribution(a.type, a.balance ?? 0), currency: a.currency }));
  if (needsConverting(signed, fx, main)) {
    const b = balancesNow(signed, fx, main);
    return b.left_out.length > 0 ? '' : `, together ${money(b.total, b.currency)} of net worth`;
  }
  if (new Set(rows.map((a) => a.currency).filter(Boolean)).size > 1) return '';
  return `, together ${money(signed.reduce((n, r) => n + r.amount, 0), main)} of net worth`;
}

/**
 * Which accounts a problem affects, and how much of net worth is shown from
 * last known balances rather than measured now, labeled as such. Hidden
 * accounts are left out, as they are of every total.
 */
export function affectedText(inst: HealthInstitution, money: (n: number, currency: string | null) => string = formatMoney, fx: PageFx | null = null): string[] {
  const h = inst.health;
  if (!h) return [];
  const lines: string[] = [];
  if (h.state === 'partial') {
    // Held at their last known balances (lib/lifecycle-questions.ts), or not
    // counted when none is recent enough; a payload from before holds says
    // only how many.
    const held = inst.accounts.filter((a) => a.held && !a.hidden);
    const counted = held.filter((a) => a.balance != null);
    const uncounted = held.filter((a) => a.balance == null);
    if (counted.length > 0) {
      const days = new Set(counted.map((a) => a.held?.as_of));
      const first = counted[0].held?.as_of;
      const day = days.size === 1 && first ? ` from ${calendarDay(first)}` : '';
      lines.push(`Shown at last known balances${day}, not measured now: ${joinNames(counted.map(label))}${together(counted, money, fx)}.`);
    }
    if (uncounted.length > 0) lines.push(`Not counted in net worth: ${joinNames(uncounted.map(label))}.`);
    if (held.length === 0) {
      const n = inst.unconfirmed_missing ?? 0;
      lines.push(`${n} account${n === 1 ? '' : 's'} not in the total.`);
    }
    return lines;
  }
  if (!inst.error) return lines;
  const recovered = inst.accounts.filter((a) => a.stale && !a.hidden && a.balance != null);
  if (recovered.length > 0) {
    const day = inst.stale_as_of ? ` from ${snapshotDay(inst.stale_as_of, inst.stale_as_of_at)}` : '';
    lines.push(`Shown at last known balances${day}, not measured now: ${joinNames(recovered.map(label))}${together(recovered, money, fx)}.`);
  }
  const unshown = inst.unshown_accounts ?? [];
  if (unshown.length > 0) {
    lines.push(`Not counted in net worth: ${joinNames(unshown.map(label))}.`);
  } else if (recovered.length === 0) {
    lines.push('Not counted in net worth.');
  }
  if (inst.stale_too_old) {
    lines.push(`Its last known balances are from ${snapshotDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to count.`);
  }
  return lines;
}

/** "Last synced Oct 6", or that it was never recorded. */
export function lastSyncedText(h: Health): string {
  return h.last_ok_at ? `Last synced ${localDay(h.last_ok_at)}` : 'Last synced: not recorded yet';
}
