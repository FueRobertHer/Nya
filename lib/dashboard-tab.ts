// lib/dashboard-tab.ts
//
// Which of the dashboard's tabs is open, kept in the address (`/?tab=plan`),
// so a reload comes back to it (docs/design/information-architecture.md#navigation-model).
// Home is the bare `/`. Read by the page on the server (app/page.tsx), so the
// first paint is already that tab's loading view, and written by the
// dashboard (components/Dashboard.tsx) with history.replaceState as the tab
// changes: a tab is never a history entry of its own, so Back does what it
// always did.

export const TABS = ['home', 'accounts', 'activity', 'budgets', 'plan'] as const;
export type Tab = (typeof TABS)[number];

type Query = { tab?: string | string[]; view?: string | string[] };

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
