// lib/month-coverage.ts
//
// Whether a month that Activity totals may be missing transactions, and the
// words for it (#51): a total that looks finished but isn't is the failure the
// connection health work exists to stop. Two causes, each exact about what is
// known:
//
//   - an institution's rows are not in this load at all, because its sync
//     stopped (/api/transactions reports it "missing"), so every month is short
//     by whatever it holds; or its older rows are still arriving ("importing");
//   - an institution's connection is broken (its health, from /api/net-worth)
//     and it last answered before the month ended, so whatever happened after
//     that has not arrived. A month that ended before it last answered is as
//     complete as it ever was. A broken connection with no recorded good sync
//     could have stopped at any time, so every month is in question.
//
// Months are local calendar months, as Activity groups them; a last sync is an
// instant, read on the local calendar too. Client-safe: no Redis, no Plaid.

import { localDate } from './local-date';

/** The health states in which a connection's transactions stop arriving. */
const STOPPED: ReadonlySet<string> = new Set(['needs_reauth', 'outage', 'relink', 'closed']);

export type Incomplete = { institution_name: string; coverage: 'missing' | 'importing' };
export type Stopped = { institution_name: string; last_ok_at: string | null };

/** The connections whose transactions have stopped arriving, from the
 *  institutions the dashboard holds (manual ones have no connection). */
export function stoppedConnections(
  institutions: { institution_name: string; manual?: boolean; health?: { state: string; last_ok_at: string | null } }[]
): Stopped[] {
  return institutions.flatMap((i) =>
    !i.manual && i.health && STOPPED.has(i.health.state) ? [{ institution_name: i.institution_name, last_ok_at: i.health.last_ok_at }] : []
  );
}

/** "YYYY-MM-01" of the month after a "YYYY-MM". */
function nextMonthStart(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Which institutions leave a month's totals possibly incomplete, and why. An
 *  institution missing from the load is named once, as missing. */
export function monthGaps(
  month: string,
  incomplete: Incomplete[],
  stopped: Stopped[]
): { missing: string[]; importing: string[]; stopped: Stopped[] } {
  const missing = [...new Set(incomplete.filter((i) => i.coverage === 'missing').map((i) => i.institution_name))];
  const importing = [...new Set(incomplete.filter((i) => i.coverage === 'importing').map((i) => i.institution_name))].filter((n) => !missing.includes(n));
  const end = nextMonthStart(month);
  const behind = stopped.filter((s) => {
    if (missing.includes(s.institution_name)) return false;
    if (s.last_ok_at === null) return true;
    const at = new Date(s.last_ok_at);
    return Number.isNaN(at.getTime()) || localDate(at) < end;
  });
  return { missing, importing, stopped: behind };
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The notes for a month, in the stale notes' plain style: empty when nothing
 * is known to be missing. `day` names a last sync's local day ("Sep 12").
 */
export function monthGapNotes(month: string, incomplete: Incomplete[], stopped: Stopped[], day: (iso: string) => string): string[] {
  const gaps = monthGaps(month, incomplete, stopped);
  const notes: string[] = [];
  if (gaps.missing.length > 0) {
    const one = gaps.missing.length === 1;
    notes.push(`Doesn't include ${joinNames(gaps.missing)}: ${one ? 'its' : 'their'} transactions couldn't be loaded, so this month may be incomplete.`);
  }
  if (gaps.stopped.length > 0) {
    const parts = gaps.stopped.map((s) => (s.last_ok_at ? `${s.institution_name} hasn't synced since ${day(s.last_ok_at)}` : `${s.institution_name} isn't syncing`));
    notes.push(`${joinNames(parts)}, so this month may be missing some of ${gaps.stopped.length === 1 ? 'its' : 'their'} transactions.`);
  }
  if (gaps.importing.length > 0) {
    notes.push(`${joinNames(gaps.importing)} ${gaps.importing.length === 1 ? 'is' : 'are'} still importing older transactions, so this month may be incomplete.`);
  }
  return notes;
}
