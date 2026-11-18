// The themes' colors for what can't read a CSS variable: the viewport's
// themeColor (app/layout.tsx, and components/theme.ts after a change) and the
// web manifest (public/manifest.json, dark: it is the install splash). The
// tokens themselves are in app/globals.css; test/design-guard.test.ts fails
// if a value here, or the manifest's, differs from the token it names.

export const DARK = {
  canvas: '#0b1019',
} as const;

export const LIGHT = {
  canvas: '#f4f5f8',
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

// A finger's target, as Nya's own controls (--tap, 44px).
const TAP = { minHeight: 'var(--tap)' };
// An icon button's: as tall and as wide.
const TAP_SQUARE = { minWidth: 'var(--tap)', minHeight: 'var(--tap)' };
// A row of Nya's own menus (.menu-item in app/globals.css), for Clerk's.
const MENU_ROW = { ...TAP, padding: 'var(--sp-2) var(--sp-3)', fontSize: 'var(--fs-3)' };
// A link inside a sentence ("Don't have an account? Sign up", a field's
// "Forgot password?"): underlined, as Nya's own are, since the accent (brass
// in dark, navy in light) is close to body text in lightness. It keeps its
// line's height, so it stays on the sentence's baseline, and reaches a
// finger's target through a box over it, as Nya's own small targets do.
const SENTENCE_LINK = {
  position: 'relative',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  '&::after': { content: '""', position: 'absolute', inset: 'min(0px, calc((100% - var(--tap)) / 2)) 0' },
} as const;

// Clerk's sign-in, menu and account window in the app's tokens: CSS
// variables, which Clerk's appearance takes, so it follows the theme as the
// app does, whichever selects it.
export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: 'var(--accent)',
    colorPrimaryForeground: 'var(--on-accent-fill)',
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
    // Clerk's own focus ring, on its fields, in the app's focus color. Clerk
    // can't take its 15% off a variable, so it draws solid, a 4px band at the
    // field's edge, which the app's own 2px ring (:focus-visible in
    // app/globals.css, which reaches Clerk's controls too) falls inside.
    colorRing: 'var(--focus)',
    // --r-sm, Nya's own inputs and small buttons (look and feel, step 2c).
    borderRadius: '8px',
    // Red Hat Text, as the app's own (app/layout.tsx loads it).
    fontFamily: 'var(--font-ui)',
    // The app's type scale, step for step: Clerk's body (md) is Nya's 15px,
    // its smallest (xs, its badges) the 12px floor, its titles a sheet's and
    // a screen's. Clerk's own scale is 11 to 24px around 13px.
    fontSize: { xs: 'var(--fs-1)', sm: 'var(--fs-2)', md: 'var(--fs-3)', lg: 'var(--fs-4)', xl: 'var(--fs-5)' },
  },
  elements: {
    // Clerk takes one color for its buttons and its links (colorPrimary), so
    // that stays --accent, which passes as link text, with --on-accent-fill on
    // it (ink on brass, 9.80:1, in dark; white on navy, 8.89:1, in light).
    // Its primary button alone takes --accent-fill, as Nya's own primary does
    // (ink on brass, 8.98:1; white on navy, 15.46:1).
    // It keeps its fill on hover, as Nya's own primary does.
    formButtonPrimary: {
      ...TAP,
      backgroundColor: 'var(--accent-fill)',
      '&:hover, &:active': { backgroundColor: 'var(--accent-fill)' },
    },
    // A field's edge is what shows it is a field: --border-input, 3:1, as
    // Nya's own fields (colorBorder stays --border-strong for Clerk's cards
    // and dividers). 44px tall, as Nya's own fields.
    formFieldInput: {
      ...TAP,
      borderColor: 'var(--border-input)',
    },
    // Every other control of Clerk's at a finger's target: the sign-in
    // form's buttons (Continue with Google, another method, Cancel), the
    // show-password eye in its field, and the account window's nav rows (the
    // menu button that stands for them on a phone), its section buttons
    // (Update profile, Add email address), tabs, ⋯ menus, avatar buttons
    // and close. Clerk draws them 24 to 42px.
    formButtonReset: TAP,
    socialButtonsBlockButton: TAP,
    alternativeMethodsBlockButton: TAP,
    formFieldInputShowPasswordButton: TAP_SQUARE,
    navbarButton: TAP,
    navbarMobileMenuButton: TAP,
    profileSectionPrimaryButton: TAP,
    menuButton: TAP,
    menuButtonEllipsis: TAP_SQUARE,
    tabButton: TAP,
    avatarImageActionsUpload: TAP,
    avatarImageActionsRemove: TAP,
    modalCloseButton: TAP_SQUARE,
    // A device's IP address is one long word, which at 320px ran past the
    // window's edge.
    activeDevice: { overflowWrap: 'anywhere' },
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
    // The account window's ⋯ menus (Remove email, Sign out of device) the
    // same: Clerk draws their rows 29px.
    menuItem: MENU_ROW,
    footerActionLink: SENTENCE_LINK,
    formFieldAction: SENTENCE_LINK,
  },
};
