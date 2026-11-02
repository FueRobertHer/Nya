// lib/flag-cache.ts
//
// The state behind lib/flag-read.ts's cached reads, and nothing else: no
// imports, so test/preload.ts can forget it before and after every test
// without loading storage (every test file runs in one process, so a value
// one file cached would otherwise answer the next file's reads).
//
// Each slot is one thing read and kept in this server instance's memory: the
// stored flags, and the deployment's owners. `forget` moves the generation on,
// so a read that started before it never lands after it.

export type Slot = {
  /** The last value read, or undefined when none has been read yet. */
  value: unknown;
  /** Whether the last attempt read it. */
  ok: boolean;
  /** When the last attempt started (ms), 0 before any. */
  triedAt: number;
  /** The read under way, shared by every caller meanwhile. */
  inFlight: Promise<void> | null;
};

const empty = (): Slot => ({ value: undefined, ok: false, triedAt: 0, inFlight: null });

export const flagCache = {
  generation: 0,
  flags: empty(),
  owners: empty(),
  /** Forgets everything read, here (a write in this instance, and tests). */
  forget(): void {
    this.generation += 1;
    this.flags = empty();
    this.owners = empty();
  },
};
