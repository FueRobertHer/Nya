'use client';

// The account menu when Clerk is on (lib/auth-mode.ts): Clerk's own button,
// with Settings and Sharing added to its menu and a "Data & privacy" page (deleting the
// account) added to its account window. Clerk's menu is the one place to
// sign out (Settings > Account only points to it), and its account window
// lists this account's sessions, which replaces "sign out everywhere".
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
export const GEAR =
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z';

export default function ClerkAccount({
  clearDevice,
  onOpenSettings,
  onOpenSharing,
}: {
  clearDevice: () => void;
  onOpenSettings: () => void;
  onOpenSharing: () => void;
}) {
  const clerk = useClerk();
  useEffect(() => {
    // Only a session that was there and went: not the first report, nor a
    // moment without one before Clerk has loaded.
    let hadSession = false;
    return clerk.addListener(({ session }) => {
      if (session) hadSession = true;
      else if (session === null && hadSession) {
        hadSession = false;
        clearDevice();
      }
    });
  }, [clerk, clearDevice]);
  return (
    <div className="user-button-slot">
      <UserButton appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }}>
        <UserButton.MenuItems>
          <UserButton.Action label="Settings" labelIcon={icon(GEAR)} onClick={onOpenSettings} />
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
