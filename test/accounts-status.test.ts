import { describe, expect, test } from 'bun:test';
import { firstToFix, missingMoney, needsYou, severityOf, worse } from '@/lib/accounts-status';
import { CONNECTION_CASES } from './connection-cases';

// One color for each connection's problems (rollout phase 3b): red when it
// is broken in a way only the person can fix, or the total is missing an
// account's money; amber for anything else that is off.

const byName = new Map(CONNECTION_CASES.map((c) => [c.name, c.inst]));
const sev = (name: string) => {
  const inst = byName.get(name);
  if (!inst) throw new Error(`no case ${name}`);
  return severityOf(inst);
};

describe('the two questions', () => {
  test('each Plaid cause, as the rule says', () => {
    expect(sev('plaid ok')).toBeNull();
    expect(sev('plaid ok, unread')).toBe('caution');
    expect(sev('plaid consent_ending')).toBe('caution');
    expect(sev('plaid disconnect_pending')).toBe('caution');
    for (const cause of ['login', 'access', 'locked', 'bank_action']) expect([cause, sev(`plaid ${cause}`)]).toEqual([cause, 'critical']);
    for (const cause of ['institution_down', 'provider', 'unreachable', 'credentials', 'token', 'setup', 'unknown']) {
      // Balances shown, nothing for the person to do: amber; nothing shown: the total is short.
      expect([cause, sev(`plaid ${cause}, recovered`)]).toEqual([cause, 'caution']);
      expect([cause, sev(`plaid ${cause}, nothing recovered`)]).toEqual([cause, 'critical']);
    }
    for (const cause of ['revoked', 'gone', 'unsupported', 'no_accounts']) {
      // Only removing it fixes it, so red even with balances shown.
      expect([cause, sev(`plaid ${cause}, recovered`)]).toEqual([cause, 'critical']);
      expect([cause, sev(`plaid ${cause}, nothing recovered`)]).toEqual([cause, 'critical']);
    }
    // Held at its last known balance: counted, so amber.
    expect(sev('plaid vanished')).toBe('caution');
  });

  test('each SimpleFIN or Lunch Flow issue, as the rule says', () => {
    const red = ['reported', 'old_balance', 'payment', 'refused', 'credentials', 'gone', 'sign'];
    const amber = ['waiting', 'missing', 'stale', 'limited', 'rejected', 'down', 'answer', 'blocked'];
    for (const issue of red) expect([issue, sev(`connector ${issue}`)]).toEqual([issue, 'critical']);
    for (const issue of amber) expect([issue, sev(`connector ${issue}`)]).toEqual([issue, 'caution']);
    expect(sev('connector ok')).toBeNull();
    // Nya's side, with its balances shown: amber.
    expect(sev('connector unreadable')).toBe('caution');
    // The dashboard's own card when nothing of them could be read
    // (lib/connectors/institutions.ts unreadableConnectorInstitution): none
    // of them is counted, so red.
    const unread = byName.get('connector unreadable')!;
    expect(severityOf({ ...unread, item_id: 'connector:unreadable', connection_id: undefined, stale_as_of: undefined, accounts: [] })).toBe('critical');
  });

  test('a new connection waiting for its first answer is amber, though its accounts aren’t counted yet', () => {
    const waiting = byName.get('connector waiting')!;
    expect(missingMoney(waiting)).toBe(false);
    expect(needsYou(waiting)).toBe(false);
  });

  test('a held account with no balance is missing money; one held at its last balance isn’t', () => {
    const inst = { item_id: 'i', error: null, accounts: [{ balance: null, held: { as_of: null } }] };
    expect(missingMoney(inst)).toBe(true);
    expect(missingMoney({ ...inst, accounts: [{ balance: 40, held: { as_of: '2026-09-12' } }] })).toBe(false);
    // A hidden one counts in nothing anyway.
    expect(missingMoney({ ...inst, accounts: [{ balance: null, held: { as_of: null }, hidden: true }] })).toBe(false);
  });

  test('without health (an older payload): a failing connection a reconnect fixes, never one that only ends soon', () => {
    expect(needsYou({ item_id: 'i', error: 'This account needs to be reconnected', needs_reauth: true, stale_as_of: '2026-10-01', accounts: [] })).toBe(true);
    expect(needsYou({ item_id: 'i', error: null, needs_reauth: true, accounts: [] })).toBe(false);
  });

  test('the institution that couldn’t load manual accounts, and a question about an account, and a note beside it', () => {
    expect(severityOf({ item_id: 'manual:error', manual: true, error: 'Could not load', accounts: [] })).toBe('critical');
    expect(severityOf({ item_id: 'i', error: null, accounts: [{ balance: 0, question: { kind: 'zero' } }] })).toBe('caution');
    expect(severityOf({ item_id: 'i', error: null, accounts: [{ balance: 0 }] }, true)).toBe('caution');
  });
});

describe('putting them together', () => {
  test('the worse of two, and the first to go to', () => {
    expect(worse('caution', 'critical')).toBe('critical');
    expect(worse(null, 'caution')).toBe('caution');
    expect(worse(null, null)).toBeNull();
    const list = [
      { id: 'a', severity: null },
      { id: 'b', severity: 'caution' as const },
      { id: 'c', severity: 'critical' as const },
      { id: 'd', severity: 'critical' as const },
    ];
    expect(firstToFix(list)?.id).toBe('c');
    expect(firstToFix(list.slice(0, 2))?.id).toBe('b');
    expect(firstToFix(list.slice(0, 1))).toBeNull();
  });
});
