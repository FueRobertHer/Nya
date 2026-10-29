import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsScreen, type SettingsSection, type SettingsView } from '@/components/Settings';
import { institutionMenu } from '@/components/InstitutionCard';
import { CAUSES } from '@/lib/connection-state';

// The Settings screen (components/Settings.tsx), which took over the Accounts
// tab's Manage mode, and how the dashboard fills it.

const sections: SettingsSection[] = [
  { id: 'preferences', title: 'Preferences', sub: 'Theme, home currency and rates, weekly summary email', content: <p>Currency card</p> },
  { id: 'data', title: 'Your data and privacy', sub: 'Download, bring back a download, API tokens', content: <div id="bring-back">Restore card</div> },
];
const noop = () => {};
const view = (v: SettingsView) => renderToStaticMarkup(<SettingsScreen view={v} sections={sections} onView={noop} onClose={noop} />);

describe('SettingsScreen', () => {
  test('the list: a row per section with its line, and a way back to the tabs', () => {
    const html = view('list');
    expect(html).toContain('>Settings</h2>');
    expect(html).toContain('aria-label="Close Settings"');
    for (const s of sections) {
      expect(html).toContain(`<span class="list-row-title">${s.title}</span>`);
      expect(html).toContain(`<span class="list-row-sub">${s.sub}</span>`);
    }
    // Only the list: no section's cards are mounted.
    expect(html).not.toContain('Currency card');
    expect(html).not.toContain('bring-back');
  });

  test('a section: its title, its cards and nothing else, with a way back to the list', () => {
    const html = view('data');
    expect(html).toContain('>Your data and privacy</h2>');
    expect(html).toContain('aria-label="Back to Settings"');
    expect(html).toContain('<div id="bring-back">Restore card</div>');
    expect(html).not.toContain('Currency card');
    expect(html).not.toContain('list-row');
  });

  test('the heading takes focus, so each level is announced', () => {
    expect(view('list')).toContain('<h2 id="settings-title" tabindex="-1">');
    expect(view('preferences')).toContain('<h2 id="settings-title" tabindex="-1">');
  });

  test('a section not offered (Sharing without Clerk) shows the list', () => {
    const html = view('sharing');
    expect(html).toContain('>Settings</h2>');
    expect(html).toContain('list-row');
  });
});

