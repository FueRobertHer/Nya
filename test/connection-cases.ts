// Every way a connection can be, as the Accounts tab receives it: one
// institution per Plaid cause and per SimpleFIN issue, in each state that
// changes what its card says (balances recovered or not, accounts held), and
// the SimpleFIN connection behind a connector's card. Shared by
// test/connection-words.test.tsx and the words recorded before rollout phase
// 3b folded Connection health and the SimpleFIN cards into the institution
// cards (test/connection-words-before-3b.json).

import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';
import { CONNECTOR_ISSUES, connectorHealth } from '@/lib/connectors/health';
import type { ConnectorIssue } from '@/lib/connectors/types';
import type { ConnectionView } from '@/lib/connectors/view';
import type { Account, Institution } from '@/components/accounts-format';

/** Noon on `day` in the machine's time zone, so the day shown is the one written. */
export const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();

const account = (over: Partial<Account> = {}): Account => ({
  account_id: 'acc_checking',
  name: 'Checking',
  official_name: null,
  mask: '4421',
  type: 'depository',
  subtype: 'checking',
  balance: 1200,
  limit: null,
  currency: 'USD',
  ...over,
});

const plaidHealth = (cause: Cause, over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  ...CAUSES[cause],
  cause,
  side: 'bank',
  last_ok_at: noon('2026-09-12'),
  ...(cause === 'ok' ? {} : { code: 'SOME_PLAID_CODE' }),
  ...over,
});

export type ConnectionCase = { name: string; inst: Institution; conn?: ConnectionView };

const REAUTH: Cause[] = ['login', 'access', 'locked', 'bank_action'];
const OUTAGE: Cause[] = ['institution_down', 'provider', 'unreachable', 'credentials', 'token', 'setup', 'unknown'];
const RELINK: Cause[] = ['revoked', 'gone', 'unsupported', 'no_accounts'];

function plaidCases(): ConnectionCase[] {
  const base: Pick<Institution, 'institution_name' | 'item_id' | 'holdings' | 'needs_reauth'> = { institution_name: 'Chase', item_id: 'item_chase', holdings: [], needs_reauth: false };
  const recovered = { stale_as_of: '2026-10-01', accounts: [account({ stale: true })] };
  const nothing = { accounts: [], unshown_accounts: [{ account_id: 'acc_checking', name: 'Checking', mask: '4421' }] };
  const cases: ConnectionCase[] = [
    { name: 'plaid ok', inst: { ...base, accounts: [account()], error: null, health: plaidHealth('ok') } },
    { name: 'plaid ok, unread', inst: { ...base, accounts: [account()], error: null, health: plaidHealth('ok', { unread: true }) } },
  ];
  for (const cause of ['consent_ending', 'disconnect_pending'] as Cause[]) {
    cases.push({ name: `plaid ${cause}`, inst: { ...base, accounts: [account()], error: null, health: plaidHealth(cause, { ends_at: noon('2099-10-15') }) } });
  }
  for (const cause of REAUTH) {
    cases.push({ name: `plaid ${cause}`, inst: { ...base, ...recovered, error: 'This account needs to be reconnected', needs_reauth: true, health: plaidHealth(cause, { side: 'you' }) } });
  }
  for (const cause of [...OUTAGE, ...RELINK]) {
    const error = cause === 'credentials' ? 'Could not decrypt stored credentials' : 'Could not fetch balances';
    cases.push({ name: `plaid ${cause}, recovered`, inst: { ...base, ...recovered, error, health: plaidHealth(cause) } });
    cases.push({ name: `plaid ${cause}, nothing recovered`, inst: { ...base, ...nothing, error, health: plaidHealth(cause) } });
  }
  cases.push({
    name: 'plaid vanished',
    inst: {
      ...base,
      error: null,
      unconfirmed_missing: 1,
      accounts: [account(), account({ account_id: 'acc_savings', name: 'Savings', mask: '0071', held: { as_of: '2026-09-12' }, question: { kind: 'missing', end: '2026-09-13', since: '2026-09-12' } })],
      health: plaidHealth('vanished'),
    },
  });
  return cases;
}

