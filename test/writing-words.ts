// What a page or a view says only where this copy lets API tokens write
// (API_WRITES_ENABLED): the words of writing, for the tests that hold every
// page and the API tokens card to saying none of them while it is off
// (test/public-pages.test.tsx, test/developers.test.tsx,
// test/api-tokens-view.test.tsx). Wording added for writing that is drawn
// whatever the switch says would carry one of these, and fail them.

export const WRITING_WORDS: readonly RegExp[] = [
  /make changes/i,
  /made to make/i,
  /makes? changes to/i,
  /update (manual accounts’ )?balances/i,
  /updates balances/i,
  /change some of it/i,
  /can also add/i,
  /\badd, change and delete\b/i,
  /delete the transactions/i,
  // Undo of a change (the restore's own Undo is another thing).
  /most can be undone/i,
  /undone or forgotten/i,
  /undo its own/i,
  /\bundo(es)? (a|one|the|this) change/i,
  /undo_change/i,
  // Forgetting a change (Earlier accounts' Forget is another thing).
  /forget(ting)? (a change|every change|what it changed|one or all)/i,
  /record of changes/i,
  /changes made with/i,
  /if-match/i,
  /idempotency/i,
  /idempotent-replayed/i,
  /write-ratelimit/i,
  /write-day/i,
  /version_(mismatch|required)/i,
  /writes_off/i,
  /insufficient_scope/i,
  /saying what it can do/i,
  /what it can do/i,
  /balances or write/i,
  /\bwrite tools?\b/i,
];

/** The words of writing a text holds: none, while writing is off. */
export const writingIn = (text: string): string[] => WRITING_WORDS.filter((w) => w.test(text)).map(String);
