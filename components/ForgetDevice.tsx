'use client';

// On the sign-in page: nobody is signed in on this device, so no dashboard
// snapshot kept here (components/device-cache.ts) should stay. Backs up the
// clearing on sign-out (components/ClerkAccount.tsx), for a sign-out that
// happened somewhere this app didn't see.

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { LOCAL_CACHE_KEY } from './device-cache';

export function ForgetDevice() {
  const { isLoaded, isSignedIn } = useAuth();
  useEffect(() => {
    // Someone signed in who came here anyway (adding a second account) keeps theirs.
    if (!isLoaded || isSignedIn) return;
    try {
      for (const key of Object.keys(localStorage)) if (key === LOCAL_CACHE_KEY || key.startsWith(`${LOCAL_CACHE_KEY}:`)) localStorage.removeItem(key);
    } catch {
      // Storage may be off; nothing is kept then anyway.
    }
  }, [isLoaded, isSignedIn]);
  return null;
}
