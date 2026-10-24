import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountsStatus, { statusCounts, type StatusEntry } from '@/components/AccountsStatus';

// The Accounts tab's status pill (rollout phase 3c): how many connections
// have a problem, in their cards' colors, and only from this load.

const noop = () => {};
const render = (entries: StatusEntry[], over: { known?: boolean; healthRead?: boolean; syncing?: boolean } = {}) =>
  renderToStaticMarkup(<AccountsStatus entries={entries} known={over.known ?? true} healthRead={over.healthRead ?? true} syncing={over.syncing ?? true} onGo={noop} />);

describe('the count', () => {
  test('a connection’s cards count once, at the worst of them', () => {
    expect(
      statusCounts([
        { key: 'conn_1', severity: 'caution' },
        { key: 'conn_1', severity: 'critical' },
        { key: 'conn_1', severity: null },
        { key: 'item_a', severity: 'caution' },
        { key: 'item_b', severity: null },
      ])
    ).toEqual({ critical: 1, caution: 1 });
  });
});

describe('what it says', () => {
  test('any problem: red, its count, a button, with the cautions in its label', () => {
    const html = render([
      { key: 'a', severity: 'critical' },
      { key: 'b', severity: 'caution' },
      { key: 'c', severity: 'caution' },
    ]);
    expect(html).toContain('<button type="button" class="chip neg" aria-label="1 connection has a problem, 2 to check: go to the first">1 problem<svg');
  });

  test('several problems', () => {
    expect(render([
      { key: 'a', severity: 'critical' },
      { key: 'b', severity: 'critical' },
    ])).toContain('aria-label="2 connections have problems: go to the first">2 problems<svg');
  });

  test('only cautions: amber, to check', () => {
    expect(render([{ key: 'a', severity: 'caution' }, { key: 'b', severity: null }])).toContain(
      '<button type="button" class="chip warn" aria-label="1 connection to check: go to the first">1 to check<svg'
    );
  });

  test('nothing off: a green badge, not a button', () => {
    const html = render([{ key: 'a', severity: null }]);
    expect(html).toContain('<span class="badge pos">');
    expect(html).toContain('All synced');
    expect(html).not.toContain('<button');
  });
});

describe('when it says nothing', () => {
  test('not from this load (the snapshot, a failed load, the connector list unread): nothing, even with a problem', () => {
    expect(render([{ key: 'a', severity: 'critical' }], { known: false })).toBe('');
    expect(render([{ key: 'a', severity: null }], { known: false })).toBe('');
  });

  test('Plaid’s warnings unread: no "All synced", but a problem still shows', () => {
    expect(render([{ key: 'a', severity: null }], { healthRead: false })).toBe('');
    expect(render([{ key: 'a', severity: 'critical' }], { healthRead: false })).toContain('1 problem');
  });

  test('only accounts typed by hand: nothing syncs, so nothing to say', () => {
    expect(render([{ key: 'manual', severity: null }], { syncing: false })).toBe('');
  });
});
