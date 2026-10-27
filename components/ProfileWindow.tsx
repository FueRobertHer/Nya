'use client';

// Clerk's account window, with Nya's "Data & privacy" page (deleting the
// account, components/DeleteAccount.tsx) added to it, opened from anywhere
// but the account menu: Settings > Account (components/AccountSettings.tsx).
// The menu's own Manage account opens the same window through
// UserButton.UserProfilePage (components/ClerkAccount.tsx); both take the
// page's name, address and icon from here.
//
// clerk.openUserProfile() alone opens the window without the page. Given the
// page, Clerk hands it an element to draw into when it is shown, and the page
// is drawn there through a portal from this tree, so DeleteAccount keeps
// Clerk's context, as UserButton.UserProfilePage does inside. (Clerk's
// profile inline in a Nya sheet was tried in look and feel step 2c: Clerk
// lays it out by the window's width, so on a wide screen it doesn't fit one.)

import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClerk } from '@clerk/nextjs';
import DeleteAccount from './DeleteAccount';

/** The page Nya adds to Clerk's account window. */
export const DATA_PAGE = { label: 'Data & privacy', url: 'data' } as const;

const SHIELD = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';
export const dataPageIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={SHIELD} />
  </svg>
);

/** Opens Clerk's account window with the Data & privacy page; `portals`
 *  must be drawn while it may be open, for the page to show. */
export function useProfileWindow(clearDevice: () => void): { open: () => void; portals: ReactNode } {
  const clerk = useClerk();
  const [page, setPage] = useState<HTMLDivElement | null>(null);
  const [icon, setIcon] = useState<HTMLDivElement | null>(null);
  const open = useCallback(
    () =>
      clerk.openUserProfile({
        customPages: [
          {
            ...DATA_PAGE,
            // Taken away: only the element Clerk names, should it have
            // drawn the page somewhere new first.
            mountIcon: setIcon,
            unmountIcon: (el) => setIcon((now) => (el && now !== el ? now : null)),
            mount: setPage,
            unmount: (el) => setPage((now) => (el && now !== el ? now : null)),
          },
        ],
      }),
    [clerk]
  );
  const portals = (
    <>
      {icon && createPortal(dataPageIcon, icon)}
      {page && createPortal(<DeleteAccount beforeSignOut={clearDevice} />, page)}
    </>
  );
  return { open, portals };
}
