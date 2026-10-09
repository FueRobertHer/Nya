import { describe, expect, test } from 'bun:test';
import { connectorHealth, connectorHealthText, connectorSideText, connectorBadge, connectorSite, CONNECTOR_ISSUES } from '@/lib/connectors/health';
import { HEALTH_STATES, CAUSES } from '@/lib/connection-state';
import type { ConnectorDetail, ConnectorIssue } from '@/lib/connectors/types';
import { FAILURE_KINDS } from '@/lib/connectors/types';

// The words connection health says about accounts SimpleFIN feeds
// (lib/connectors/health.ts): what is wrong, whose side it is on, what to do,
// and SimpleFIN's own error text as it sent it.

const detail = (issue: ConnectorIssue, over: Partial<ConnectorDetail> = {}): ConnectorDetail => ({
  connector: 'simplefin',
  label: 'SimpleFIN',
  host: 'bridge.example',
  connection_id: 'conn_x',
  issue,
  messages: [],
  accounts: [],
  ...over,
});

describe('connector health', () => {
  test('every issue, and every kind of failed request, has a state in the list, an action and words', () => {
    for (const kind of FAILURE_KINDS) expect(CONNECTOR_ISSUES).toContain(kind);
    for (const issue of CONNECTOR_ISSUES) {
      const h = connectorHealth(detail(issue, { messages: ['msg'], accounts: ['Visa'] }), null);
      expect(HEALTH_STATES).toContain(h.state);
      expect(h.cause).toBe('connector');
      expect(connectorBadge(h).length).toBeGreaterThan(0);
      if (issue !== 'ok') expect(connectorHealthText('My Bank', h)?.length).toBeGreaterThan(20);
    }
    expect(CAUSES.connector).toEqual({ state: 'outage', action: 'wait' });
  });

  test('a problem SimpleFIN reports is shown in its own words, as on its side, to be fixed there', () => {
    const h = connectorHealth(detail('reported', { messages: ['Connection to My Bank may need attention'] }), '2026-10-08T13:00:00.000Z', 'connector');
    expect(h).toMatchObject({ state: 'needs_reauth', side: 'connector', last_ok_at: '2026-10-08T13:00:00.000Z' });
    expect(connectorBadge(h)).toBe('Needs attention at SimpleFIN');
    expect(connectorHealthText('My Bank', h)).toBe(
      "SimpleFIN reports: “Connection to My Bank may need attention”. This is between SimpleFIN and My Bank: fix it in SimpleFIN (often by signing in to My Bank there again), then refresh here. Until then its balances are shown as last known, and no day's total is saved."
    );
    expect(connectorSideText('My Bank', h)).toBe("On SimpleFIN's side");
    expect(connectorSite(h.detail!)).toBe('https://bridge.example/');
  });

  test('access SimpleFIN no longer accepts is the person’s to renew, with a new token, keeping the accounts', () => {
    const h = connectorHealth(detail('refused', { messages: ['SimpleFIN no longer accepts Nya’s access (HTTP 403).'] }), null, 'you');
    expect(h).toMatchObject({ state: 'relink', action: 'relink', side: 'you' });
    expect(connectorBadge(h)).toBe('Needs connecting again');
    expect(connectorHealthText('My Bank', h)).toContain('Connect again with a new Setup Token: your accounts and their history stay.');
    expect(connectorSideText('My Bank', h)).toBe('On your side: your SimpleFIN account');
  });

  test('what is on Nya’s side asks nothing of the person', () => {
    for (const issue of ['stale', 'unreadable', 'limited', 'rejected'] as ConnectorIssue[]) {
      const h = connectorHealth(detail(issue, { messages: ['x'] }), null);
      expect([issue, h.side]).toEqual([issue, 'nya']);
      expect(connectorHealthText('My Bank', h)).toContain('Nothing for you to do');
      expect(connectorSideText('My Bank', h)).toBe("On Nya's side");
    }
  });

  test('an outage at SimpleFIN says so in its words and waits', () => {
    const h = connectorHealth(detail('down', { messages: ['SimpleFIN had a problem of its own (HTTP 503).'] }), null, 'connector');
    expect(h).toMatchObject({ state: 'outage', action: 'wait' });
    expect(connectorBadge(h)).toBe('Not updating');
    expect(connectorHealthText('My Bank', h)).toBe('“SimpleFIN had a problem of its own (HTTP 503).” Nothing to do: this usually clears on its own, and Nya asks again at its next update.');
  });

  test('missing accounts are named, and the way to stop tracking them is said', () => {
    const one = connectorHealth(detail('missing', { accounts: ['Visa'] }), null);
    expect(one).toMatchObject({ state: 'partial', action: 'resolve' });
    expect(connectorHealthText('My Bank', one)).toContain("Visa isn't in SimpleFIN's latest answer. If you removed it at SimpleFIN, stop tracking it here");
    const two = connectorHealth(detail('missing', { accounts: ['Visa', 'Savings'] }), null);
    expect(connectorHealthText('My Bank', two)).toContain("Visa and Savings aren't in SimpleFIN's latest answer");
  });

  test('a working connection says nothing more than that it works', () => {
    const h = connectorHealth(detail('ok'), '2026-10-09T13:00:00.000Z');
    expect(h).toMatchObject({ state: 'healthy', side: 'none', action: 'none' });
    expect(connectorHealthText('My Bank', h)).toBeNull();
    expect(connectorSideText('My Bank', h)).toBeNull();
    expect(connectorBadge(h)).toBe('Working');
  });
});
