import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { clerkEnabled } from '@/lib/auth-mode';

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
  themeColor: '#0f1115',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Clerk's sign-in, menu and account window in the app's own dark palette
// (the tokens in app/globals.css).
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#5b8def',
    colorPrimaryForeground: '#ffffff',
    colorBackground: '#171a21',
    colorForeground: '#e8e9ec',
    colorMutedForeground: '#8b8f98',
    colorMuted: '#1e222b',
    colorNeutral: '#e8e9ec',
    colorInput: '#0f1115',
    colorInputForeground: '#e8e9ec',
    colorBorder: '#2a2f3a',
    colorDanger: '#ef5b5b',
    colorSuccess: '#3ecf8e',
    colorWarning: '#e0a83c',
    colorModalBackdrop: 'rgba(0, 0, 0, 0.6)',
    borderRadius: '10px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Clerk only when its keys are set (lib/auth-mode.ts): without them its
  // provider would fail, and the app signs in with the shared password.
  // Decided per request, never at build: a page prerendered without the keys
  // would keep the password sign-in after Clerk was turned on.
  await connection();
  const page = (
    <html lang="en">
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/service-worker.js').catch(function () {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
  return clerkEnabled() ? <ClerkProvider appearance={CLERK_APPEARANCE}>{page}</ClerkProvider> : page;
}
