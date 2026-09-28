'use client';

// On the sign-in page: nobody is signed in on this device, so no dashboard
// snapshot kept here (components/device-cache.ts) should stay. Backs up the
// clearing on sign-out (components/ClerkAccount.tsx), for a sign-out that
// happened somewhere this app didn't see.

import { useEffect } from 'react';
import { LOCAL_CACHE_KEY } from './device-cache';

export function ForgetDevice() {
  useEffect(() => {
    try {
      for (const key of Object.keys(localStorage)) if (key === LOCAL_CACHE_KEY || key.startsWith(`${LOCAL_CACHE_KEY}:`)) localStorage.removeItem(key);
    } catch {
      // Storage may be off; nothing is kept then anyway.
    }
  }, []);
  return null;
}
