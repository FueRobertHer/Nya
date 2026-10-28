// lib/dashboard-tab.ts
//
// Which of the dashboard's tabs is open, kept in the address (`/?tab=plan`),
// so a reload comes back to it (docs/design/information-architecture.md#navigation-model).
// Home is the bare `/`. Read by the page on the server (app/page.tsx), so the
// first paint is already that tab's loading view, and written by the
// dashboard (components/Dashboard.tsx) with history.replaceState as the tab
// changes: a tab is never a history entry of its own, so Back does what it
// always did.
//
// Settings, shown in place of the tabs, is kept the same way beside the tab
// under it (`/?tab=accounts&settings=connections`): its list, or one of its
// sections. Replaced too, never pushed, so a reload comes back to it and
// Back still leaves the page.

export const TABS = ['home', 'accounts', 'activity', 'budgets', 'plan'] as const;
export type Tab = (typeof TABS)[number];

/** Settings' sections (components/Settings.tsx), in the order it lists them. */
export const SETTINGS_SECTIONS = ['preferences', 'transactions', 'connections', 'sharing', 'data', 'account'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
/** What Settings shows: its list of sections, or one of them. */
export type SettingsView = 'list' | SettingsSectionId;

type Query = { tab?: string | string[]; view?: string | string[]; settings?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The tab an address asks for: `?tab=`, or the Accounts tab for a notice
 *  email's `?view=connections` (lib/connection-state.ts CONNECTIONS_PATH).
 *  Anything else is Home. Takes the page's searchParams or a URLSearchParams. */
export function parseTab(query: Query | URLSearchParams): Tab {
  const get = (key: keyof Query) => (query instanceof URLSearchParams ? (query.get(key) ?? undefined) : first(query[key]));
  if (get('view') === 'connections') return 'accounts';
  const tab = get('tab');
  return (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'home';
}

/** The address for a tab: `href` with `?tab=` set (left out for Home) and
 *  `?view=` dropped, since that asked for a tab once and has been answered;
 *  anything else in the query, and the hash, kept. Relative to the origin. */
export function tabHref(tab: Tab, href: string): string {
  const url = new URL(href, 'http://localhost');
  url.searchParams.delete('view');
  if (tab === 'home') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Whether the address asks for Settings, and which part of it: `?settings=`
 *  naming a section opens that section; any other value (`list`, empty, one
 *  it doesn't know) opens the list. Absent, Settings is closed. Sharing is
 *  only offered with Clerk (`sharing: false` without it), so asking for it
 *  then opens the list. Takes the page's searchParams or a URLSearchParams. */
export function parseSettings(query: Query | URLSearchParams, { sharing = true }: { sharing?: boolean } = {}): SettingsView | null {
  const value = query instanceof URLSearchParams ? query.get('settings') : first(query.settings);
  if (value === null || value === undefined) return null;
  if (value === 'sharing' && !sharing) return 'list';
  return (SETTINGS_SECTIONS as readonly string[]).includes(value) ? (value as SettingsSectionId) : 'list';
}

/** The address with Settings in it: `href` with `?settings=` set to `view`,
 *  or dropped when Settings is closed (null); the tab, the rest of the query
 *  and the hash kept. Relative to the origin. */
export function settingsHref(view: SettingsView | null, href: string): string {
  const url = new URL(href, 'http://localhost');
  if (view === null) url.searchParams.delete('settings');
  else url.searchParams.set('settings', view);
  return `${url.pathname}${url.search}${url.hash}`;
}
