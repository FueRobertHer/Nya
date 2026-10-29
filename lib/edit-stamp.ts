// lib/edit-stamp.ts
//
// The time a record is saved at, where that time is also what an edit sends
// back to say which version it was opened on (a split's or a share's
// `updated_at`): an edit is refused when the stored stamp differs from the one
// it saw. A save's millisecond alone can't be that token, since two saves in
// one millisecond, or behind a clock that stepped back, would leave it the
// same and an edit opened before the second would go through.

/** `now`, or just after `was` (the replaced record's stamp, absent for none)
 *  when the clock hasn't passed it, so every save moves the stamp forward. */
export function stampAfter(was: string | undefined, now: Date): string {
  const before = was === undefined ? Number.NaN : Date.parse(was);
  return new Date(before >= now.getTime() ? before + 1 : now.getTime()).toISOString();
}
