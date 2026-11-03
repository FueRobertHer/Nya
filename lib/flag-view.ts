// lib/flag-view.ts
//
// The feature switches as the pages that set them show them: /dev/flags for
// local development, and the admin page's Feature switches card. One row per
// flag this release knows (lib/flags.ts), from the store's report
// (lib/flag-store.ts getAllReport), and the record of changes in words.
//
// Worded here, on the server, so the pages' client components import only
// this module's types: lib/flags.ts reaches storage through lib/containers.ts,
// which no client file may (test/client-imports.test.ts).
//
// The admin page's rows name an audience's accounts and the sign-in list's
// people; /dev/flags, open to anyone signed in to a local server, gets their
// counts alone.

import type { ContainerId, ContainerRecord } from './containers';
import type { EnvironmentChange } from './repo';
import {
  FLAG_KEYS,
  audienceVariable,
  choiceOf,
  choicesFor,
  cspVariable,
  defaultChoice,
  flagDef,
  isAudienceValue,
  isFlagKey,
  isListValue,
  isModeValue,
  isSwitchValue,
  opsVariable,
  variableSet,
  type AudienceKey,
  type FlagKey,
  type FlagValue,
} from './flags';

/** One switch as the pages show it. */
export type SwitchRow = {
  key: string;
  name: string;
  about: string;
  offMeans: string;
  kind: 'audience' | 'mode' | 'switch' | 'list';
  removeBy: string | null;
  choices: string[];
  /** The choice stored ('list' for a stored list), null when none is (its
   *  default applies), or 'unreadable'. */
  stored: string | null | 'unreadable';
  defaultChoice: string | null;
  variable: string | null;
  variableSet: boolean;
  /** The choice the variable makes while it is set; null otherwise, and for
   *  the list. */
  variableChoice: string | null;
  /** An audience: how many accounts the stored value names. */
  accounts: number | null;
  /** The list: how many people are on the stored one. */
  people: number | null;
  /** The admin page only (null on /dev/flags): the accounts by id, and the
   *  list's ids and emails. */
  containers: string[] | null;
  ids: string[] | null;
  emails: string[] | null;
};

export type Place = 'admin' | 'dev';

/** The choice a flag's variable makes while set, or null. */
function variableChoice(key: FlagKey): string | null {
  const def = flagDef(key);
  switch (def.value) {
    case 'audience': {
      const on = audienceVariable(key as AudienceKey);
      return on === undefined ? null : on ? 'everyone' : 'nobody';
    }
    case 'mode':
      return cspVariable() ?? null;
    case 'switch': {
      const on = opsVariable();
      return on === undefined ? null : on ? 'on' : 'off';
    }
    case 'list':
      return null;
  }
}

/** One flag's row, from its stored value (null for none) or 'unreadable'. */
export function switchRow(key: FlagKey, value: FlagValue | null | 'unreadable', place: Place): SwitchRow {
  const def = flagDef(key);
  const stored = value === 'unreadable' ? null : value;
  const audience = stored && isAudienceValue(stored) ? stored : null;
  const list = stored && isListValue(stored) ? stored : null;
  const admin = place === 'admin';
  return {
    key,
    name: def.name,
    about: def.about,
    offMeans: def.offMeans,
    kind: def.value,
    removeBy: def.kind === 'release' ? def.removeBy : null,
    choices: [...choicesFor(key)],
    stored: value === 'unreadable' ? 'unreadable' : def.value === 'list' ? (stored ? 'list' : null) : choiceOf(key, stored),
    defaultChoice: defaultChoice(key),
    variable: 'variable' in def && def.variable ? def.variable : null,
    variableSet: variableSet(key),
    variableChoice: variableChoice(key),
    accounts: audience ? audience.containers.length : null,
    people: list ? list.ids.length + list.emails.length : null,
    containers: admin && audience ? [...audience.containers] : null,
    ids: admin && list ? [...list.ids] : null,
    emails: admin && list ? [...list.emails] : null,
  };
}

/** Every flag's row, in the registry's order, from the store's report. */
export function switchRows(report: { entries: ReadonlyMap<string, FlagValue>; unrecognised: readonly string[] }, place: Place): SwitchRow[] {
  return FLAG_KEYS.map((key) => switchRow(key, report.unrecognised.includes(key) ? 'unreadable' : (report.entries.get(key) ?? null), place));
}

// ---- The record, in words ----

/** One change as the admin page shows it: what changed, when, and who. */
export type ChangeLine = { at: string; key: string; what: string; by: string };

