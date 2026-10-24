import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectButtonsView, LUNCHFLOW_OPTION } from '@/components/ConnectButtons';
import { ConnectIntro, ConnectorCardView, CredentialField, endsThere, refreshedWords, retryLine, SignView } from '@/components/Connectors';
import { ConnectionHealthView } from '@/components/ConnectionHealth';
import { connectorHealth, connectorHealthText } from '@/lib/connectors/health';
import { connectorBalanceDay, connectorLabel, CONNECTOR_WORDS, ANY_CONNECTOR } from '@/lib/connectors/types';
import { connectorOffered, lunchFlowEnabled } from '@/lib/connectors/switch';
import type { ConnectionView } from '@/lib/connectors/view';

// What the screens say of Lunch Flow (components/Connectors.tsx,
// ConnectButtons.tsx, ConnectionHealth.tsx): the option beside SimpleFIN's,
// what connecting says it is, costs, brings and keeps, the key typed out of
// sight, the sign question's word on cards a bank reports by their credit,
// its card on the Accounts tab and its rows in connection health, and a
// balance's date said as the day Nya received it, never as the bank's.

const noop = () => {};

const conn = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  connection_id: 'conn_1',
  connector: 'lunchflow',
  label: 'Lunch Flow',
  host: 'lunchflow.app',
  site: 'https://lunchflow.app/',
  created_at: '2026-10-01T12:00:00.000Z',
  last_fetch: { at: '2026-10-09T13:00:00.000Z', ok: true, kind: null, message: null, problems: [], missing: [], added: 4, updated: 0, pending: 0, unreadable: 0, note: null },
  last_answer_at: '2026-10-09T13:00:00.000Z',
  history: { from: '2024-10-10', to: '2026-10-09', complete: false },
  accounts: [
    {
      account_id: 'manual_a',
      name: 'Everyday',
      institution_name: 'Monzo',
      type: 'depository',
      currency: 'GBP',
      balance: 1520.4,
      reported: 1520.4,
      sign: null,
      needs_sign: false,
      balance_at: '2026-10-09T13:00:00.000Z',
    },
  ],
  available: [],
  ...over,
});

describe('the option to connect', () => {
  test('sits beside SimpleFIN’s, says what it costs and who is paid, and only shows when offered', () => {
    const html = renderToStaticMarkup(<ConnectButtonsView connecting={false} starting={null} brokerage={false} idBase="cb" onConnect={noop} onConnectSimpleFin={noop} onConnectLunchFlow={noop} />);
    expect(html).toContain('>Connect with SimpleFIN</button>');
    expect(html).toContain('>Connect with Lunch Flow</button>');
    expect(html.indexOf('Connect with SimpleFIN')).toBeLessThan(html.indexOf('Connect with Lunch Flow'));
    expect(html).toContain(LUNCHFLOW_OPTION.note);
    expect(LUNCHFLOW_OPTION.note).toContain('paid to Lunch Flow');
    expect(renderToStaticMarkup(<ConnectButtonsView connecting={false} starting={null} brokerage={false} idBase="cb" onConnect={noop} onConnectSimpleFin={noop} />)).not.toContain('Lunch Flow');
  });

  test('the dashboard offers it in both places it offers SimpleFIN, only where the deployment turned it on', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("setConnectorAsk({ kind: 'connect', connector: 'lunchflow' })");
    expect(dashboard).toContain('lunchFlow = false,');
    expect(dashboard.match(/onConnectLunchFlow=\{connectLunchFlow\}/g)?.length).toBe(2);
    expect(dashboard).toContain('const connectLunchFlow = lunchFlow ? askLunchFlow : undefined;');
    // Decided on the server, from LUNCHFLOW_ENABLED, for both kinds of sign-in.
    const page = readFileSync(join(import.meta.dir, '..', 'app', 'page.tsx'), 'utf8');
    expect(page).toContain('const lunchFlow = lunchFlowEnabled();');
    expect(page.match(/lunchFlow=\{lunchFlow\}/g)?.length).toBe(2);
  });

  test('the switch is on only for LUNCHFLOW_ENABLED=1, and never stands in SimpleFIN’s way', () => {
    const saved = process.env.LUNCHFLOW_ENABLED;
    try {
      for (const [value, on] of [
        [undefined, false],
        ['', false],
        ['0', false],
        ['true', false],
        ['yes', false],
        ['1', true],
      ] as const) {
        if (value === undefined) delete process.env.LUNCHFLOW_ENABLED;
        else process.env.LUNCHFLOW_ENABLED = value;
        expect([value, lunchFlowEnabled(), connectorOffered('lunchflow'), connectorOffered('simplefin')]).toEqual([value, on, on, true]);
      }
    } finally {
      if (saved === undefined) delete process.env.LUNCHFLOW_ENABLED;
      else process.env.LUNCHFLOW_ENABLED = saved;
    }
  });
});

