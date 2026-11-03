// lib/flag-change.ts
//
// One change the admin makes to a feature switch (lib/flags.ts) on the admin
// page, sent to app/api/admin/flags as `{ key, change }`, and the value it
// leaves. Each change is small and says what it does, so each is one entry in
// the record of changes (lib/flag-store.ts):
//
//   { op: 'choose', choice }                       an audience's `on`, a mode,
//                                                  a switch's on or off;
//   { op: 'add-account' | 'remove-account', container }
//                                                  an account an audience is
//                                                  also on for;
//   { op: 'add-person' | 'remove-person', entry }  someone on the sign-in list:
//                                                  an email or a Clerk user id.
//
// Pure: nothing here reads storage. The route reads and writes through the
// store's one write (flagsStore.update), whose function must answer a value:
// so a change that changes nothing, or that is refused, is thrown from inside
// it (NoFlagChange, FlagChangeRefused), and nothing is written or recorded.

import { isContainerId, type ContainerId } from './containers';
import {
  MAX_ENTRY,
  MAX_LIST,
  choiceOf,
  choicesFor,
  defaultChoice,
  flagDef,
  isAudienceValue,
  isListValue,
  valueFromChoice,
  type AudienceOn,
  type FlagKey,
  type FlagValue,
} from './flags';

export type FlagChange =
  | { op: 'choose'; choice: string }
  | { op: 'add-account' | 'remove-account'; container: ContainerId }
  | { op: 'add-person' | 'remove-person'; entry: string };

/** A Clerk user id, as Clerk makes them. */
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;
/** An email address, as far as a typo goes: something either side of one "@". */
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Someone for the sign-in list, as typed: an email (stored lowercase) or a
 *  Clerk user id. Adding holds them to those shapes, so a typo can't add a
 *  meaningless entry; removing takes any entry the stored list could hold
 *  (lib/flags.ts isListValue), since a list may have been set some other way. */
function personEntry(raw: unknown, adding: boolean): string | { refused: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { refused: 'Type an email address or a Clerk user id.' };
  const entry = raw.trim();
  if (entry.length > MAX_ENTRY) return { refused: 'That is longer than an email address or a user id can be.' };
  if (entry.includes(',')) return { refused: 'Add or remove one person at a time.' };
  if (entry.includes('@')) {
    if (adding && !EMAIL.test(entry)) return { refused: 'That doesn’t look like an email address.' };
    return entry.toLowerCase();
  }
  if (adding && !CLERK_USER_ID.test(entry)) return { refused: 'Type an email address, or a Clerk user id (it starts with user_).' };
  return entry;
}

/** The change a request asks of flag `key`, or why it can't be made: a
 *  sentence for the admin. */
export function parseFlagChange(key: FlagKey, raw: unknown): FlagChange | { refused: string } {
  if (!isRecord(raw)) return { refused: 'Say what to change.' };
  const kind = flagDef(key).value;
  switch (raw.op) {
    case 'choose':
      if (kind === 'list') return { refused: 'Who may sign in is changed by adding and removing people.' };
      if (typeof raw.choice !== 'string' || !choicesFor(key).includes(raw.choice)) return { refused: 'That isn’t a choice this switch takes.' };
      return { op: 'choose', choice: raw.choice };
    case 'add-account':
    case 'remove-account':
      if (kind !== 'audience') return { refused: 'Only a switch for an audience is on for accounts.' };
      if (!isContainerId(raw.container)) return { refused: 'Name an account by its id.' };
      return { op: raw.op, container: raw.container };
    case 'add-person':
    case 'remove-person': {
      if (kind !== 'list') return { refused: 'Only who may sign in lists people.' };
      const entry = personEntry(raw.entry, raw.op === 'add-person');
      return typeof entry === 'string' ? { op: raw.op, entry } : entry;
    }
    default:
      return { refused: 'That isn’t a change a switch takes.' };
  }
}

/** The value `change` leaves on flag `key`, given the one stored (null for
 *  none): the new value, 'unchanged' when it changes nothing (the choice
 *  already stored, adding what is there, removing what isn't), or why it is
 *  refused. An audience given its first account starts from this
 *  environment's default; a list given its first person starts empty. */
export function applyFlagChange(key: FlagKey, current: FlagValue | null, change: FlagChange, now: number = Date.now()): FlagValue | 'unchanged' | { refused: string } {
  const updatedAt = new Date(now).toISOString();
  switch (change.op) {
    case 'choose': {
      if (current !== null && choiceOf(key, current) === change.choice) return 'unchanged';
      return valueFromChoice(key, change.choice, current, now) ?? { refused: 'That isn’t a choice this switch takes.' };
    }
    case 'add-account':
    case 'remove-account': {
      const stored = current !== null && isAudienceValue(current) ? current : null;
      const named = stored?.containers ?? [];
      if (change.op === 'remove-account') {
        if (!named.includes(change.container)) return 'unchanged';
        return { on: stored!.on, containers: named.filter((c) => c !== change.container), updatedAt };
      }
      if (named.includes(change.container)) return 'unchanged';
      if (named.length >= MAX_LIST) return { refused: `A switch can be on for at most ${MAX_LIST} accounts by name.` };
      return { on: stored?.on ?? (defaultChoice(key) as AudienceOn), containers: [...named, change.container], updatedAt };
    }
    case 'add-person':
    case 'remove-person': {
      const stored = current !== null && isListValue(current) ? current : { ids: [], emails: [] };
      const email = change.entry.includes('@');
      const list = email ? stored.emails : stored.ids;
      const there = list.includes(change.entry);
      if (change.op === 'remove-person') {
        if (!there) return 'unchanged';
        const rest = list.filter((e) => e !== change.entry);
        return { ids: email ? stored.ids : rest, emails: email ? rest : stored.emails, updatedAt };
      }
      if (there) return 'unchanged';
      if (list.length >= MAX_LIST) return { refused: `The list holds at most ${MAX_LIST} ${email ? 'email addresses' : 'user ids'}.` };
      return { ids: email ? stored.ids : [...stored.ids, change.entry], emails: email ? [...stored.emails, change.entry] : stored.emails, updatedAt };
    }
  }
}

/** Thrown from a store update for a change that changes nothing, so nothing
 *  is written or recorded. */
export class NoFlagChange extends Error {
  constructor() {
    super('The change changes nothing.');
    this.name = 'NoFlagChange';
  }
}

/** Thrown from a store update for a change refused against the value read. */
export class FlagChangeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagChangeRefused';
  }
}

/** applyFlagChange, for a store update: the new value, or one of the two
 *  thrown. */
export function nextFlagValue(key: FlagKey, current: FlagValue | null, change: FlagChange, now: number = Date.now()): FlagValue {
  const next = applyFlagChange(key, current, change, now);
  if (next === 'unchanged') throw new NoFlagChange();
  if ('refused' in next) throw new FlagChangeRefused(next.refused);
  return next;
}

/** Whether a change from the admin page needs a fresh sign-in
 *  (lib/fresh-sign-in.ts): everywhere but Vercel's Preview and a local `next
 *  dev`. Decided from those two, never from lib/flags.ts flagEnvironment
 *  alone, which calls anything off Vercel development: a server run with
 *  `next start` elsewhere asks for it too. */
export function flagChangeNeedsFreshSignIn(): boolean {
  return process.env.VERCEL_ENV !== 'preview' && process.env.NODE_ENV !== 'development';
}
