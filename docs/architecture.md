# Architecture

How Nya stores, protects and reconstructs your data. Operational procedures are in [operations.md](operations.md).

- [Storage and encryption](#storage-and-encryption)
  - [Storage seam](#storage-seam)
- [Caching](#caching)
- [Net-worth history](#net-worth-history)
- [Containers](#containers)
- [On-device snapshot and offline use](#on-device-snapshot-and-offline-use)
- [Tests](#tests)

## Storage and encryption

Everything is stored in Upstash Redis, in a key namespace per environment (`production:`, `preview:`, `dev:`; see `lib/storage.ts`). Plaid access tokens, balances, history and transactions are all encrypted (AES-256-GCM, `lib/crypto.ts`) before they are written, so a leak of the database or of a backup alone exposes none of it.

Encryption is layered. Data is encrypted with **data keys** that the app generates and keeps in Redis, each locked with one **master key** (`MASTER_KEY`, which lives only in your environment variables). `PLAID_ENCRYPTION_KEY` is the original key, `k0`, used for everything written before data keys existed and as a fallback if a data key is ever unavailable. Rotating the master key re-locks only the data keys, never the data. See [operations.md](operations.md#encryption-keys) for turning it on, moving old data across, and rotating.

The protection is against someone who obtains the database or a backup without the keys. It does not protect against someone with access to the Vercel environment, which holds both the master key and the database credentials.

Each institution's stored transaction and investment history is one compressed, encrypted blob, refused (never trimmed) past a size ceiling (`MAX_TXN_BLOB_CHARS`, 8,388,608 characters by default). Trimming would drop the oldest rows, which are exactly the ones no bank will serve again. `GET /api/storage-usage` measures every stored blob, per institution and in total, with the ceiling, the container they belong to, blobs left behind by a disconnected institution, and the size a blocked institution was refused at. A refusal's log line names the container too. Nothing enforces a quota yet; these are the numbers one would read (`lib/blob-sizes.ts`).

### Storage seam

New stores are built on the storage seam, `lib/repo.ts`, never on the Redis client. A store gets a few named operations instead of raw key access, so the code that uses it does not depend on Redis, and a Postgres or SQLite backend (which self-hosting would need) can later replace Redis one store at a time. It is Phase 1 of the Postgres migration plan, and changes nothing about how existing data is stored.

A store is declared once, in a module under `lib/`, with:

- a **name**, its key family: each container's data is at `<prefix>:c:<container id>:<name>`;
- **`what`**, a plural noun for messages ("Your saved rules could not be read");
- **`isValid`**, the shape check run on every read and before every write;
- **`exportable`**: whether its content belongs in the person's own data download.

There are two shapes. `defineValueStore` holds one encrypted JSON value per container, replaced whole on every save, like goals and budgets (`get`, `set`, `remove`). `defineMapStore` holds one encrypted JSON value per id in a Redis hash, each entry written on its own so two writers never clobber each other, like manual accounts (`get`, `getAll`, `getAllLenient`, `set`, `setMany`, `remove`, `count`, `has`). A value store suits data one person edits at a time; anything a webhook, a script or a second device can change at the same time belongs in a map store.

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

- **Use the seam.** New code never imports `redis()`, `rawRedis()` or `@upstash/redis`, nor the raw-key helpers of `lib/stored-json.ts`. If the seam lacks an operation, add a named, tested method to `lib/repo.ts` (with its Lua script, if it must be atomic), never a way to reach an arbitrary key. `test/storage-boundary.test.ts` enforces this. Its LEGACY list names the files that reached Redis before the seam, and it only ever shrinks.
- **Declare the store, and import its module in `lib/stores.ts`.** That catalogue is how everything that walks every store sees all of them: the key inventory (`classify()` in `lib/reencrypt.ts`, which the re-encryption pass relies on) and a person's data download. A declared store is in the key inventory by construction, with no list to update. `test/repo.test.ts` fails if a declaring module is missing from the catalogue or two stores share a name.
- **Label strictness.** Reads are strict: never saved reads as empty, a value that cannot be decrypted, parsed or shape-checked throws `StoredDataUnreadableError`, and a storage failure throws as it is, so a failure never looks like "nothing saved". `getAllLenient` is the one lenient read. It leaves out entries it cannot read (a storage failure still throws) and is only for conveniences that nothing writes, deletes or records on; say so where it is called. A value store refuses to save over a value it cannot read, and a map store has no "replace everything".
- **Use opaque ids.** A map store's ids are Redis field names, stored and backed up in plaintext. Use random ids, hashes or a provider's own ids, never names, merchants, dates or amounts. The seam accepts only letters, digits and `_.:-`.
- **Decide `exportable`.** True for what the person entered or what describes their money; false for secrets (token hashes, connector credentials) and the service's own bookkeeping.

Seam values are encrypted like everything else, but not bound to a crypto context (the `c` flag in `lib/crypto.ts`). The re-encryption pass cannot move a bound value, so it could never finish, and binding stops no swap while values written under `k0` cannot carry a context. The header of `lib/repo.ts` says what binding would take later.

The existing stores still call Redis directly and move behind the seam one at a time, each coming off the LEGACY list as it does. The seam's contract tests run the same assertions against the test double and, where `redis-server` is installed, against a real Redis.

## Caching

Balance and transaction responses are cached in Redis, encrypted with the same keys (`lib/cache.ts`), so the dashboard doesn't wait on live Plaid calls every load. The cache lasts 15 minutes; with Plaid webhooks configured it lasts up to six hours and is dropped the moment Plaid reports new data. The Refresh button bypasses it.

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
- loans and manual accounts are held flat, since amortization isn't in the transaction stream and a typed balance has no stream at all.

The chart draws the whole estimated region dashed and labels it estimated. Some details:

- An institution whose investments product isn't available falls back to flat for those accounts without affecting the rest of the run. One whose data is merely still being extracted also falls back, but the run isn't recorded as complete, so the next load rebuilds it once the flows have arrived rather than freezing the gap in place.
- An investment account whose flows out-run its balance (a $60k rollover into an account worth less than that today) is floored at zero from that day backward rather than dropped, so a large arrival reads as the step it was.
- Because a brokerage often reports further back than a bank, an investment account's own series is walked past the oldest cash transaction even though the net-worth total stops there.
- New links request 730 days of transactions; older Items may only have about 90 days until relinked.
- Hidden accounts are subtracted when the history is read, not when it is written, which is why hiding is retroactive and unhiding is exact. See [features.md](features.md#hiding-accounts).

## Containers

Every record belongs to a container, stored under `<prefix>:c:<container id>:`. A container is the unit of one person's data: with Clerk each account owns its own, and with the shared password the deployment uses a single one. Every function that reads or writes stored data takes the container, so a key cannot be built for a container nobody resolved. See [operations.md](operations.md#containers) and [authentication.md](authentication.md).

## On-device snapshot and offline use

The dashboard keeps its last-known snapshot in the browser's `localStorage` so the PWA opens instantly and still shows balances offline. The service worker never caches `/api/*` responses, so refreshing, linking and transactions need a network connection. The snapshot is readable on the device without the app password; see [authentication.md](authentication.md#what-is-not-covered).

## Tests

`bun test` runs quickly with no Redis, Plaid keys or network: storage and the Plaid client are faked. The suite concentrates on the logic where a silent wrong answer is worst: the net-worth history layers and hidden-account subtraction, the backward balance walk, Plaid's investment sign conventions and pagination, liability normalization, the credit/loan sign rule every total depends on, last-known-balance recovery, idle-cash detection, encryption and key rotation, backup and restore, sharing, and the session and proxy gates. Some React components and routes are covered as well. Anything talking to live Plaid is not. The storage seam's contract runs against both the test double and a real Redis (where `redis-server` is installed), and an import-boundary test keeps new code off the Redis client.
