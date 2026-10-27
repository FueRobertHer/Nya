'use client';

// Settings > Account's card (docs/design/information-architecture.md#settings).
// With Clerk on (lib/auth-mode.ts): Manage account, opening Clerk's account
// window with Nya's Data & privacy page (components/ProfileWindow.tsx), and
// where to sign out, which is the account menu's alone. In password mode:
// Sign out, and Sign out everywhere.

import { useProfileWindow } from './ProfileWindow';

function ClerkCard({ clearDevice }: { clearDevice: () => void }) {
  const profile = useProfileWindow(clearDevice);
  return (
    <div className="card stack">
      <p className="helper">Sign out is in the account menu, under your picture or initial at the top right.</p>
      <div className="btn-row">
        <button className="btn secondary" onClick={profile.open}>
          Manage account
        </button>
      </div>
      {profile.portals}
    </div>
  );
}

export default function AccountSettings({
  clerk,
  clearDevice,
  onSignOut,
  onSignOutEverywhere,
}: {
  clerk: boolean;
  /** What a sign-out through Clerk clears first (components/ClerkAccount.tsx). */
  clearDevice: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}) {
  if (clerk) return <ClerkCard clearDevice={clearDevice} />;
  return (
    <div className="card stack">
      <p className="helper">Sign out everywhere also signs out every other device.</p>
      <div className="btn-row">
        <button className="btn secondary" onClick={onSignOut}>
          Sign out
        </button>
        <button className="btn secondary" onClick={onSignOutEverywhere}>
          Sign out everywhere
        </button>
      </div>
    </div>
  );
}
