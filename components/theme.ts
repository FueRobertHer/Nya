// components/theme.ts
//
// The theme chosen on this device (Settings > Preferences, components/
// ThemeCard.tsx): System, Dark or Light. System follows the device: dark when
// it is dark or says nothing, light when it is light, which the CSS decides
// (app/globals.css), so it needs nothing here.
//
// KEPT IN A COOKIE (`nya-theme`, lib/theme.ts), never on the server's side of
// the account: it is this device's display, like hide amounts, so a phone and
// a laptop can differ. A cookie rather than localStorage because the browser
// sends it with each page, so the root layout draws the page in the choice
// from the first paint, with no script before it. System is no cookie at all.
// Where cookies are blocked a choice lasts as long as the page.
//
// A CHANGE applies at once: the root's data-theme, which the layout set from
// the cookie, and the chrome color and color-scheme it sent. Other tabs open
// on this device follow on their next load.

import { useSyncExternalStore } from 'react';
import { THEME_COOKIE, colorScheme, themeChoice, themeColors, type ThemeChoice } from '@/lib/theme';

const YEAR = 365 * 24 * 60 * 60;
const listeners = new Set<() => void>();

/** The choice the page is drawn in, from the root's data-theme. */
export function currentTheme(): ThemeChoice | null {
  return typeof document === 'undefined' ? null : themeChoice(document.documentElement.dataset.theme);
}

/** Choose a theme for this device (null: the system's) and draw in it now. */
export function setTheme(choice: ThemeChoice | null) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = choice
    ? `${THEME_COOKIE}=${choice}; Path=/; Max-Age=${YEAR}; SameSite=Lax${secure}`
    : `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  const root = document.documentElement;
  if (choice) root.dataset.theme = choice;
  else delete root.dataset.theme;
  // What the layout sent for the old choice (lib/theme.ts), in place.
  const metas = document.head.querySelectorAll('meta[name="theme-color"]');
  for (const { media, color } of themeColors(choice)) {
    for (const m of metas) if (m.getAttribute('media') === media) m.setAttribute('content', color);
  }
  for (const m of document.head.querySelectorAll('meta[name="color-scheme"]')) m.setAttribute('content', colorScheme(choice));
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The choice, drawn again when it changes. The server can't see the root
 *  element, so it renders System and the browser corrects it. */
export function useTheme(): ThemeChoice | null {
  return useSyncExternalStore(subscribe, currentTheme, () => null);
}
