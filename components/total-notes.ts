// components/total-notes.ts
//
// The notes under the Home total that say what it is missing (#51), naming
// each institution rather than only counting them: "Chase needs reconnecting,
// last seen Sep 12, and isn't counted in this total". The total is the number
// people read, so a gap in it is said there, not only on the Accounts tab.
// Same wording style as before, with the names in. Pure, so the tests hold the
// words; the dashboard draws each as an amber line under the total.

import { joinNames } from '@/lib/month-coverage';

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
  health?: { last_ok_at: string | null };
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

/** The notes for the total, in the order they were always shown. */
export function totalNotes(institutions: TotalNoteInstitution[], day: DayFormat): string[] {
  const notes: string[] = [];

  // Recovered: shown at last known balances. They share one snapshot, so one date.
  const stale = institutions.filter((i) => i.stale_as_of);
  if (stale.length === 1) {
    const [i] = stale;
    notes.push(`${i.institution_name} ${i.needs_reauth ? 'needs reconnecting' : "couldn't refresh"}; its balances are from ${day.snapshot(i.stale_as_of!, i.stale_as_of_at)}`);
  } else if (stale.length > 1) {
    const phrases = stale.map((i) => `${i.institution_name} ${i.needs_reauth ? 'needs reconnecting' : "couldn't refresh"}`);
    const dates = new Set(stale.map((i) => i.stale_as_of));
    const from = dates.size === 1 ? ` from ${day.snapshot(stale[0].stale_as_of!, stale[0].stale_as_of_at)}` : '';
    notes.push(`${joinNames(phrases)}; showing their last known balances${from}`);
  }

  // Recovered, but short some rows.
  const short = institutions.filter((i) => (i.stale_missing ?? 0) > 0);
  if (short.length > 0) {
    const { n, where } = accountsAt(short, (i) => i.stale_missing ?? 0);
    notes.push(`${n} ${plural(n, 'account', 'accounts')} at ${where} couldn't be shown, so this total is incomplete`);
  }

  // Answered, without accounts it used to report.
  const vanished = institutions.filter((i) => (i.unconfirmed_missing ?? 0) > 0);
  if (vanished.length > 0) {
    const { n, where } = accountsAt(vanished, (i) => i.unconfirmed_missing ?? 0);
    notes.push(`${n} ${plural(n, 'account', 'accounts')} at ${where} stopped reporting, so this total is short by ${plural(n, 'it', 'them')} · history is paused until that settles`);
  }

  // Failed with nothing recovered: the total is short by all of each.
  const uncounted = institutions.filter((i) => i.error && !i.stale_as_of);
  const seen = (i: TotalNoteInstitution) => (i.health?.last_ok_at ? `last seen ${day.instant(i.health.last_ok_at)}` : null);
  if (uncounted.length === 1) {
    const [i] = uncounted;
    const when = seen(i);
    notes.push(`${i.institution_name} ${i.needs_reauth ? 'needs reconnecting' : "couldn't be reached"}${when ? `, ${when},` : ''} and isn't counted in this total`);
  } else if (uncounted.length > 1) {
    const phrases = uncounted.map((i) => {
      const parts = [i.needs_reauth ? 'needs reconnecting' : null, seen(i)].filter(Boolean);
      return parts.length > 0 ? `${i.institution_name} (${parts.join(', ')})` : i.institution_name;
    });
    notes.push(`${joinNames(phrases)} aren't counted in this total`);
  }
  return notes;
}
