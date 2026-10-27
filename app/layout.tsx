import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import { cookies } from 'next/headers';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import { clerkEnabled } from '@/lib/auth-mode';
import { CLERK_APPEARANCE, THEME_COOKIE, colorScheme, statusBarStyle, themeChoice, themeColors } from '@/lib/theme';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';

// Next takes metadata or generateMetadata, not both: this is the part that
// doesn't depend on the theme.
const METADATA: Metadata = {
  title: 'Nya',
  description: 'Combined balance sheet across all your connected accounts',
  manifest: '/manifest.json',
};

// The theme chosen on this device (components/theme.ts keeps it in a cookie),
// or none to follow the system: the page, its chrome color and iOS's status
// bar are sent in it, so nothing flashes and no script runs before paint.
async function chosenTheme() {
  return themeChoice((await cookies()).get(THEME_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    ...METADATA,
    appleWebApp: {
      capable: true,
      statusBarStyle: statusBarStyle(await chosenTheme()),
      title: 'Nya',
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const choice = await chosenTheme();
  return {
    themeColor: themeColors(choice),
    colorScheme: colorScheme(choice),
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Clerk only when its keys are set (lib/auth-mode.ts): without them its
  // provider would fail, and the app signs in with the shared password.
  // Decided per request, never at build: a page prerendered without the keys
  // would keep the password sign-in after Clerk was turned on. Rendering per
  // request is also what lets every page carry its own nonce
  // (lib/security-headers.ts).
  await connection();
  const page = (
    <html lang="en" data-theme={(await chosenTheme()) ?? undefined}>
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
    // Straight to sign-in after the account menu's Sign out, the only one with
    // Clerk on, rather than through the home page's redirect.
    <ClerkProvider appearance={CLERK_APPEARANCE} afterSignOutUrl="/sign-in" dynamic>
      {page}
    </ClerkProvider>
  ) : (
    page
  );
}
