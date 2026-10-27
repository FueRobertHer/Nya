import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTab, tabHref, TABS } from '@/lib/dashboard-tab';

// The open tab kept in the address (lib/dashboard-tab.ts), so a reload comes
// back to it: read by the page on the server, written by the dashboard.

describe('the tab an address asks for', () => {
  test('?tab= names one of the five', () => {
    for (const tab of TABS) expect(parseTab({ tab })).toBe(tab);
    expect(parseTab(new URLSearchParams('tab=budgets'))).toBe('budgets');
  });

  test('anything else is Home: none, an unknown one, a repeated one takes the first', () => {
    expect(parseTab({})).toBe('home');
    expect(parseTab({ tab: 'settings' })).toBe('home');
    expect(parseTab({ tab: '' })).toBe('home');
    expect(parseTab({ tab: ['plan', 'accounts'] })).toBe('plan');
    expect(parseTab(new URLSearchParams(''))).toBe('home');
  });

  test('a notice email’s ?view=connections opens Accounts, whatever ?tab= says', () => {
    expect(parseTab({ view: 'connections' })).toBe('accounts');
    expect(parseTab(new URLSearchParams('view=connections&tab=plan'))).toBe('accounts');
    expect(parseTab({ view: 'other', tab: 'plan' })).toBe('plan');
  });
});

describe('the address for a tab', () => {
  test('Home is the bare path; another tab is ?tab=', () => {
    expect(tabHref('home', 'https://nya.test/?tab=plan')).toBe('/');
    expect(tabHref('plan', 'https://nya.test/')).toBe('/?tab=plan');
    expect(tabHref('activity', '/?tab=plan')).toBe('/?tab=activity');
  });

  test('?view= is answered once and dropped; the rest of the query and the hash stay', () => {
    expect(tabHref('accounts', 'https://nya.test/?view=connections')).toBe('/?tab=accounts');
    expect(tabHref('budgets', 'https://nya.test/?x=1&tab=home#top')).toBe('/?x=1&tab=budgets#top');
    expect(tabHref('home', 'https://nya.test/?x=1&tab=plan')).toBe('/?x=1');
  });

  test('reading back the address written gives the same tab', () => {
    for (const tab of TABS) expect(parseTab(new URL(tabHref(tab, 'https://nya.test/?view=connections'), 'https://nya.test').searchParams)).toBe(tab);
  });
});

describe('where it is read and written', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');

  test('the page reads it on the server and hands it to the dashboard and to the app loading', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('parseTab(await searchParams)');
    expect(page).toContain('<AppLoading account="clerk" tab={tab} />');
    expect(page.match(/initialTab=\{tab\}/g)?.length).toBe(2);
  });

  test('the dashboard replaces the address as the tab changes, never pushing a history entry', () => {
    const dashboard = read('components/Dashboard.tsx');
    expect(dashboard).toContain('useState<Tab>(initialTab)');
    expect(dashboard).toContain("window.history.replaceState(null, '', href)");
    expect(dashboard).not.toContain('pushState');
  });

  test('Reports, opened from Activity, goes back to it', () => {
    expect(read('components/ReportsPage.tsx')).toContain('<a href="/?tab=activity">← Nya</a>');
  });

  test('offline, a tab’s address finds the page kept for another', () => {
    expect(read('public/service-worker.js')).toContain("event.request.mode === 'navigate' ? caches.match(event.request, { ignoreSearch: true })");
  });
});
