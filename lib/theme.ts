// The themes' colors for what can't read a CSS variable: the viewport's
// themeColor (app/layout.tsx, and components/theme.ts after a change) and the
// web manifest (public/manifest.json, dark: it is the install splash). The
// tokens themselves are in app/globals.css; test/design-guard.test.ts fails
// if a value here, or the manifest's, differs from the token it names.

export const DARK = {
  canvas: '#0d0f14',
} as const;

export const LIGHT = {
  canvas: '#f6f7f9',
} as const;

/** A theme chosen in Settings > Preferences. None follows the system: dark
 *  when it is dark or says nothing, light when it is light (the CSS decides). */
export type ThemeChoice = 'light' | 'dark';

/** The cookie that keeps the choice on this device, which the root layout
 *  reads so the first paint is already in it (components/theme.ts sets it). */
export const THEME_COOKIE = 'nya-theme';

/** The choice a cookie holds; anything else is the system's. */
export function themeChoice(value: string | null | undefined): ThemeChoice | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** The browser's chrome color, as three entries whatever the choice, so a
 *  change can rewrite them in place: each theme's canvas by the system's
 *  setting, then dark's for a browser that states none (the first that
 *  matches applies); or the chosen one's for all three. */
export function themeColors(choice: ThemeChoice | null): { media?: string; color: string }[] {
  const canvas = (t: ThemeChoice) => (t === 'light' ? LIGHT : DARK).canvas;
  return [
    ...(['light', 'dark'] as const).map((t) => ({ media: `(prefers-color-scheme: ${t})`, color: canvas(choice ?? t) })),
    { color: canvas(choice ?? 'dark') },
  ];
}

/** What the page tells the browser it draws in, for its own controls and
 *  the canvas before the styles load. */
export function colorScheme(choice: ThemeChoice | null): 'light' | 'dark' | 'dark light' {
  return choice ?? 'dark light';
}

/** iOS home-screen apps: white status text over the page, which only reads
 *  on dark, or the light bar with dark text. With no choice the system's
 *  setting isn't known here, so dark's, as before (docs/features.md). */
export function statusBarStyle(choice: ThemeChoice | null): 'default' | 'black-translucent' {
  return choice === 'light' ? 'default' : 'black-translucent';
}

// A row of Nya's own menus (.menu-item in app/globals.css), for Clerk's.
const MENU_ROW = { minHeight: 'var(--tap)', padding: 'var(--sp-2) var(--sp-3)', fontSize: 'var(--fs-3)' };

// Clerk's sign-in, menu and account window in the app's tokens: CSS
// variables, which Clerk's appearance takes, so it follows the theme as the
// app does, whichever selects it.
export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: 'var(--accent)',
    colorPrimaryForeground: 'var(--on-fill)',
    colorBackground: 'var(--surface)',
    colorForeground: 'var(--text-1)',
    colorMutedForeground: 'var(--text-2)',
    colorMuted: 'var(--elevated)',
    colorNeutral: 'var(--text-1)',
    colorInput: 'var(--canvas)',
    colorInputForeground: 'var(--text-1)',
    colorBorder: 'var(--border-strong)',
    colorDanger: 'var(--neg)',
    colorSuccess: 'var(--pos)',
    colorWarning: 'var(--warn)',
    colorModalBackdrop: 'var(--scrim)',
    // --r-sm, Nya's own inputs and small buttons (look and feel, step 2c).
    borderRadius: '8px',
    // Red Hat Text, as the app's own (app/layout.tsx loads it).
    fontFamily: 'var(--font-ui)',
  },
  elements: {
    // Clerk takes one color for its buttons and its links (colorPrimary), so
    // that stays --accent, which passes as link text; its primary button alone
    // takes the deeper --accent-fill, as Nya's own primary does, so its white
    // label passes too (5.17:1, where white on --accent is 3.23:1 in dark).
    formButtonPrimary: {
      backgroundColor: 'var(--accent-fill)',
      '&:hover, &:active': { backgroundColor: 'var(--accent-fill)', filter: 'brightness(0.92)' },
    },
    // Clerk draws its plain badge ("Primary" beside an address) in its border
    // color, which on this border is unreadable; secondary text instead, as
    // the app's own labels.
    badge: {
      '&[data-color="primary"]': { color: 'var(--text-2)', borderColor: 'var(--border-strong)' },
    },
    // The account menu's rows as Nya's own menus' (.menu-item): a 44px row,
    // its padding and body type. Clerk's rows (Sign out) and the ones Nya
    // adds (Settings, Sharing) take separate keys.
    userButtonPopoverActionButton: MENU_ROW,
    userButtonPopoverCustomItemButton: MENU_ROW,
  },
};
