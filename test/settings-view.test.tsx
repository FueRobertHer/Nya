import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsScreen, type SettingsSection, type SettingsView } from '@/components/Settings';

// The Settings screen (components/Settings.tsx), which took over the Accounts
// tab's Manage mode, and how the dashboard fills it.

const sections: SettingsSection[] = [
  { id: 'preferences', title: 'Preferences', sub: 'Home currency and rates, weekly summary email', content: <p>Currency card</p> },
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
      account: ['<ClerkSignOut', 'onClick={logout}', 'onClick={signOutEverywhere}'],
    };
    for (const [id, cards] of Object.entries(homes)) {
      const text = section(id);
      for (const card of cards) expect([id, card, text.includes(card)]).toEqual([id, card, true]);
    }
    // Sharing only where there is Clerk to share between people.
    expect(dashboard).toContain("...(clerk\n      ? [\n          {\n            id: 'sharing' as const,");
  });

  test('each Manage card is mounted once, in Settings only', () => {
    for (const card of ['<CurrencyCard ', '<CategoriesCard', '<TagsCard ', '<RulesCard ', '<VendorDefaultsCard ', '<ReviewSettingsCard ', '<AccountLinks ', '<AdminUnusedItems ', '<DownloadMyData', '<ReceiptsCard ', '<InventoryEntry ', '<ApiTokens ', '<WeeklySummaryCard ']) {
      expect([card, dashboard.split(card).length - 1]).toEqual([card, 1]);
    }
  });

  test('the restore banner and the currency notes open their Settings sections', () => {
    expect(dashboard).toContain("setSettings('data');");
    expect(dashboard).toContain("setSettings('preferences');\n    setCurrencyFocus({ rateFor });");
    // The empty state keeps its own Bring back a download, never on screen with Settings.
    expect(dashboard).toContain(') : settings ? (\n          <SettingsScreen');
  });

  // The institution's card and its rows (components/InstitutionCard.tsx).
  const card = readFileSync(join(import.meta.dir, '..', 'components', 'InstitutionCard.tsx'), 'utf8');

  // Rendered: test/institution-card-view.test.tsx ("each row is one button
  // that opens the account, with nothing inside it to press") and
  // test/account-sheet-view.test.tsx (Hide, Close… and Delete per kind).
  test('an account row holds no button that Manage used to add; the account sheet it opens does', () => {
    const rows = card.slice(card.indexOf('<ul className="list-rows">'), card.indexOf('</ul>'));
    expect(rows).toContain('<button className="list-row" onClick={() => onOpenAccount(a.account_id)}>');
    for (const word of ['Hide', 'Close…', 'Delete']) expect(rows).not.toContain(word);
    const sheet = readFileSync(join(import.meta.dir, '..', 'components', 'AccountSheet.tsx'), 'utf8');
    const footer = sheet.slice(sheet.indexOf('const footer = ('), sheet.indexOf('return (\n    <Sheet'));
    for (const word of ['Hide', 'Close…', 'Update balance', 'Add transaction']) expect(footer).toContain(word);
    expect(sheet).toContain("...(typed ? [{ label: 'Delete…', danger: true,");
    expect(dashboard).toContain('onOpenAccount={(account_id) => setAccountOpen({ item_id: inst.item_id, account_id })}');
    // An account gone while its sheet is open closes it for good, so it never
    // opens again by itself when the account comes back (Unhide).
    expect(dashboard).toContain('if (accountOpen && !openedAccount) setAccountOpen(null);');
    expect(dashboard).toContain('const shownAccount = useLast(openedAccount);');
  });

  test('a linked institution has Options, holding Add or remove accounts and Disconnect', () => {
    expect(card).toContain('onClick={() => setOptionsTarget(inst)}');
    expect(dashboard).toContain('setOptionsTarget={setOptionsTarget}');
    // An institution whose accounts are all hidden has no card, so Settings > Connections offers the same Options.
    expect(section('connections')).toContain('onClick={() => setOptionsTarget(inst)}');
    const sheet = dashboard.slice(dashboard.indexOf('<Sheet open={!!optionsTarget}'), dashboard.indexOf('<Sheet\n        open={!!disconnectTarget}'));
    expect(sheet).toContain('startManageAccounts(shownOptionsTarget.item_id);');
    expect(sheet).toContain('startDisconnect(shownOptionsTarget);');
  });

  test('password mode has a gear for Settings instead of the sign-out buttons in the header', () => {
    const header = dashboard.slice(dashboard.indexOf('<div className="top-actions">'), dashboard.indexOf('{loading ? ('));
    expect(header).toContain('aria-label="Settings"');
    expect(header).not.toContain('onClick={logout}');
    expect(header).not.toContain('onClick={signOutEverywhere}');
    expect(header).toContain('onOpenSettings={openSettings}');
  });
});
