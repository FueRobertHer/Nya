// components/total-notes.ts
//
// The notes under the Home total that say what it is missing (#51), naming
// each institution rather than only counting them: "Chase needs reconnecting,
// last seen Sep 12, and isn't counted in this total". The total is the number
// people read, so a gap in it is said there, not only on the Accounts tab.
// Same wording style as before, with the names in. Pure, so the tests hold the
// words. Each comes with its color (rollout phase 4a): red when it says the
// total is short or an institution needs the person, by the same rule as the
// cards (lib/accounts-status.ts), amber otherwise, and a few words for the
// summary line that gathers the lesser ones (components/TotalCaveats.tsx).

import { joinNames } from '@/lib/month-coverage';
import { worse, type Severity } from '@/lib/accounts-status';

/** What the notes read of an institution, as /api/net-worth sends it. */
export type TotalNoteInstitution = {
  institution_name: string;
  error: string | null;
  needs_reauth: boolean;
  manual?: boolean;
  stale_as_of?: string;
  stale_as_of_at?: string;
  stale_missing?: number;
  unconfirmed_missing?: number;
  /** `detail`: what a connector's accounts are waiting on (lib/connectors/health.ts). */
  health?: { last_ok_at: string | null; detail?: { issue: string } | null };
  /** Its rows: an account missing from its answer is held at its last known
   *  balance (`held`), or without one when that is too old to count, and
   *  says whether the person answered that it is still open. */
  accounts?: { balance: number | null; hidden?: boolean; held?: unknown; question?: { still_open?: true } }[];
};