/** The card's own line for an issue, as lib/connectors/institutions.ts writes it. */
function errorLine(issue: ConnectorIssue, label: string, messages: string[]): string | null {
  switch (issue) {
    case 'ok':
      return null;
    case 'reported':
      return `${label} reports: ${messages[0]}`;
    case 'missing':
      return `Not every account was in ${label}'s latest answer`;
    case 'waiting':
      return `Waiting for ${label}'s answer`;
    case 'sign':
      return `${label} reports a card or loan as money held: say which way it goes`;
    case 'old_balance':
      return `${label}'s latest balance is from Sep 20`;
    case 'stale':
      return `No answer from ${label} in over a day`;
    case 'gone':
      return `Its ${label} connection is gone`;
    case 'refused':
    case 'credentials':
      return `${label} needs connecting again`;
    case 'payment':
      return `${label} says your subscription needs paying`;
    case 'unreadable':
      return `What Nya keeps about this ${label} connection couldn't be read`;
    default:
      return `Couldn't refresh from ${label}`;
  }
}

/** The SimpleFIN connection behind a connector card, saying the same as its health. */
function connectionFor(issue: ConnectorIssue): ConnectionView {
  const failed = ['refused', 'credentials', 'payment', 'limited', 'rejected', 'down', 'answer', 'blocked'].includes(issue);
  return {
    connection_id: 'conn_1',
    connector: 'simplefin',
    label: 'SimpleFIN',
    host: 'bridge.example',
    site: 'https://bridge.example/',
    created_at: '2026-10-01T12:00:00.000Z',
    last_fetch: {
      at: '2026-10-09T13:00:00.000Z',
      ok: !failed,
      kind: failed ? (issue as never) : null,
      message: failed ? 'The server said no.' : null,
      problems: issue === 'reported' ? [{ message: 'Connection to My Bank may need attention', accounts: ['Checking'] }] : [],
      missing: issue === 'missing' ? ['Savings'] : [],
      added: 0,
      updated: 0,
      pending: 0,
      unreadable: 0,
      note: issue === 'reported' ? 'New transactions for Checking couldn’t be saved; Nya tries again at its next update.' : null,
    },
    last_answer_at: issue === 'waiting' ? null : '2026-10-09T13:00:00.000Z',
    history: { from: '2026-07-11', to: '2026-10-09', complete: true },
    accounts: [
      {
        account_id: 'manual_a',
        name: 'Checking',
        institution_name: 'My Bank',
        type: issue === 'sign' ? 'credit' : 'depository',
        currency: 'USD',
        balance: issue === 'sign' || issue === 'waiting' ? null : 1500.25,
        reported: 1500.25,
        sign: null,
        needs_sign: issue === 'sign',
        balance_at: '2026-10-08T12:00:00.000Z',
      },
    ],
    available: [],
  } as unknown as ConnectionView;
}

function connectorCases(): ConnectionCase[] {
  return CONNECTOR_ISSUES.map((issue) => {
    // As lib/connectors/institutions.ts fills them: the problem's own words,
    // the old balance's time, or (for a sign question) each account with its
    // reported balance.
    const messages =
      issue === 'reported'
        ? ['Connection to My Bank may need attention']
        : issue === 'old_balance'
          ? [noon('2026-09-20')]
          : issue === 'sign'
            ? ['Checking (+$1,500.25)']
            : ['The server said no.'];
    const accounts = issue === 'missing' || issue === 'sign' ? ['Savings'] : issue === 'reported' ? ['Checking'] : [];
    const detail = { connector: 'simplefin' as const, label: 'SimpleFIN', host: 'bridge.example', connection_id: 'conn_1', issue, messages, accounts };
    const noBalance = issue === 'sign' || issue === 'waiting';
    const error = errorLine(issue, 'SimpleFIN', messages);
    const inst: Institution = {
      institution_name: 'My Bank',
      item_id: 'connector:conn_1:ref1',
      manual: true,
      connector: 'simplefin',
      connection_id: 'conn_1',
      holdings: [],
      needs_reauth: false,
      error,
      ...(error && !noBalance ? { stale_as_of: '2026-10-08' } : {}),
      // A balance kept from an answer before a failed one is marked recovered.
      accounts: [account({ account_id: 'manual_a', type: issue === 'sign' ? 'credit' : 'depository', balance: noBalance ? null : 1500.25, updated_at: noon('2026-10-08'), ...(error && !noBalance ? { stale: true } : {}) })],
      health: connectorHealth(detail, noon('2026-10-09'), issue === 'sign' || issue === 'refused' || issue === 'payment' ? 'you' : undefined),
    };
    return { name: `connector ${issue}`, inst, conn: connectionFor(issue) };
  });
}

export const CONNECTION_CASES: ConnectionCase[] = [...plaidCases(), ...connectorCases()];
