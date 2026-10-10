// lib/app-url.ts
//
// The app's public address, from APP_URL: the link in a notice email
// (lib/connection-notices.ts) and the address the developer page
// (app/developers) shows in its examples. Reads the environment only, so a
// public page can use it.

/**
 * The app's public address, from APP_URL: https, or http on this machine for
 * local development. Null when unset or unusable.
 */
export function appUrl(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}
