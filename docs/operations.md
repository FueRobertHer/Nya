# Operations

Runbooks for keeping the data safe: backups and restores, encryption keys, containers, email and the weekly summary, and what a rollback must not undo. For setup see [deployment.md](deployment.md); for how the data is stored see [architecture.md](architecture.md).

Everything under `/api/ops/*` is locked the same way (`lib/ops.ts`): it answers 404 unless `OPS_ENABLED=1`, accepts POST only, and compares `OPS_SECRET` in constant time. Set `OPS_ENABLED=1` only while you run an operation, then remove it and redeploy, so a leaked `OPS_SECRET` is useless on its own.

- [Backups](#backups)
- [Restoring a backup](#restoring-a-backup)
- [Encryption keys](#encryption-keys)
- [Plaid secrets in older logs](#plaid-secrets-in-older-logs)
- [Containers](#containers)
- [Moving the data into containers](#moving-the-data-into-containers)
- [Category ids: the migration and rolling back](#category-ids-the-migration-and-rolling-back)
- [Rules, tags and notes, and rolling back](#rules-tags-and-notes-and-rolling-back)
- [Goals: plans and rolling back](#goals-plans-and-rolling-back)
- [Budget rollover and rolling back](#budget-rollover-and-rolling-back)
- [Rolling back once the brokerage option is on](#rolling-back-once-the-brokerage-option-is-on)
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

Check it worked the next day: the cron's log in Vercel says "Backup written", with the key archive's name, and both files are in the store's browser. Before that line, it logs how long each step took (export, upload, read-back, count, list, keys, prune). A failed night shows as a failed cron run with the reason, and the older copies are left alone. Each step has a time limit, so a storage call that doesn't finish in time fails the run naming that step (for example "The backup's read-back step took longer than 45s") instead of running into Vercel's 300-second limit with no reason given. "Took longer" can mean the call never answered or that Vercel Blob kept retrying it (it retries server and network errors up to 10 times); to tell which, set `DEBUG=blob` on Production for a night, and the log shows each retry. A copy whose upload or read-back ran out of time may still be in the store, unchecked. Vercel doesn't send an alert for it, so the dashboard shows a note when the last backup failed or none has been saved for two days.

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

Not everything in it is encrypted, so still treat the file as private: dates, account, transaction and connection ids, the names of your linked banks (and whether Plaid included transactions when each connection was linked), the merchant names you have renamed, and for sharing, the names people gave each other, which accounts each shares at which level and until when, and for each connection the random id its records of showings are kept under and when they began (not what they record), are stored as plain text. The database holds the same in plain text, and the public Security page (`/security`) says so.

The last line also carries a checksum, so a file damaged in storage or transit is caught before it is restored. It is not a signature: it will not stop someone who edits the file on purpose.

Caches and the login's rate-limit counters are left out on purpose. So are API tokens and their request counts (`api-tokens`, `api-requests`, declared `backup: false` on the storage seam): a backup must never bring back a token revoked after it was taken, which nothing could tell its owner, so a restore ends every token and people make new ones. Each account's count of data downloads is a store on the storage seam, so it is kept like the rest, with its expiry. Avoid running it around 13:00 UTC, when the daily snapshot writes.

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

With `--overwrite`, it prints how many keys it is about to replace, saves the target's current contents as a pair, `nya-pre-restore-<target>-<time>.f2.ndjson` and its keys in `nya-pre-restore-<target>-<time>.keys.ndjson`, and checks they hold every key it is about to delete. Then it **replaces** the target entirely (login rate-limit counters aside), so nothing newer than the archive survives. API tokens are in no backup, so afterwards every token is gone: tell the people who use the deployment to make new ones under **Manage**, **API tokens**. If the target changes while this is going on, it stops before deleting anything. It finishes by reading everything back, the key store included, and comparing it with what it restored, and reports success only if they match exactly. If a restore stops part way, run it again with `--overwrite`.

File paths are resolved from the repo root, since `bun run` runs there, and that is also where the pre-restore file is written.

Don't use the app while a restore is running, and avoid 13:00 UTC: anything written to the target mid-restore makes the final comparison fail. If a deployment serves the target (restoring over production, say), **redeploy it right after** the restore: a running instance remembers the data key it writes with for up to a minute, and if the restore replaced that key, anything it writes meanwhile can never be read.

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

**Keep `PLAID_ENCRYPTION_KEY` in Vercel even after the pass completes.** It costs nothing, values outside the containers and archives taken before the pass still need it, and if it is marked Sensitive in Vercel (so it cannot be read back out) and you have no other copy, removing it is permanent: any value still under `k0` then (an old backup, a fallback write) could never be read again. The environment's data keys stay too, for the same reasons.

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
- **Rewritten at every deletion.** The last step of an account deletion rewrites every kept generation without the destroyed keys, and so does each nightly run for any generation still lacking a tombstone. A rewrite is a pure filter of the file before it (the destroyed keys' lines dropped, and every tombstone it lacks added), named after the file it replaces and checked line by line as exactly that before that file is deleted. A run reads a file only when its name says it lacks a tombstone, so a night with no deletion since the last reads just the generation it builds on.
- **One writer at a time.** Reading the store, writing, checking and deleting older files happen under a lock (`backups:keys-lock`: a token, an expiry of two minutes, released only by its holder, like the snapshot's). After writing, the writer reads the tombstones again and rewrites any generation still holding a tombstoned key before it deletes anything. The nightly run waits up to 30 seconds for the lock, then fails. A deletion waits 5 seconds and takes 20 at most; if it can't, it leaves a marker (`backups:keys-pending`) that the next nightly run honours and clears, and its receipt says "by the next nightly backup".
- **A short cache lifetime.** Key archives are written with Vercel Blob's shortest cache lifetime, 60 seconds, since a deleted blob can still be served from its cache that long.
- **How many keys fit.** Measured on a local Redis through the same client calls, with an in-memory blob store: at 30,000 keys a night with nothing to rewrite took 2.7 s of CPU, 159 Redis requests and 7 blob calls moving 23 MB (about 8 s at 25 ms a request, 100 ms a blob call and 50 MB/s), and one rewriting all seven generations (a deletion's rewrite the nightly run caught up on) 5.4 s, the same requests and 35 blob calls moving 186 MB (about 17 s). So inside the key step's 40 seconds, a night that rewrites everything fits about 50,000 keys, and a quiet one well over twice that; a deletion's rewrite fits its 20 seconds up to about 40,000, and past that is left for the nightly run, which its receipt says.

The map, `crypto:container-keys`, stays in the data archive, with the data it describes. Once the data archive reads back, and before the key archive, the nightly run counts, from the headers of the values it already holds, which containers have a value under `k0` or an environment key, and notes the archive's time in each one's map entry (`shared_in`), clearing its `moved` if set, so the pass walks it again. It notes too, from the folder's listing, the time of the newest format-1 archive taken after a container's key was made (`key_in`: a rollback's, which holds the whole key store, this key included), clearing `moved` the same way, since the release before may have written the container's values under a shared key. A run that can't write and check its key archive fails, and the dashboard says so, though its data archive is kept (with what it counted) and nothing is pruned. A data archive alone can't be read even with `MASTER_KEY` (values under `k0` aside): it needs a key archive.

**A key archive that doesn't read back.** A run reads the newest generation, to build on, twice before it gives up on it; then it fails, naming the file, and writes nothing, rather than build tonight's on less. Download that file from the store's browser and look: if it is damaged, delete it there, and the next run builds from the generation before it. A key only it carried (one that had left the live store) is then gone from the archives, unless you put its line's record back in `crypto:keys` by hand. An older generation that doesn't read back is deleted by the run that finds it, which logs it: the generation after it was built from it, so holds everything it held but the keys destroyed since. A deletion that finds the newest damaged leaves its rewrite for the nightly run, and its receipt says so.

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

**If a read fails.** Goals or plans that can't be read answer 409 and are never saved over, as goals always have: the card says so and editing is paused. A plan saved by a later release reads as unrecognised, also 409, and is kept exactly as it is, for that release to read again. The app doesn't yet offer to remove a damaged plan: one that can't be recovered from a backup (the 409 names its goal under `unreadable_ids`; never one under `unrecognised_ids`) can be deleted by hand in the Upstash console, `HDEL <prefix>:c:<id>:goal-plans <goal id>`, and its goal then reads with no plan. Account links that can't be read stop a save, since a save decides on them whether a goal moved: a damaged link, or what Nya keeps of a stored connection's accounts (`accounts:meta`, which tells a link whose earlier id is live again), answers 409 with which it is and what still works, and nothing is written. The card still shows the goals, each on its account id as stored, and says why the save didn't go through: a damaged link is removed under Reconnected accounts on the Accounts tab; a connection's record is written again the next time its accounts load. A record of a connection no longer stored names no live account, so it stops nothing.

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

## Rolling back once the brokerage option is on

Once `PLAID_BROKERAGE_LINK=1` is set and anyone has connected with **Connect a brokerage or retirement account** ([deployment.md](deployment.md#brokerage-and-retirement-connections)), **never roll back to a release from before the one that added it.** Those releases ask Plaid for every connection's transactions on every load, and on a connection made with the brokerage option that first call starts Plaid's Transactions product, billed monthly until the connection is removed, wherever the institution offers it. It can't be taken off a connection again. Turning the option off doesn't help: it only stops new connections. Rolling back to that release or any later one is safe.

If you have to go back further, first find those connections. In the Upstash console, each container's `<prefix>:c:<id>:plaid:items` hash holds one record per connection, and the ones made with the brokerage option carry `"transactions_billed":false` (`null` means the lookup when it was linked failed, so it could be either). Disconnect each of them on the Accounts tab (**Manage**, then **Disconnect** on its card) before the rollback, and connect them again once you are back on a release with the check, linking each new account to the one it replaces ([features.md](features.md#removing-an-institution-and-adding-it-back)) so its history carries on. Or keep them, and accept the fee on each.

## Email and the weekly summary

**Turning email on.** Set `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL`, and with the shared password `NOTIFY_EMAIL` ([deployment.md](deployment.md#email-notices) has the steps), then redeploy. That turns on every email at once: the connection notices, the download and API token notices, and the [weekly summary](features.md#the-weekly-summary), which stays off for each person until they turn it on under **Manage** on the Accounts tab. Nothing else is needed for it, and there is nothing to run. Its emails come from the daily snapshot, so only production sends them (crons run only there), but **Send me one now** works on any deployment with email and `APP_URL` set up, Preview's demo accounts excepted. The card says when this copy can't send one (no email, nobody to write to with the shared password, no `APP_URL`), and still shows what it would say.

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
