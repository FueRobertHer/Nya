import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectButtonsView, SIMPLEFIN_OPTION } from '@/components/ConnectButtons';
import { ChooseView, ConnectIntro, ConnectorCardView, guessKind, KINDS } from '@/components/Connectors';
import { ConnectionHealthView } from '@/components/ConnectionHealth';
import { connectorHealth } from '@/lib/connectors/health';
import type { ConnectionView } from '@/lib/connectors/view';

// The screens for bringing your own sync (components/Connectors.tsx): the
// option beside the connect buttons, what connecting says, choosing accounts,
// a connection's card, and its rows in connection health.

const noop = () => {};

const conn = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  connection_id: 'conn_1',
  connector: 'simplefin',
  label: 'SimpleFIN',
  host: 'bridge.example',
  site: 'https://bridge.example/',
  created_at: '2026-10-01T12:00:00.000Z',
  last_fetch: { at: '2026-10-09T13:00:00.000Z', ok: true, kind: null, message: null, problems: [], missing: [], added: 4, updated: 0, pending: 1, unreadable: 0, note: null },
  last_answer_at: '2026-10-09T13:00:00.000Z',
  history: { from: '2026-07-11', to: '2026-10-09', complete: false },
  accounts: [{ account_id: 'manual_a', name: 'Checking', institution_name: 'My Bank', type: 'depository', currency: 'USD', balance: 1500.25, balance_at: '2026-10-08T12:00:00.000Z' }],
  available: [],
  ...over,
});

describe('the option to connect', () => {
  test('sits beside the other ways to connect, says what it costs and who is paid, and only shows when offered', () => {
    const html = renderToStaticMarkup(<ConnectButtonsView connecting={false} starting={null} brokerage={false} idBase="cb" onConnect={noop} onConnectSimpleFin={noop} />);
    expect(html).toContain('>Connect with SimpleFIN</button>');
    expect(html).toContain(SIMPLEFIN_OPTION.note);
    expect(SIMPLEFIN_OPTION.note).toContain('$15 a year, paid to SimpleFIN');
    expect(renderToStaticMarkup(<ConnectButtonsView connecting={false} starting={null} brokerage={false} idBase="cb" onConnect={noop} />)).not.toContain('SimpleFIN');
  });

  test('connecting says what SimpleFIN is, that a token works once, and what Nya keeps', () => {
    const html = renderToStaticMarkup(<ConnectIntro again={false} />);
    expect(html).toContain('You pay SimpleFIN for it ($15 a year), not Nya');
    expect(html).toContain('A token works once');
    expect(html).toContain('keeps that\n        access encrypted, and never sees your bank password'.replace(/\n\s+/g, ' '));
    expect(renderToStaticMarkup(<ConnectIntro again={true} />)).toContain('the same accounts carry on, with their history');
  });
});

describe('choosing accounts', () => {
  test('a first guess of each kind comes from its name and the sign of its balance', () => {
    expect(['Visa Signature', 'AMEX Gold', 'Mortgage', 'Roth IRA', 'Brokerage', 'Everyday Checking', 'Savings'].map((n) => guessKind(n))).toEqual([
      'credit',
      'credit',
      'loan',
      'investment',
      'investment',
      'depository',
      'depository',
    ]);
    expect(guessKind('Account 1234', -50)).toBe('credit');
    expect(guessKind('Account 1234', 50)).toBe('depository');
    expect(KINDS.map((k) => k.value)).toEqual(['depository', 'credit', 'loan', 'investment', 'other']);
  });

  test('lists what SimpleFIN offers by bank with its balance, says the kinds are guesses, and refuses an unknown currency', () => {
    const html = renderToStaticMarkup(
      <ChooseView
        label="SimpleFIN"
        tracked={[]}
        offers={[
          { remote_id: 'A', name: 'Checking', institution: 'My Bank', currency: 'USD', currency_text: 'USD', balance: 1500.25, balance_at: null },
          { remote_id: 'B', name: 'Visa', institution: 'My Bank', currency: 'USD', currency_text: 'USD', balance: -432.1, balance_at: null },
          { remote_id: 'C', name: 'Miles', institution: 'Airline', currency: null, currency_text: 'https://example.com/miles.json' },
        ]}
        choices={{ A: 'depository', B: 'credit' }}
        keep={true}
        busy={false}
        guessed={true}
        onChoose={noop}
        onKeep={noop}
      />
    );
    expect(html).toContain('Nya guessed from its name and balance: check each one');
    expect(html).toContain('<p class="institution-name">My Bank</p>');
    expect(html).toContain('$1,500.25');
    expect(html).toContain('-$432.10');
    expect(html).toContain('In a currency Nya doesn’t know (https://example.com/miles.json): can’t be tracked');
    expect(html).toMatch(/<select disabled="" aria-label="Track Miles">/);
  });

  test('stopping a tracked account asks whether to keep it as a manual account, keeping by default', () => {
    const props = {
      label: 'SimpleFIN',
      tracked: conn().accounts,
      offers: [],
      keep: true,
      busy: false,
      guessed: false,
      onChoose: noop,
      onKeep: noop,
    };
    expect(renderToStaticMarkup(<ChooseView {...props} choices={{}} />)).not.toContain('Keep as manual');
    const html = renderToStaticMarkup(<ChooseView {...props} choices={{ manual_a: 'stop' }} />);
    expect(html).toContain('Keep as manual account');
    expect(html).toContain('Past net-worth totals keep what it held');
    expect(html).toMatch(/<input type="radio" name="connector-keep" checked=""/);
    expect(html).toContain('<option value="stop" selected="">Stop tracking</option>');
  });
});

