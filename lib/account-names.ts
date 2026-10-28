// lib/account-names.ts
//
// The names a list gives its accounts, so no two rows read the same when the
// accounts behind them are different (the screen review found Home's Needs
// attention saying "Plaid Mortgage is overdue" twice: two sandbox banks
// linked to one account, with the same account names and the same masks).
// Each account goes by its name where no other in the list has it. Where two
// or more share a name, each is named with its institution in front, as the
// rest of the app writes an account in full ("Chase Checking", lib/api-read.ts
// accountLabels). Only where the institution is the same too is its mask
// added ("Chase Checking ••1111"). Where all three match there is nothing
// more a person would recognise, so they are left alike: rows are keyed by
// account id regardless. Pure, for the page and the server.

/** An account as a list knows it. */
export type NamedAccount = { id: string; name: string; institution: string; mask?: string | null };

/** Each account's name in the list, by id (see the header). `mask: false`
 *  never adds the mask, for a caller that writes "••mask" after every name
 *  itself (the payoff plan), so it isn't written twice. `nameFirst` puts the
 *  institution after the name ("Checking, Chase"), for a line that may be
 *  cut short with an ellipsis (Activity's rows): what tells two apart is
 *  then the part that is cut, so the account's own name comes first. */
export function distinctAccountNames(list: readonly NamedAccount[], opts: { mask?: boolean; nameFirst?: boolean } = {}): Map<string, string> {
  const withMask = opts.mask !== false;
  const byName = new Map<string, NamedAccount[]>();
  for (const a of list) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
  const out = new Map<string, string>();
  for (const [name, same] of byName) {
    if (same.length === 1) {
      out.set(same[0].id, name);
      continue;
    }
    for (const a of same) {
      const full = !a.institution ? name : opts.nameFirst ? `${name}, ${a.institution}` : `${a.institution} ${name}`;
      const twin = same.some((b) => b !== a && b.institution === a.institution);
      out.set(a.id, twin && withMask && a.mask ? `${full} ••${a.mask}` : full);
    }
  }
  return out;
}
