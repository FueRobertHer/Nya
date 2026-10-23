// lib/attachments-mode.ts
//
// Whether this copy of Nya keeps receipts and documents (#47,
// lib/attachments.ts), from its settings alone, so the public pages
// (app/privacy, app/security) can say so without reading anything stored.
//
//   connected  a file store is connected (BLOB_READ_WRITE_TOKEN): files
//              already attached can be viewed, moved, renamed, deleted and
//              downloaded, the nightly sweep runs, and deleting an account
//              deletes them;
//   uploads    adding new ones too, which also needs ATTACHMENTS_QUOTA_MB,
//              the most each account may keep, so whoever pays for the
//              storage chooses to.

import { objectsConnected } from './attachment-objects';

/** ATTACHMENTS_QUOTA_MB in bytes, or null when it is unset or not a whole
 *  number of megabytes from 1 to 1,000,000 (then nothing can be added): read
 *  on each use, and validated, so a typo turns adding off rather than on. */
export function quotaBytes(): number | null {
  const raw = process.env.ATTACHMENTS_QUOTA_MB;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n * 1024 * 1024 : null;
}

export type AttachmentsMode = { connected: boolean; uploads: boolean; quota_bytes: number | null };

/** What this copy of Nya allows (see the header). */
export function attachmentsMode(): AttachmentsMode {
  const connected = objectsConnected();
  const quota = quotaBytes();
  return { connected, uploads: connected && quota !== null, quota_bytes: quota };
}
