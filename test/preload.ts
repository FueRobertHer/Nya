// test/preload.ts
//
// Loaded before the test files (bunfig.toml). A plain `bun test` runs every
// test file in one process (`bun run test`, with --parallel, gives each file a
// fresh global), so there an environment variable one file sets holds for the
// files after it. Three are read each time they are used, so one left set
// changes a later file's results: the blob size ceiling (MAX_TXN_BLOB_CHARS,
// lib/blob.ts), which some tests lower to reach the refusal path, makes a later
// file's saves refuse; the Lunch Flow switch (LUNCHFLOW_ENABLED,
// lib/connectors/switch.ts), which the Lunch Flow tests turn on, would leave
// every later file with connecting allowed; and the receipts quota
// (ATTACHMENTS_QUOTA_MB, lib/attachments-mode.ts), which turns adding files on.
// So all three are deleted when the run starts, before each test and after it,
// whatever the shell or a .env file set (bun test reads .env and .env.test on
// its own): every test starts from the code's defaults, the full ceiling, Lunch
// Flow off and no files added, and so does each file's load and beforeAll. A
// test that wants one set does so in its own beforeEach (this file's runs
// first), or in the test itself.
//
// The local feature switches page's switch (NYA_DEV_FLAGS, lib/dev-flags.ts)
// is cleared the same way, and so is what the feature switches' reads keep in
// memory (lib/flag-cache.ts): every test reads what its own store holds.
//
// The same holds for a shared test helper's own state: its module is loaded
// once for the whole run, so what one file leaves in it reaches every file
// after it that imports it (test/restore-run.ts's `sent`, which one test sets
// to fail a restore's batches part way). A helper registers how to set its
// state back with `resetEachTest` (test/shared-reset.ts), and every one is
// run here, before each test of every file.

import { afterEach, beforeEach } from 'bun:test';
import { runSharedResets } from './shared-reset';
import { flagCache } from '../lib/flag-cache';

const RESET = ['MAX_TXN_BLOB_CHARS', 'LUNCHFLOW_ENABLED', 'ATTACHMENTS_QUOTA_MB', 'NYA_DEV_FLAGS'];

function reset() {
  for (const name of RESET) delete process.env[name];
  // The feature switches read in this instance's memory (lib/flag-cache.ts,
  // which imports nothing): what one file's reads cached would otherwise
  // answer the next file's, whatever its own store holds.
  flagCache.forget();
  runSharedResets();
}

reset();
beforeEach(reset);
// After the file's own afterEach, so nothing a test set reaches the next
// file's load or beforeAll.
afterEach(reset);
