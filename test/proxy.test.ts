import { describe, expect, test } from 'bun:test';

const { config } = await import('@/proxy');

// The matcher selects the paths the session gate runs on. The self-
// authenticating routes must be excluded exactly, and nothing else with them.
const gated = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe('the session gate', () => {
  test('skips exactly the routes that authenticate themselves', () => {
    for (const path of ['/api/snapshot', '/api/snapshot/catchup', '/api/ingest/balance', '/api/ops/export', '/api/ops/rotate-master', '/api/login']) {
      expect(gated(path)).toBe(false);
    }
  });

  test('still covers anything that merely starts with one of them', () => {
    for (const path of ['/api/ops/rotate-master2', '/api/snapshot-runs', '/api/snapshot/other', '/api/snapshot/catchup/x', '/api/ops/exports', '/api/ops/rotate-master/x', '/api/ops/other']) {
      expect(gated(path)).toBe(true);
    }
  });

  test('covers ordinary routes and pages', () => {
    for (const path of ['/api/budgets', '/api/net-worth', '/', '/settings']) expect(gated(path)).toBe(true);
  });
});
