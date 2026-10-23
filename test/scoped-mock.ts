// test/scoped-mock.ts
//
// A module mock for one test file. Bun's mock.module holds for the whole
// process: a module one file mocks stays mocked for every file that runs
// after it, so a later file that uses the real module (one that relies on
// Clerk not being reachable, say) passes or fails by the order the files run
// in (bun test --randomize changes it), and mock.restore() doesn't undo one.
// mockForFile copies the real module's exports before mocking it, and puts
// them back after the file, so no later file sees the mock.
//
// The modules nearly every file mocks for itself before using them
// (lib/storage with test/fake-redis.ts, lib/plaid, and Clerk's server module
// in test/clerk-mock.ts) are left to that convention.

import { afterAll, mock } from 'bun:test';

export async function mockForFile(specifier: string, factory: () => Record<string, unknown>): Promise<void> {
  const real = { ...(await import(specifier)) };
  mock.module(specifier, factory);
  afterAll(() => {
    mock.module(specifier, () => real);
  });
}
