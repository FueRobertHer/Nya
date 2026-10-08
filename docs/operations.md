# Operations

Runbooks for keeping the data safe: backups and restores, encryption keys, and containers. For setup see [deployment.md](deployment.md); for how the data is stored see [architecture.md](architecture.md).

Everything under `/api/ops/*` is locked the same way (`lib/ops.ts`): it answers 404 unless `OPS_ENABLED=1`, accepts POST only, and compares `OPS_SECRET` in constant time. Set `OPS_ENABLED=1` only while you run an operation, then remove it and redeploy, so a leaked `OPS_SECRET` is useless on its own.

- [Backups](#backups)
- [Restoring a backup](#restoring-a-backup)
- [Encryption keys](#encryption-keys)
- [Plaid secrets in older logs](#plaid-secrets-in-older-logs)
- [Containers](#containers)
- [Moving the data into containers](#moving-the-data-into-containers)

## Backups

Some of what Nya stores exists nowhere else: banks stop serving old transactions after a while, and no bank serves daily balance history at all. A copy is taken every night; take one by hand before any risky change too.

These are the operator's copies of the whole environment, for recovery, with every value kept as stored: what is encrypted in the database stays encrypted, and what is plain text there (dates, ids, bank names, renamed merchant names; see below) is plain text in the copy. A person's own copy of their data, decrypted, is a different thing they download themselves: see [data-export.md](data-export.md).

### Nightly backups

Every night at 16:00 UTC (after the daily snapshot and its catch-up), a cron (`/api/backup`) takes the same archive as the manual export below and saves it to Vercel Blob under `backups/<environment>/`. It reads each copy back to check it before anything old is deleted. Copies older than 30 days are deleted, but the newest 7 are always kept.

To turn it on:

1. In Vercel, create a Blob store with **private** access (Storage, Create, Blob) and connect it to the project. That sets `BLOB_READ_WRITE_TOKEN`. It must be private: the archive is financial data.
2. `CRON_SECRET` must be set (the snapshot cron needs it too).
3. Optionally set `BACKUP_KEEP_DAYS` to keep more or fewer days (a whole number, 1 or more).
4. Redeploy. Crons run only on the production deployment.

Check it worked the next day: the cron's log in Vercel says "Backup written", and the file is in the store's browser. Before that line, it logs how long each step took (export, upload, read-back, list, prune). A failed night shows as a failed cron run with the reason, and the older copies are left alone. Each step has a time limit, so a storage call that doesn't finish in time fails the run naming that step (for example "The backup's read-back step took longer than 45s") instead of running into Vercel's 300-second limit with no reason given. "Took longer" can mean the call never answered or that Vercel Blob kept retrying it (it retries server and network errors up to 10 times); to tell which, set `DEBUG=blob` on Production for a night, and the log shows each retry. A copy whose upload or read-back ran out of time may still be in the store, unchecked. Vercel doesn't send an alert for it, so the dashboard shows a note when the last backup failed or none has been saved for two days.

To restore from one, download it from the store's browser in Vercel and follow [Restoring a backup](#restoring-a-backup).

The copies live in Vercel, like the database. They protect against losing or damaging the data, not against losing the Vercel account: download one now and then and keep it somewhere else too.

### Taking a backup by hand

1. In Vercel, set `OPS_SECRET` and `OPS_ENABLED=1` on the environment you want to back up, then redeploy.
2. Download it:

   ```bash
   curl -X POST https://your-app.vercel.app/api/ops/export -H "Authorization: Bearer $OPS_SECRET" -o nya-export.ndjson
   ```

3. Check the last line of the file is a footer (`{"end":true,...}`). If it is missing, the download was cut short; take it again.
4. Remove `OPS_ENABLED` and redeploy. While it is unset the route answers 404.

Balances, transactions, budgets, goals and access tokens stay **encrypted** in the archive and cannot be read without `PLAID_ENCRYPTION_KEY` (and, once data keys are in use, `MASTER_KEY`; the data keys themselves are in the archive, encrypted with it). Keep a copy of those keys somewhere separate from both the archive and Vercel (a password manager, or on paper). Lose them and the backup cannot be read.

Not everything in it is encrypted, so still treat the file as private: dates, account and transaction ids, the names of your linked banks, and the merchant names you have renamed are stored as plain text.

The last line also carries a checksum, so a file damaged in storage or transit is caught before it is restored. It is not a signature: it will not stop someone who edits the file on purpose.

Caches and the login's rate-limit counters are left out on purpose. Each account's count of data downloads is a store on the storage seam, so it is kept like the rest, with its expiry. Avoid running it around 13:00 UTC, when the daily snapshot writes.

## Restoring a backup

Restore runs on your own machine, not as a web route: a real backup can be bigger than Vercel lets a request upload, and it keeps anything on the internet from being able to overwrite your data.

1. `vercel env pull .env.local` so the command has the Upstash credentials. Every environment shares one database, so these credentials can reach production too. What decides where the restore writes is the prefix.
2. Try it on a scratch namespace first, and check the file without writing:

   ```bash
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --target restore-test --dry-run
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --target restore-test
   ```

   To look at the result, point a preview deployment at it by setting `REDIS_PREFIX=restore-test` on that preview.

The command refuses, and writes nothing, when:

- the file is incomplete, damaged, or from a different key layout;
- `--target` does not match `REDIS_PREFIX` (both are required, so a leftover shell variable cannot aim it somewhere you did not mean);
- the target already holds data and `--overwrite` is not given;
- the target is `production` and `--confirm-production` is not given;
- it would replace data with an archive holding no keys (`--allow-empty` overrides), or with one taken from a different environment (`--allow-different-source` overrides). Restoring into an **empty** target from anywhere, like production into `restore-test`, needs neither;
- the target has containers (see [Containers](#containers)) and the archive's are not the same, for example an archive from before containers existed: restoring it would leave `CONTAINER_ID` naming a container that no longer exists. `--replace-registry` overrides; afterwards set `CONTAINER_ID` again (or create a container, if the archive has none). A dry run reports this too.

With `--overwrite`, it prints how many keys it is about to replace, saves the target's current contents to a `nya-pre-restore-<target>-<time>.ndjson` file, and checks that file holds every key it is about to delete. Then it **replaces** the target entirely (login rate-limit counters aside), so nothing newer than the archive survives. If the target changes while this is going on, it stops before deleting anything. It finishes by reading everything back and comparing it with the archive, and reports success only if they match exactly. If a restore stops part way, run it again with `--overwrite`.

File paths are resolved from the repo root, since `bun run` runs there, and that is also where the pre-restore file is written.

Don't use the app while a restore is running, and avoid 13:00 UTC: anything written to the target mid-restore makes the final comparison fail. If a deployment serves the target (restoring over production, say), **redeploy it right after** the restore: a running instance remembers the data key it writes with for up to a minute, and if the restore replaced that key, anything it writes meanwhile can never be read.

`.ndjson` files are git-ignored so a backup is never committed by accident.

## Encryption keys

Data is encrypted with **data keys** that the app generates and stores in Redis, each locked with one **master key**, `MASTER_KEY` (envelope encryption, `lib/crypto.ts`). `PLAID_ENCRYPTION_KEY` is the original key, `k0`: everything written before data keys existed is under it.

**Keep `MASTER_KEY` in your password manager.** Without it, nothing encrypted with a data key can be read, from the database or from any backup. Keep `PLAID_ENCRYPTION_KEY` and `SESSION_SECRET` safe too: losing the encryption key makes values still under `k0` permanently undecryptable (you would have to reconnect every account), and losing or leaking the session secret would let someone forge a login cookie.

### Turning on the master key

Generate a master key (`openssl rand -base64 32`), save it in your password manager, and add it in Vercel as `MASTER_KEY` (Production, marked Sensitive). The next write creates the first data key, and from then on new data is written under it. Existing data stays under `k0` until the re-encryption pass below moves it.

- **Without `MASTER_KEY`** the app keeps writing under `k0`, exactly as before. If the data key can't be used for any reason, writes fall back to `k0` and the log says so ("Writing with the legacy key", repeated hourly while it lasts), so a problem with the master can never block a save.
- Only a deployment with the **current** master creates a data key, never while a master rotation is being prepared or is pending, and one at a time. An old deployment still running after a rotation writes under `k0` instead.
- **Never remove `PLAID_ENCRYPTION_KEY`** while any value still uses `k0`.
- **Status:** an empty POST to `/api/ops/rotate-master` (with `OPS_ENABLED=1`) reports `active_key`, the data key new writes use (`null` means still `k0`), `active_key_problem` if this deployment cannot use it, and `this_instance_fallback_since` if the instance that answered has been writing under `k0` instead.

### Moving existing data to the data key

Everything written before `MASTER_KEY` was set is still under `k0`. The re-encryption pass moves every value that is not under the active data key to it, safely while the app is running: a value is only written back if it has not changed since it was read, and readers see exactly the same data either way.

1. Take a backup first (see [Backups](#taking-a-backup-by-hand)). Don't run the pass while a restore is running.
2. With `OPS_ENABLED=1`, check what is left. This changes none of your data and creates no key (like any read, it can finish a master rotation that is already due):

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET"
   ```

   `to_move` counts values by the key they are under (`k0` is the old one). `active_key` is `null` until the first data key exists; the first run creates it.
3. Move them, repeating until it answers `"complete": true` (each call stops after about 40 seconds and carries on next time):

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' -d '{"run":true}'
   ```

4. Remove `OPS_ENABLED` and redeploy.

It never shows values, only key and field names, counts and reasons. What the fields mean:

- `unclassified`: a store the pass does not know about. Left alone; a bug to report.
- `unreadable`: a value it cannot move, left exactly as it was, with the reason: it cannot be decrypted, the key has an unexpected type, it is bound to a context, it is listed as plaintext but is encrypted, and so on.
- `changed_meanwhile`: saved by the app while being moved; picked up next call.
- `deleted_meanwhile`: deleted by the app while being moved; nothing to do.

If a call stops with "the active data key changed", something replaced the key store mid-pass (a restore, most likely): nothing was written under a key that no longer exists. Call it again once that is finished.

**Keep `PLAID_ENCRYPTION_KEY` in Vercel even after the pass completes.** It costs nothing, the app still falls back to it if the data key is ever unavailable, and if it is marked Sensitive in Vercel (so it cannot be read back out) and you have no other copy, removing it is permanent: any value still under `k0` then (an old backup, a fallback write) could never be read again.

### Rotating the master key

A rotation never touches your data, only the locks on the data keys, and never needs a second key in Vercel.

1. Generate a new key (`openssl rand -base64 32`) and save it in your password manager first.
2. Set `OPS_ENABLED=1` (and `OPS_SECRET`, as for a backup), redeploy, then send the new key to the running app, which still has the current one. Reading it with `read -rs` keeps it out of your shell history:

   ```bash
   read -rs NEW_KEY   # paste the new key, press Enter
   printf '{"new_master_key":"%s"}' "$NEW_KEY" | curl -sS -X POST \
     https://your-app.vercel.app/api/ops/rotate-master \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' --data-binary @-
   ```

   Every data key gets a second lock for the new key, checked before it is saved. **Only continue if this returns `"prepared"`.** If it returns an error, nothing was switched over; fix the cause and send it again.
3. Check the `new_master_fingerprint` it returns matches the key you saved:

   ```bash
   { printf 'nya master key fingerprint:'; printf '%s' "$NEW_KEY" | openssl base64 -d -A; } \
     | openssl dgst -sha256 -r | cut -c1-16
   ```

4. In Vercel, set `MASTER_KEY` to the new key, remove `OPS_ENABLED`, and redeploy.

That's all. Twenty-four hours later the app removes the old locks by itself; until then you can still roll back to the previous deployment. After that, the old key opens nothing in the database.

- **Checking progress:** POST an empty body to the same URL (with `OPS_ENABLED=1`). It answers `none`, `prepared` (the new key isn't deployed yet), or `grace` with the time the old locks go.
- **If something went wrong** (the new deployment can't read its data, you sent a key you didn't save, or you never did step 4): roll back or keep the current deployment, then send a new key. A new request replaces an unfinished one.
- **Preview** has its own key store (it is a separate database). If it shares the master key, rotate it separately, or scope `MASTER_KEY` to Production only.
- **Backups** taken before a rotation still need the old key.
- **What this does not do:** someone who already has a copy of the database or a backup *and* the old key can still read that copy, and the data keys in it don't change. After a real leak, the data keys need replacing too, which comes with the re-encryption pass.

## Plaid secrets in older logs

Until the Plaid client started stripping the request from its errors (`lib/plaid-scrub.ts`), a failed Plaid call could print that request into the deployment's logs: the `PLAID-SECRET` header and, for most calls, the Item's access token. It happened whenever a route logged the whole error, which the disconnect path did on every failed removal (an Item already revoked at Plaid fails that way) and the dashboard routes did on a timeout.

If logs from before that change still exist (Vercel's own runtime logs, or a log drain with longer retention):

- Rotate the Plaid secret: on the Plaid dashboard's Keys page, generate a new secret for the environment, set `PLAID_SECRET` to it in Vercel, redeploy, then delete the old one.
- An access token alone is of no use without the client id and the secret, so rotating the secret covers the tokens too. To also replace a token, Plaid's `/item/access_token/invalidate` returns a new one for an Item; Nya has no tool for it yet.
- Delete or shorten the retention of the old logs where you can.

## Containers

Every record belongs to a *container*, stored under `<prefix>:c:<container id>:`. The first one is created once, by you, never automatically (two requests racing to create one would split your data between two):

1. With `OPS_ENABLED=1`, create it:

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/containers -H "Authorization: Bearer $OPS_SECRET" \
     -H 'Content-Type: application/json' -d '{"create":true}'
   ```

   It answers with the new id. Asking again is refused.
2. In Vercel, set `CONTAINER_ID` to that id (Production) and redeploy.
3. Check: an empty POST to the same route lists the containers and should say `"container_id_status": "ok"`.
4. Remove `OPS_ENABLED` and redeploy.

Preview has its own container (a separate prefix, a separate registry): do the same there if you use preview.

Every request works in this deployment's container: the one `CONTAINER_ID` names, or with it unset, the only active one. (With Clerk on, it is the container the signed-in account owns instead; see [authentication.md](authentication.md).) Without a usable container (none, `CONTAINER_ID` wrong, the container being restored, or more than one active) data requests are refused with a 503 saying why; nothing is read or written anywhere else.

Logging in with the shared password needs a container to exist, so create it before deploying to a new environment. For local development, run the app with `OPS_ENABLED=1` and an `OPS_SECRET` once, create the container with the same `curl` against `http://localhost:3000`, and set `CONTAINER_ID` in `.env.local`.

## Moving the data into containers

This is a **one-time** migration for an environment that predates containers. A new install skips it. Data was stored under `<prefix>:<name>` and is now read from `<prefix>:c:<id>:<name>`. `bun run move-data` copies it across: byte for byte, leaving the old keys exactly as they were. It only copies a fixed list of keys (never caches, sessions or the container's own keys) and never copies a copy. It records what it copied, so a later run can tell which side changed since:

- only the old key: copied again. If it was deleted there, the container's copy is deleted too, but only with `--propagate-deletes`, and never more than five at once. More than that is refused and the keys are named: if they really should go (say an institution with several stored keys was disconnected), delete each one by hand in the Upstash console, `DEL <prefix>:c:<id>:<name>` and then `HDEL <prefix>:c:<id>:move:copied <name>`, and run again;
- only the container key: kept (the new release wrote or deleted it);
- both: a **conflict**. The run is refused, nothing written, and the report names the key.

Every write checks the container key still holds what the run expected, in one step with its record, so a write the new release makes during a run is never written over (the run stops instead). Without `--run` it only reports; any warning it prints means a run would be refused.

**Merging the release is the deploy**, so everything up to step 5 happens before merging.

1. Take an export (see [Backups](#taking-a-backup-by-hand)) and check it restores into `restore-test`, using a checkout of `main` from before this release (this release refuses archives from before containers). Rehearse steps 3 to 8 there with this release.
2. Pick a quiet time away from 13:00 and 15:00 UTC (the snapshot crons). **From step 4 until step 8, keep the app closed everywhere** (close any open tab or installed app too: a page already loaded keeps talking to the release it came from) and pause anything that calls `/api/ingest/balance`. Even viewing the app writes (today's snapshot, the transaction sync).
3. See what it would do:

   ```bash
   vercel env pull .env.local
   REDIS_PREFIX=production CONTAINER_ID=<id> bun run move-data --target production --confirm-production
   ```

   It warns if the environment holds none of the keys every environment in use has (usually the wrong `.env.local` or prefix); a run is then refused unless you pass `--allow-empty`.
4. Copy: the same with `--run`.
5. Merge the release. While it builds, the old release is still live: run step 4 again once the build has started.
6. When the new release is live, and **still without opening the app**, report again (step 3). Anything written to the old keys since step 5 shows as a copy or refresh: run step 4 again to bring it across.
7. Report once more: it should show nothing to copy, refresh or delete, and no conflicts. A conflict means both releases wrote the same key, and it blocks every run until settled. Merge it by hand **into the container's key** (for a date-keyed history hash, `HSET` the old key's missing dates into `<prefix>:c:<id>:<name>`; never delete the container's own), then settle it with `--resolve <name>` in place of `--run`. That records the old key as seen, so the container's value is kept, and a later write to the old key shows as a conflict again. Report again after.

   If a run is killed, its lock frees itself within the hour. When you are sure no run is going, delete `<prefix>:c:<id>:move:lock` by hand instead of waiting (any hash it was building expires on its own).
8. Now open the app. Check the dashboard, the history chart's left edge, the transaction counts, that no institution re-downloads its whole history, and `GET /api/storage-usage`. Resume the ingest script.

An export from before the move is refused by `bun run restore` from now on; restore it with the previous release, then move it.

**Don't run the re-encryption pass** (`/api/ops/reencrypt`) from step 4 until the old keys are deleted: it rewrites both copies differently, and every key would read as a conflict.

**Rolling back** is redeploying the previous release, which reads only the old keys: anything the new release wrote is not there. Rolling forward again, the move carries across what changed only on one side; keys both releases wrote are conflicts to merge by hand. The shorter the time rolled back, the fewer. If you roll back with Vercel's Instant Rollback, later merges are not deployed to production until you undo it in the dashboard.

**Preview** merges `main` automatically (`sync-preview.yml`), so it gets this release as soon as it merges. Its data is sandbox data: before merging, create its container (as above, in the preview environment), then wipe its old keys and re-link sandbox institutions after the merge, rather than moving them.

**Deleting the old keys** comes weeks later, separately, after a fresh verified export. First retire the move:

```bash
REDIS_PREFIX=production CONTAINER_ID=<id> bun run move-data --target production --confirm-production --retire
```

It is refused unless a report shows nothing left to copy, refresh or delete and no conflicts (the proof nothing written to the old keys is left behind), and afterwards every run is refused, so a run can never take the missing old keys for deletions to carry into the container.