describe('a connection’s card', () => {
  test('says where it reaches, when it answered, how much history has come and the requests left', () => {
    const html = renderToStaticMarkup(<ConnectorCardView conn={conn()} requests={{ left: 5, limit: 8, resets_in_seconds: 100 }} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(html).toContain('bridge.example · 1 account tracked · last answered');
    expect(html).toContain('5 of 8 requests left today');
    expect(html).toContain('older ones arrive over the next few nights');
    expect(html).toContain('>Refresh</button>');
    expect(html).toContain('>Choose accounts</button>');
    expect(html).toContain('>Disconnect</button>');
  });

  test('shows SimpleFIN’s own words, and offers to connect again when it refuses Nya’s access', () => {
    const refused = conn({
      last_fetch: { at: '2026-10-09T13:00:00.000Z', ok: false, kind: 'refused', message: 'SimpleFIN no longer accepts Nya’s access (HTTP 403).', problems: [], missing: [], added: 0, updated: 0, pending: 0, unreadable: 0, note: null },
    });
    const html = renderToStaticMarkup(<ConnectorCardView conn={refused} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(html).toContain('SimpleFIN no longer accepts Nya’s access (HTTP 403).');
    expect(html).toContain('>Connect again</button>');
    expect(html).not.toContain('>Refresh</button>');
    const reported = conn({ last_fetch: { ...conn().last_fetch!, problems: [{ message: 'Connection to My Bank may need attention', accounts: ['Checking'] }] } });
    expect(renderToStaticMarkup(<ConnectorCardView conn={reported} requests={null} busy={false} note={null} onAsk={noop} onRefresh={noop} />)).toContain(
      'SimpleFIN reports: “Connection to My Bank may need attention” (Checking)'
    );
  });

  test('Refresh waits when the day’s requests are spent', () => {
    const html = renderToStaticMarkup(<ConnectorCardView conn={conn()} requests={{ left: 0, limit: 8, resets_in_seconds: 100 }} busy={false} note={null} onAsk={noop} onRefresh={noop} />);
    expect(html).toMatch(/<button class="secondary" disabled="">Refresh<\/button>/);
  });
});

describe('in connection health', () => {
  const row = (issue: Parameters<typeof connectorHealth>[0]['issue'], messages: string[] = []) => ({
    institution_name: 'My Bank',
    item_id: `connector:conn_1:${issue}`,
    manual: true,
    connector: 'simplefin',
    connection_id: 'conn_1',
    error: issue === 'ok' ? null : 'x',
    accounts: [],
    health: connectorHealth({ connector: 'simplefin', label: 'SimpleFIN', host: 'bridge.example', connection_id: 'conn_1', issue, messages, accounts: [] }, '2026-10-08T13:00:00.000Z', issue === 'reported' ? 'connector' : undefined),
  });
  const render = (rows: ReturnType<typeof row>[]) =>
    renderToStaticMarkup(
      <ConnectionHealthView rows={rows} open={true} onToggle={noop} unavailable={false} connecting={false} onReconnect={noop} onRemove={noop} onManageAccounts={noop} onConnector={noop} now={Date.parse('2026-10-09T14:00:00Z')} />
    );

  test('a SimpleFIN row says it is via SimpleFIN, in SimpleFIN’s words, whose side it is, and links to fix it there', () => {
    const html = render([row('reported', ['Connection to My Bank may need attention'])]);
    expect(html).toContain('My Bank<span class="manual-badge">via SimpleFIN</span>');
    expect(html).toContain('Needs attention at SimpleFIN');
    expect(html).toContain('SimpleFIN reports: “Connection to My Bank may need attention”');
    expect(html).toContain('On SimpleFIN&#x27;s side');
    expect(html).toContain('<a class="connector-site" href="https://bridge.example/" target="_blank" rel="noreferrer">Open SimpleFIN</a>');
    expect(html).toContain('>Refresh</button>');
    // Never Plaid's own words.
    expect(html).not.toContain('Plaid');
  });

  test('refused access offers Connect again; missing accounts offer Choose accounts; Nya’s side offers nothing', () => {
    expect(render([row('refused')])).toContain('>Connect again</button>');
    expect(render([row('missing')])).toContain('>Choose accounts</button>');
    const nya = render([row('limited')]);
    expect(nya).not.toContain('<button class="secondary"');
    expect(nya).toContain('On Nya&#x27;s side');
  });

  test('the dashboard shows the cards, the drawer and the option, and keeps manual-only actions off SimpleFIN accounts', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain('<ConnectorSheet ask={connectorAsk}');
    expect(dashboard.match(/<ConnectorCards /g)?.length).toBe(2);
    expect(dashboard.match(/onConnectSimpleFin=\{connectSimpleFin\}/g)?.length).toBe(2);
    expect(dashboard).toContain("{inst.connector ? 'via SimpleFIN' : 'Manual'}");
    for (const gate of ['{inst.manual && !inst.connector && (', '{inst.manual && !inst.connector && !a.hidden && (', '{inst.manual && !inst.connector && manageMode && (']) {
      expect(dashboard).toContain(gate);
    }
  });
});
