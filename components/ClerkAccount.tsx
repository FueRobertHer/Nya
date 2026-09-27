'use client';

import { UserButton, useClerk } from '@clerk/nextjs';

// Sign-out and account settings when Clerk is on (lib/auth-mode.ts). Clerk's
// account menu lists this account's sessions, which replaces "sign out
// everywhere". `beforeSignOut` clears what this device keeps.
export default function ClerkAccount({ beforeSignOut }: { beforeSignOut: () => void }) {
  const { signOut } = useClerk();
  return (
    <>
      <button
        className="secondary logout-btn"
        onClick={() => {
          beforeSignOut();
          void signOut({ redirectUrl: '/sign-in' });
        }}
      >
        Sign out
      </button>
      <UserButton />
    </>
  );
}
