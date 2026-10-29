import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSettings, parseTab, settingsHref, tabHref, SETTINGS_SECTIONS, TABS, type SettingsView } from '@/lib/dashboard-tab';

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

describe('Settings in the address', () => {
  test('?settings= names a section, or asks for the list', () => {
    for (const id of SETTINGS_SECTIONS) expect(parseSettings({ settings: id })).toBe(id);
    expect(parseSettings(new URLSearchParams('tab=plan&settings=data'))).toBe('data');
    expect(parseSettings({ settings: 'list' })).toBe('list');
  });

  test('absent is closed; empty, unknown or repeated asks for the list or takes the first', () => {
    expect(parseSettings({})).toBeNull();
    expect(parseSettings(new URLSearchParams('tab=plan'))).toBeNull();
    expect(parseSettings({ settings: '' })).toBe('list');
    expect(parseSettings(new URLSearchParams('settings'))).toBe('list');
    expect(parseSettings({ settings: 'manage' })).toBe('list');
    expect(parseSettings({ settings: ['account', 'data'] })).toBe('account');
  });

  test('Sharing is offered only with Clerk: without it the address opens the list', () => {
    expect(parseSettings({ settings: 'sharing' }, { sharing: false })).toBe('list');
    expect(parseSettings({ settings: 'account' }, { sharing: false })).toBe('account');
    expect(parseSettings({ settings: 'sharing' })).toBe('sharing');
  });

  test('the address for it sets or drops only ?settings=, keeping the tab, the rest and the hash', () => {
    expect(settingsHref('connections', 'https://nya.test/?tab=accounts')).toBe('/?tab=accounts&settings=connections');
    expect(settingsHref('list', '/')).toBe('/?settings=list');
    expect(settingsHref(null, 'https://nya.test/?tab=plan&settings=data#top')).toBe('/?tab=plan#top');
    expect(settingsHref(null, '/?x=1')).toBe('/?x=1');
  });

  test('reading back the address written gives the same tab and the same Settings, through both', () => {
    const views: (SettingsView | null)[] = [null, 'list', ...SETTINGS_SECTIONS];
    for (const tab of TABS)
      for (const view of views) {
        const url = new URL(settingsHref(view, tabHref(tab, 'https://nya.test/?view=connections&settings=account')), 'https://nya.test');
        expect([tab, view, parseTab(url.searchParams), parseSettings(url.searchParams)]).toEqual([tab, view, tab, view]);
        // A tab changing under Settings keeps it.
        const again = new URL(tabHref('budgets', url.href), 'https://nya.test');
        expect(parseSettings(again.searchParams)).toBe(view);
      }
  });
});

describe('where it is read and written', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf8');

  test('the page reads it on the server and hands it to the dashboard and to the app loading', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('const params = await searchParams;');
    expect(page).toContain('const tab = parseTab(params);');
    // Sharing only where there is Clerk to share between people.
    expect(page).toContain('const settings = parseSettings(params, { sharing: clerkEnabled() });');
    expect(page).toContain('<AppLoading account="clerk" tab={tab} settings={settings} />');
    expect(page.match(/initialTab=\{tab\} initialSettings=\{settings\}/g)?.length).toBe(2);
  });

  test('the dashboard replaces the address as the tab or Settings changes, never pushing a history entry', () => {
    const dashboard = read('components/Dashboard.tsx').replace(/\r\n/g, '\n');
    expect(dashboard).toContain('useState<Tab>(initialTab)');
    expect(dashboard).toContain('useState<SettingsView | null>(initialSettings)');
    expect(dashboard).toContain('const href = settingsHref(settings, tabHref(tab, window.location.href));');
    expect(dashboard).toContain("window.history.replaceState(null, '', href)");
    expect(dashboard).toContain('}, [tab, settings]);');
    expect(dashboard).not.toContain('pushState');
    // The address it came with is read before anything writes over it.
    const read1 = dashboard.indexOf('setSettings(parseSettings(query, { sharing: clerk }));');
    const write = dashboard.indexOf('const href = settingsHref(');
    expect(read1).toBeGreaterThan(-1);
    expect(read1).toBeLessThan(write);
  });

  test('Your data, opened from Settings > Your data, goes back to it', () => {
    expect(read('components/DataInventory.tsx')).toContain('<PageHeader back="/?settings=data" />');
  });

  test('Reports, opened from Activity, goes back to it', () => {
    // The shared header's link back (components/PageHeader.tsx), to Activity.
    expect(read('components/ReportsPage.tsx')).toContain('<PageHeader back="/?tab=activity"');
    expect(read('components/PageHeader.tsx')).toContain('<a className="brand page-brand" href={back}>');
  });

  test('offline, a tab’s address finds the page kept for another', () => {
    expect(read('public/service-worker.js')).toContain("event.request.mode === 'navigate' ? caches.match(event.request, { ignoreSearch: true })");
  });

  test('reloading a tab sends the browser’s own page request, so the session can renew', () => {
    // A copy made in the worker doesn't read as a page load, so Clerk skips
    // its renewal and sends a signed-in reload to the sign-in page.
    const worker = read('public/service-worker.js');
    expect(worker).toContain('self.registration.navigationPreload?.enable()');
    expect(worker).toContain('.then((preloaded) => preloaded ?? fetch(event.request))');
  });
});
