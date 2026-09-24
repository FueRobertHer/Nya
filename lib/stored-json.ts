// lib/stored-json.ts
//
// One encrypted JSON value under one Redis key, for small stores that are
// replaced whole on every save (goals, budgets).
//
// THE BUG THIS EXISTS FOR. Those stores used to read an unreadable value (a
// failed decrypt, damaged JSON) as "nothing saved", so the dashboard showed an
// empty list, and the next save, which sends the whole list, wrote the new
// near-empty one over the real data. An unreadable value is usually
// recoverable (a missing or changed key, fixed by restoring it); overwritten
// data is not. lib/transactions.ts made the same change for the same reason.
//
// So here:
//   - never saved             -> null (the caller's "empty")
//   - saved but unreadable    -> StoredDataUnreadableError, never "empty"
//   - saving over unreadable  -> refused with the same error; the value stays
//                                exactly as it is until it can be read again
//   - Redis unreachable       -> the Redis error, also never "empty"

import { redis } from './storage';
import {
  encrypt,
  decrypt,
  DecryptFailedError,
  MalformedCiphertextError,
  MasterKeyError,
  UnknownKeyError,
} from './crypto';

export class StoredDataUnreadableError extends Error {
  /** What actually went wrong, for the log: the user-facing message is the
   *  same whatever it was. Crypto error messages name keys and formats,
   *  never data. */
  readonly cause?: unknown;

  constructor(
    readonly what: string,
    cause?: unknown
  ) {
    super(`Your saved ${what} could not be read, so they were left untouched.`);
    this.name = 'StoredDataUnreadableError';
    this.cause = cause;
  }
}

/** Errors that mean the stored value itself cannot be read. Anything else (a
 *  missing encryption key in the environment, a database error while loading
 *  a data key) is a problem with this deployment, not with the data, so it is
 *  left to surface as an ordinary server error. */
function isUnreadable(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    err instanceof MalformedCiphertextError ||
    err instanceof DecryptFailedError ||
    err instanceof UnknownKeyError ||
    err instanceof MasterKeyError
  );
}

async function parse<T>(blob: string, what: string, isValid: (v: unknown) => v is T): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await decrypt(blob));
  } catch (err) {
    if (isUnreadable(err)) throw new StoredDataUnreadableError(what, err);
    throw err;
  }
  if (!isValid(value)) throw new StoredDataUnreadableError(what, new Error('stored value has the wrong shape'));
  return value;
}

/** A line for the server log saying why, without any stored data. */
export function describeUnreadable(err: StoredDataUnreadableError): string {
  const c = err.cause;
  return c instanceof Error ? `${c.name}: ${c.message}` : String(c);
}

/** The stored value, or null when nothing has ever been saved. */
export async function readEncryptedJson<T>(
  key: string,
  what: string,
  isValid: (v: unknown) => v is T
): Promise<T | null> {
  const blob = await redis().get<string>(key);
  if (blob === null || blob === undefined || blob === '') return null;
  return parse(String(blob), what, isValid);
}

/**
 * Replace the stored value, unless what is there now cannot be read: then
 * refuse, so an unreadable value is never overwritten by one built from an
 * empty list.
 */
export async function writeEncryptedJson<T>(
  key: string,
  what: string,
  value: T,
  isValid: (v: unknown) => v is T
): Promise<void> {
  await readEncryptedJson(key, what, isValid);
  await redis().set(key, await encrypt(JSON.stringify(value)));
}
