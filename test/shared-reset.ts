// test/shared-reset.ts
//
// How a shared test helper sets its own state back before each test of every
// file (test/preload.ts runs them): its module is loaded once for the whole
// run, so without this what one file leaves in it would reach the files after
// it. Kept on the global object, so the preload and every helper see one list
// however each imports this file.

const KEY = Symbol.for('nya.test.shared-resets');
type Registry = { [KEY]?: (() => void)[] };

const resets = (): (() => void)[] => ((globalThis as Registry)[KEY] ??= []);

/** Registers `fn`, run before each test of every file from now on. */
export function resetEachTest(fn: () => void): void {
  resets().push(fn);
}

/** Runs every reset registered (test/preload.ts). */
export function runSharedResets(): void {
  for (const fn of resets()) fn();
}
