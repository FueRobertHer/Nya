import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountsSegments, { accountsPanelId, accountsTabId } from '@/components/AccountsSegments';
import { Segmented } from '@/components/Segmented';
import { TabSkeleton } from '@/components/LoadingSkeletons';

// The Accounts tab's two views (components/AccountsSegments.tsx): a tablist
// whose tabs each control their own panel, drawn as the tab loads too, and
// every way into the tab landing on Accounts, where what it focuses is.

const tags = (html: string, role: string) => [...html.matchAll(new RegExp(`<button[^>]*role="${role}"[^>]*>`, 'g'))].map((m) => m[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

describe('the views', () => {
  test('each tab controls its own panel, the chosen one selected and the tab stop', () => {
    const html = renderToStaticMarkup(<AccountsSegments segment="investments" onSegment={() => {}} />);
    expect(html).toContain('role="tablist" aria-label="Accounts views"');
    expect(
      tags(html, 'tab').map((t) => [attr(t, 'id'), attr(t, 'aria-controls'), attr(t, 'aria-selected'), attr(t, 'tabindex')])
    ).toEqual([
      [accountsTabId('accounts'), accountsPanelId('accounts'), 'false', '-1'],
      [accountsTabId('investments'), accountsPanelId('investments'), 'true', '0'],
    ]);
  });

  test('a tablist over one panel still names that one for every tab', () => {
    const html = renderToStaticMarkup(
      <Segmented label="Views" value="a" onChange={() => {}} options={[['a', 'A'], ['b', 'B']]} tabs={{ id: (v) => `t-${v}`, panel: 'one' }} />
    );
    expect(tags(html, 'tab').map((t) => attr(t, 'aria-controls'))).toEqual(['one', 'one']);
  });

  test('the loading view draws them, unavailable, so nothing moves when the tab arrives', () => {
    const html = renderToStaticMarkup(<TabSkeleton tab="accounts" segments={{ accounts: 'accounts' }} />);
    expect(html).toContain('<div inert=""><div class="segmented accounts-segments" role="tablist"');
    expect(tags(html, 'tab').map((t) => attr(t, 'aria-selected'))).toEqual(['true', 'false']);
    const summary = renderToStaticMarkup(<TabSkeleton tab="accounts" segments={{ accounts: 'investments' }} />);
    expect(tags(summary, 'tab').map((t) => attr(t, 'aria-selected'))).toEqual(['false', 'true']);
    expect(summary).toContain('Loading investment returns');
    // Its hero and the range's card, said as one.
    expect(summary.split('class="card stack"')).toHaveLength(3);
    expect(summary.split('role="status"')).toHaveLength(2);
  });
});

describe('ways into the tab', () => {
  // Home's links, the status pill and a notice email's link focus a card or a
  // notice in the Accounts view: each goes there first. Only the tab bar
  // keeps the view last chosen.
  const source = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');

  test("every link sets the view with the tab", () => {
    const bare = [...source.matchAll(/setTab\('accounts'\)/g)].length;
    // The one in openAccounts itself.
    expect(bare).toBe(1);
    expect(source).toMatch(/const openAccounts = useCallback\(\(\) => \{\r?\n\s+setTab\('accounts'\);\r?\n\s+setAccountsSegment\('accounts'\);/);
  });

  test('the status pill shows the card it goes to', () => {
    const fix = source.slice(source.indexOf('const goToFirstToFix = useCallback'), source.indexOf('}, [cardStatus, cardless, openConnections]);'));
    expect(fix.indexOf("setAccountsSegment('accounts')")).toBeGreaterThan(-1);
    expect(fix.indexOf("setAccountsSegment('accounts')")).toBeLessThan(fix.indexOf('requestAnimationFrame'));
  });
});
