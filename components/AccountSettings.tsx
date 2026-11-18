'use client';

// Settings > Account's card (docs/design/information-architecture.md#settings).
// With Clerk on (lib/auth-mode.ts): who is signed in, read from Clerk and
// shown in place; Manage account, opening Clerk's account window with Nya's
// Data & privacy page (components/ProfileWindow.tsx), where it is all changed;
// and where to sign out, which is the account menu's alone. In password mode:
// Sign out, and Sign out everywhere.
//
// A shared demo account (lib/demo.ts) shows no email and no Manage account:
// Clerk's window would show its sign-in details and, on Security, every
// visitor's device with its address, as the account menu explains
// (components/ClerkAccount.tsx). The server says which it is; until it has,
// the row waits in placeholders and Manage account isn't offered, so a demo
// account never shows either first. When it can't say, neither is shown,
// and the card says to load the page again.
//
// Only Clerk's data is drawn here, never its UI: Clerk lays its profile out by
// the window's width, so it stays in its own window (ProfileWindow.tsx). The
// picture is Clerk's, as the avatar's is (its default is set in Clerk's
// dashboard).

import { useUser } from '@clerk/nextjs';
import { useSignInDetails } from './ClerkAccount';
import { useProfileWindow } from './ProfileWindow';
import { Notice } from './TotalCaveats';

/** Said where Manage account is for a demo account, as its Data & privacy
 *  page said it (lib/account-deletion.ts). */
export const DEMO_ACCOUNT_LINE = 'This is a demo account, shared by everyone who tries the app. It can’t be deleted.';

/** Said in their place when the server couldn't say whether this is a demo
 *  account. */
export const ACCOUNT_UNSURE = 'Your email and Manage account couldn’t be shown just now. Load the page again.';

/** Who is signed in: their picture, their name (full, else their username,
 *  else their email), and their email under it when that isn't the name.
 *  Without its sign-in details (a demo account), the picture and the name
 *  alone, never the email. The same row in placeholders while Clerk loads,
 *  or while whether to show them isn't known (null); nothing without a
 *  user. */
export function Identity({ details }: { details: boolean | null }) {
  const { isLoaded, user } = useUser();
  if (!isLoaded || (user && details === null))
    return (
      <ul className="list-rows" aria-hidden="true">
        <li>
          <div className="list-row account-identity">
            <span className="skeleton block" />
            <span className="list-row-text">
              <span className="list-row-title">
                <span className="skeleton rows-skeleton-title" />
              </span>
              <span className="list-row-sub">
                <span className="skeleton rows-skeleton-sub" />
              </span>
            </span>
          </div>
        </li>
      </ul>
    );
  if (!user) return null;
  const email = details ? (user.primaryEmailAddress?.emailAddress ?? null) : null;
  const name = user.fullName || user.username || email;
  if (!name) return null;
  return (
    <ul className="list-rows" aria-label="Signed in as">
      <li>
        <div className="list-row account-identity">
          {user.imageUrl && <img src={user.imageUrl} alt="" />}
          <span className="list-row-text">
            <span className="list-row-title">{name}</span>
            {email && email !== name && <span className="list-row-sub">{email}</span>}
          </span>
        </div>
      </li>
    </ul>
  );
}

function ClerkCard({ clearDevice }: { clearDevice: () => void }) {
  const { user } = useUser();
  const details = useSignInDetails(user?.id);
  const profile = useProfileWindow(clearDevice);
  return (
    <div className="card stack">
      <Identity details={details === null ? null : details === 'shown'} />
      <p className="helper">Sign out is in the account menu, under your picture or initial at the top right.</p>
      {details === 'demo' && <p className="helper">{DEMO_ACCOUNT_LINE}</p>}
      {details === 'unsure' && <Notice level="caution">{ACCOUNT_UNSURE}</Notice>}
      {details === 'shown' && (
        <div className="btn-row">
          <button className="btn secondary" onClick={profile.open}>
            Manage account
          </button>
        </div>
      )}
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
