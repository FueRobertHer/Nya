// lib/api-versions.ts
//
// The `version` of what an API write can change, and how a request names the
// one it read (If-Match). A version is worked out from what is stored each
// time it is asked for, never stored itself: so a change made in the app
// moves it exactly as one made through the API does, and no stored shape
// changes. It is a keyed digest (HMAC-SHA-256, base64url) of the stored fields
// a write depends on, and nothing else (no `created_at`, no `updated_at`, no
// ids of a file's rows, no category's earlier names). Some of those fields
// aren't served as stored (the tags a person took off a row, a name a rule
// shows otherwise), so the digest is keyed with a key only the server holds
// (derived from PLAID_ENCRYPTION_KEY, for this purpose alone): a token can't
// work out a version from a guess, and so can't confirm one, offline. A new
// key moves every version, which only asks a program to read again:
//
//   manual account  name, institution_name, type, subtype, currency: its
//                   details. Not the balance, which a script may push every
//                   hour: that would make every rename from a program stale.
//   transaction     two parts, `<row>.<said>`: the row (account, date,
//                   amount, currency, name, category, note) and what is said
//                   beside it (excluded, tags put on and taken off). A change
//                   to the row checks the first, a change to its exclusion or
//                   tags the second, each inside its own compare-and-set.
//   category        name, group, icon, archived.
//   group           name, kind, order.
//   tag             name, color.
//
// A request names the version it read in If-Match, quoted as an entity tag
// ("..."), or bare for a program that drops the quotes. A weak tag (W/"...")
// never matches, as RFC 9110's strong comparison has it; `*` is refused as no
// version at all, since a change must say what it was made from.

import { createHash, createHmac } from 'node:crypto';
import type { ManualAccount } from './manual';
import type { ManualTxn } from './manual-txns';
import type { TxnAnnotation } from './txn-annotations';
import type { Category, CategoryGroup } from './categories';
import type { Tag } from './tags';

/** The digest's key, derived once for the environment's key it is from. */
let keyed: { from: string; key: Buffer } | null = null;
function versionKey(): Buffer {
  const from = process.env.PLAID_ENCRYPTION_KEY ?? '';
  if (keyed?.from !== from) keyed = { from, key: createHash('sha256').update(`nya-api-version-key:${from}`, 'utf8').digest() };
  return keyed.key;
}

const digest = (parts: unknown, chars: number) => createHmac('sha256', versionKey()).update(JSON.stringify(parts), 'utf8').digest('base64url').slice(0, chars);

export function accountVersion(a: Pick<ManualAccount, 'name' | 'institution_name' | 'type' | 'subtype' | 'currency'>): string {
  return digest(['account', a.name, a.institution_name, a.type, a.subtype ?? null, a.currency ?? 'USD'], 22);
}

/** A transaction's row part. */
export function rowVersion(r: Pick<ManualTxn, 'account_id' | 'date' | 'amount' | 'currency' | 'name' | 'category' | 'note'>): string {
  return digest(['row', r.account_id, r.date, r.amount, r.currency, r.name, r.category, r.note], 11);
}

/** A transaction's part for what is said beside it. */
export function saidVersion(a: Pick<TxnAnnotation, 'excluded' | 'tags' | 'untagged'> | null): string {
  return digest(['said', a?.excluded ?? null, a?.tags ?? [], a?.untagged ?? []], 11);
}

export function txnVersion(row: ManualTxn, said: TxnAnnotation | null): string {
  return `${rowVersion(row)}.${saidVersion(said)}`;
}

export function categoryVersion(c: Pick<Category, 'name' | 'group' | 'icon' | 'archived'>): string {
  return digest(['category', c.name, c.group, c.icon ?? null, c.archived === true], 22);
}

export function groupVersion(g: Pick<CategoryGroup, 'name' | 'kind' | 'order'>): string {
  return digest(['group', g.name, g.kind, g.order], 22);
}

export function tagVersion(t: Pick<Tag, 'name' | 'color'>): string {
  return digest(['tag', t.name, t.color], 22);
}

/** The version If-Match names: absent (null), unusable ('none': `*`, or not
 *  a tag at all), weak ('weak', which never matches), or the version. */
export function readIfMatch(header: string | null): string | null | 'none' | 'weak' {
  if (header === null) return null;
  const v = header.trim();
  if (v === '' || v === '*' || v.length > 100) return 'none';
  if (/^W\//i.test(v)) return 'weak';
  const m = /^"([A-Za-z0-9_.-]{1,60})"$/.exec(v) ?? /^([A-Za-z0-9_.-]{1,60})$/.exec(v);
  return m ? m[1] : 'none';
}

/** A version as an ETag header carries it. */
export const etag = (version: string) => `"${version}"`;

/** The two parts of a transaction's version, or null for one that isn't. */
export function txnParts(version: string): { row: string; said: string } | null {
  const m = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{11})$/.exec(version);
  return m ? { row: m[1], said: m[2] } : null;
}