describe('the dashboard', () => {
  const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const section = (id: string) => {
    const at = dashboard.indexOf(`id: '${id}'`);
    const next = dashboard.indexOf("\n    {\n      id: '", at + 1);
    const nextShared = dashboard.indexOf("\n          {\n            id: '", at + 1);
    const ends = [next, nextShared, dashboard.indexOf('\n  ];', at)].filter((n) => n > at);
    return dashboard.slice(at, Math.min(...ends));
  };

  test('has no Manage mode left', () => {
    expect(dashboard).not.toContain('manageMode');
    expect(dashboard).not.toContain("'Manage'");
  });

  test('puts every card Manage held in its Settings section', () => {
    const homes: Record<string, string[]> = {
      preferences: ['<CurrencyCard', '<WeeklySummaryCard'],
      transactions: ['<CategoriesCard', '<TagsCard', '<RulesCard', '<VendorDefaultsCard', '<ReviewSettingsCard'],
      connections: ['allHiddenInstitutions.map', '<AccountLinks', '{admin && <AdminUnusedItems'],
      data: ['<DownloadMyData', '{filesMode?.connected && <ReceiptsCard', '<InventoryEntry', '<div id="bring-back" tabIndex={-1}>', '<ApiTokens'],
      // Its card (components/AccountSettings.tsx), with password mode's two.
      account: ['<AccountSettings', 'onSignOut={logout}', 'onSignOutEverywhere={signOutEverywhere}'],
    };
    for (const [id, cards] of Object.entries(homes)) {
      const text = section(id);
      for (const card of cards) expect([id, card, text.includes(card)]).toEqual([id, card, true]);
    }
    // With Clerk, signing out is the account menu's alone: Settings > Account
    // points to it and repeats no Sign out of its own (its one button is
    // Manage account, test/account-settings-view.test.tsx).
    const card = readFileSync(join(import.meta.dir, '..', 'components', 'AccountSettings.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const clerkCard = card.slice(card.indexOf('function ClerkCard('), card.indexOf('export default function AccountSettings('));
    expect(clerkCard.length).toBeGreaterThan(0);
    expect(clerkCard).toContain('Sign out is in the account menu');
    expect(clerkCard).not.toMatch(/SignOut|signOut|logout/);
    // Password mode's two say how they differ, and both say "Sign out".
    expect(card).toContain('Sign out everywhere also signs out every other device.');
    expect(dashboard).not.toContain('Log out');
    // Sharing only where there is Clerk to share between people.
    expect(dashboard).toContain("...(clerk\n      ? [\n          {\n            id: 'sharing' as const,");
  });

  test('each Manage card is mounted once, in Settings only', () => {
    for (const card of ['<CurrencyCard ', '<CategoriesCard', '<TagsCard ', '<RulesCard ', '<VendorDefaultsCard ', '<ReviewSettingsCard ', '<AccountLinks ', '<AdminUnusedItems ', '<DownloadMyData', '<ReceiptsCard ', '<InventoryEntry ', '<ApiTokens ', '<WeeklySummaryCard ']) {
      expect([card, dashboard.split(card).length - 1]).toEqual([card, 1]);
    }
  });

  test('the restore banner and the currency notes open their Settings sections', () => {
    expect(dashboard).toContain("enterSettings('data');");
    expect(dashboard).toContain("enterSettings('preferences');\n      setCurrencyFocus({ rateFor });");
    // The empty state keeps its own Bring back a download, never on screen with Settings.
    expect(dashboard).toContain(') : settings ? (\n            <SettingsScreen');
  });

  test('every way into Settings records what opened it, and closing falls back when that is gone', () => {
    // Needs attention, the pill and the Accounts notice; the account menu's two.
    expect(dashboard).toContain("const openConnections = useCallback(() => enterSettings('connections'), [enterSettings]);");
    expect(dashboard).toContain("const openSettings = useCallback(() => enterSettings('list', avatarButton() ?? (document.activeElement as HTMLElement | null)), [enterSettings]);");
    expect(dashboard).toContain("const openSharing = useCallback(() => enterSettings('sharing', avatarButton() ?? (document.activeElement as HTMLElement | null)), [enterSettings]);");
    // Only from closed: moving between its own levels keeps the first opener.
    expect(dashboard).toContain('if (!settingsShown.current) settingsOpener.current = opener;');
    expect(dashboard).toContain("const target = opener?.isConnected ? opener : (avatarButton() ?? document.querySelector<HTMLElement>('.top-actions [aria-label=\"Settings\"]'));");
    // Nothing else sets Settings open but enterSettings, the address, and the tab bar's close.
    const opens = [...dashboard.matchAll(/setSettings\(([^)]*)\)/g)].map((m) => m[1]);
    expect(opens.sort()).toEqual(['null', 'null', 'parseSettings(query, { sharing: clerk }', 'view'].sort());
  });

  test('Sharing is in place, one place: the account menu and the empty state open Settings > Sharing', () => {
    expect(section('sharing')).toContain('content: <SharingSettings />,');
    expect(dashboard).not.toContain('SharingDrawer');
    expect(dashboard).not.toContain('sharingOpen');
    expect(dashboard).toContain('onOpenSharing={openSharing}');
    expect(dashboard).toContain('<button className="secondary" onClick={openSharing}>');
  });

  test('a reload in Settings shows Settings loading, not the tab under it', () => {
    expect(dashboard).toContain('settings ? (\n              <SettingsSkeleton view={settings} sharing={clerk} />\n            ) : (\n              <TabSkeleton');
  });

  // The institution's card and its rows (components/InstitutionCard.tsx).
  const card = readFileSync(join(import.meta.dir, '..', 'components', 'InstitutionCard.tsx'), 'utf8');

  // Rendered: test/institution-card-view.test.tsx ("each row is one button
  // that opens the account, with nothing inside it to press") and
  // test/account-sheet-view.test.tsx (Hide, Mark as closed… and Delete per kind).
  test('an account row holds no button that Manage used to add; the account sheet it opens does', () => {
    const rows = card.slice(card.indexOf('<ul className="list-rows">'), card.indexOf('</ul>'));
    expect(rows).toContain('<button className="list-row" onClick={() => onOpenAccount(a.account_id)}>');
    for (const word of ['Hide', 'Mark as closed…', 'Delete']) expect(rows).not.toContain(word);
    const sheet = readFileSync(join(import.meta.dir, '..', 'components', 'AccountSheet.tsx'), 'utf8');
    const footer = sheet.slice(sheet.indexOf('const footer = ('), sheet.indexOf('return (\n    <Sheet'));
    for (const word of ['Hide', 'Mark as closed…', 'Update balance', 'Add transaction']) expect(footer).toContain(word);
    expect(sheet).toContain("...(typed ? [{ label: 'Delete…', danger: true,");
    expect(dashboard).toContain('onOpenAccount={(account_id) => setAccountOpen({ item_id: inst.item_id, account_id })}');
    // An account gone while its sheet is open closes it for good, so it never
    // opens again by itself when the account comes back (Unhide).
    expect(dashboard).toContain('if (accountOpen && !openedAccount) setAccountOpen(null);');
    expect(dashboard).toContain('const shownAccount = useLast(openedAccount);');
  });

  test('a linked institution’s ⋯ holds Add or remove accounts and Disconnect, on its card and in Settings', () => {
    const called: string[] = [];
    const on = {
      onDetails: () => called.push('details'),
      onRemove: (id: string) => called.push(`remove ${id}`),
      onConnector: (ask: { kind: string }) => called.push(`ask ${ask.kind}`),
      startManageAccounts: (id: string) => called.push(`manage ${id}`),
      startEnableLiabilities: (id: string) => called.push(`enable ${id}`),
    };
    const plaid = { institution_name: 'Chase', item_id: 'item_chase', error: null, needs_reauth: false, accounts: [], holdings: [], health: { ...CAUSES.ok, cause: 'ok' as const, side: 'none' as const, last_ok_at: null } };
    const items = institutionMenu(plaid, null, null, on);
    expect(items.map((i) => [i.label, !!i.danger])).toEqual([
      ['Connection details', false],
      ['Add or remove accounts', false],
      ['Disconnect…', true],
    ]);
    for (const i of items) i.onSelect();
    expect(called).toEqual(['details', 'manage item_chase', 'remove item_chase']);
    // Typed by hand: no connection, so no ⋯ (each account is removed in its sheet).
    expect(institutionMenu({ ...plaid, item_id: 'manual:wallet', manual: true, health: undefined }, null, null, on)).toEqual([]);
    expect(card).toContain('const menu = institutionMenu(inst, place, requestsLeft, { onDetails, onRemove, onConnector, startManageAccounts, startEnableLiabilities });');
    expect(dashboard).toContain('onRemove={removeConnection}');
    // An institution whose accounts are all hidden has no card, so Settings > Connections offers the same ⋯.
    expect(section('connections')).toContain('const menu = institutionMenu(inst, null, null, {');
    expect(dashboard).not.toContain('optionsTarget');
  });

  test('password mode has a gear for Settings instead of the sign-out buttons in the header', () => {
    const header = dashboard.slice(dashboard.indexOf('<div className="top-actions">'), dashboard.indexOf('{loading ? ('));
    expect(header).toContain('aria-label="Settings"');
    expect(header).not.toContain('onClick={logout}');
    expect(header).not.toContain('onClick={signOutEverywhere}');
    expect(header).toContain('onOpenSettings={openSettings}');
  });
});
