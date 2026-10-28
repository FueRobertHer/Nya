import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  // Each label starts with the words on screen, so "click 1 problem" works by voice.
  test('any problem: red, its count, a button, with the cautions in its label', () => {
    const html = render([
      { key: 'a', severity: 'critical' },
      { key: 'b', severity: 'caution' },
      { key: 'c', severity: 'caution' },
    ]);
    expect(html).toContain('<button type="button" class="chip neg" aria-label="1 problem, 2 to check: go to the first connection">1 problem<svg');
  });

  test('several problems', () => {
    expect(render([
      { key: 'a', severity: 'critical' },
      { key: 'b', severity: 'critical' },
    ])).toContain('aria-label="2 problems: go to the first connection">2 problems<svg');
  });

  test('only cautions: amber, to check', () => {
    expect(render([{ key: 'a', severity: 'caution' }, { key: 'b', severity: null }])).toContain(
      '<button type="button" class="chip warn" aria-label="1 to check: go to the first connection">1 to check<svg'
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

describe('its place on the tab', () => {
  test('the pill first, on the left, then Add account, tonal, at the right', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const bar = dashboard.slice(dashboard.indexOf('<div className="accounts-bar">'), dashboard.indexOf('<AccountsSummary'));
    expect(bar.indexOf('<AccountsStatus')).toBeGreaterThan(-1);
    expect(bar.indexOf('<AccountsStatus')).toBeLessThan(bar.indexOf('Add account'));
    expect(bar).toContain('<button className="btn secondary" onClick={() => setAddAccountOpen(true)}>');
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('.accounts-bar > .btn {\n  margin-left: auto;\n}');
  });
});
