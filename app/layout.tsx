import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { clerkEnabled } from '@/lib/auth-mode';
import { DARK, FONT_UI } from '@/lib/theme';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';

export const metadata: Metadata = {
  title: 'Nya',
  description: 'Combined balance sheet across all your connected accounts',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Nya',
  },
};

export const viewport: Viewport = {
  themeColor: DARK.canvas,
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Clerk's sign-in, menu and account window in the app's own dark palette
// (lib/theme.ts, the tokens in app/globals.css).
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: DARK.accent,
    colorPrimaryForeground: DARK['on-fill'],
    colorBackground: DARK.surface,
    colorForeground: DARK['text-1'],
    colorMutedForeground: DARK['text-2'],
    colorMuted: DARK.elevated,
    colorNeutral: DARK['text-1'],
    colorInput: DARK.canvas,
    colorInputForeground: DARK['text-1'],
    colorBorder: DARK['border-strong'],
    colorDanger: DARK.neg,
    colorSuccess: DARK.pos,
    colorWarning: DARK.warn,
    colorModalBackdrop: DARK.scrim,
    borderRadius: '10px',
    fontFamily: FONT_UI,
  },
  elements: {
    // Clerk draws its plain badge ("Primary" beside an address) in its border
    // color, which on this border is unreadable; secondary text instead, as
    // the app's own labels.
    badge: {
      '&[data-color="primary"]': { color: DARK['text-2'], borderColor: DARK['border-strong'] },
    },
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Clerk only when its keys are set (lib/auth-mode.ts): without them its
  // provider would fail, and the app signs in with the shared password.
  // Decided per request, never at build: a page prerendered without the keys
  // would keep the password sign-in after Clerk was turned on. Rendering per
  // request is also what lets every page carry its own nonce
  // (lib/security-headers.ts).
  await connection();
  const page = (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
  // `dynamic`: Clerk renders its script tags on the server, with the nonce
  // proxy.ts made for this request, as the policy requires. That is Clerk's
  // documented way to work under a nonce-based policy.
  return clerkEnabled() ? (
    <ClerkProvider appearance={CLERK_APPEARANCE} dynamic>
      {page}
    </ClerkProvider>
  ) : (
    page
  );
}