export type DayFormat = {
  /** A stored snapshot's day (a UTC date, and the instant it was taken). */
  snapshot: (date: string, at?: string) => string;
  /** An instant's local day. */
  instant: (iso: string) => string;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Names, with how many accounts at each when more than one place is named. */
function accountsAt(insts: TotalNoteInstitution[], count: (i: TotalNoteInstitution) => number): { n: number; where: string } {
  const n = insts.reduce((sum, i) => sum + count(i), 0);
  return { n, where: joinNames([...new Set(insts.map((i) => i.institution_name))]) };
}

/** What is wrong with an institution shown at last known balances, in a few
 *  words: a card or loan SimpleFIN reports as money held waits for the
 *  person's answer, which no refresh brings. */
const holdUp = (i: TotalNoteInstitution) =>
  i.health?.detail?.issue === 'sign' ? 'has a card or loan waiting for your answer' : i.needs_reauth ? 'needs reconnecting' : "couldn't refresh";

/** What a restore holds back, as /api/net-worth sends it (lib/user-restore/
 *  restored.ts totalsHold): no total is recorded while it holds. */
export type RestoreHoldNote = { unfinished: boolean; waiting: { institution_name: string; last: string | null }[]; unreadable: boolean };

/** A note on the total, with its color and a few words for the summary
 *  line ("last known balances at Chase"): never an amount. */
export type TotalNote = { text: string; severity: Severity; summary: string };

/** Each institution's one color, as its card has it (lib/accounts-status.ts
 *  severityOf), so a note never says less than the card. */
export type SeverityOf<T> = (inst: T) => Severity | null;

/** The notes for the total, in the order they were always shown, then what
 *  a restore holds back (`hold`), said every day while it holds. */
export function totalNotes(institutions: TotalNoteInstitution[], day: DayFormat, hold?: RestoreHoldNote | null): string[] {
  return totalCaveats(institutions, day, hold, () => null).map((n) => n.text);
}

/** The same notes, each with its color: a note naming several institutions
 *  takes the worst of theirs, and one that says the total is short is red
 *  whatever they say. */
export function totalCaveats<T extends TotalNoteInstitution>(institutions: T[], day: DayFormat, hold: RestoreHoldNote | null | undefined, severityOf: SeverityOf<T>): TotalNote[] {
  const notes = institutionNotes(institutions, day, severityOf);
  if (hold) notes.push(...restoreCaveats(hold, day));
  return notes;
}

/** What a restore holds back, in words: why no total is recorded, and what
 *  to do. A restored bank's own balances count in no total here: it isn't
 *  connected. */
export function restoreNotes(hold: RestoreHoldNote, day: DayFormat): string[] {
  return restoreCaveats(hold, day).map((n) => n.text);
}

/** A restore that isn't finished, or can't be read, holds the record back:
 *  amber. A bank it brought back that isn't connected is missing from the
 *  total: red. */
function restoreCaveats(hold: RestoreHoldNote, day: DayFormat): TotalNote[] {
  const notes: TotalNote[] = [];
  if (hold.unfinished)
    notes.push({
      text: "A restore of your download hasn't finished, so no total is recorded until it does: resume it or undo it in Settings, Your data and privacy",
      severity: 'caution',
      summary: 'a restore not finished',
    });
  if (hold.waiting.length === 1) {
    const [w] = hold.waiting;
    notes.push({
      text: `${w.institution_name}, brought back from your download${w.last ? ` with transactions to ${day.snapshot(w.last)}` : ''}, isn't connected here and isn't counted in this total · no total is recorded until you connect it again and link its accounts, or stop following them (Settings, Your data and privacy, Bring back a download)`,
      severity: 'critical',
      summary: `${w.institution_name} not connected after a restore`,
    });
  } else if (hold.waiting.length > 1) {
    const names = joinNames(hold.waiting.map((w) => w.institution_name));
    notes.push({
      text: `${names}, brought back from your download, aren't connected here and aren't counted in this total · no total is recorded until you connect each again and link its accounts, or stop following them (Settings, Your data and privacy, Bring back a download)`,
      severity: 'critical',
      summary: `${names} not connected after a restore`,
    });
  }
  if (hold.unreadable) notes.push({ text: "What a restore brought back can't be read just now, so no total is recorded until it can be", severity: 'caution', summary: "a restore can't be read" });
  return notes;
}

function institutionNotes<T extends TotalNoteInstitution>(institutions: T[], day: DayFormat, severityOf: SeverityOf<T>): TotalNote[] {
  const notes: TotalNote[] = [];
  // The worst color of these institutions' cards, never below amber: each
  // note says something is off.
  const worst = (list: T[]): Severity => list.reduce<Severity | null>((w, i) => worse(w, severityOf(i)), null) ?? 'caution';

  // Recovered: shown at last known balances. They share one snapshot, so one date.
  const stale = institutions.filter((i) => i.stale_as_of);
  if (stale.length === 1) {
    const [i] = stale;
    notes.push({
      text: `${i.institution_name} ${holdUp(i)}; its balances are from ${day.snapshot(i.stale_as_of!, i.stale_as_of_at)}`,
      severity: worst(stale),
      summary: `last known balances at ${i.institution_name}`,
    });
  } else if (stale.length > 1) {
    const phrases = stale.map((i) => `${i.institution_name} ${holdUp(i)}`);
    const dates = new Set(stale.map((i) => i.stale_as_of));
    const from = dates.size === 1 ? ` from ${day.snapshot(stale[0].stale_as_of!, stale[0].stale_as_of_at)}` : '';
    notes.push({
      text: `${joinNames(phrases)}; showing their last known balances${from}`,
      severity: worst(stale),
      summary: `last known balances at ${joinNames(stale.map((i) => i.institution_name))}`,
    });
  }

  // Recovered, but short some rows.
  const short = institutions.filter((i) => (i.stale_missing ?? 0) > 0);
  if (short.length > 0) {
    const { n, where } = accountsAt(short, (i) => i.stale_missing ?? 0);
    notes.push({ text: `${n} ${plural(n, 'account', 'accounts')} at ${where} couldn't be shown, so this total is incomplete`, severity: 'critical', summary: `${n} ${plural(n, 'account', 'accounts')} not shown` });
  }

  // Answered, without accounts it used to report. Each is held at its last
  // known balance until the person says whether it closed
  // (lib/lifecycle-questions.ts), or left out when that is too old to count;
  // a payload from before holds left them all out. Nothing is saved to
  // history meanwhile.
  const vanished = institutions.filter((i) => (i.unconfirmed_missing ?? 0) > 0);
  if (vanished.length > 0) {
    const { n, where } = accountsAt(vanished, (i) => i.unconfirmed_missing ?? 0);
    const held = vanished.flatMap((i) => (i.accounts ?? []).filter((a) => a.held && !a.hidden));
    const out = held.length === 0 ? n : held.filter((a) => a.balance === null).length;
    // Answered "Still open": the hold waits for the account, not for an answer.
    const answered = held.length > 0 && held.every((a) => a.question?.still_open);
    const what =
      out === 0
        ? answered
          ? `; you said ${plural(n, 'it is', 'they are')} still open, so ${plural(n, 'it is', 'they are')} counted at ${plural(n, 'its last known balance', 'their last known balances')}`
          : `; ${plural(n, 'it is', 'they are')} counted at ${plural(n, 'its last known balance', 'their last known balances')} until you say whether ${plural(n, 'it', 'they')} closed`
        : `, so this total is short by ${out === n ? plural(n, 'it', 'them') : `${out} of them`}`;
    const paused = answered ? `until ${plural(n, 'it comes', 'they come')} back, two weeks at most` : 'until you answer';
    notes.push({
      text: `${n} ${plural(n, 'account', 'accounts')} at ${where} stopped reporting${what} · history is paused ${paused}`,
      // Short by an account with no balance: red. Held at the last known one: amber.
      severity: out === 0 ? 'caution' : 'critical',
      summary: `${n} ${plural(n, 'account', 'accounts')} stopped reporting`,
    });
  }

  // Failed with nothing recovered: the total is short by all of each.
  const uncounted = institutions.filter((i) => i.error && !i.stale_as_of);
  const seen = (i: TotalNoteInstitution) => (i.health?.last_ok_at ? `last seen ${day.instant(i.health.last_ok_at)}` : null);
  if (uncounted.length === 1) {
    const [i] = uncounted;
    const when = seen(i);
    // As its card: red, but a new connection waiting for its first answer
    // was never in the total, and is amber there.
    notes.push({
      text: `${i.institution_name} ${i.needs_reauth ? 'needs reconnecting' : "couldn't be reached"}${when ? `, ${when},` : ''} and isn't counted in this total`,
      severity: worst(uncounted),
      summary: `${i.institution_name} not counted`,
    });
  } else if (uncounted.length > 1) {
    const phrases = uncounted.map((i) => {
      const parts = [i.needs_reauth ? 'needs reconnecting' : null, seen(i)].filter(Boolean);
      return parts.length > 0 ? `${i.institution_name} (${parts.join(', ')})` : i.institution_name;
    });
    notes.push({ text: `${joinNames(phrases)} aren't counted in this total`, severity: worst(uncounted), summary: `${joinNames(uncounted.map((i) => i.institution_name))} not counted` });
  }
  return notes;
}
