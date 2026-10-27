'use client';

// The account menu when Clerk is on (lib/auth-mode.ts): Clerk's own button,
// with Settings and Sharing added to its menu and a "Data & privacy" page
// (deleting the account, components/ProfileWindow.tsx) added to its account
// window, which Settings > Account opens too. Clerk's menu is the one place to
// sign out (Settings > Account only points to it), and its account window
// lists this account's sessions, which replaces "sign out everywhere".
//
// Signing out through that menu doesn't pass through this app, so what this
// device keeps (`clearDevice`) is cleared when Clerk reports the session gone.

import { useEffect } from 'react';
import { UserButton, useClerk } from '@clerk/nextjs';
import DeleteAccount from './DeleteAccount';
import { GEAR } from './HeaderIcon';
import { DATA_PAGE, dataPageIcon } from './ProfileWindow';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PEOPLE = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75';

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
      {/* Until Clerk draws the avatar, the circle the app loading drew in its
          place (components/LoadingSkeletons.tsx), so the dashboard taking
          over leaves it as it was. */}
      <UserButton
        appearance={{ elements: { avatarBox: { width: 34, height: 34 } } }}
        fallback={<span className="skeleton user-button-skeleton" aria-hidden="true" />}
      >
        <UserButton.MenuItems>
          <UserButton.Action label="Settings" labelIcon={icon(GEAR)} onClick={onOpenSettings} />
          <UserButton.Action label="Sharing" labelIcon={icon(PEOPLE)} onClick={onOpenSharing} />
          <UserButton.Action label="manageAccount" />
          <UserButton.Action label="signOut" />
        </UserButton.MenuItems>
        <UserButton.UserProfilePage label={DATA_PAGE.label} url={DATA_PAGE.url} labelIcon={dataPageIcon}>
          <DeleteAccount beforeSignOut={clearDevice} />
        </UserButton.UserProfilePage>
      </UserButton>
    </div>
  );
}