describe('connecting', () => {
  test('says what Lunch Flow is, that it is paid, what it doesn’t bring, how its balances are dated, and what Nya keeps of the key', () => {
    const html = renderToStaticMarkup(<ConnectIntro again={false} connector="lunchflow" />);
    for (const words of [
      'You pay Lunch Flow for it',
      'not Nya',
      'no pending transactions, no holdings for investment accounts',
      'no categories',
      'gives no date with a balance, so each one shows the day Nya received it',
      'add an API destination and paste its API key below',
      'checks the key with Lunch Flow once, keeps it encrypted, never shows it again',
      'Deleting that destination in Lunch Flow ends Nya’s access there',
    ]) {
      expect([words, html.includes(words)]).toEqual([words, true]);
    }
    expect(html).not.toContain('Setup Token');
    const again = renderToStaticMarkup(<ConnectIntro again connector="lunchflow" />);
    expect(again).toContain('no longer accepts the API key Nya had');
    expect(again).toContain('the same accounts carry on, with their history');
    // SimpleFIN's words are as they were.
    expect(renderToStaticMarkup(<ConnectIntro again={false} />)).toContain('Setup Token');
  });

  test('the key is typed out of sight, in a field named for it; a token is shown, as before', () => {
    const key = renderToStaticMarkup(<CredentialField connector="lunchflow" value="lf_secret_value" busy={false} onChange={noop} />);
    expect(key).toContain('<label class="field connector-token">API key<input type="password"');
    expect(key).toContain('autoComplete="off"');
    expect(key).toContain('spellCheck="false"');
    expect(key).not.toContain('<textarea');
    const token = renderToStaticMarkup(<CredentialField connector="simplefin" value="" busy={false} onChange={noop} />);
    expect(token).toContain('<label class="field connector-token">Setup Token<textarea');
    expect(token).not.toContain('type="password"');
    // The sheet's own field is this one.
    const sheet = readFileSync(join(import.meta.dir, '..', 'components', 'Connectors.tsx'), 'utf8');
    expect(sheet).toContain('<CredentialField connector={view.connector} value={token} busy={busy} onChange={setToken} />');
  });

  test('disconnecting says the key still works at Lunch Flow until its destination is deleted there', () => {
    expect(endsThere('lunchflow')).toBe('Its API key still works at Lunch Flow until you delete that API destination there.');
    expect(endsThere('simplefin')).toContain('SimpleFIN still lists Nya');
  });
});

describe('a card reported as money held', () => {
  test('Lunch Flow’s question adds what to do when the figure is the credit left to spend', () => {
    const accounts = [{ ...conn().accounts[0], type: 'credit', reported: 4000, balance: null, needs_sign: true }];
    const lf = renderToStaticMarkup(<SignView label="Lunch Flow" accounts={accounts} signs={{}} busy={false} onSign={noop} />);
    expect(lf).toContain('credit left to spend in place of its balance');
    expect(lf).toContain('stop tracking the card with Choose accounts');
    const sf = renderToStaticMarkup(<SignView label="SimpleFIN" accounts={accounts} signs={{}} busy={false} onSign={noop} />);
    expect(sf).not.toContain('credit left to spend');
  });
});

