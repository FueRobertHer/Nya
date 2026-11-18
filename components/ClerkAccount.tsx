'use client';

// The account menu when Clerk is on (lib/auth-mode.ts). For a real account,
// Clerk's own button, with Settings and Sharing added to its menu and a
// "Data & privacy" page (deleting the account, components/ProfileWindow.tsx)
// added to its account window, which Settings > Account opens too. Clerk's
// menu is the one place to sign out (Settings > Account only points to it),
// and its account window lists this account's sessions, which replaces "sign
// out everywhere".
//
// A shared demo account (lib/demo.ts) never gets Clerk's button: its menu
// shows the account's email, and its account window shows the sign-in
// details (email, password, connected accounts) and, on Security, every
// visitor's device with its address and city. Clerk lets its menu's Manage
// account and its window's Profile and Security pages be moved, never taken
// out, so a demo account gets Nya's own menu instead, under its picture:
// Settings, Sharing and Sign out. Which it is, the server says
// (app/api/demo/me), never the browser; until it has, the circle the app
// loading drew; when it can't say, Nya's menu, so a demo account is never
// shown Clerk's for want of an answer.
//
// Signing out through Clerk's menu doesn't pass through this app, so what
// this device keeps (`clearDevice`) is cleared when Clerk reports the session
// gone; Nya's own Sign out clears it first as well.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { UserButton, useClerk, useUser } from '@clerk/nextjs';
import DeleteAccount from './DeleteAccount';
import { GEAR } from './HeaderIcon';
import { nextIndex } from './Menu';
import { DATA_PAGE, dataPageIcon } from './ProfileWindow';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PEOPLE = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75';
const PERSON = 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8';

/** Whether this account may be shown its sign-in details: its email, and
 *  Clerk's account window with its password, connected accounts and
 *  devices. 'shown' only once the server has said, for this account, that
 *  it isn't a demo account (app/api/demo/me); 'demo' when it has said it is
 *  one; 'unsure' when it couldn't say, or answered for another account,
 *  which shows them no more than 'demo' does. Null until it has answered
 *  for this account. Asked again whenever the account changes (a demo
 *  sign-in changes it in place, components/demo-sign-in.ts), and an answer
 *  for the one before is never used. */
export type SignInDetails = 'shown' | 'demo' | 'unsure';
export function useSignInDetails(userId: string | null | undefined): SignInDetails | null {
  const [answer, setAnswer] = useState<{ user: string; details: SignInDetails } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    fetch('/api/demo/me', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body: { user?: unknown; demo?: unknown } | null) => {
        const said = body?.user === userId ? body.demo : undefined;
        if (live) setAnswer({ user: userId, details: said === false ? 'shown' : said === true ? 'demo' : 'unsure' });
      });
    return () => {
      live = false;
    };
  }, [userId]);
  return userId && answer?.user === userId ? answer.details : null;
}

/** Nya's account menu, for a demo account: its picture as the button, and
 *  Settings, Sharing and Sign out, as an object's ⋯ menu works
 *  (components/Menu.tsx, the WAI-ARIA menu button pattern): opening moves
 *  focus to the first item, the arrow keys, Home and End move between them,
 *  Escape closes it and gives focus back to the button, and so does choosing
 *  one, so the Settings sheet gives focus back to it when it closes. Its
 *  own, not Menu itself, whose button is always the ⋯. */
function OwnAccountMenu({ imageUrl, items }: { imageUrl: string | null; items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemEls = () => itemRefs.current.slice(0, items.length).filter((el): el is HTMLButtonElement => !!el);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (open) itemEls()[0]?.focus();
  }, [open]);

  // A press anywhere else closes it, leaving focus where the press put it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const els = itemEls();
    const to = nextIndex(
      e.key,
      els.indexOf(document.activeElement as HTMLButtonElement),
      els.map(() => true)
    );
    if (to !== null) {
      e.preventDefault();
      els[to].focus();
    }
  };

  return (
    <div className="menu-anchor" ref={wrap} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn account-menu-btn"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {/* The picture Clerk keeps for the account (its default is set in
            Clerk's dashboard), as Clerk's own button draws it. */}
        {imageUrl ? <img src={imageUrl} alt="" /> : icon(PERSON)}
      </button>
      {open && (
        // Under the button and aligned to its right edge, as a ⋯ menu's: the
        // button is the header's last, at the screen's right edge, so it is
        // never past either edge, nor short of room below.
        <div id={id} role="menu" aria-label="Account" className="menu">
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const { user } = useUser();
  const details = useSignInDetails(user?.id);
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
  // To the page ClerkProvider names for after a sign-out (app/layout.tsx).
  const signOut = useCallback(() => {
    clearDevice();
    clerk.signOut().catch(() => {
      window.location.href = '/sign-in';
    });
  }, [clerk, clearDevice]);
  return (
    <div className="user-button-slot">
      {/* Until Clerk draws the avatar, and the server has said whose menu it
          is, the circle the app loading drew in its place
          (components/LoadingSkeletons.tsx), so the dashboard taking over
          leaves it as it was. */}
      {details === null ? (
        <span className="skeleton user-button-skeleton" aria-hidden="true" />
      ) : details === 'shown' ? (
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
      ) : (
        <OwnAccountMenu
          imageUrl={user?.imageUrl || null}
          items={[
            { label: 'Settings', onSelect: onOpenSettings },
            { label: 'Sharing', onSelect: onOpenSharing },
            { label: 'Sign out', onSelect: signOut },
          ]}
        />
      )}
    </div>
  );
}
