# Architecture

How Nya stores, protects and reconstructs your data. Operational procedures are in [operations.md](operations.md).

- [Storage and encryption](#storage-and-encryption)
  - [Storage seam](#storage-seam)
- [Caching](#caching)
- [Net-worth history](#net-worth-history)
- [Containers](#containers)
- [On-device snapshot and offline use](#on-device-snapshot-and-offline-use)
- [Security headers and the public pages](#security-headers-and-the-public-pages)
- [Tests](#tests)

## Storage and encryption

Everything is stored in Upstash Redis, in a key namespace per environment (`production:`, `preview:`, `dev:`; see `lib/storage.ts`). The values that hold financial data are encrypted (AES-256-GCM, `lib/crypto.ts`) before they are written: Plaid access tokens, balances, history, transactions, budgets, goals, category changes and renames, manual accounts and the caches. The structure around them is not: key and field names, and the few stores that hold no amounts (`classify()` in `lib/reencrypt.ts` lists every store and how it is kept). So a leak of the database or of a backup alone exposes no balances, transactions or access tokens, but it does expose dates and times, account, transaction and connection ids, the names of your linked banks, the merchant names you have renamed, and for sharing, the names people gave each other and which accounts each shares at which level (the same list as [operations.md](operations.md#taking-a-backup-by-hand)).

Encryption is layered. Data is encrypted with **data keys** that the app generates and keeps in Redis, each locked with one **master key** (`MASTER_KEY`, which lives only in your environment variables). `PLAID_ENCRYPTION_KEY` is the original key, `k0`, used for everything written before data keys existed and as a fallback if a data key is ever unavailable. Rotating the master key re-locks only the data keys, never the data. See [operations.md](operations.md#encryption-keys) for turning it on, moving old data across, and rotating.

The protection is against someone who obtains the database or a backup without the keys. It does not protect against someone with access to the Vercel environment, which holds both the master key and the database credentials.

Logs leave out what a request carried. A failed Plaid call throws an error that holds the request it was making (the Plaid secret in its headers, an access token in its body), and printing it copies both into the deployment's logs. The Plaid client is built so its errors never carry the request (`lib/plaid-scrub.ts`): the endpoint, the method and Plaid's answer stay, the headers, body and raw request go. Routes also log errors through `loggable()` (`lib/log-safe.ts`), which keeps the endpoint, Plaid's error code, reason and request id, the status and the stack, for anything that reaches a log some other way. Logs written before this change may hold the Plaid secret and access tokens: see [operations.md](operations.md).

Each institution's stored transaction and investment history is one compressed, encrypted blob, refused (never trimmed) past a size ceiling (`MAX_TXN_BLOB_CHARS`, 8,388,608 characters by default). Trimming would drop the oldest rows, which are exactly the ones no bank will serve again. `GET /api/storage-usage` measures every institution's stored transaction and investment blob, per institution and in total, with the ceiling, the container they belong to, blobs left behind by a disconnected institution, and the size a blocked institution was refused at. A refusal's log line names the container too. Nothing enforces a quota yet; these are the numbers one would read (`lib/blob-sizes.ts`). The transactions entered on manual accounts (one compressed book per account, under the same ceiling, `lib/manual-txns.ts`) are not measured there yet.

### Storage seam

New stores are built on the storage seam, `lib/repo.ts`, never on the Redis client. A store gets a few named operations instead of raw key access, so the code that uses it does not depend on Redis, and a Postgres or SQLite backend (which self-hosting would need) can later replace Redis one store at a time. It is Phase 1 of the Postgres migration plan, and changes nothing about how existing data is stored.

The seam keeps data inside containers only, by design: every store's data lives in the person's container and is deleted with it. There is no environment-wide store. A lookup that has to work before the container is known carries the container's opaque id itself (an API token will), so its record can live inside the container too.

A store is declared once, in a module under `lib/`, with:

- a **name**, its key family: each container's data is at `<prefix>:c:<container id>:<name>`. A name already claimed by a key family stored the old way, an environment-wide store or a backup exclusion is refused;
- **`what`**, a plural noun for messages ("Your saved rules could not be read");
- **`isValid`**, the current shape, checked on every read and before every write;
- **`exportable`**: whether its content will belong in the person's own data download;
- optionally **`upgrade`**, which turns what an earlier version stored into the current shape, and **`compress`**, which stores each value gzipped, for values that can grow large.

There are two shapes for data. `defineValueStore` holds one encrypted JSON value per container, replaced whole on every save, like goals and budgets (`get`, `set`, `remove`). `defineMapStore` holds one encrypted JSON value per id in a Redis hash, like manual accounts (`get`, `getMany`, `getAll`, `getAllReport`, `getAllLenient`, `set`, `setMany`, `update`, `updateMany`, `remove`, `count`, `has`).

A third shape is for the service's own bookkeeping: `defineCounterStore` keeps a count per container in a fixed window that starts with its first count and ends on its own, for a rate limit such as the five downloads of your data an hour (`download-count` in `lib/rate-limit.ts`). `take` counts one and `read` reports the window, each one Lua script, so counts racing each other are each counted once and a count is never left without its expiry. A counter is a plain integer, never encrypted and never exported; a stored count that is not one fails as unreadable, so a limit built on it stays shut instead of opening.

Writes to different ids of a map store never touch each other. Writes to the same id, like saves of a value store, are last-write-wins: reading an entry and then saving it loses a change saved in between. When something else can change the same entry at the same time (a webhook, a rule, a second device), use `update(ctx, id, fn)`. It reads the entry, computes the new value with `fn`, and writes only if the entry has not changed meanwhile (a compare-and-set in Lua); if it has, it waits a moment and runs `fn` again on what is there now, up to five times, then gives up with `UpdateConflictError`. It compares by SHA-1, so a large value is not sent back with its replacement. For a change that must land on several entries together or not at all (moving a manual transaction from one account's book to another's), `updateMany(ctx, ids, fn)` does the same for up to 16 entries at once: one Lua script compares every entry read and writes all of them or none, so no reader ever sees part of the change. A value store is for data one person edits at a time.

```ts
// lib/rules.ts
export const rulesStore = defineMapStore<Rule>('rules', {
  what: 'rules',
  isValid: isRule,
  exportable: true,
});

// lib/stores.ts
import './rules';
```

The rules for a new store:

- **Use the seam.** New code never imports `redis()`, `rawRedis()` or `@upstash/redis`, nor the raw-key helpers of `lib/stored-json.ts`, and never adds a key family to `lib/key-families.ts` or builds a new key by hand, even under a prefix or template the code already uses. If the seam lacks an operation, add a named, tested method to `lib/repo.ts` (with its Lua script, if it must be atomic), never a way to reach an arbitrary key. `test/storage-boundary.test.ts` enforces this. Its LEGACY list names the files that reached Redis before the seam; that list, the old key families and the key names the code builds (each with the files that build it) only ever shrink.
- **Declare the store, and import its module in `lib/stores.ts`.** That catalogue is how everything that walks every store sees all of them: the key inventory (`classify()` in `lib/reencrypt.ts`, which the re-encryption pass relies on) and the person's data download (`lib/user-export.ts`), where each store declared `exportable` is a section of its own, read strictly. A declared store is in the key inventory by construction, with no list to update. `test/repo.test.ts` fails if a declaring module is missing from the catalogue or two stores share a name. The catalogue lists only stores built on the seam; the download reads the older stores itself until they move.
- **Label strictness.** Reads are strict. Never saved reads as empty. A value the seam cannot use is one of two kinds. **Unreadable**: its bytes are damaged (not ciphertext, or ciphertext that fails to authenticate under a data key). **Unrecognised**: as far as this code can tell it is intact, but it does not understand it: not JSON, a shape `isValid` rejects even after `upgrade`, or a format a later version may write (another version tag or flag, or a value bound to a context), so a rollback never offers such values for removal. Strict reads throw `StoredDataUnreadableError` for either: `UnreadableEntriesError` for a map store, naming the ids of each kind, and `UnreadableValueError` for a value store. **Only unreadable entries may ever be offered for removal**, and only once the person confirms: an unrecognised one is intact data and a bug to fix with `upgrade`. A deployment that cannot read the data (no `MASTER_KEY`, the wrong one, a key missing from the key store, a failed decrypt under `k0`, decompression failing, Redis unreachable) throws that error as it is, never reported as either kind or read as empty. A failed decrypt under `k0` is always treated so: `PLAID_ENCRYPTION_KEY` does not commit to its key, so after it is replaced every older value fails exactly as damage would, even beside newer values that read fine. `getAllReport` returns the readable entries, the unreadable ids and the unrecognised ids, so a route can show what it read, offer to remove the unreadable, and report the rest. `getAllLenient` is the one lenient read: it leaves out what it cannot use, and is only for conveniences that nothing writes, deletes or records on; say so where it is called. A value store refuses to save over a value it cannot read, and a map store has no "replace everything".
- **Answer its errors.** In a route, as `app/api/budgets/route.ts` does: `ContainerError` with `containerUnavailable()` (503); `StoredDataUnreadableError` with 409 and `{ error: err.message, unreadable: true }`, plus the id lists of an `UnreadableEntriesError`; `StoreRefusedError` (`UpdateConflictError`, `StoredValueTooLargeError`) with its `status` (409, 413) and the message; anything else with a plain 500.
- **Keep every stored shape readable.** Values are rewritten only when saved, and a restored backup brings old ones back, so `isValid` must accept every shape a deployed version wrote, after `upgrade`. Add a field as optional, or give the store an `upgrade` that fills it in. `upgrade` sees every stored value, current ones too, returns the current shape, leaves what it does not recognise for `isValid` to reject, and never throws. Writes always store the current shape.
- **Use opaque ids.** A map store's ids are Redis field names, stored and backed up in plaintext. Use random ids, a provider's own ids, or a hash of a random secret such as an API token. Never content (names, merchants, dates, amounts), and never a plain hash of content, which anyone with a copy of the database can reverse by hashing guesses. An id that must be derived from content needs a keyed HMAC whose key is not in the database. The seam accepts only letters, digits and `_.:-`.
- **Decide `exportable`.** True for what the person entered or what describes their money; false for secrets (token hashes, connector credentials) and the service's own bookkeeping. An exportable store is in the person's data download with nothing else to do: a section named after the store, holding its value (a value store) or its entries as `{ id, value }` (a map store). A name a part of that file already uses (`notes`, `accounts`) would fail every download, and `test/user-export.test.ts` fails first.

Every write is checked against the request-size ceiling of `lib/blob.ts` (`MAX_TXN_BLOB_CHARS`) and refused whole and loudly, with `StoredValueTooLargeError` (413): nothing is ever trimmed to fit. `compress` keeps large values well under it, and can be switched on or off later, since reads take either form.

Seam values are encrypted like everything else, but not bound to a crypto context (the `c` flag in `lib/crypto.ts`). The re-encryption pass cannot move a bound value, so it could never report complete, and retiring a leaked key depends on that. The header of `lib/repo.ts` says what binding would take later.

The existing stores still call Redis directly and move behind the seam one at a time. As each moves, it comes off the LEGACY list and out of `lib/key-families.ts`, and is given its Postgres destination. The seam's contract tests run the same assertions against the test double and, where `redis-server` is installed, against a real Redis.

## Caching

Balance and transaction responses are cached in Redis, encrypted with the same keys (`lib/cache.ts`), so the dashboard doesn't wait on live Plaid calls every load. The cache lasts 15 minutes; with Plaid webhooks configured it lasts up to six hours and is dropped the moment Plaid reports new data. The Refresh button bypasses it. The transactions cache holds only what came from Plaid (with categories, renames and exclusions carried across a re-link applied): transactions entered by hand and what the person said about each transaction are read on every request and merged after it, so entering, editing or excluding a transaction never drops the cache or waits on Plaid, and a record that can't be read is marked on its row rather than stopping the cache.

## Net-worth history

The daily net-worth series behind the Home chart (`lib/history.ts`) is stored the same way, encrypted and keyed by UTC date. It has two layers, and real points always win over estimated ones for the same date.

**Real snapshots** are recorded on every clean live fetch, plus daily by a Vercel Cron (`vercel.json`, `/api/snapshot`, authenticated with `CRON_SECRET`), so the chart stays gapless even on days you don't open the app. Per-account balances are snapshotted alongside the total, which feeds the tap-to-expand account charts.

- The cron runs each active container on its own (`lib/snapshot-job.ts`) and answers 200 with one result per container, even when some failed. It answers 500 when nothing was snapshotted: the container registry cannot be read (after one retry), holds no container, or no container was recorded (every one failed, came back unclean, was deferred, or is not active). Nothing linked is not a failure.
- A second entry two hours later (`/api/snapshot/catchup`) is the catch-up: containers already recorded that day are skipped, and the rest (failed, unclean, not started in time, or with nothing linked) are run again.
- Each container's outcomes are kept per date and served, newest first, by `GET /api/snapshot-runs`. They describe this environment's cron, so exports leave them out and a restore keeps them.
- No snapshot is recorded on a day when any institution failed or an account is unconfirmed missing. Accounts that did answer are still recorded to a separate per-account layer so their own charts stay real.

**Estimated backfill** reconstructs up to a year of history on first use (and after linking a new institution) from transaction data (`/api/backfill`), at three levels of fidelity:

- cash and credit accounts are walked backward from today's balances, un-applying each day's transactions;
- investment accounts have their external flows (deposits, withdrawals, dividends, fees) un-applied the same way, but market movement isn't a transaction and can't be recovered, so price changes within the window are not modelled;
- loans and manual accounts are held flat, since amortization isn't in the transaction stream and a typed balance has no stream at all (transactions entered by hand on a manual account need not add up to its balance, so they are never walked).

The chart draws the whole estimated region dashed and labels it estimated. Some details:

- An institution whose investments product isn't available falls back to flat for those accounts without affecting the rest of the run. One whose data is merely still being extracted also falls back, but the run isn't recorded as complete, so the next load rebuilds it once the flows have arrived rather than freezing the gap in place.
- An investment account whose flows out-run its balance (a $60k rollover into an account worth less than that today) is floored at zero from that day backward rather than dropped, so a large arrival reads as the step it was.
- Because a brokerage often reports further back than a bank, an investment account's own series is walked past the oldest cash transaction even though the net-worth total stops there.
- New links request 730 days of transactions; older Items may only have about 90 days until relinked.
- Hidden accounts are subtracted when the history is read, not when it is written, which is why hiding is retroactive and unhiding is exact. See [features.md](features.md#hiding-accounts).

## Containers

Every record belongs to a container, stored under `<prefix>:c:<container id>:`. A container is the unit of one person's data: with Clerk each account owns its own, and with the shared password the deployment uses a single one. Every function that reads or writes stored data takes the container, so a key cannot be built for a container nobody resolved. See [operations.md](operations.md#containers) and [authentication.md](authentication.md).

## On-device snapshot and offline use

The dashboard keeps its last-known snapshot in the browser's `localStorage` so the PWA opens instantly and still shows balances offline. The service worker never caches `/api/*` responses, so refreshing, linking, transactions and the Plan tab's saved assumptions need a network connection. The Plan tab's code is fetched the first time the tab opens (the service worker keeps a copy once it has been fetched); if that fails, the tab says it couldn't be loaded and offers to try again, and the other tabs work as before (`components/PlanTabLoader.tsx`). The snapshot is readable on the device without the app password; see [authentication.md](authentication.md#what-is-not-covered).

## Security headers and the public pages

The headers that are the same on every response (HSTS, nosniff, the referrer policy, the permissions policy, `X-Frame-Options` and the opener policy) are set in `next.config.js`, so they also reach static files and the routes the proxy skips. Each page's Content-Security-Policy is built per request in `proxy.ts` (`lib/security-headers.ts`) with a fresh nonce, which Next.js puts on its scripts and Clerk on its own (`ClerkProvider`'s `dynamic`, `app/layout.tsx`); `CSP_MODE` sends it report-only (the default), enforced, or not at all. It is the only Content-Security-Policy: a browser enforces every one it is sent, and how Vercel combines a `next.config.js` header with a proxy header of the same name is not documented. The app writes no inline script of its own: the service worker registers from a client component. How to check the policy against a live Plaid Link and Clerk session and then enforce it is in [deployment.md](deployment.md#security-headers-and-the-content-security-policy).

`/security` and `/privacy` say in plain language how the data is protected, who can read what, and how long things are kept. They are readable without signing in (`PUBLIC_PAGES` in `proxy.ts`, which still runs on them, for the policy), read no stored data (from the environment, only `CSP_MODE`, whether a usable `MASTER_KEY` is set, which decides whether `/security` describes envelope encryption or the single key, and how backups are kept: `backupRetention()` in `lib/backup.ts`, the rule the deletion receipt dates by, so the pages and a receipt give the same number of days), and are held by `test/public-pages.test.tsx` to the code's figures and to a list of claims they must never make (that nobody but you can read the data, that it is encrypted end to end, that deletion is instant and complete).

## Tests

`bun test` runs quickly with no Redis, Plaid keys or network: storage and the Plaid client are faked. The suite concentrates on the logic where a silent wrong answer is worst: the net-worth history layers and hidden-account subtraction, the backward balance walk, Plaid's investment sign conventions and pagination, liability normalization, the credit/loan sign rule every total depends on, last-known-balance recovery, idle-cash detection, the payoff plan's arithmetic (checked against the closed-form amortization formula, and reconciled to the cent), encryption and key rotation, backup and restore, sharing, the session and proxy gates, the security headers and Content-Security-Policy, and the planning engine (property tests, and golden tests that check its results are consistent with the figures published withdrawal-rate studies report; see [features.md](features.md#how-it-is-checked)). Some React components and routes are covered as well. Anything talking to live Plaid is not. The storage seam's contract runs against both the test double and a real Redis (where `redis-server` is installed), and an import-boundary test keeps new code off the Redis client.