describe('its card and its health', () => {
  test('what didn’t come this time is a wait on the card, never Lunch Flow’s word; Refresh says not everything came', () => {
    const problems = [
      { message: 'Credit Card: no balance came. Bank data is temporarily unavailable. This usually resolves within a minute. (HTTP 503)', accounts: ['Credit Card'], retry: true },
      { message: 'The connection to Monzo is disconnected', accounts: ['Everyday'], retry: false },
    ];
    const html = renderToStaticMarkup(<ConnectorCardView conn={conn({ last_fetch: { ...conn().last_fetch!, problems } })} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(html).toContain('Credit Card: no balance came. Bank data is temporarily unavailable. This usually resolves within a minute. (HTTP 503). Nya asks again at its next update.</p>');
    expect(html).not.toContain('Lunch Flow reports: “Credit Card');
    expect(html).toContain('Lunch Flow reports: “The connection to Monzo is disconnected” (Everyday)');
    expect(retryLine('Pot 3: no balance came. Nya’s time for this update ran out before it asked Lunch Flow.')).toBe(
      'Pot 3: no balance came. Nya’s time for this update ran out before it asked Lunch Flow. Nya asks again at its next update.'
    );
    expect(refreshedWords('Lunch Flow', { added: 0, problems, missing: [] })).toBe('Lunch Flow answered, but not everything came (its card says what): nothing new so far.');
    expect(refreshedWords('Lunch Flow', { added: 1, problems: [], missing: ['Savings'] })).toBe('Lunch Flow answered, but not everything came (its card says what): 1 new transaction so far.');
    expect(refreshedWords('Lunch Flow', { added: 2, problems: [], missing: [] })).toBe('Lunch Flow answered: 2 new transactions.');
  });

  test('its history is said as what came from a day on, and a whole one as all in', () => {
    const complete = renderToStaticMarkup(<ConnectorCardView conn={conn({ history: { from: '2024-10-10', to: '2026-10-09', complete: true } })} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(complete).toContain('Everything Lunch Flow has from Oct 10, 2024 on is in.');
    const coming = renderToStaticMarkup(<ConnectorCardView conn={conn()} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(coming).toContain('older transactions arrive with its next daily update');
    expect(coming).not.toContain('next few nights');
  });

  test('the card names Lunch Flow and offers Connect again when the key is refused', () => {
    const html = renderToStaticMarkup(<ConnectorCardView conn={conn()} requests={{ left: 6, limit: 8, resets_in_seconds: 100 }} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(html).toContain('Lunch Flow<span class="manual-badge">Your own sync</span>');
    expect(html).toContain('lunchflow.app');
    const refused = conn({ last_fetch: { ...conn().last_fetch!, ok: false, kind: 'refused', message: 'Lunch Flow no longer accepts the API key Nya has (HTTP 403).' } });
    const r = renderToStaticMarkup(<ConnectorCardView conn={refused} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(r).toContain('Lunch Flow no longer accepts the API key Nya has (HTTP 403).');
    expect(r).toContain('>Connect again</button>');
  });

  test('a health row is via Lunch Flow, in its words, with an API key to connect again and its site to fix a bank', () => {
    const row = (issue: Parameters<typeof connectorHealth>[0]['issue'], messages: string[] = []) => ({
      institution_name: 'Monzo',
      item_id: `connector:conn_1:${issue}`,
      manual: true,
      connector: 'lunchflow',
      connection_id: 'conn_1',
      error: 'x',
      accounts: [],
      health: connectorHealth({ connector: 'lunchflow', label: 'Lunch Flow', host: 'lunchflow.app', connection_id: 'conn_1', issue, messages, accounts: [] }, null, issue === 'reported' ? 'connector' : undefined),
    });
    const render = (rows: ReturnType<typeof row>[]) =>
      renderToStaticMarkup(
        <ConnectionHealthView rows={rows} open={true} onToggle={noop} unavailable={false} connecting={false} onReconnect={noop} onRemove={noop} onManageAccounts={noop} onConnector={noop} now={Date.parse('2026-10-09T14:00:00Z')} />
      );
    const reported = render([row('reported', ['The connection to Monzo is disconnected'])]);
    expect(reported).toContain('Monzo<span class="manual-badge">via Lunch Flow</span>');
    expect(reported).toContain('Lunch Flow reports: “The connection to Monzo is disconnected”');
    expect(reported).toContain('>Open Lunch Flow</a>');
    const refused = render([row('refused')]);
    expect(refused).toContain('>Connect again</button>');
    expect(connectorHealthText('Monzo', row('refused').health)).toContain('Connect again with an API key from Lunch Flow');
    expect(connectorHealthText('Monzo', row('credentials').health)).toContain('Connect again with an API key from Lunch Flow');
    expect(connectorHealthText('Monzo', row('refused').health)).not.toContain('Setup Token');
  });
});

describe('words', () => {
  test('a balance’s date is the bank’s for SimpleFIN, and the day Nya received it for Lunch Flow', () => {
    expect(connectorBalanceDay('simplefin', 'Oct 8')).toBe('Balance as of Oct 8');
    expect(connectorBalanceDay('lunchflow', 'Oct 9')).toBe('Balance as Lunch Flow gave it on Oct 9');
    expect(connectorBalanceDay('somethingnew', 'Oct 9')).toBe('Balance as of Oct 9');
    expect([connectorLabel('lunchflow'), connectorLabel('simplefin'), ANY_CONNECTOR]).toEqual(['Lunch Flow', 'SimpleFIN', 'SimpleFIN or Lunch Flow']);
    const card = readFileSync(join(import.meta.dir, '..', 'components', 'InstitutionCard.tsx'), 'utf8');
    expect(card).toContain('connectorBalanceDay(inst.connector, fmtInstantDay(a.updated_at))');
  });
});
