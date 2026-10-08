'use client';

// Registers the service worker (public/service-worker.js) once the page has
// loaded. From the app's own script rather than an inline <script>, so the
// Content-Security-Policy needs no exception for it (lib/security-headers.ts).

import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    };
    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
  return null;
}
