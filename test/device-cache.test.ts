import { describe, expect, test } from 'bun:test';
import { cacheKeyFor, LOCAL_CACHE_KEY, reloadKeyAfter } from '@/components/device-cache';

describe('the on-device dashboard snapshot', () => {
  test('is kept per signed-in account, so a shared device never shows one person the other', () => {
    expect(cacheKeyFor('user_a')).not.toBe(cacheKeyFor('user_b'));
    expect(cacheKeyFor('user_a')).not.toBe(LOCAL_CACHE_KEY);
    expect(cacheKeyFor(undefined)).toBe(LOCAL_CACHE_KEY); // the shared password's one user
  });
});

describe('what the parts beside the balances read again on', () => {
  test('a first load as old as the saved snapshot reads nothing again', () => {
    expect(reloadKeyAfter(null, '2026-10-29T10:00:00Z', '2026-10-29T10:00:00Z')).toBeNull();
  });

  test('a first load newer than the snapshot, or with none saved, reads them again', () => {
    expect(reloadKeyAfter(null, '2026-10-29T11:00:00Z', '2026-10-29T10:00:00Z')).toBe('2026-10-29T11:00:00Z');
    expect(reloadKeyAfter(null, '2026-10-29T11:00:00Z', undefined)).toBe('2026-10-29T11:00:00Z');
  });

  test('later loads read them again when the balances moved, and not otherwise', () => {
    const first = reloadKeyAfter(null, '2026-10-29T11:00:00Z', undefined);
    expect(reloadKeyAfter(first, '2026-10-29T11:00:00Z', undefined)).toBe(first);
    expect(reloadKeyAfter(first, '2026-10-29T12:00:00Z', undefined)).toBe('2026-10-29T12:00:00Z');
    // Once a load has given it a time, a later one back at the snapshot's is a change too.
    expect(reloadKeyAfter('2026-10-29T12:00:00Z', '2026-10-29T10:00:00Z', '2026-10-29T10:00:00Z')).toBe('2026-10-29T10:00:00Z');
  });
});
