// lib/background.ts
//
// Work a route starts and doesn't wait for: the email that says a download
// happened, or an API token was made (lib/download-notice.ts). The answer
// never waits on it, and it can never fail the answer: it is given a catch of
// its own before anything else sees it.
//
// ON THE PLATFORM, Next's after() is handed the promise, which keeps the
// function alive until it settles (on Vercel, through waitUntil), so a
// download that finishes first doesn't end the email with it. The work
// starts at once, not after the response, so a slow download over a slow
// connection doesn't hold the email back, nor a time limit end it unsent.
// OUTSIDE A REQUEST (tests, scripts), after() has nothing to attach to: the
// work runs on its own, and backgroundSettled() lets a test wait for it.

import { after } from 'next/server';

const running = new Set<Promise<void>>();

/** Starts nothing: `task` has already started. Keeps it from failing anything
 *  else, and the platform from ending before it settles. */
export function background(task: Promise<unknown>): void {
  const settled = task.then(
    () => {},
    () => {}
  );
  running.add(settled);
  void settled.finally(() => running.delete(settled));
  try {
    after(settled);
  } catch {
    // Outside a request: it runs on its own (see the header).
  }
}

/** For tests: resolves once every task started so far has settled. */
export async function backgroundSettled(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}
