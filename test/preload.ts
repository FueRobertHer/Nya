// test/preload.ts
//
// Loaded before the test files (bunfig.toml). Bun runs every test file in one
// process, so an environment variable one file sets holds for the files after
// it. Three are read each time they are used, so one left set changes a later
// file's results: the blob size ceiling (MAX_TXN_BLOB_CHARS, lib/blob.ts),
// which some tests lower to reach the refusal path, makes a later file's saves
// refuse; the Lunch Flow switch (LUNCHFLOW_ENABLED, lib/connectors/switch.ts),
// which the Lunch Flow tests turn on, would leave every later file with
// connecting allowed; and the receipts quota (ATTACHMENTS_QUOTA_MB,
// lib/attachments-mode.ts), which turns adding files on. So all three are
// deleted when the run starts, before each test and after it, whatever the
// shell or a .env file set (bun test reads .env and .env.test on its own):
// every test starts from the code's defaults, the full ceiling, Lunch Flow
// off and no files added, and so does each file's load and beforeAll. A test
// that wants one set does so in its own beforeEach (this file's runs first),
// or in the test itself.

import { afterEach, beforeEach } from 'bun:test';

const RESET = ['MAX_TXN_BLOB_CHARS', 'LUNCHFLOW_ENABLED', 'ATTACHMENTS_QUOTA_MB'];

function reset() {
  for (const name of RESET) delete process.env[name];
}

reset();
beforeEach(reset);
// After the file's own afterEach, so nothing a test set reaches the next
// file's load or beforeAll.
afterEach(reset);
