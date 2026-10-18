import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectButtonsView, LUNCHFLOW_OPTION } from '@/components/ConnectButtons';
import { ConnectIntro, ConnectorCardView, endsThere, SignView } from '@/components/Connectors';
import { ConnectionHealthView } from '@/components/ConnectionHealth';
import { connectorHealth, connectorHealthText } from '@/lib/connectors/health';
import { connectorBalanceDay, connectorLabel, CONNECTOR_WORDS, ANY_CONNECTOR } from '@/lib/connectors/types';
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

  test('the dashboard offers it in both places it offers SimpleFIN', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("setConnectorAsk({ kind: 'connect', connector: 'lunchflow' })");
    expect(dashboard.match(/onConnectLunchFlow=\{connectLunchFlow\}/g)?.length).toBe(2);
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

  test('the key is typed out of sight, in a field named for it', () => {
    const sheet = readFileSync(join(import.meta.dir, '..', 'components', 'Connectors.tsx'), 'utf8');
    expect(sheet).toContain("{view.connector === 'lunchflow' ? (");
    expect(sheet).toContain('<input type="password" value={token}');
    expect(CONNECTOR_WORDS.lunchflow.credential).toBe('API key');
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
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain('connectorBalanceDay(inst.connector, fmtInstantDay(a.updated_at))');
  });
});
