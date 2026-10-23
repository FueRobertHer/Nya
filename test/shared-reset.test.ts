import { describe, expect, test } from 'bun:test';
import { resetEachTest } from './shared-reset';

// A shared test helper's state, left set by one test, is set back before the
// next test of any file (test/preload.ts, test/shared-reset.ts): its module is
// loaded once for the whole run. The two tests run in this order unless the
// run is randomized; either way the second finds the state as registered.

const state = { failAfter: Infinity };
resetEachTest(() => {
  state.failAfter = Infinity;
});

describe('a shared helper’s state', () => {
  test('a test leaves it set', () => {
    state.failAfter = 3;
    expect(state.failAfter).toBe(3);
  });

  test('the next test finds it set back', () => {
    expect(state.failAfter).toBe(Infinity);
  });
});
