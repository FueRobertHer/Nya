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
  return clerkEnabled() ? <ClerkProvider>{page}</ClerkProvider> : page;
}
