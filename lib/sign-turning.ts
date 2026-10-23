// lib/sign-turning.ts
//
// The note a download carries when an account's history was being turned
// over to match its kind as it was made (lib/sign-repair.ts: a job still
// pending), in words and read back: the download writes it
// (lib/user-export.ts), and a restore of that download reads which accounts
// it names (lib/user-restore/plan.ts), to finish turning them over where the
// restored totals prove each day (lib/sign-repair.ts planRestoredRepairs).
// One module for both, so the words and their reading never part. Pure, and
// safe for the page, which reads the file.

/** The prefix every manual account's id has, a tracked one's too
 *  (lib/manual.ts MANUAL_ID_PREFIX): only those are ever turned over. */
const ACCOUNT = /^manual_[A-Za-z0-9_-]{1,100}$/;

/** The note, for the accounts whose jobs are pending. */
export function turningOverWords(ids: readonly string[]): string {
  const one = ids.length === 1;
  return `The history of ${one ? 'one account' : `${ids.length} accounts`} (${ids.join(', ')}) is being turned over to match what ${one ? 'it is' : 'they are'}: until that finishes, some of ${one ? 'its' : 'their'} earlier days in account_history are in the other sign. Nya’s daily update tries again, and whoever runs your Nya can finish it: download again once it is done.`;
}

const NOTE = /^The history of (?:one account|\d+ accounts) \(([^()]*)\) is being turned over to match what (?:it is|they are): /;

/** The accounts a note names, or null for any other note. An id that isn't
 *  an account's that could be turned over is left out. */
export function turningOverIds(note: string): string[] | null {
  const m = NOTE.exec(note);
  if (!m) return null;
  return [...new Set(m[1].split(', ').filter((id) => ACCOUNT.test(id)))];
}