const AUDIENCE_WORDS: Record<string, string> = { nobody: 'Off', admin: 'You', 'admin-and-demo': 'You and the demo accounts', everyone: 'Everyone' };
const MODE_WORDS: Record<string, string> = { off: 'Off', 'report-only': 'Report only', enforce: 'Enforce' };

/** An account as the admin page names it: "You" for the admin's own, else
 *  the start of its id, as Storage across accounts does. */
export function accountName(container: string, admin: ContainerId | null): string {
  return container === admin ? 'You' : `Account ${container.slice(0, 8)}`;
}

/** An account in the registry, as the switches' sheets list it: named, with
 *  the day it was made, and whether it is in use (only an active one can be
 *  added to a switch). */
export type AdminAccount = { id: string; name: string; made: string | null; active: boolean };

/** The registry's accounts, the admin's own first, then oldest first. */
export function adminAccounts(list: readonly (ContainerRecord & { id: ContainerId })[], admin: ContainerId | null): AdminAccount[] {
  return [...list]
    .sort((a, b) => Number(b.id === admin) - Number(a.id === admin) || a.created_at.localeCompare(b.created_at))
    .map((c) => ({ id: c.id, name: accountName(c.id, admin), made: c.created_at || null, active: c.status === 'active' }));
}

/** Whether the ops routes are open, and by what: their variable while it is
 *  set, else the stored switch (its default is off everywhere). Null while
 *  they are closed. */
export type OpsOpen = 'variable' | 'stored';

export function opsOpen(stored: FlagValue | null | 'unreadable'): OpsOpen | null {
  const variable = opsVariable();
  if (variable !== undefined) return variable ? 'variable' : null;
  return stored !== 'unreadable' && stored && isSwitchValue(stored) && stored.on ? 'stored' : null;
}

/** Who made a change, in words: the admin, local development, an account's
 *  deletion, or another account by the start of its id. */
function byWords(by: string, admin: ContainerId | null): string {
  if (by === 'local development') return 'Local development';
  if (by === 'account deletion') return 'Account deletion';
  if (by === admin) return 'You';
  return /^[0-9a-f]{8}-/.test(by) ? `Account ${by.slice(0, 8)}` : by;
}

const added = (from: readonly string[], to: readonly string[]) => to.filter((x) => !from.includes(x));

/** One recorded change in words, by the flag's name: "Detailed tax in the
 *  Plan: Off to You", "Lunch Flow: added Account 1a2b3c4d", "Who may sign in:
 *  added jane@example.com". A change to a flag this release doesn't know is
 *  named by its key. */
export function describeChange(change: EnvironmentChange<FlagValue>, admin: ContainerId | null): ChangeLine {
  const name = isFlagKey(change.key) ? flagDef(change.key).name : change.key;
  const { from, to } = change;
  const parts: string[] = [];
  const moved = (words: Record<string, string>, a: string | null, b: string) => parts.push(a === null ? `set to ${words[b] ?? b}` : `${words[a] ?? a} to ${words[b] ?? b}`);
  if (isAudienceValue(to)) {
    const was = from && isAudienceValue(from) ? from : null;
    if (!was || was.on !== to.on) moved(AUDIENCE_WORDS, was?.on ?? null, to.on);
    for (const c of added(was?.containers ?? [], to.containers)) parts.push(`added ${accountName(c, admin)}`);
    for (const c of added(to.containers, was?.containers ?? [])) parts.push(`removed ${accountName(c, admin)}`);
  } else if (isModeValue(to)) {
    const was = from && isModeValue(from) ? from.mode : null;
    moved(MODE_WORDS, was, to.mode);
  } else if (isSwitchValue(to)) {
    const was = from && isSwitchValue(from) ? (from.on ? 'On' : 'Off') : null;
    parts.push(was === null ? `set to ${to.on ? 'On' : 'Off'}` : `${was} to ${to.on ? 'On' : 'Off'}`);
  } else if (isListValue(to)) {
    const was = from && isListValue(from) ? [...from.ids, ...from.emails] : [];
    const now = [...to.ids, ...to.emails];
    for (const p of added(was, now)) parts.push(`added ${p}`);
    for (const p of added(now, was)) parts.push(`removed ${p}`);
  }
  return { at: change.at, key: change.key, what: `${name}: ${parts.length > 0 ? parts.join(', ') : 'saved again'}`, by: byWords(change.by, admin) };
}
