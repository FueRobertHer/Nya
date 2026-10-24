// The dark theme's colors for what can't read a CSS variable: Clerk's
// appearance and the viewport's themeColor (app/layout.tsx), and the web
// manifest (public/manifest.json). The tokens themselves are in
// app/globals.css; test/design-guard.test.ts fails if a value here, or the
// manifest's, differs from the token it names.

export const DARK = {
  canvas: '#0d0f14',
  surface: '#151821',
  elevated: '#1c202b',
  'border-strong': '#2b3140',
  'text-1': '#eceef2',
  'text-2': '#9499a6',
  accent: '#5b8def',
  pos: '#34d399',
  neg: '#f87171',
  warn: '#fbbf24',
  'on-fill': '#ffffff',
  scrim: 'rgba(0, 0, 0, 0.55)',
} as const;

export const FONT_UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
