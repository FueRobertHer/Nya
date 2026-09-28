'use client';

// The account menu when Clerk is on (lib/auth-mode.ts): Clerk's own button,
// with Sharing added to its menu and a "Data & privacy" page (deleting the
// account) added to its account window. Clerk's menu signs out and lists
// this account's sessions, which replaces "sign out everywhere".
//
// Signing out through that menu doesn't pass through this app, so what this
// device keeps (`clearDevice`) is cleared when Clerk reports the session gone.

import { useEffect } from 'react';
import { UserButton, useClerk } from '@clerk/nextjs';
import DeleteAccount from './DeleteAccount';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PEOPLE = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75';
const SHIELD = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';

export default function ClerkAccount({ clearDevice, onOpenSharing }: { clearDevice: () => void; onOpenSharing: () => void }) {
  const clerk = useClerk();
  useEffect(
    () =>
      clerk.addListener(({ session }) => {
        if (session === null) clearDevice();
      }),
    [clerk, clearDevice]
  );
  return (
    <div className="user-button-slot">
      <UserButton appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }}>
        <UserButton.MenuItems>
          <UserButton.Action label="Sharing" labelIcon={icon(PEOPLE)} onClick={onOpenSharing} />
          <UserButton.Action label="manageAccount" />
          <UserButton.Action label="signOut" />
        </UserButton.MenuItems>
        <UserButton.UserProfilePage label="Data & privacy" url="data" labelIcon={icon(SHIELD)}>
          <DeleteAccount beforeSignOut={clearDevice} />
        </UserButton.UserProfilePage>
      </UserButton>
    </div>
  );
}
