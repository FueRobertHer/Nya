import { describe, expect, test } from 'bun:test';
import { cacheKeyFor, LOCAL_CACHE_KEY } from '@/components/device-cache';

describe('the on-device dashboard snapshot', () => {
  test('is kept per signed-in account, so a shared device never shows one person the other', () => {
    expect(cacheKeyFor('user_a')).not.toBe(cacheKeyFor('user_b'));
    expect(cacheKeyFor('user_a')).not.toBe(LOCAL_CACHE_KEY);
    expect(cacheKeyFor(undefined)).toBe(LOCAL_CACHE_KEY); // the shared password's one user
  });
});
