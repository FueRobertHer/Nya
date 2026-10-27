# Operations

Runbooks for keeping the data safe: backups and restores, encryption keys, containers, email and the weekly summary, and what a rollback must not undo. For setup see [deployment.md](deployment.md); for how the data is stored see [architecture.md](architecture.md).

Everything under `/api/ops/*` is locked the same way (`lib/ops.ts`): it answers 404 unless `OPS_ENABLED=1`, accepts POST only, and compares `OPS_SECRET` in constant time. Set `OPS_ENABLED=1` only while you run an operation, then remove it and redeploy, so a leaked `OPS_SECRET` is useless on its own.

- [Backups](#backups)
- [Restoring a backup](#restoring-a-backup)
- [Encryption keys](#encryption-keys)
- [Plaid secrets in older logs](#plaid-secrets-in-older-logs)
- [Containers](#containers)
- [Storage across accounts](#storage-across-accounts)
- [Moving the data into containers](#moving-the-data-into-containers)
- [Category ids: the migration and rolling back](#category-ids-the-migration-and-rolling-back)
- [Rules, tags and notes, and rolling back](#rules-tags-and-notes-and-rolling-back)
- [Goals: plans and rolling back](#goals-plans-and-rolling-back)
- [Budget rollover and rolling back](#budget-rollover-and-rolling-back)
- [Sharing more than accounts, and rolling back](#sharing-more-than-accounts-and-rolling-back)
- [Rolling back once the brokerage option is on](#rolling-back-once-the-brokerage-option-is-on)
- [Exchange rates, and rolling back](#exchange-rates-and-rolling-back)
- [Turning on restores](#turning-on-restores)
- [Shared expenses: the phone check, and rolling back](#shared-expenses-the-phone-check-and-rolling-back)
- [Receipts and documents](#receipts-and-documents)
- [Repairing balance signs](#repairing-balance-signs)
- [Email and the weekly summary](#email-and-the-weekly-summary)
- [An address locked out of the login](#an-address-locked-out-of-the-login)

## Backups

Some of what Nya stores exists nowhere else: banks stop serving old transactions after a while, and no bank serves daily balance history, or what an investment account held on a past day, at all. A copy is taken every night; take one by hand before any risky change too.

These are the operator's copies of the whole environment, for recovery, with every value kept as stored: what is encrypted in the database stays encrypted, and what is plain text there (dates, ids, bank names, renamed merchant names; see below) is plain text in the copy. A person's own copy of their data, decrypted, is a different thing they download themselves: see [data-export.md](data-export.md).

### Nightly backups

Every night at 16:00 UTC (after the daily snapshot and its catch-up), a cron (`/api/backup`) takes the same archive as the manual export below and saves it to Vercel Blob under `backups/<environment>/`, named `nya-<time>.f2.ndjson`. It leaves the key store out: that goes in a key archive of its own, written right after it under `keys/<environment>/` ([Per-container data keys](#per-container-data-keys)). It reads each copy back to check it before anything old is deleted. Data archives older than 30 days are deleted, but the newest 7 are always kept; key archives, seven nights' of them.

To turn it on:

1. In Vercel, create a Blob store with **private** access (Storage, Create, Blob) and connect it to the project. That sets `BLOB_READ_WRITE_TOKEN`. It must be private: the archive is financial data.
2. `CRON_SECRET` must be set (the snapshot cron needs it too).
3. Optionally set `BACKUP_KEEP_DAYS` to keep more or fewer days (a whole number, 1 or more).
4. Redeploy. Crons run only on the production deployment.

Check it worked the next day: the cron's log in Vercel says "Backup written", with the key archive's name, and both files are in the store's browser. Before that line, it logs how long each step took (export, upload, read-back, count, list, keys, prune). A failed night shows as a failed cron run with the reason, and the older copies are left alone. Each step has a time limit, so a storage call that doesn't finish in time fails the run naming that step (for example "The backup's read-back step took longer than 45s") instead of running into Vercel's 300-second limit with no reason given. "Took longer" can mean the call never answered or that Vercel Blob kept retrying it (it retries server and network errors up to 10 times); to tell which, set `DEBUG=blob` on Production for a night, and the log shows each retry. Within a step, a listing, a delete or a read that hasn't finished in 5 seconds is sent again on a new request (with 10 seconds, then 20, three tries at most, while the step has time), and the log says "Vercel Blob didn't finish a listing within 5s; sent again on a new request": Vercel Blob never times out a request on its own, so one connection that went quiet used to use up the whole step and fail the night. A try can also run out while Vercel Blob waits between its own retries of an error, so if that line comes up night after night, set `DEBUG=blob` to see which. The receipts clean-up's listings and deletes are sent again the same way. An upload is never sent again this way (a second backup upload would find the first's file and fail). To try again without waiting a night, use **Run now** on the Nightly jobs page (`/admin/jobs`, admin only; [deployment.md](deployment.md#4-scheduled-jobs)), which Home's Admin card links to. A copy whose upload or read-back ran out of time may still be in the store, unchecked. Vercel doesn't send an alert for it, so the dashboard shows a note when the last backup failed or none has been saved for two days, and "No nightly backup has been recorded yet" while no run has recorded its outcome at all (a new deployment's first day, the night after a restore, or a run that never gets as far as recording itself).

To restore from one, download it and the newest key archive from the store's browser in Vercel and follow [Restoring a backup](#restoring-a-backup).

The copies live in Vercel, like the database. They protect against losing or damaging the data, not against losing the Vercel account: download one now and then and keep it somewhere else too.

### Taking a backup by hand

1. In Vercel, set `OPS_SECRET` and `OPS_ENABLED=1` on the environment you want to back up, then redeploy.
2. Download both files, the data and then its keys:

   ```bash
   curl -X POST https://your-app.vercel.app/api/ops/export -H "Authorization: Bearer $OPS_SECRET" -o nya-export.ndjson
   curl -X POST https://your-app.vercel.app/api/ops/export -H "Authorization: Bearer $OPS_SECRET" -d '{"keys": true}' -o nya-keys.ndjson
   ```

3. Check the last line of each file is a footer (`{"end":true,...}`). If it is missing, the download was cut short; take it again.
4. Remove `OPS_ENABLED` and redeploy. While it is unset the route answers 404.

Balances, transactions, budgets, goals and access tokens stay **encrypted** in the archive and cannot be read without `PLAID_ENCRYPTION_KEY` and, once data keys are in use, `MASTER_KEY` with the key archive: the data keys are in the key archive, each encrypted with the master, and never in the data archive. Keep a copy of those two settings somewhere separate from the archives and Vercel (a password manager, or on paper). Lose them and the backup cannot be read. A key archive keeps every key in it for as long as you keep it, those of accounts deleted later included: keep it for the restore you took it for, and replace the two files as a pair.

SimpleFIN Access URLs and Lunch Flow API keys are never in the archive. Unlike a Plaid access token, which is of no use without the Plaid secret, each works on its own: it reads a person's accounts there ([Bring your own sync](features.md#bring-your-own-sync)). So both are kept out of every backup (they are the same store, `connector-secrets`), with the counts of requests made to either, and a restore ends each person's connections there: they connect again (with a new Setup Token, or a Lunch Flow API key, which may be the one they had), and their accounts, history and transactions carry on.

Not everything in it is encrypted, so still treat the file as private: dates, account, transaction and connection ids, the random ids of the people a person splits costs with and of their IOUs (never their names, usernames or amounts), the names of your linked banks (and whether Plaid included transactions when each connection was linked), the merchant names you have renamed, and for sharing, the names people gave each other, which accounts each shares at which level and until when, which other kinds (net worth, spending, holdings, budgets, goals) each shares at which level, with the random ids of the goals chosen, and for each connection the random id its records of showings are kept under and when they began (not what they record), are stored as plain text. The database holds the same in plain text, and the public Security page (`/security`) says so.

The last line also carries a checksum, so a file damaged in storage or transit is caught before it is restored. It is not a signature: it will not stop someone who edits the file on purpose.

Caches and the login's rate-limit counters are left out on purpose. So are API tokens and their request counts (`api-tokens`, `api-requests`, declared `backup: false` on the storage seam): a backup must never bring back a token revoked after it was taken, which nothing could tell its owner, so a restore ends every token and people make new ones. The ECB's exchange rates (`fx:`) are public and can be fetched again, so they are left out too, named in the header's `excluded`; a restore keeps the target's own copy, and into an empty database the fetch is run once by hand ([Exchange rates](#exchange-rates-and-rolling-back)). Each account's count of data downloads is a store on the storage seam, so it is kept like the rest, with its expiry. Avoid running it around 13:00 UTC, when the daily snapshot writes.

## Restoring a backup

Restore runs on your own machine, not as a web route: a real backup can be bigger than Vercel lets a request upload, and it keeps anything on the internet from being able to overwrite your data.

1. `vercel env pull .env.local` so the command has the Upstash credentials. Every environment shares one database, so these credentials can reach production too. What decides where the restore writes is the prefix.
2. Try it on a scratch namespace first, and check the file without writing:

   ```bash
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --keys nya-keys.ndjson --target restore-test --dry-run
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --keys nya-keys.ndjson --target restore-test
   ```

   A data archive of format 2 (every one this release takes) needs its key archive with `--keys`: one taken at the same time or later (the nightly run's newest is always fine). A format-1 archive, which the release before takes, carries its keys inside and is restored without `--keys`.

   To look at the result, point a preview deployment at it by setting `REDIS_PREFIX=restore-test` on that preview.

The command refuses, and writes nothing, when:

- the file is incomplete, damaged, or from a different key layout;
- `--target` does not match `REDIS_PREFIX` (both are required, so a leftover shell variable cannot aim it somewhere you did not mean);
- the target already holds data and `--overwrite` is not given;
- the target is `production` and `--confirm-production` is not given;
- it would replace data with an archive holding no keys (`--allow-empty` overrides), or with one taken from a different environment (`--allow-different-source` overrides). Restoring into an **empty** target from anywhere, like production into `restore-test`, needs neither;
- the target has containers (see [Containers](#containers)) and the archive's are not the same, for example an archive from before containers existed: restoring it would leave `CONTAINER_ID` naming a container that no longer exists. `--replace-registry` overrides; afterwards set `CONTAINER_ID` again (or create a container, if the archive has none). A dry run reports this too;
- a value in the data archive is under a key the key archive neither holds nor marks destroyed (use a newer key archive), or a format-2 archive's values need a key archive and none was given.

A deleted account is never brought back: the containers named by the tombstones of the key archive and of the target are left out, with their owners' entries and the sharing connections their accounts were in, and the dry run names them ([Per-container data keys](#per-container-data-keys)).

With `--overwrite`, it prints how many keys it is about to replace, saves the target's current contents as a pair, `nya-pre-restore-<target>-<time>.f2.ndjson` and its keys in `nya-pre-restore-<target>-<time>.keys.ndjson`, and checks they hold every key it is about to delete. Then it **replaces** the target entirely (login rate-limit counters aside), so nothing newer than the archive survives. API tokens are in no backup, so afterwards every token is gone: tell the people who use the deployment to make new ones in **Settings**, **API tokens**. If the target changes while this is going on, it stops before deleting anything. It finishes by reading everything back, the key store included, and comparing it with what it restored, and reports success only if they match exactly. If a restore stops part way, run it again with `--overwrite`.

File paths are resolved from the repo root, since `bun run` runs there, and that is also where the pre-restore file is written.

Don't use the app while a restore is running, and avoid 13:00 UTC (the daily snapshot) and 17:30 UTC (the receipts' clean-up): anything written to the target mid-restore makes the final comparison fail. The clean-up checks for a restore itself too: a restore deletes the backups' record (`backups:status`) as its first write, and the clean-up writes nothing while backups are kept and that record isn't there, until the next nightly backup writes it again ([The nightly clean-up](#the-nightly-clean-up)). If a deployment serves the target (restoring over production, say), **redeploy it right after** the restore: a running instance remembers the data key it writes with for up to a minute, and if the restore replaced that key, anything it writes meanwhile can never be read.

`.ndjson` files are git-ignored so a backup is never committed by accident.

## Encryption keys

Data is encrypted with **data keys** that the app generates and stores in Redis, each locked with one **master key**, `MASTER_KEY` (envelope encryption, `lib/crypto.ts`). `PLAID_ENCRYPTION_KEY` is the original key, `k0`: everything written before data keys existed is under it. Each container has a data key of its own once it is born with one or the migration pass gives it one ([below](#per-container-data-keys)); until then its values are under the environment's data keys.

**Keep `MASTER_KEY` in your password manager.** Without it, nothing encrypted with a data key can be read, from the database or from any backup. Keep `PLAID_ENCRYPTION_KEY` and `SESSION_SECRET` safe too: losing the encryption key makes values still under `k0` permanently undecryptable (you would have to reconnect every account), and losing or leaking the session secret would let someone forge a login cookie.

### Turning on the master key

Generate a master key (`openssl rand -base64 32`), save it in your password manager, and add it in Vercel as `MASTER_KEY` (Production, marked Sensitive). The next write creates the first data key, and from then on new data is written under it. Existing data stays under `k0` until the re-encryption pass below moves it.

- **Without `MASTER_KEY`** the app keeps writing under `k0`, exactly as before. If the environment's data key can't be used for any reason, writes fall back to `k0` and the log says so ("Writing with the legacy key", repeated hourly while it lasts), so a problem with the master can never block a save there. A container with a key of its own never falls back: if its key can't be used, its requests answer 503 and nothing is written until it can.
- **Containers made from then on** are born with a key of their own, made in the step that registers them; those made before get theirs from the migration pass.
- Only a deployment with the **current** master creates a data key, never while a master rotation is being prepared or is pending, and one at a time. An old deployment still running after a rotation writes under `k0` instead.
- **Never remove `PLAID_ENCRYPTION_KEY`** while any value still uses `k0`.
- **Status:** an empty POST to `/api/ops/rotate-master` (with `OPS_ENABLED=1`) reports `active_key`, the data key new writes use (`null` means still `k0`), `active_key_problem` if this deployment cannot use it, and `this_instance_fallback_since` if the instance that answered has been writing under `k0` instead.

### Moving existing data to keys of its own: the migration pass

Everything written before `MASTER_KEY` was set is under `k0`, and every container made before this release keeps its values under the environment's keys (`k0` and the environment's data keys, which every container can read). The migration pass gives each container a data key of its own and moves its values to it, safely while the app is running: a value is only written back if it has not changed since it was read, and only while its container's map entry still names that key; readers see exactly the same data either way. **It is a required step of this release** ([below](#per-container-data-keys)).

1. Take a backup first, both files (see [Backups](#taking-a-backup-by-hand)). Don't run the pass while a restore is running, nor during a data move.
2. With `OPS_ENABLED=1`, check what is left. This changes nothing and makes no key (like any read, it can finish a master rotation that is already due):

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET"
   ```

   `to_move` counts the values still under another key than their container's, by key (`k0` is the original one), and `not_moved` lists the containers walked that aren't moved yet.
3. Run it, a call at a time, each starting after the last container the one before finished, until a call answers `"walked_all": true`; then start again from the beginning, until a call from the beginning answers `"complete": true`. Each call stops after about 40 seconds:

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' -d '{"run":true}'
   # then, with the next_after it answered:
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' -d '{"run":true,"after":"<next_after>"}'
   ```

   A container is recorded as moved only by a walk that begins at least a minute after its key was made (instances pick a new key up within a minute), so the first run gives keys and moves values, and a run a minute later records them as moved.
4. Remove `OPS_ENABLED` and redeploy.

It never shows values, only container ids, key and field names, counts and reasons. What the fields mean:

- `keys_made`, `maps_restored`, `marked_moved`: containers given a key, given back a map entry their key's record names, or recorded as moved by this call.
- `damaged`: a container left alone because something says its key was lost: a value under a key the store doesn't hold, a value under another container's key while it has none, several keys naming it, or a map entry that can't be read. It gets no key until that is looked at.
- `skipped`: not walked: being restored or archived, its key destroyed, deleted mid-walk, a master rotation pending, or key numbers at their cap.
- `outside_containers`: values the data move left at the root, counted on a call from the beginning and never written.
- `unclassified`: a store the pass does not know about. Left alone; a bug to report.
- `unreadable`: a value it cannot move, left exactly as it was, with the reason: it cannot be decrypted, the key has an unexpected type, it is bound to a context, it is under another container's key, it is listed as plaintext but is encrypted, and so on.
- `changed_meanwhile`: saved by the app while being moved; picked up next call.
- `deleted_meanwhile`: deleted by the app while being moved; nothing to do.

**Keep `PLAID_ENCRYPTION_KEY` in Vercel even after the pass completes.** It also keys the versions the API serves (`lib/api-versions.ts`): were it ever replaced, every version would move once, and each program that writes would get one 412 and read again (nothing stored depends on a version). It costs nothing, values outside the containers and archives taken before the pass still need it, and if it is marked Sensitive in Vercel (so it cannot be read back out) and you have no other copy, removing it is permanent: any value still under `k0` then (an old backup, a fallback write) could never be read again. The environment's data keys stay too, for the same reasons.

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
- **Backups** taken before a rotation still need the old key: the key archives until they are pruned, seven nights later.
- **Container keys** are re-locked with the rest, a page of keys per request, and a finish that stops part way is completed by the next attempt. While a rotation is prepared or pending no container key can be made, so a container born meanwhile writes under the environment's key: run the migration pass once it has finished. How many keys fit in the route's minute is under [Per-container data keys](#per-container-data-keys).
- **What this does not do:** someone who already has a copy of the database or a backup *and* the old key can still read that copy, and the data keys in it don't change. After a real leak, the data keys need replacing too, which comes with the re-encryption pass.

### Per-container data keys

Each container's values are encrypted under a data key of its own: one made in the step that registers a container, or, for a container made before this release, by the migration pass. Deleting an account destroys its key, and the key backups are rewritten without it. How it works is in [architecture.md](architecture.md#per-container-data-keys); this is what it changes for you.

**This release's runbook.** Once it is deployed:

1. Let the nightly backup run once (or take both files by hand, [above](#taking-a-backup-by-hand)) and check its log names a key archive.
2. Run the migration pass until a call from the beginning answers `"complete": true` ([above](#moving-existing-data-to-keys-of-its-own-the-migration-pass)). Until it has, accounts made before this release are under the shared key, and the receipt says so for each of them. Run it again after a master rotation finishes and after rolling forward.
3. If Upstash's Daily Backup is on for the database (its Backups tab), set `DATABASE_BACKUP_DAYS` to the days it keeps each copy (1 or 3), so the receipt and the pages add them to the window. Never keep a backup made there by hand (Backup & Export): it holds the whole database, key store included, until it is deleted.
4. Check the status (below) now and then: containers without a key or not yet moved, keys left behind by an account deleted while rolled back, and a deletion's rewrite of the key archives left for the nightly run.

**Backups are two kinds of file.** The nightly data archive (format 2, named `nya-<time>.f2.ndjson`, so a format-1 archive the release before writes is told apart by its name) leaves the key store out: `crypto:keys`, `crypto:active`, `crypto:master`, `crypto:rotation`, `crypto:key-seq` and the tombstones, `crypto:destroyed` (the rotation lock is in neither kind of file). They go in key archives, named `keys/<environment>/nya-keys-<taken>--<written>--<tombstones>.ndjson` (the last part a digest of the tombstones the file holds), in the same private Blob store, outside the folder the data archives are pruned from:

- **Seven generations are kept**, a new one written each night after the data archive, built from the newest before it, the oldest beyond seven deleted only once the new one is checked. Never pruned on a night that fails.
- **No key is ever dropped without a tombstone.** Each generation holds every key in the live store and every key of the generation before it that hasn't been tombstoned. A key that has left the live store without a tombstone (removed by hand, a bug, a restore of an older point) is carried forward, with when it was first missed (`missing_since`) and when a data archive last named it (`named_last`), until the oldest data archive still in the folder was taken after both, and never sooner than `backupRetention().max_days` after the later. So it stays as long as any kept copy can need it, however long a value kept naming it, and however long nights that fail keep old copies (nothing is pruned on one, and the newest seven are always kept). A night that wrote its data archive but no key archive counts as naming every key carried, since nothing recorded what its values named. The nightly log names a carried key, and so does the status. So the backups never lose a key overnight because the live store did.
- **Checked, before anything older is deleted**: the file reads back byte for byte; it is exactly what the live store and the generation before make it (every key and tombstone of the store, every key and tombstone of the generation before but the keys tombstoned since or let go by the rule above, each carried line's times, and nothing else), or it is deleted, as a file that doesn't read back is, so no night builds on it; every key from the live store in it unwraps with the current master and is the key its id names (and, while a rotation is prepared, still carries the next master's lock); and it holds every key id that a value in the same night's data archive names, or a tombstone for that id. A file that fails only these last two checks is the store as it stands, so it is kept, and the run fails. A key carried forward was checked when it was last in the store. Without `MASTER_KEY` a key archive holds the tombstones alone; one with keys in it can't be checked, and the run fails.
- **Rewritten at every deletion.** The last step of an account deletion rewrites every kept generation without the destroyed keys, and so does each nightly run for any generation still lacking a tombstone. A rewrite is a pure filter of the file before it (the destroyed keys' lines dropped, and every tombstone it lacks added), named after the file it replaces and checked line by line as exactly that before that file is deleted. A run reads a file only when its name says it lacks a tombstone, or when an older one that doesn't read back would be deleted on the strength of it, so a night with no deletion since the last reads just the generation it builds on.
- **One writer at a time.** Reading the store, writing, checking and deleting older files happen under a lock (`backups:keys-lock`: a token, an expiry of two minutes, released only by its holder, like the snapshot's). After writing, the writer reads the tombstones again and rewrites any generation still holding a tombstoned key before it deletes anything. The nightly run waits up to 30 seconds for the lock, then fails. A deletion waits 5 seconds and takes 20 at most; if it can't, it leaves a marker (`backups:keys-pending`) that the next nightly run honours and clears, and its receipt says "by the next nightly backup".
- **A short cache lifetime.** Key archives are written with Vercel Blob's shortest cache lifetime, 60 seconds, since a deleted blob can still be served from its cache that long.
- **How many keys fit.** Measured on a local Redis through the same client calls, with an in-memory blob store: at 30,000 keys a night with nothing to rewrite took 2.7 s of CPU, 159 Redis requests and 7 blob calls moving 23 MB (about 8 s at 25 ms a request, 100 ms a blob call and 50 MB/s), and one rewriting all seven generations (a deletion's rewrite the nightly run caught up on) 5.4 s, the same requests and 35 blob calls moving 186 MB (about 17 s). So inside the key step's 40 seconds, a night that rewrites everything fits about 50,000 keys, and a quiet one well over twice that; a deletion's rewrite fits its 20 seconds up to about 40,000, and past that is left for the nightly run, which its receipt says.

The map, `crypto:container-keys`, stays in the data archive, with the data it describes. Once the data archive reads back, and before the key archive, the nightly run counts, from the headers of the values it already holds, which containers have a value under `k0` or an environment key, and notes the archive's time in each one's map entry (`shared_in`), clearing its `moved` if set, so the pass walks it again. It notes too, from the folder's listing, the time of the newest format-1 archive taken after a container's key was made (`key_in`: a rollback's, which holds the whole key store, this key included), clearing `moved` the same way, since the release before may have written the container's values under a shared key. A run that can't write and check its key archive fails, and the dashboard says so, though its data archive is kept (with what it counted) and nothing is pruned. A data archive alone can't be read even with `MASTER_KEY` (values under `k0` aside): it needs a key archive.

**A key archive that doesn't read back.** A run reads the newest generation, to build on, twice before it gives up on it; then it fails, naming the file, and writes nothing, rather than build tonight's on less. Download that file from the store's browser and look: if it is damaged, delete it there, and the next run builds from the generation before it. A key only it carried (one that had left the live store) is then gone from the archives, unless you put its line's record back in `crypto:keys` by hand. An older generation that doesn't read back is deleted by the run that finds it, which logs it, once a newer one has read back intact in that run (one whose name says it needs no rewrite is read then, never trusted on its name alone): the generation after it was built from it, so holds everything it held but the keys destroyed since. One with no newer one intact is kept, since it alone may hold a key; the run still rewrites every older one, so a key just destroyed leaves every file that can be rewritten, and then fails, naming the one it kept. Before it fails, it deletes the older files a stopped rewrite left of each generation that reads back intact (one passed over by its name is read for it) or was deleted for a newer one, which may still hold that key; those of the kept one, and of any whose newest file doesn't read back, stay, since one may be the only file of its generation that reads. If deleting them, or reading a generation for them, fails, the run still fails naming the one it kept, and a later run deletes them. A deletion that finds the newest damaged leaves it for the nightly run, and its receipt says so.

**A value under a key nothing holds.** The nightly run fails with "A value in tonight's data archive is under k<n>-<hex>, which the key archive neither holds nor marks destroyed", and nothing is pruned until it is fixed. A check of the migration pass (`POST /api/ops/reencrypt` without `run`) names the value under `unreadable`, by key and field, with `UnknownKeyError` as the reason. If a kept key archive holds the key (a restore that lost it, a key removed by hand), put its record back in `crypto:keys` exactly as that archive's line holds it. If none does, nothing can read the value: delete that key or hash field in the Upstash console (it is lost either way), and the next run succeeds.

The night after a deletion, the run first sweeps the deleted container's prefix once more, for a write that came later still, and notes it (`swept`).

**Restoring needs both.** `bun run restore <data.f2.ndjson> --keys <keys.ndjson> --target <prefix>` checks each file, then, before writing anything:

- takes as tombstones those of the key archive and those already in the target, together, and leaves out every container tombstoned in either (a deleted account): its registry entry, its owners' entries, every key in it, and the sharing connections its account was in, as a deletion ends them; its map entry says its key was destroyed. It never writes back a tombstoned key. The same applies to a format-1 archive, which restores alone, as before, with the tombstones it carries and the target's. A restore never brings a deleted account back, and the dry run names the containers it leaves out;
- reads the header of every value in the data archive (`classify()` says where the ciphertext is) and refuses if one names a key the key archive neither holds nor marks destroyed: use a newer key archive;
- restores a container whose map entry names a key the key archive lacks, with nothing under that key (made just before the data archive), without its map entry, so it writes under the shared key until the pass gives it one, rather than failing every write; and says so;
- leaves out of the live store the keys of containers the data archive doesn't have (made after it was taken). The kept key archives still carry them, as above, for as long as a data archive may need them.

The copy of the target saved before an overwrite is a pair too. Keys, the map and the tombstones name containers, never the environment prefix, so a restore into another namespace (`restore-test`) reads with the source's `MASTER_KEY`, as before. Redeploy after a restore: an instance also remembers a container's key for up to a minute.

**The migration pass** is described [above](#moving-existing-data-to-keys-of-its-own-the-migration-pass). In short:

- **Per container, in id order, from a cursor.** Each call carries `"after": "<container id>"` (the last container the one before finished) and answers `next_after`, so it reaches every container however many there are. Only active containers are walked; one being restored or archived is named and skipped. A check (no `run`) reports, per container, whether it has a key, whether it is moved, and how many of its values are still under other keys (by key); the values outside any container, counted and left alone; and the problems below.
- **Keys first.** A run gives a key to each active container that has none, in `nya:container-key-create`, but only to one whose values are all under `k0` or the environment's keys. A container with a value under a container key the store doesn't hold is reported as damage and gets no key. A container whose map entry is missing while its key's record names it gets its entry back from that record. While a master rotation is prepared or pending, or a rotation step holds its lock, a call makes no key and uses up no key number: it says so for each container.
- **Then values.** Each value under another key moves to its container's key with a compare-and-set, guarded in the same step by the map entry still naming that key and the key still being stored. Each is read back once written and decrypted under its container's `Ctx` with the key loaded fresh from the store. A container whose map entry changes mid-walk (deleted meanwhile) ends its walk, and the pass goes on to the next.
- **Moved.** A container is recorded as moved (`moved` in its map entry: the time its own walk began) only when one call walked the whole of it, the walk began at least a minute after its key was made (instances pick a new key up within a minute), and it found nothing left under another key and nothing unreadable, unclassified or changed meanwhile. A run skips moved containers. A value that still lands under the shared key in a moved container (an instance of the release before still draining after a deploy, an old deployment's own URL, a rollback) is found by the nightly count, which clears `moved`, so the next run walks the container again.
- **Complete** means every active container has a key and is moved, from a call that walked to the last container with nothing damaged, unreadable or unclassified. A second complete run writes nothing.
- **`"after_rollback": true`** is only for data archives taken by hand while rolled back, which the backups can't see: it clears every container's `moved` and dates `shared_in` now.
- It never writes a key outside the containers, so the copies the data move left at the root are never rewritten. Still don't run it during a data move (steps 4 to 8 of [Moving the data into containers](#moving-the-data-into-containers)).

**Status, and destroying a key by hand.** `POST /api/ops/container-keys` (locked like every ops route) with an empty body reports `with_key` (how many active containers have a key, and how many are moved), `without_key` and `not_moved` (the containers, up to 200 of each, with the count), `orphaned_keys` (keys whose container is no longer in the registry, and those containers), `entries_missing_key` (map entries naming a key the store lacks), `unreadable_entries`, `carried_forward` (keys the newest key archive carries forward; null when none could be read), `tombstones`, `key_numbers` (the next one, and how many are left before the cap) and `key_archives_pending` (a deletion's rewrite left for the nightly run). With `{"destroy_keys_of": ["<container id>"]}` it destroys the keys of the containers named (up to 50), each only if the registry no longer lists it, the way a deletion does, and rewrites the key archives. Nothing ever destroys a key on its own: a registry read wrongly, or restored with `--replace-registry`, must never cost a living container its key.

**The environment's keys stay.** `k0` (`PLAID_ENCRYPTION_KEY`) and the environment's data keys are not retired in this change: values outside the containers, archives taken before the pass, and anything written while rolled back still need them. A later change can retire an environment data key once the pass reports nothing under it and every archive still kept was taken after that.

**Rotating the master** works as before and re-locks container keys too, a page of keys per request, and an interrupted finish is completed by the next attempt instead of refusing for good. Measured on a local Redis through the same client calls, prepare costs about 0.36 ms of CPU a key and finish about 0.08 ms, each with one request per 50 keys: 30,000 keys took 11 s to prepare and 2.4 s to finish locally, 26 s and 18 s once each request costs 25 ms. So inside the route's minute, prepare fits about 50,000 keys (leaving room for a slower server) and finish about twice that. Prepare is still one pass that writes every key again; past that size it needs to resume key by key, as finish does. While a rotation is pending no container key can be made, so a container born meanwhile writes under the environment's key: run the pass once the rotation has finished. Key archives taken before a rotation still need the old master until they are pruned, seven nights later; data archives never carry a lock again. A key carried forward (one that had left the live store) isn't in the store for a rotation to re-lock, so it keeps only the lock it had: until it is let go, restoring a data archive that needs it takes the old master too, so keep that until then.

**Deleting an account destroys its key.** In this order:

1. the container is archived;
2. what it holds is counted, and its map entry read, for the receipt (below);
3. its banks are disconnected;
4. every key in it is deleted;
5. it leaves the registry;
6. **its key is destroyed**, in one Lua step that only acts on a container no longer in the registry: every key whose record names the container (found by `HSCAN` of the store as well as through the map, since a damaged map entry must not let a key survive) goes, a tombstone is written for each, and the map entry becomes `{"destroyed": "<day>"}`. The deletion then checks that no key naming the container is left. Repeating the step does nothing more, and answers the same keys;
7. the account's owners entry becomes a marker, `deleted:<container id>`, which `owned()` refuses, so a request from another tab can't get the account a new container;
8. sharing ends;
9. the sign-in is deleted, and then the owners marker;
10. the container is swept once more for late writes;
11. every kept key archive is rewritten without the key (above).

The key goes once nothing needs it any more (counting reads through it, and disconnecting decrypts each bank's token with it) and before the owners entry is replaced, which is how a deletion that stopped part way finds its container again, so a retry never loses track of a key it still has to destroy. A request already in flight (a sync, the snapshot cron) that writes after step 6 fails on the destroyed map entry if its instance doesn't have the key in memory, and writes under a key that exists nowhere if it does (for up to a minute). Anything written there in plain text (a count, a snapshot's outcome) is under the container's prefix, and the nightly run sweeps every destroyed container's prefix once more the night after its deletion, so nothing late stays.

**How long a deleted account's copies stay readable.** For an account deleted now:

- **The database**: its data at once, its key seconds later.
- **Nightly backups, what is under its own key**: unreadable once every kept key archive has been rewritten without the key: within minutes, as part of the deletion, or by the next nightly backup that succeeds if that failed; the receipt says which. A deleted blob can still be served from Vercel's cache for up to 60 seconds after. The copies stay in the backups, unreadable, until they are pruned.
- **A backup taken while an older version ran** (a rollback's format-1 archive, taken after the account's key was made) holds the key itself, so until it is pruned, `backupDaysAtMost` after it was taken, every copy of the account's data can be decrypted with `MASTER_KEY`. The deletion lists the backup folder for one, as the nightly run does, and the receipt dates it, or says it couldn't check when the folder couldn't be listed.
- **Nightly backups, what is under a shared key**: readable with `MASTER_KEY` until the newest kept copy that holds the account readably is pruned. The receipt dates it from the map entry: for an account born with its key, from the newest archive that found one of its values under a shared key (`shared_in`), or never; for one the pass gave its key, from when the pass found nothing left to move (`moved`), or the deletion if it never did, or a later `shared_in`; for one with no key of its own, from the deletion. A copy is gone `backupDaysAtMost` after it was taken (32 days with the default `BACKUP_KEEP_DAYS`).
- **Nightly backups, plain text**: dates, ids, bank names, the original names of renamed merchants and sharing's names stay readable until the copies are pruned, within the same 32 days of the deletion. Per-container keys don't change this; encrypting that metadata (the master plan's Gap 1) would.
- **The database host's own backups**: Upstash's Daily Backup, a switch on each database's Backups tab, keeps each copy for 1 or 3 days, and a backup made there by hand (Backup & Export) is kept until it is deleted. Each holds the whole database, key store included, so while one exists the account's encrypted copies can be read with it and `MASTER_KEY`. Set `DATABASE_BACKUP_DAYS` to the days Daily Backup keeps (0, the default, means it is off): the pages and the receipt add it to the window. Never keep a manual one.
- **A key archive downloaded by hand** before the deletion opens the account's encrypted copies for as long as it is kept.
- **Instances running at the time** may hold the key in memory until they end. They read only the live database, where nothing of the account is left.
- **What is kept for good**: the tombstone, that a container id existed and the day its key was destroyed.

**What a rollback sees.** The release before reads everything this one writes, so rolling back is safe at any time, with no switch to turn off first. `test/release-before.test.ts` holds this release to that with the release before's own code (`test/fixtures/release-before`, byte for byte): its decrypt, its key store reader, its export and verifier, its rotation, its pass's plain-text check and its first key, against what this release writes. When the release before changes, copy its files there and change their hashes in the test.

- every value reads as before: container keys are ordinary entries of the key store to it. The isolation check is off while it runs: its `decrypt` takes no `Ctx`, so a value copied from one container into another reads there;
- it writes under the environment's active key, containers with a key of their own included. Rolling forward, those still read (the environment's keys are accepted in every container), the nightly count finds them, and the next pass moves them back;
- containers it creates get no key until the next pass;
- an account it deletes keeps its key, since it doesn't know to destroy it. Rolling forward, the status lists those keys (their container is gone from the registry), and `destroy_keys_of` destroys them;
- its nightly backups are format-1 archives that put the whole key store, container keys included, in the data archive. Rolling forward, this release notices them by name: each container whose key was made before such an archive was taken is dated by it (`key_in`) and walked again by the pass, and a deletion lists the folder itself, so a receipt says the archive holds the key, and until when, even before a nightly run has noted it;
- it writes no key archive and deletes none, so the generations taken before the rollback stay as they were;
- **don't run its re-encryption pass**: it moves every container's values back to the environment's key and answers `complete: true` without a word about it;
- **restore from a checkout of this release**, even while rolled back: its `bun run restore` refuses format 2 rather than restoring a data archive without its keys, and a restore runs locally, so a checkout of this release always works;
- don't rotate the master while rolled back: its finish has the interrupted-finish trap this release fixes. A rotation it does complete re-locks container keys like any other.

**What the pages and the receipt say.** The public pages read no stored data, so they say it conditionally, and only where a master key is set (`keyDeletionText` in `lib/deletion-receipt.ts`, the same words on both): accounts made on this version are normally under a key of their own from the start, and older ones (or one made while a key couldn't be: during a rotation, past the key-number cap) once whoever runs this copy has moved them; until then, under a key shared by everyone on this copy. Deleting an account destroys its key, so nothing encrypted under it can be decrypted from any copy Nya keeps, normally within minutes of the deletion and at the latest after the next nightly backup that succeeds. The encrypted copies stay in backups, unreadable, until they age out; the plain text in them stays readable until then. What that doesn't reach: a key backup whoever runs Nya downloaded by hand, the database provider's own backups when they are on (`DATABASE_BACKUP_DAYS`), and a backup taken while an older version ran. The tombstone is kept. The receipt and the signed-in account's page state the person's own case from the map: whether their data is under a key of its own, when the key backups were rewritten (or "by the next nightly backup"), until when copies under the shared key exist (or that none do), and, when a backup taken while an older version ran holds the key, that every copy of their data can be decrypted with the master key until that backup goes (or that it couldn't be checked, when the folder couldn't be listed). Its "what stays" names a key backup downloaded by hand. The wording is the owner's to sign off.

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

## Storage across accounts

The admin (whoever owns the deployment's own container: the account that signed in first with Clerk, or the password holder; `CONTAINER_ID` if set, as for [unused connections](features.md#keeping-plaid-costs-down)) has a read-only view of every container in **Settings**, then **Storage across accounts** (`/admin/storage`, read by `GET /api/admin/storage`, `lib/admin-storage.ts`). The page lives at `/admin-view/storage` and the proxy sends only the admin there (`lib/admin-gate.ts`), so anyone else's request for `/admin/storage` reaches no route and gets the 404 any path that does not exist gets, header for header; asked for where it lives, it is answered as a path no route matches. The route answers anyone else with the JSON 404 the unused connections route gives, before anything they sent is looked at. What is left to tell it apart, all minor: the link to it on the Settings screen is in the app's code for everyone, as the unused connections card is; a request under `/admin/` makes a read or two of the database that another missing path doesn't, so it takes a little longer; and `/admin-view/...` asked for by anyone else is answered through a rewrite, so beside the same 404 its response carries Next's `x-middleware-rewrite` header, which names the path it was answered with. The page's path there is in the code, which is public, so the header says nothing the code doesn't.

For each container, by its random id ("You" for the admin's own), with its status and the day it was made:

- **Stored**: what the container holds in all, its number of keys, and its largest single value with its share of the size ceiling. Keys that couldn't be measured are counted, and the total is then a floor.
- **Bank connections through Plaid**: each Item by its bank's name and id, with its transaction and investment transaction blobs against the ceiling (`MAX_TXN_BLOB_CHARS`, [deployment.md](deployment.md#3-environment-variables)), whether a save was refused for its size (`txns-blocked:`, which clears on the next sync that fits) or its last save failed (`txns-unsaved:`), whether Plaid billed Transactions on it when it was linked, and what the daily check last found (refused since, every account hidden since, flagged; `lib/item-usage.ts`). Blobs whose Item is no longer linked are listed as left behind: they cost storage all the same.
- **SimpleFIN or Lunch Flow**: how many connections, how many still hold their access (one without it needs connecting again, as after a restore), and how many accounts they keep up to date.
- **Last daily snapshot**: the newest run recorded in `snapshot:runs`, with its outcome, reason and tries.

Sort by what is stored, nearness to the ceiling, bank connections, connector connections, the oldest last snapshot or the newest account; sorting is among the accounts loaded so far.

**What it reads.** Nothing of anyone's data is decrypted. The page's containers are measured through the storage seam (`measureContainers` in `lib/repo.ts`, without their values' heads): one SCAN of every container's keys and one Lua step per hundred of a container's keys that answers each key's type, entries, bytes and largest value, never a value. Beside it, three plain-text records, which it shows: the Items' records (each bank's name, Plaid's ids, whether Plaid billed Transactions; the access token inside each is never opened), the daily check's record of each Item, and the snapshot's newest run, with the reason it gave. A record that can't be read is said so, never shown as nothing or replaced by an older one. No person's name or email address is shown.

**What it costs.** Containers come 20 a request (`?limit=` up to 50, `?after=<container id>` for the next page, which **Load more accounts** sends). The page walks the database's keyspace once with `SCAN ... MATCH` (about `keys in the database ÷ 500` calls, however many containers are on the page), then makes one Lua step per hundred of each container's keys, and reads three records per container, four containers at a time. The route has five minutes (`maxDuration`) for a large database: open it to look, not on a timer.

**What to do with it.** An Item near the ceiling is the one whose next sync may be refused: raise `MAX_TXN_BLOB_CHARS` (its write is refused whole, never trimmed, until then). A container far larger than the rest, or an Item flagged as unused, is the costly one; the Unused connections card in Settings can disconnect a flagged Item after its checks. A snapshot that keeps failing names its reason. Each person sees the same kind of numbers for their own account under **Your data**, with which key each kind is under ([features.md](features.md#your-data)).

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

**Rolling back** is redeploying the previous release, which reads only the old keys: anything the new release wrote is not there. Rolling forward again, the move carries across what changed only on one side; keys both releases wrote are conflicts to merge by hand. The shorter the time rolled back, the fewer. If you roll back with Vercel's Instant Rollback, later merges are not deployed to production until you undo it in the dashboard. A release from before containers also predates the brokerage option's check, so leave `PLAID_BROKERAGE_LINK` unset until the move is done and rolling back is no longer a plan (see [below](#rolling-back-once-the-brokerage-option-is-on)).

**Preview** merges `main` automatically (`sync-preview.yml`), so it gets this release as soon as it merges. Its data is sandbox data: before merging, create its container (as above, in the preview environment), then wipe its old keys and re-link sandbox institutions after the merge, rather than moving them.

**Deleting the old keys** comes weeks later, separately, after a fresh verified export. First retire the move:

```bash
REDIS_PREFIX=production CONTAINER_ID=<id> bun run move-data --target production --confirm-production --retire
```

It is refused unless a report shows nothing left to copy, refresh or delete and no conflicts (the proof nothing written to the old keys is left behind), and afterwards every run is refused, so a run can never take the missing old keys for deletions to carry into the container.

## Category ids: the migration and rolling back

The release that gave categories ids and groups ([features.md](features.md#categories-and-groups)) changes what names a category. Before it, a category was its words, stored wherever it was used: a category you chose for a transaction (`txn-category-overrides`), one carried across a re-link (`txn-category-carry`), the category on a transaction entered by hand or imported (`manual-transactions`), and the name a budget was saved under (`budgets`). There is nothing to run: each container migrates itself the first time the app reads it, and the read-only API and the data download never write.

**What happens on the first read.** The app makes the person's categories (the `categories` store): the default groups, every Plaid category, `other`, and a category for every set of words already on their data, each named by its words exactly as Nya showed it, so nothing a person or a program reads changes. Every set of words becomes a **text key** of exactly one category: what was stored stays as it was, and each value is now a key that files into a category, which a rename never changes. Then budgets move to the `budget-set` store, by category id: each name to the category its words file into (names that land on one category add up, so the month's total doesn't move). The `budgets` blob is left as it was. Overrides, carried categories and manual and imported rows are not rewritten at all.

**Lossless and idempotent.** Every budget name gets a category, whatever the limit on categories; every override, carried category and row keeps its words, which file into a category. A second read finds the set and the budgets stored and writes nothing. Two first reads at once (the dashboard loads transactions and budgets side by side) agree: the categories are made and grown with a compare-and-set, so both use the same ids.

**What a rollback sees.** Redeploying the release before reads only what it always read, and every one of those stores still holds what it understands:

- **Categories chosen for transactions, carried ones, manual and imported rows**: exactly as that release wrote them. A category chosen since is stored as the category's first text key: its words when it was first made (a seeded or older category's original words, so a renamed one shows under its old name; a category made since, under the name it was made with). A transaction filed under a merged category keeps its own words, so it shows as it did before the merge.
- **Budgets**: every save writes the `budget-set` store, then the `budgets` blob with each category's budget under its first text key. So the release before shows every category budget as last saved, a renamed one under its old words, a merged one's added into the one it went into under that one's words. It never shows a group's budget (it has no groups): those wait in `budget-set`. It can save them too: category budgets are held to its 50, and a first text key to its 60 characters. Two devices saving at once leave the blob the copy of whichever save landed last, whole: after writing the blob, a save reads `budget-set` again and writes its copy instead if another save has replaced it since. `budget-set` keeps the copies it replaced for two minutes, so a read that finds one of them in the blob (a slow save's write, about to be corrected) corrects it as well, rather than taking it for a change the release before made.
- **Not shown at all**: group budgets, groups, archiving, renames, icons, and categories that exist only in the new release's lists (that release builds its list from the words on transactions, as before).

**Rolling forward again.** The `budget-set` store keeps the copy of the `budgets` blob it last wrote, and what the blob held before that write. On the next read:

- the blob is that copy: nothing happened;
- the blob is still what it held before the last save (a save that stopped between its two writes): the save is finished;
- anything else: the release before changed it after the rollback. Its category budgets are taken in, by name, onto categories as on the first read; group budgets, which it never saw, are kept.

Categories chosen, carried or typed during a rollback are words, as always: the next load of the Activity tab makes a category for any words that none has yet. A category made with the same name as one of yours is the same category.

**If a read fails.** Budgets or categories that can't be read answer 409 and are never saved over, as before. Transactions are still shown, each under the category it came with, with a note, until the categories can be read.

## Rules, tags and notes, and rolling back

The release that added tags and notes (#40) and rules (#36) ([features.md](features.md#tags-and-notes)) migrates nothing. Its new stores, `tags` and `rules`, start empty, and tags and notes are fields of the record each transaction's exclusion was already kept in (`transaction-annotations`, and `carried-annotations` for a re-link).

**Vendor renames stay as they are.** They were not turned into rules. A rename is the person's own choice for a merchant, made from one of its transactions, so it stays a layer of its own above the rules: kept where it always was (`txn-vendor-renames`), written by the rename route exactly as before, and applied before the rules run, so a rename beats a rule's name, as a category chosen for a transaction beats a rule's category ([architecture.md](architecture.md#tags-notes-and-rules)). Moving renames into rules would have put them in a store the release before can't read: after a rollback every merchant's name would revert, and a rename made or changed during the rollback would be lost on rolling forward. Left where they are, both releases read and write the same renames.

**Imported, SimpleFIN and Lunch Flow rows' names.** Their names came from a bank's file or feed, as a bank row's do, so rules rename them too (a row entered by hand keeps the name typed). A name the person gives an imported row in its edit form is theirs: the row keeps it under `named` (`lib/manual-txns.ts`) while it is the row's name, and no rule renames it. A SimpleFIN or Lunch Flow row's payee can't be edited (it stays the bank's), so it never has `named`, and a rule is how the person renames one. Nothing is migrated for it: a row without `named` is one whose name came with it.

**What a rollback sees.** The release before reads only what it always read:

- **Renames, categories chosen, exclusions**: exactly as before. A record that now also holds tags, tags taken off or a note reads to it as it always did: it sees the exclusion and keeps the rest when it saves one (fields it doesn't know ride along), and it prunes or forgets a whole record as it always did.
- **Not applied, not shown**: rules, tags and notes. Transactions show as the bank and the person have them: one a rule hid counts again, one a rule filed is under the bank's category, one a rule renamed has the bank's name. Nothing is lost: the `rules` and `tags` stores are kept as they are, and apply again on rolling forward. Its re-encryption pass reports their keys as ones it doesn't know and leaves them alone; its data download leaves them out; backups keep them, as they keep every key in a container.
- **During the rollback**: a disconnect carries only exclusions across a later re-link, so tags and notes on that institution's transactions don't come back with it; a category a rule uses can be deleted there, and the rule is then shown broken and does nothing until it is changed, never filing anything somewhere else. A manual row's `named` is a field that release doesn't know: its rows read and save as before, keeping it; a name it gives an imported row isn't marked as the person's, so on rolling forward a rule that matches the row may rename it (the name stays stored, and the person can give it again).
- **The cached transactions** (at most six hours old) pass that release's check. Their rows hold three fields it doesn't strip, the account a row is on, a renamed merchant's bank name and what a row carries from an earlier account, which reach only the person's own browser, which ignores them, until the cache next expires.

**Rolling forward again.** The transactions cached by the release before are a miss (they lack what rules and re-links read, `layer_facts`), so each person's next load syncs once. Rules, tags and notes are where they were.

**A new field in a rule** ships in two releases, as allocation settings do: one that reads it, then one that writes it. The rules' stored shape is closed, so a rule with a field this release doesn't know makes every rule unrecognised (none applied, nothing saved over them), rather than one rule applied without a condition and matching more than it should.

## Goals: plans and rolling back

The release that gave goals plans (#42, [features.md](features.md#savings-goals)) keeps each goal's plan (its allocation, monthly target, target date and whether it is archived, with what the server works out for them) in a store of its own, `goal-plans` (`lib/goal-plans.ts`), one entry per goal id. The `goals` value keeps each goal's name, target and account, as before. There is nothing to run: a goal without an entry has no plan, and reads exactly as it did.

**What a rollback sees.** The release before reads `goals` as it always did: every goal, archived ones among the rest (it has no archive), each counting its account's whole balance (it has no allocations), with no monthly target, date or projection. It neither reads nor writes `goal-plans`, a store it doesn't know, and its saves rewrite `goals` with the four fields, which is all this release keeps there, so no save of its loses anything set in this one. It refuses to save more than 20 goals, and this release keeps to that limit, archived goals included, so it can always save. It doesn't know the `goal-plans` key either: its data download leaves the plans out, and its re-encryption pass names the key under `unclassified` and leaves it alone ([above](#moving-existing-data-to-the-data-key)), so the pass reports complete again only once this release is back.

**Rolling forward again.** Each entry holds its goal's four fields as the save that wrote it left them in `goals` and, only while that save hasn't finished, the goal as it read before it (`before`). On the next read:

- a goal whose four fields are those: its plan, as set;
- a goal that a save which stopped between its writes left with its four fields as they were before it: as it read before that save, plan and all;
- a goal the release before renamed, retargeted or moved to another account, even back to how it was before this release's last save: its plan still applies, but an allocation, and where the line to its target date starts, only on the account they were set on (following account links, so a reconnect doesn't count as a move): an allocation is never a claim on another account. The goal then counts what the allocated goals leave, as it did there, says what its allocation was, and the next save drops it; a goal with a target date shows no "where you should be" line until the next save starts one on the account it tracks now;
- a goal the release before deleted: its entry belongs to no goal and is never read as anyone's (goal ids are random, so no later goal can take it over), and the next save deletes it;
- a goal the release before added: no entry, no plan.

Nothing else set is lost, and no entry outlives the next save. A save the page was told failed may leave `before` in an entry until the next save; only then can the release before, setting a goal back to how it was, bring back the plan it had before that save.

**The order of a save.** A save writes the entry of every goal it lists with a plan, and of each plan it empties, in one write (one `HSET`, all or none), each changed one with the goal as it read before the save; then `goals`; then settles the entries, in compare-and-set writes of up to 16 entries each: it clears `before` from those it wrote, and deletes those no goal needs (of goals it removed, those the release before left, and plans it emptied), each only while the entry is still what this save wrote or read. Whatever point a save stops at, every goal reads either as it did before the save or as the save left it, never a mix: a changed entry carries the goal as it read before, and reads that way until `goals` holds the new fields (a save that changes only plans leaves the four fields in `goals` as they were, so it is whole once its entries are written); an entry for a goal the save adds belongs to no goal until `goals` lists it; and an entry the save deletes belongs to no goal by then. The page is told the save failed, and shows what is stored; the next save settles what it left.

**Two devices saving at the same moment.** `goals` is the list of whichever save wrote it last, as with `goals` alone, and every goal in it has the plan one of the two saves gave it: each save writes the entry of every goal it lists. Those writes are plain, so whichever save writes an entry last wins it, as whichever writes `goals` last wins the list; settling is the only compare-and-set, and each entry carries the random id of the save that wrote it (`save`), so settling never deletes an entry, nor clears its `before`, once another save has written it since this one read. A goal one device deletes, which the other device's page still lists and saves last, comes back as that page had it, plan and all.

**A page from before plans.** A page cached on a phone from the release before sends goals without plans; each keeps its stored plan, so it can't clear an allocation it can't see. This release's page always sends each goal's plan, even an empty one.

**If a read fails.** Goals or plans that can't be read answer 409 and are never saved over, as goals always have: the card says so and editing is paused. A plan saved by a later release reads as unrecognised, also 409, and is kept exactly as it is, for that release to read again. When it is plans, the 409 says so (`repair: "goal-plans"`, with their goals under `unreadable_ids` and `unrecognised_ids`), and the card offers to remove those whose bytes are damaged, once the person confirms (`POST /api/goals` with `{ "action": "repair", "confirm": true }`, `removeDamagedPlans` in `lib/goal-plans.ts`): each is removed only while it is still the damaged bytes read, as the [storage seam](architecture.md#storage-seam) allows, and its goal then reads with no plan. A plan under `unrecognised_ids` is never removed. Removing can't be undone from the app, so a plan a backup can recover is best recovered before the person removes it; a deletion by hand (`HDEL <prefix>:c:<id>:goal-plans <goal id>`) is no longer needed. Account links that can't be read stop a save, since a save decides on them whether a goal moved: a damaged link, or what Nya keeps of a stored connection's accounts (`accounts:meta`, which tells a link whose earlier id is live again), answers 409 with which it is and what still works, and nothing is written. The card still shows the goals, each on its account id as stored, and says why the save didn't go through: a damaged link is removed under Reconnected accounts on the Accounts tab; a connection's record is written again the next time its accounts load. A record of a connection no longer stored names no live account, so it stops nothing.

## Budget rollover and rolling back

The release with budget rollover and income carryover ([features.md](features.md#budget-rollover-and-income-carryover)) keeps what it adds in two stores of its own, beside the budget set: `budget-months` (each budget's amounts by month and the months it rolled over) and `income-carryover` (the setting). It never changes the `budget-set` store's shape, and writes it exactly as the release before does. There is nothing to run: the record begins the first time the app is opened after this release with budgets set (`since`), and a budget's amount in a month before then is assumed to be its earliest recorded one.

**What a rollback sees.** The release before reads neither store: it shows every budget flat, from `budget-set`, as it always did, with no carry, no month picker and no income pool. Nothing it saves can reach the new stores, so nothing it saves can corrupt them; its budget saves write `budget-set` and the name-keyed copy as before ([Category ids](#category-ids-the-migration-and-rolling-back)). Backups keep both stores, as they keep every store on the seam.

**Rolling forward again.** The app's next read of the month's budgets (on opening it) notes what the release before changed in the budget set, against what the record last saw:

- **an amount it changed** applies from the month it is first read here; the months before keep the amounts recorded for them. A change made during the rollback in an earlier month is so counted from the month it is first seen: the months between show the amount before it, and a carry across them counts that amount;
- **a budget it added** had none before the month it is first seen, so a rollover turned on for it counts from then;
- **a budget it removed** ends its rollover from that month (turned on again, it starts afresh);
- **a category it merged** is followed: the record of the merged one is read as part of the one it went into, amounts added month by month, and moves there with the next change; **one it deleted** is dropped.

Rollover settings and the income setting themselves are as they were before the rollback.

**If a read fails.** A record or setting that can't be read is never taken for none: the Budgets tab's month answers 409 and says so, showing this month's budgets without any carry; rollover changes are refused (409); the read-only API answers 409 `unreadable`; the download names the part it couldn't read. Budgets still save: a save writes only the budget set, and the record, once it can be read again, notes the change as of the month it is read in, as it does after a rollback. Nothing is saved over either store. A damaged record is a backup to restore, or a bug to fix: a record a later release wrote reads as unrecognised and waits for that release.

## Sharing more than accounts, and rolling back

The release that lets a person share their net worth, spending, holdings, budgets and chosen goals beside their accounts ([authentication.md](authentication.md#sharing-between-people)) keeps those choices in the share record each connection already has, the `<id>|share|<user>` field of the environment-wide `connections` hash, under a key of its own, `views`, beside `accounts` (or `expiring`, for a share with an end). Nothing else is stored for them: what the other person is shown of each kind is worked out from the owner's own data each time it is read (`lib/share-views.ts`), and each quarter hour of a record of showings (`sharing-access-log`) may carry the kinds it showed, under `views` (each as it was shown, with the ids of the goals shown). Reads of what is shared are counted per person in `sharing-reads`, a counter that ends on its own. There is nothing to run.

**What a rollback sees.** The release before reads a share's `accounts` (or `expiring`) as it always did, and passes over `views`, a key it doesn't know: the other person sees the accounts shared and none of the other kinds, and the owner's drawer shows only the accounts (a share of other kinds alone reads there as one that shares no account, and can't be renewed). Any change it saves to the share, its accounts or its end (Save, or Renew), writes the share without `views`: from then on, rolled forward or not, the other kinds are no longer shared. Its drawer renames through Save too, which sends the accounts with the name, so a rename there drops them the same way. So a rollback can take a kind away, never share one more widely. Removing or blocking the connection deletes the field, `views` with it, as it always did. Its records of showings read as before, the kinds on a quarter hour passed over; a showing it records in the same quarter hour writes that one row back without them. Its data download leaves the other kinds out.

**Rolling forward again.** A share the release before didn't save is read with the kinds as they were chosen, and they show again at once (the person can't have meant to end what their drawer didn't show them, so check with them if they changed sharing meanwhile); one it saved has none until they are chosen again. A kind, a level or a field this release doesn't know, written by a later one, is read as not shared, never as more.

**If a read fails.** Each kind is worked out on its own: one whose data can't be read (the budgets, the goals, the allocation settings, holdings history, an account's end, a bank's stored transactions, a manual account's book, rows imported from files into a linked account, or an account net worth or holdings would count that couldn't be read or hasn't been loaded) says so on the other person's card and in the owner's preview, never a short figure, and the rest is shown. Storage out of reach fails the read of that person's share whole, as it does for accounts. Nothing on this path writes to the owner's data, so there is nothing to repair here: fix or restore what can't be read, and the share reads again. A goals share can't name a new goal while the goals can't be read (the save answers 409); the goals already chosen stay chosen.

## Rolling back once the brokerage option is on

Once `PLAID_BROKERAGE_LINK=1` is set and anyone has connected with **Connect a brokerage or retirement account** ([deployment.md](deployment.md#brokerage-and-retirement-connections)), **never roll back to a release from before the one that added it.** Those releases ask Plaid for every connection's transactions on every load, and on a connection made with the brokerage option that first call starts Plaid's Transactions product, billed monthly until the connection is removed, wherever the institution offers it. It can't be taken off a connection again. Turning the option off doesn't help: it only stops new connections. Rolling back to that release or any later one is safe.

If you have to go back further, first find those connections. In the Upstash console, each container's `<prefix>:c:<id>:plaid:items` hash holds one record per connection, and the ones made with the brokerage option carry `"transactions_billed":false` (`null` means the lookup when it was linked failed, so it could be either). Disconnect each of them on the Accounts tab (**Options** on its card, then **Disconnect…**) before the rollback, and connect them again once you are back on a release with the check, linking each new account to the one it replaces ([features.md](features.md#removing-an-institution-and-adding-it-back)) so its history carries on. Or keep them, and accept the fee on each.

## Exchange rates, and rolling back

The ECB's reference rates, which a person's home currency converts with ([architecture.md](architecture.md#exchange-rates)), are fetched by a cron of their own, `/api/fx/fetch` at 16:30 UTC, with `CRON_SECRET` ([deployment.md](deployment.md#4-scheduled-jobs)). Crons run on production only, so:

- **A preview or a fresh environment** has no rates until the fetch runs once by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/fx/fetch`. The first run writes the whole history, newest year first (about 28 writes of 170 KB), within the route's minute; one that runs out of time has written the newest years, and the next run finishes the rest. Until then, someone who chose a home currency sees every amount in another currency left out and named ("Nya doesn't have the ECB's rates yet"), never a guess.
- **After a restore into an empty database**, run it once by hand too: backups leave the rates out, as they can be fetched again (`REFETCHED_PREFIXES` in `lib/export.ts`). A restore over a database that has them keeps the running copy's, and an archive the release before took, which holds `fx:ecb`, restores with its copy skipped.
- **`?full=1`** (with the secret) compares and rewrites every year, not only those that can still change, for when you have reason to think the ECB changed a published year. A year is still never written with fewer days than are stored, and the newest publication never moves back.
- **A damaged field** (one that isn't JSON or isn't the shape its id holds) reads as no rate on its days, which every converted figure says as rates Nya doesn't have yet, naming the field ("the USD rates of 2019"). The next run writes it again from the file: a calendar or the newest publication with its year, and a past year's series once the nightly check reaches that year (each run checks the past years, one read of about 170 KB each, from a different one each night, until its writes' deadline; a run that runs out of time logs how many it left). The record names them (`fetch`'s `mended`) and so does the log ("wrote again USD:2019, which were missing, couldn't be used or didn't match the file").
- **When it fails**, it writes nothing from a file it couldn't read whole, records why (`fx:ecb`'s `fetch` field: when, the reason, the newest day it saw, and the last run that worked) and answers 500, so the cron's log shows the failed run. After 30 hours without a run that worked, or with the newest rates over 5 days old, every converted figure and the Currency card say the rates are from that day. All environments share one database, so production, preview and dev each keep their copy, about 5 MB each.

**What a rollback sees.** The release before reads none of it: `currency-settings`, `fx:ecb` and the history's split in a cached payload are unknown to it, so it shows every total as it did, unconverted, whatever was chosen, and the API without the new fields. It has no such cron, so the rates stop where they were until the rollforward's first run. Its backups take `fx:ecb` like any other key, which this release's restore skips. The account directory's `currency` is an optional field: it keeps reading entries with it and drops it from an entry it writes again, after which that account, once disconnected, is counted in the main currency of a converted chart until it is seen again. A Plaid account with only an unofficial currency code (a cryptocurrency) keeps the code this release recorded for it in the remembered accounts and lifecycle entries, which the release before reads as any other currency: its API's `totals` gives it a total of its own, as this release does. A manual account's currency, chosen in its form or corrected in the choice of a home currency, is the field an account kept from a connector already has (`currency` in its record, three capital letters, absent for US dollars): the release before reads it as it reads a kept account's, in that currency, and keeps it on each save (its **Update balance** form, which can't change it, and a scripted push of the balance).

**Converting totals of transactions** (spending, budgets, the Plan, reports, the weekly summary, shares and the API's flows) stores nothing new either: every converted figure is worked out on each read, and `/api/transactions` sends its rates beside the rows, after the cache. A rollback to the release before shows those totals unconverted again, each naming what it left out, and its budgets, Plan and forecast in the currencies they were in, which a home currency never changed. The one write is the person's: moving the transactions typed on a manual account into its corrected currency (only when they tick it) writes each moved row's `currency` field, which the release before reads as any row's currency.

**Rolling forward again.** Nothing to run: the person's choice and their own rates are as they were, and the rates are brought up to date by the next run.

## The Plan's currency, and rolling back

The currency the Plan's typed figures are in is a value store beside the plan, `fire-plan-currency` ([architecture.md](architecture.md#storage-seam)). Nothing to run: a plan saved before has its currency recorded the first time its owner opens the Plan tab with every account loaded, or they are asked.

**What a rollback sees.** The release before never reads the store, and the plan's own shape is unchanged, so its Plan tab and Home's FI card work as before, in the accounts' currency as they always were. A save there writes the plan alone. Back on this release, a save that left every typed amount as it was keeps the record. One that changed an amount leaves the record apart from the plan, so the tab asks which currency the figures are in rather than read them in the old one. A download from the release before has no `fire-plan-currency` part. The release before refuses a download from this one, as it refuses any part it doesn't know.

## The saved plan, and rolling back

**This is my plan** on the Plan tab keeps a value store of its own, `fire-plan-saved` ([architecture.md](architecture.md#storage-seam)), beside the plan. Nothing to run: it is empty until someone saves one.

**What a rollback sees.** The release before never reads the store: its Plan tab has no Progress card, and nothing else changes. A download from the release before has no `fire-plan-saved` part. The release before refuses a download from this one that holds a saved plan, as it refuses any part it doesn't know. Rolling forward again, the saved plan is where it was, and its comparison is worked out again from the balances recorded meanwhile.

## Turning on restores

Bringing a download back into an account ([data-export.md](data-export.md#bringing-it-back)) is off unless `RESTORE_ENABLED=1` ([deployment.md](deployment.md#3-environment-variables)). The release that has it reads everything a restore writes whether it is on or not: the restore's record, the accounts and bank transactions it brought back (`user-restore`, `restored-accounts`, `restored-transactions`, `restored-investment-transactions`), which it holds and doesn't count until linked, the hold on net worth totals and the backfill while a restored bank waits, and the checks that keep the API, the MCP server, shares and the weekly summary from answering out of a restore that hasn't finished. With it off, the card isn't offered and the routes refuse to start, send to, finish or empty; a restore already recorded is still shown, and can still be undone.

**In this order: deploy, let it run, then turn it on.** Deploy the release with `RESTORE_ENABLED` unset, and leave it running long enough that rolling back past it is no longer a plan. Then set `RESTORE_ENABLED=1` and redeploy.

**Never roll back past the release before the one that turned it on.** A release from before this one doesn't know the restore's stores. In an account a restore was written into, it wouldn't read the bank transactions brought back (they'd be gone from Activity, budgets and reports while it runs, and back after), nor the restore's record, so an unfinished restore would no longer hold anything: net worth totals would be recorded short, without the banks that wait, into the real history, for good, and the API and shares would answer from part of the data. Rolling back to the read-side release (the one with the stores, deployed with `RESTORE_ENABLED` unset) or any later one is safe: it reads and holds as this one does, and only refuses new restores.

**Turning it off again** refuses new restores and leaves the ones written as they are, read and held; undo still works. **Nothing to run**, either way: the counters (`user-restore-starts`, five starts, undos and emptyings a day; `user-restore-batches`, two thousand batches an hour; `user-restore-previews`, thirty looks at whether the account is empty an hour) end on their own. A restore's batches are no bigger than 4 MB each, under Vercel's request limit, and each takes at most 60 seconds (`maxDuration`); an undo takes a pause longer than that between its two sweeps, so a batch already in flight can't land after it. Vercel enforces that limit. A host that doesn't (a Node server of your own) still refuses a batch that hasn't begun writing 30 seconds after it arrived, and holds the finish the same way before each of its writes, but a write that is itself slowed past the pause could land after an undo's second sweep: the account then shows that part again, and **Empty this account** (Settings, Your data and privacy, Bring back a download) clears it.

**If a restore's record can't be read** (damaged), the account holds its totals as for one unfinished, and the card offers to empty the account; whoever runs the copy can instead delete the container's `user-restore` key once they have checked what is there.

**The answers about restored banks need no switch.** Whether `RESTORE_ENABLED` is on or not, the card asks about each bank a restore brought back through Plaid that isn't linked: count its transactions as an ended account's, a connection made since isn't it, or which account tracked through SimpleFIN or Lunch Flow carries it on (`restored-answers`, [data-export.md](data-export.md#bringing-it-back)). Rolling back to the release before is safe: it doesn't know `restored-answers`, so the counted banks' transactions are held again there, said under each month, and nothing counts twice (it counts no restored row that isn't linked); the ends the answers wrote are in `account-lifecycle`, which it reads, so those accounts stay ended and hold no total. Back on this release, everything reads as before.

## Carrying a restored account on

An account a restore brought back from a SimpleFIN or Lunch Flow connection, whose new access gives it other ids (a new SimpleFIN Bridge account, another server, Lunch Flow in place of SimpleFIN), can be carried on by the account tracked in its place ([data-export.md](data-export.md#bringing-it-back)): Choose accounts asks which it is, the account keeps its id and history, and the new provider's transactions are matched to the ones from the download as they arrive. It is off unless `RESTORE_CARRY_ON_ENABLED=1` ([deployment.md](deployment.md#3-environment-variables)). With it off, Choose accounts asks nothing and says that a tracked account is a new one, whose transactions count beside the download's where both have them; an account carried on already is still read and matched, and can still be undone.

**In this order: deploy, let it run, then turn it on.** A carried-on account's entry is `version: 2`, which the release before doesn't recognise. Deploy this release with `RESTORE_CARRY_ON_ENABLED` unset, leave it running long enough that rolling back past it is no longer a plan, then set `RESTORE_CARRY_ON_ENABLED=1` and redeploy.

**Never roll back past the release before the one that turned it on.** Rolled back further, for each person who carried an account on, the release before reads their connector accounts as unreadable, as a rollback past Lunch Flow does (below): none is fetched, no total is recorded for them, their transactions are left out, said, and their cards answer 409. Nothing is lost or written; rolling forward, each connection's next fetch asks from before the last day it fetched. It never fetches the new provider's rows without the matching, which would count them twice. Rows taken over keep what they were (`continues`), which the release before reads and keeps through its own writes.

**Nothing to run**, either way. Turning it off again leaves the accounts carried on as they are.

## Lunch Flow and rolling back

Lunch Flow ([features.md](features.md#lunch-flow-and-what-it-costs)) is off unless `LUNCHFLOW_ENABLED=1` ([deployment.md](deployment.md#turning-on-lunch-flow)). **Turn it on only once Lunch Flow has confirmed in writing that people may use their own Personal API key in this app, and once anyone has connected it, never roll back to a release from before it.** Rolling back to this release or any later one is safe. Turning the switch off doesn't make an older release safe: it only stops new connections, and the connections already made stay.

Why: a release from before Lunch Flow knows only SimpleFIN, and reads the connector stores strictly, each as a whole. One entry it doesn't recognise (a Lunch Flow connection, account, key or account let go, each marked `lunchflow`) makes the whole store unreadable to it, so for each person with any Lunch Flow connection, while it runs:

- **every connector account of theirs is unreadable, SimpleFIN's too.** Net worth shows one card that couldn't be read in place of all of them, so no day's total is recorded for that person, as when a bank can't be reached. Activity leaves out every connector account's transactions, saying the SimpleFIN accounts couldn't be read (its only words for them);
- **none of their connections is fetched**, SimpleFIN's included. Each night's run logs `Connectors: N connection(s) in container … could not be read and were not fetched.` and `Connectors: the daily fetch failed for a connection in container ….` for them;
- **the Accounts tab loses their connection cards**: `GET /api/connectors` answers 409, so there is no Refresh, Choose accounts or Disconnect for any of them, SimpleFIN's included, until you roll forward.

Nothing is lost: like anything it can't read, the older release never takes these entries for none and never deletes them, the rows Lunch Flow brought stay in `manual-transactions` as they are, and a rule with Lunch Flow as its source still reads, matching nothing. Rolling forward again, everything reads as before, and each connection's next daily update asks from before the last day it fetched (45 days before for Lunch Flow, five for SimpleFIN), so the days of the rollback are fetched again then (after a long one, SimpleFIN's over the following nights). The net-worth totals those people missed during it are not recorded after the fact.

If you must go back further all the same, first have each person with a Lunch Flow connection disconnect it on the Accounts tab (keeping its accounts as manual accounts, or removing them): with no Lunch Flow entry left in their stores, the older release reads their SimpleFIN connections as before. The entries of accounts let go (`connector-ended`) count too: those are forgotten with **Forget**, under **Accounts you stopped tracking** on the Reports page.

## Letting API tokens write, and rolling back

Writing through the API and the MCP server ([features.md](features.md#writing-through-a-token)) is off unless `API_WRITES_ENABLED=1` ([deployment.md](deployment.md#3-environment-variables)). The variable is read when each request is served, but it lives in the deployment's environment, so **turning it on or off takes a redeploy** (minutes, not seconds). The release that has it reads everything writing writes whether it is on or not: a token's `access` (`balances` or `write`, absent on a read token, which is stored exactly as before), the record of changes (`api-changes`), the keys creates were sent with (`api-change-keys`), and the write counters (`api-write-requests`, a token's writes this minute; `api-write-days`, its changes and creates in 24 hours, all of the person's tokens' changes, and each manual account whose balance a token set that day, so its estimated history is rebuilt at most once a day, with a mark for a push that skipped it, which the nightly snapshot catches up). The record is encrypted, in the person's download and in backups; the keys and the counters are bookkeeping, never exported or backed up. With it off, no token can be made that does more than read, a write path answers as it did before writing existed (405 with `Allow: GET` where reading is served, 404 elsewhere), the MCP server neither lists nor runs a write tool, and the pages say nothing of writing; tokens already made keep their access and read as it allows, and the record, Undo and Forget stay in the app.

**In this order: deploy, let it run, then turn it on.** Deploy the release with `API_WRITES_ENABLED` unset, and leave it running long enough that rolling back past it is no longer a plan. Then set `API_WRITES_ENABLED=1` and redeploy.

**Turning it off again** stops every write at once (after the redeploy) and leaves what was written as it is. **Nothing to run**, either way: the counters end on their own, and the nightly snapshot prunes the record past 30 days and the keys past 24 hours (`pruneChanges` in `lib/api-changes.ts`, beside the records of showings; the app's list prunes too, whenever it is read).

**The fast lever is revoking the token.** For one person, a token that is writing what it shouldn't is stopped at its next request when it is revoked under API tokens; the person sees and undoes its changes under Changes made with your tokens. The switch is for the whole copy, and takes a redeploy.

**Rolling back past the release that turned it on** is safe for reads, and fails closed for writing, but costs a little:

- **A token made to update balances or make changes doesn't work there.** The release before reads a token's record closed, and doesn't know `access`, so it takes the record for one saved by another version: such a token is refused (401, as any token that doesn't work), and the API tokens card names it as saved by another version of Nya without offering to revoke it. Revoke it after rolling forward again, or have the person make a new token; read tokens work throughout.
- **A restore into an account with a record of changes, or recent writes, is refused there.** Its check that an account is empty before a restore counts every key it doesn't know as data: the record (kept 30 days), the keys (24 hours), and the write counters, which outlive their last count by two windows (`api-write-requests` two minutes, `api-write-days` 48 hours). Each makes the account read as in use while it is there. Nothing is lost; the restore can be made after rolling forward, or once those have gone.
- **The record isn't in its download**, which doesn't know the store, though its nightly backup carries it (and the counters, which end on their own).
- **Don't re-encrypt while rolled back.** Its migration pass and master rotation don't know the new stores, so values written by writing would stay under the keys they were written with; run them after rolling forward.

Rolling forward again, everything reads as before: the tokens made to write work again, and their changes are in the record, undoable for what is left of their 30 days.

## Shared expenses: the phone check, and rolling back

Shared expenses ([features.md](features.md#shared-expenses)) need no variable and nothing to run: six stores on the seam (`expense-settings`, `expense-people`, `expense-shares`, `expense-ious`, `expense-payments`, `expense-dismissed`), written only when a person adds someone or shares a cost.

**The phone check, before turning on more links.** Only Venmo's documented link ships on (`https://venmo.com/<username>?txn=charge&amount=35.00&note=...`, and `txn=pay`). The forms nobody documented sit behind `UNCONFIRMED_LINKS` in `lib/shared-expenses/links.ts`, a constant in the code that is `false`: Venmo's app scheme (`venmo://paycharge?txn=charge&recipients=<username>&amount=&note=`), Venmo's form without a username (`https://venmo.com/?txn=...`), and Cash App's amount path (`https://cash.app/$<cashtag>/<amount>`, to pay someone). Before setting it to `true`, check each, and the documented one, on an iPhone and on an Android phone, from the installed app (Add to Home Screen) as well as the browser, with Venmo and Cash App installed and signed in, and once with them not installed: that the app opens (or the web page does), on the request or the payment, to the right person, with the amount and the note filled in and nothing sent until you send it; that a note with a comma, an ampersand, an emoji and 200 characters arrives whole; and that coming back to Nya leaves it where it was. Then change the constant, say which forms were checked, when and on what, in its comment, and update the tests that hold it off (`test/shared-expenses-model.test.ts` and `test/shared-expenses-ui.test.tsx`) and features.md. A form that fails stays off; the message covers it.

**What a rollback sees.** The release before reads none of the six stores. While it runs, every transaction counts as the bank shows it (a shared dinner whole, a friend's payment as money in), no IOU's row counts, and nothing is said about it; its storage report lists the stores' keys as ones it doesn't know, which is expected; its download leaves them out, and a download that has them is refused by its restore, which refuses a part it doesn't know. Nothing is lost: it never deletes what it can't read. Rolling forward, everything reads as before; a share on a transaction split or grouped meanwhile is left unapplied and said, until it is shared again as a part, or the group goes.

- **A restore into an account with shared expenses is refused there**, since its check that an account is empty counts every key it doesn't know as data. Make it after rolling forward.
- **Don't re-encrypt while rolled back.** Its migration pass and master rotation don't know the six stores, so their values would stay under the keys they were written with; run them after rolling forward.
- **A cached Activity read from before the rollback** (for its lifetime, 15 minutes, or 6 hours with webhooks) can carry a field on each posted bank row that the release before doesn't take out before sending it (`content_key`: the row's account id, day, amount and the bank's words, all the person's own), so their own browser receives it, and it is shown nowhere. A disconnect while rolled back records no `carry_key`, so the shares and payments on that institution's transactions don't carry across a re-link after rolling forward: they are listed as gone, to move or keep.

## Receipts and documents

Photos of receipts and PDFs attached to transactions ([features.md](features.md#receipts-and-documents), [architecture.md](architecture.md#receipts-and-documents)) are the first data that doesn't live in the database: their encrypted parts are kept in the same private Vercel Blob store as the backups, under `attachments/<environment>/<account id>/<file id>/<part>`, and only their records (with each file's key, locked with the account's own data key) are in the database.

### Turning them on

They are on in two steps, so whoever pays for the storage chooses to:

1. **A file store, and a master key.** The Blob store the backups use ([Nightly backups](#nightly-backups)) is the file store: with `BLOB_READ_WRITE_TOKEN` set, files already attached can be opened, moved, renamed, deleted and downloaded, the nightly clean-up runs, and deleting an account deletes its files. A file is locked with its account's own data key, so `MASTER_KEY` must be set too ([Turning on the master key](#turning-on-the-master-key)); an account without a key of its own yet can't attach anything until the [migration pass](#moving-existing-data-to-keys-of-its-own-the-migration-pass) gives it one, and the sheet says so.
2. **A quota.** Adding a file also needs `ATTACHMENTS_QUOTA_MB`: the most each account may keep, in megabytes (a whole number from 1; 1024 is a good start). Unset, nothing new can be added and the pages say "Adding new ones is off on this copy of Nya"; what is there stays reachable. Each account may also keep at most 4,000 files, 10 on one transaction, each at most 10 MiB.

Then redeploy. Nothing to run.

**Give the token to Production only**, or make one Blob store per environment. In Vercel, when the store is connected to the project, untick Preview and Development (Storage, the store, Projects, the project's environments), or connect a second store to them. Whoever holds the token can read, list and delete every object in the store, every environment's files and backups among them: a Preview deployment running a branch's code with Production's token could reach Production's files. They are encrypted, and their keys are in Production's database, not the store, but a delete needs no key. Every call the app makes passes the token itself, so the store it writes to is the store it reads from.

The store must be **private**, as for the backups. Each upload checks the address Blob answers with, and a store made public by mistake fails every upload: the object is deleted at once, the sheet says the file store can't be reached, and the log says `Receipts and documents: the file store failed StoreNotPrivateError`. Nothing is ever left readable by its address.

### What it costs

Vercel bills Blob for what is stored, for the operations made and for data moved; the prices change, so see Vercel's [Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing). What each flow does:

- **Attaching a file**: one upload per part (a photo is one part, about 300 KB; a PDF one per 2 MiB, at most 5), and one for its thumbnail.
- **Opening one**: one read per part, through the app's function (data moved from Blob to the function, and from it to the browser), and one for a thumbnail. Nothing is cached, so each look reads again.
- **Deleting one**: one delete call for all its parts.
- **The ZIP download**: one listing of the account's folder when the card gets the download ready and one per ZIP file, and one read per part. A ZIP file holds at most 400 files, so one of many small files still goes out in the route's 300 seconds.
- **The nightly clean-up**: a delete call per abandoned upload or unfinished delete; once a week, a listing of the environment's folder and of each account's folder.
- **Deleting an account**: a listing of its folder and a delete call per hundred objects, for 30 seconds at most, so the deletion's records and key always go in the route's time; what is left is unreadable once the key is destroyed, and the nightly clean-up empties the folder (the receipt says how many were left).

What is stored, and what the quota counts, is each file's encrypted parts and its thumbnail: their own size plus 29 bytes each.

### The nightly clean-up

Object storage has no foreign keys, so a cron (`/api/attachments/sweep`, at 17:30 UTC, after the backup and checking `CRON_SECRET`) keeps the store and the records saying the same: it throws away uploads left unfinished a day past their hour, finishes deletes the store couldn't take at the time, works out each account's usage and index again from the records, and checks where files are placed against the stored transactions (for an account a failed step marked, and every account once a week). Once a week it lists the store: an object no record names is deleted only once no kept backup could still hold a record naming it, so a record a backup could bring back always finds its file; and a deleted account's folder is emptied. For the nightly backups that is exact: only once the oldest data archive still in the backups' folder was taken after the object was first seen unnamed (one listing of `backups/<environment>/`), so a long backup outage, after which old archives are kept as the newest seven, or a cron that ran late, never shortens it. And at least `DATABASE_BACKUP_DAYS` + 1 days, and 2, after it was first seen, for the database host's own backups ([deployment.md](deployment.md#3-environment-variables): set it to what Upstash keeps, or a restore from one of its backups could bring back a record whose file the clean-up has deleted). Never while the backups are failing, or while `BACKUP_KEEP_DAYS` or `DATABASE_BACKUP_DAYS` is invalid, nor while an account's registry status says it is being restored; a folder of an account that is neither in the registry nor deleted is logged and left alone, as is any object whose name isn't a file's id. When it fails, the admin can run it again from the Nightly jobs page (`/admin/jobs`), except while the breaker holds it.

**Not while a restore may be running.** An operator restore ([Restoring a backup](#restoring-a-backup)) deletes the backups' record as its first write, and only the next nightly backup writes it again. While backups are kept and that record isn't there, the clean-up writes nothing at all (the run's answer says `paused`), and it checks again before each account and before the store-wide pass, so one that started before the restore stops at the next account. Keep restores away from 17:30 UTC all the same.

**The breaker.** In an account whose folder has objects and no record at all, or where more than 20 percent of its files, or more than 50, would go in one pass, the clean-up deletes nothing there, logs `Receipts sweep: the breaker held account <id> (…)`, and the dashboard says it held back for a week. That is what records wiped by mistake look like (a bad restore, a migration that went wrong): check the account's `attachments` records before anything else. If they are truly gone and the objects are to go, delete the account's folder (`attachments/<environment>/<account id>/`) in the store's browser; the objects can't be opened without the records anyway.

The dashboard also says when the last run failed, with the reason, when none has finished for nine days, and that it is paused while the backups' record isn't there (below). A run does what it can in four minutes and the next one carries on from the account after the last it finished.

### Backups, restores and the files

**The files are in no backup.** The nightly backups copy the database, so they hold each file's record and its locked key, never the file. This copy keeps one copy of each file, and the card in Settings asks people to download theirs; the store's own durability is Vercel's. A file someone deletes is gone once its objects are: no backup restores it.

**Restoring a backup** of the database brings back the records as they were that night. A file deleted since has no objects any more, so it says it can't be opened (the person deletes it); a file added since has objects and no record, which the clean-up deletes once no kept backup could name it (the wait above, from when it first sees it), never before. Files are kept under the environment's name (`REDIS_PREFIX`, or `VERCEL_ENV`): a backup restored under another prefix finds every file "not in storage" until its folder is copied across, from `attachments/<old environment>/` to `attachments/<new environment>/` (a short script with `@vercel/blob`'s `list` and `copy`, passing `access: 'private'`), and its records stay as they were meanwhile.

**Rotating the master key** and the migration pass leave the files alone: each file's key is locked with its account's own data key, which a rotation locks again under the new master and never replaces. **An account's own data key must never be replaced or retired while the account lives**: every file key would have to be locked again under the new one first, and nothing does that yet.

### Before turning attachments on

What the tests here can't check, on real devices, once on a Preview deployment with its own store:

- **A PDF**: tap Save in the viewer, and open the file, in Chrome, Firefox and Safari on a computer, in Safari on an iPhone, and in the app added to an iPhone's home screen. A PDF is only ever saved in this release, never shown in the page, because which policy each browser's own viewer accepts needs those devices.
- **A HEIC photo from a real iPhone**: Take a photo in Safari, and choose a HEIC one from the library in Safari, and in Chrome on the iPhone; it should arrive as a JPEG with no location. Chrome or Firefox on a computer or an Android phone should refuse a HEIC with what to do.
- **A long till receipt** photographed whole: readable once zoomed.

### Rolling back

A release from before this one doesn't know the stores: the records and the files stay as they are, unread, and nothing deletes them. While it runs, an account's deletion deletes its records and destroys its key, so its files can never be opened again, but leaves its objects in the store; rolling forward, the clean-up empties that folder. Its restore's check that an account is empty counts the records as data. Turning the quota off is the lever that stops new files, and needs no rollback.

## Repairing balance signs

An account read as the other kind (money held, money owed) from some day on reads every day before it the other way in converted history, the chart with it hidden and the estimate, though every recorded total stays right ([architecture.md](architecture.md#net-worth-history), `lib/sign-repair.ts`). A change of what a SimpleFIN or Lunch Flow account is re-signs its history itself, and a manual account can no longer change at all. What is left is accounts changed under an older release: a manual account flipped before the app refused it, or a tracked one whose kind was changed before a change re-signed its history. `POST /api/ops/sign-repair` (locked like every ops route) finds and repairs them, one container at a time:

1. **The dry run.** `{"container": "<id>"}` (the ids from `/api/ops/containers`) writes nothing, and answers each manual or tracked account in it some of whose days were counted the other way, or can't be told, and every job under way: its id, whether it is manual or tracked (`gone` for a job whose account is neither any more, which its next run drops), its type now, how many values a repair would turn over by layer (`r` recorded, `p` partial, `e` and `f` the estimate's walked and flat, `x` walked past it), and the first and last day. Ids, days and counts only: never an amount or a name.
   - **Which days.** On a day with a recorded total, every set of the day's accounts with a known type (Plaid's too: a bank can change an account's kind as well) whose balances, counted the other way, explain that total is weighed. An account in every such set is proven counted the other way that day; one in none, counted as now; one in some but not all, can't be told. A day without a total (a partial day, a value walked past the estimate), or one nothing proves, is inferred from the nearest proven days on both sides when they agree, assuming the account didn't change and change back between them. So `days` counts proven and inferred days alike. On a day with more than 24 accounts holding a balance, only the manual and tracked accounts are weighed, every other account taken as counted as it reads now, so the proof there leans on that; with more than 24 of those, nothing is proven (it would take too long to weigh): its days are inferred, or reported `undetermined`.
   - `refused`, with the days and why, when the days can't be told exactly: a day some sets of accounts explain with it and some without (two flipped together whose balances add up to a third's, two equal balances, or a held and an owed balance that cancel out, which can never be told apart), which refuses the repair of each such account; a day between one counted the other way and one counted as now; or a run counted the other way reaching an end nothing marks. `days` is then empty: a refused repair turns nothing over.
   - `undetermined` (`count`, the first ten `days`, and `why`, how many of them for each reason: `no-total`, `ambiguous`, `untyped` for an account on the day whose type isn't known, `too-many` past 24 manual and tracked accounts, `unexplained` for a total nothing explains, `unreadable`): days nothing tells, with a proven day counted as now on one side only (or none at all), such as a partial day before the first total. A repair leaves them as they are; they may count the other way, and only a look at the account's own history can say.
   - `pending` (`kind`, `retype` or `repair`; `failures`, the nights in a row on which the nightly job failed on it, or ran out of time, without getting through any of it (a night that gets through some of it sets the count back, and if it then fails, counts as the first of a new run); `error`, the last failure's kind; `stopped`, once three such nights in a row have passed and the nightly job no longer tries it): a job under way. A job record this release can't read makes the whole dry run answer 409 with `unreadable` and its id. The short record a finished job leaves (below) isn't listed.
2. **The repair.** `{"container": "<id>", "account_id": "<id>", "repair": true}` finishes the account's job if one is under way, else plans one: it turns the account's value over on exactly the days the dry run counted, under the links lock, each in one step and only while the value there is still the one planned, and answers how many (`negated`), with `undetermined` for the days it left. A day with a total is also decided again as it is then, and left when it now reads as counted as now (an estimate rebuilt since, say): a manual account's balance is the same number either way, so its value alone can't say. Every total stays as it was recorded. Refused (409, with the `days`) when the dry run says `refused`, writing nothing; answered `negated: 0` when there is nothing to repair. Run again, it finds nothing.
   - `pending: true`: it stopped at its time (90 seconds under the lock, so it fits the lock's lease), what it did kept. Send the same body again.
   - `abandoned`, in words: the job was planned for the account as one kind and it is the other now (changed back under the release before, say), so it was dropped and nothing more was turned over. Run the dry run again: it reads the account as it is now.
   - Refused while the account is being forgotten (finish the forget first); a forget of the account, and the API's undo of an account it made, are refused while its job is pending.
3. **Cut off part way** (a timeout, a 500), it is finished by sending the same body again, by the next nightly snapshot, within 5 seconds of each container's run (`SIGN_BUDGET_MS`, off its start budget, so the run still ends in time; a long one goes on another night), or by a download of the person's data, within 90 seconds; none turns a day over twice, and each run takes what it went through out of the job's plan when it stops, so the next goes on from there. A job that fails, or runs out of time before going through a single day (`error` is then `Stalled`), on three nights in a row without getting through any of it is left for you (a night that gets through some of it and then fails counts as the first of a new three, and a download's failure counts none): the dry run shows it `stopped`, with the kind of its last error in `error`; the log has the rest (`Balance signs:`), and a forget or an undo of the account says whoever runs the copy can finish it. Send the repair once the cause is fixed.
4. **After it finishes**, a short record stays in its place for at least ten minutes, until the next run (the nightly snapshot at the latest): that run decides the day it finished, the day it began, and the day before each, again by their totals, and turns over a day proven counted the other way. That catches a recording that read the account's old kind just before the change and landed after the job had turned its day over. A day measured without a total is left so, and the record then goes.

An account's earlier ids (from before a re-link) are not re-signed, by a retype or a repair: their days may still read the other way in converted history.

**A download brought back while a job was pending.** A download made while an account's job couldn't finish says so in its notes, and that account's earlier days are partly in each sign. Brought back into another copy (or a new account), the restore's finish plans that account's repair from the history it brought back and finishes it, but only where every day is told exactly: there is no dry run to look at first. With a day the dry run would answer `refused` or `undetermined`, it turns nothing over, the account waits (`restored-sign-repairs`, state `waiting`, with the first days), and the restore card names it and those days, saying whoever runs the copy can repair it. Run the dry run and the repair above for it, as for any account: the repair clears the card's note. One the finish didn't get to (the links lock held, out of time) is planned by the next nightly snapshot or download. A planned one is an ordinary job: one the nightly job has stopped trying (step 3) is said so on the restore card, which then says whoever runs the copy has to finish it; send the repair once the cause is fixed.

A container being restored answers 409; run it once the restore is done. **Rolling back** past this release is safe: no stored shape changes and no reader does, so the release before reads every repaired day right. It ignores the record of a job under way (`sign-repairs`), and what a restore found of one (`restored-sign-repairs`), so finish any before rolling back: until then those accounts read there as they always did. Its own change of a tracked account's kind doesn't re-sign anything, as before; when that change takes an account with a job under way here back across, the job is dropped with words when it next runs, and this release's dry run finds the account afterwards.

## Email and the weekly summary

**Turning email on.** Set `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL`, and with the shared password `NOTIFY_EMAIL` ([deployment.md](deployment.md#email-notices) has the steps), then redeploy. That turns on every email at once: the connection notices, the download and API token notices, and the [weekly summary](features.md#the-weekly-summary), which stays off for each person until they turn it on in **Settings**, Your data and privacy. Nothing else is needed for it, and there is nothing to run. Its emails come from the daily snapshot, so only production sends them (crons run only there), but **Send me one now** works on any deployment with email and `APP_URL` set up, Preview's demo accounts excepted. The card says when this copy can't send one (no email, nobody to write to with the shared password, no `APP_URL`), and still shows what it would say.

**Turning it off for everyone.** There is no switch of its own. Unsetting `APP_URL` stops every summary (each must carry its link to turn it off), and only leaves the other emails without their link; unsetting `RESEND_API_KEY` or `MAIL_FROM` stops every email. Each person's setting stays as it is, and the summaries start again when the setting comes back.

**What the log tells you.** Every line starts `Weekly summary:`, names a container by its opaque id at most, and never carries an address, an amount or what the email said.

| The line says | What it means, and what to do |
| --- | --- |
| `emailed N summaries.` | The run sent that many. |
| `N summaries are due, but APP_URL is not set ...: none was sent` | Set `APP_URL`. They go with the next run that finds them due (the catch-up, or a day or two later). |
| `no time left for this run's summaries; N container(s) wait for the next run.` | The run's mail deadline came first. Seen now and then, nothing to do: they go with the catch-up or the next day. Seen every send day, more summaries are due on one day than one run can send: see [architecture.md](architecture.md#the-weekly-summary). |
| `the email service is failing, so N other container(s) wait for the next run.` | Resend gave no answer, a 5xx or a 429 twice. Its status is on the line before (`was not sent; trying again next run.`, with the status and Resend's error code). Check Resend's status page and the API key. A send that got no answer at all is marked in its container's record, as it may have gone. |
| `the summary for container ... was not sent: The weekly summary would have carried ...` | The check before sending found what looks like a figure, and nothing went: a bug in the words, never something to put right by hand. Report it with the kinds the line names; the person's next week tries again. |
| `the setting or record of container ... could not be read, so no summary goes for it.` | A damaged or unrecognised `weekly-summary` or `weekly-summary-state`. No summary goes for that person until it reads again: a backup to restore, or a bug. Deleting `<prefix>:c:<id>:weekly-summary-state` by hand only makes a new key (links in emails already sent stop working) and forgets the last week sent, so one may go again that day. Deleting `<prefix>:c:<id>:weekly-summary` turns the summary off, as if it was never set. |
| `... could not be read for container ..., so that part is left out.` | One part of a summary (its transactions, budgets, goals, planned items or connection records) couldn't be read; the email said so, and the rest went. The same data is unreadable in the app. |
| `the transactions of container ... could not all be brought up to date` | The sync before the summary failed, or ran out of time (`Bringing transactions up to date took longer than 20000 ms`). The summary said which connection's transactions aren't in, rather than comparing the week. |
| `... could not be made; trying again next run. Reading the summary took longer than 15000 ms` | Reading what the summary says ran out of time, so none went for that person this run. Seen every week for one container, its data takes longer to read than the summary allows: report it, with the container. |
| `N sync(s) that ran out of time were still going when the run ended` | A sync went on past its 20 seconds and the run's end. The next sync, the app's or the next run's, puts right whatever it writes. Seen often, Plaid is slow to answer. |
| `the email service refused this week's key for container ..., and no earlier try under it went unanswered` | Resend kept the week's idempotency key from an earlier request that didn't go, and the summary has changed since. Nothing is recorded, and the week goes once the key lapses, a day after it was first used. |
| `nobody to email for container ...` | With the shared password, set `NOTIFY_EMAIL`; with Clerk, the owner's address isn't verified or the account is no longer allowed in. |
| `the time zone set for container ... is not one this runtime knows` | The runtime's time zone data lacks a zone saved earlier. The summary waits; it goes once the runtime knows it, or the person picks another. |
| `turned off from its link.` | Someone used the link in an email. Nothing to do. |

A flood of links that don't work is turned away by address, counted with the API's tokens that don't work (600 in 10 minutes, `lib/api-limits.ts`); nothing about it is logged per request.

**Rolling back.** A release from before the weekly summary doesn't know its stores: it sends nothing, leaves them as they are, and its re-encryption pass names them under `unclassified` and leaves them alone, as for `goal-plans` ([above](#goals-plans-and-rolling-back)). It doesn't have the link's route or page either, so a link in an email already sent asks the person to sign in, and turns nothing off, until this release is back; no summary goes meanwhile. Rolled forward, every setting is as it was, and the summaries start again with the next send day: a week the rollback missed by more than two days isn't sent late.

## An address locked out of the login

Ten wrong passwords from one address (the login and the password asked for before a data download count together) shut that address out of the password login for 15 minutes from the first of them. Each count is written together with its expiry in one step (`lib/rate-limit.ts`), so a lockout always ends on its own: there is no key to delete by hand. A count left without an expiry by an older release (which set the expiry with a second request that could fail) is given a whole window the next time that address tries. The demo sign-in's limit per address (on Preview) is counted the same way.
