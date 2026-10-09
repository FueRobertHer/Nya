// lib/existing-items.ts
//
// Which already-linked Plaid Items are at a given institution. Used by the
// dashboard to catch a new connection to an institution that is already
// connected, and offer to add the accounts to that Item instead: one Item per
// login is cheaper (Plaid bills per Item) and needs no second setup.
//
// Whichever way either connection is made (as a bank or card, or as a brokerage
// or retirement account: components/ConnectButtons.tsx), it is still one login.
// Adding accounts to the Item already there brings in what they need: a
// checking account added to a brokerage connection gets its transactions, where
// the institution offers them, from the next sync (lib/item-products.ts), where
// a second Item would duplicate any account both share.
//
// Matches on Plaid's institution id when both sides have one. Falls back to the
// display name only when one side has no id (an Item linked before ids were
// stored, and failing, so no fetch has reported one): both names come from
// Plaid's Link metadata, so they agree for the same institution.

type Candidate = {
  item_id: string;
  institution_name: string;
  institution_id?: string | null;
  manual?: boolean;
};

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function existingItemsAt<T extends Candidate>(
  institutions: T[],
  target: { institution_id?: string | null; name?: string | null }
): T[] {
  return institutions.filter((inst) => {
    // Manual groupings aren't Items; there is nothing to add accounts to.
    if (inst.manual) return false;
    if (inst.institution_id && target.institution_id) return inst.institution_id === target.institution_id;
    const name = norm(target.name);
    return name !== '' && norm(inst.institution_name) === name;
  });
}
