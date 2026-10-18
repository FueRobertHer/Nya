// test/preload.ts
//
// Loaded before the test files (bunfig.toml). Bun runs every test file in one
// process, so an environment variable one file sets holds for the files after
// it. The blob size ceiling (MAX_TXN_BLOB_CHARS, lib/blob.ts), which some
// tests lower to reach the refusal path, is read each time it is used: one
// left lowered makes a later file's saves refuse. So it is put back, before
// each test, as it was when the run began; a test that wants it lowered sets
// it in its own beforeEach, or in the test itself.

import { beforeEach } from 'bun:test';

const atStart = process.env.MAX_TXN_BLOB_CHARS;

beforeEach(() => {
  if (atStart === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
  else process.env.MAX_TXN_BLOB_CHARS = atStart;
});
