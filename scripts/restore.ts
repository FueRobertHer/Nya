// scripts/restore.ts
//
// Restore an archive from /api/ops/export into Redis. Run locally:
//
//   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --keys nya-keys.ndjson --target restore-test
//
// A data archive of format 2 (the nightly backups' `nya-<time>.f2.ndjson`, and
// /api/ops/export) keeps no keys: it is restored with a key archive (the
// nightly `keys/<environment>/nya-keys-*.ndjson`, or /api/ops/export with
// {"keys": true}) at least as new as it. A format-1 archive, which the release
// before writes, carries its keys inside and is restored without --keys.
// Either way a deleted account is never brought back (lib/restore.ts).
//
// The Upstash credentials come from .env.local (`vercel env pull .env.local`),
// which Bun loads on its own. Every environment shares one database, so those
// credentials reach production too: the prefix is what decides where this
// writes, and it has to be named twice (REDIS_PREFIX and --target) to agree.
//
// Flags:
//   --target <name>        required; must match REDIS_PREFIX
//   --keys <file>          the key archive, for a data archive of format 2
//   --overwrite            replace a target that already holds data
//   --confirm-production   required on top of the above to write production
//   --dry-run              verify the archive and the target, write nothing
//   --allow-empty          let an archive with no keys replace a populated target
//   --allow-different-source
//                          let an archive taken from another environment replace
//                          a populated target (restoring into an EMPTY target from
//                          anywhere, like production into restore-test, needs no flag)
//   --replace-registry     let an archive whose containers differ from the
//                          target's (or that has none) replace the target's
//                          container registry; CONTAINER_ID must be set again
//
// Paths are resolved from the repo root, since `bun run` runs there.
//
// See lib/restore.ts for the checks and their order.

import { writeFile } from 'node:fs/promises';
import { rawRedis } from '@/lib/storage';
import { exportLines, isExcluded } from '@/lib/export';
import { KeyArchiveRefused, keyArchiveNow, verifyKeyArchive, type VerifiedKeyArchive } from '@/lib/key-archive';
import {
  RestoreRefused,
  archiveRegistry,
  checkRegistry,
  checkTarget,
  planRestore,
  restoreArchive,
  targetKeyFacts,
  targetKeys,
  targetRegistry,
  verifyArchive,
  type RestoreClient,
} from '@/lib/restore';

export type RestoreArgs = {
  file: string;
  keys?: string;
  target?: string;
  overwrite: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  allowEmpty: boolean;
  allowDifferentSource: boolean;
  replaceRegistry: boolean;
};

export function parseArgs(argv: string[]): RestoreArgs {
  const args: RestoreArgs = {
    file: '',
    overwrite: false,
    confirmProduction: false,
    dryRun: false,
    allowEmpty: false,
    allowDifferentSource: false,
    replaceRegistry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--keys') {
      args.keys = argv[++i];
      if (!args.keys || args.keys.startsWith('--')) throw new RestoreRefused('--keys needs the key archive’s file.');
    }
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-empty') args.allowEmpty = true;
    else if (a === '--allow-different-source') args.allowDifferentSource = true;
    else if (a === '--replace-registry') args.replaceRegistry = true;
    else if (a.startsWith('--')) throw new RestoreRefused(`Unknown flag ${a}.`);
    else if (!args.file) args.file = a;
    else throw new RestoreRefused(`Unexpected argument ${a}.`);
  }
  if (!args.file) throw new RestoreRefused('Usage: bun run restore <archive.ndjson> [--keys <keys.ndjson>] --target <prefix>');
  return args;
}

/**
 * Export the target to local files before anything in it is deleted, as a
 * pair (the data, and its key store as a key archive), and prove they are
 * complete and hold every key about to be deleted. Excluded keys (caches) are
 * the only ones allowed to be missing from them.
 */
async function backUpTarget(client: RestoreClient, target: string, existing: string[]): Promise<{ data: string; keys: string }> {
  let text = '';
  let keysText = '';
  let saved: Set<string>;
  try {
    for await (const line of exportLines(client)) text += line;
    saved = new Set(verifyArchive(text).records.map((r) => r.key));
    keysText = await keyArchiveNow(client);
    const keys = verifyKeyArchive(keysText);
    // What the key archive holds stands for the key store's own keys.
    if (keys.keys.size > 0) saved.add('crypto:keys');
    if (keys.tombstones.size > 0) saved.add('crypto:destroyed');
    for (const name of keys.beside.keys()) saved.add(name);
    saved.add('crypto:rotation-lock'); // a lock, never kept
  } catch (err) {
    // Reworded so it is clear the TARGET could not be saved; the archive being
    // restored is fine. Nothing has been deleted at this point.
    const reason = err instanceof Error ? err.message : String(err);
    throw new RestoreRefused(`Could not back up the target, so nothing was changed: ${reason}`);
  }

  const prefix = `${target}:`;
  const unsaved = existing
    .map((key) => key.slice(prefix.length))
    // The backup leaves out what every export leaves out, containers' included.
    .filter((key) => !saved.has(key) && !isExcluded(key));
  if (unsaved.length > 0) {
    throw new RestoreRefused(
      `The target changed while it was being backed up (${unsaved.length} keys missing from the backup). Nothing was changed; run the restore again.`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const data = `nya-pre-restore-${target}-${stamp}.f2.ndjson`;
  const keys = `nya-pre-restore-${target}-${stamp}.keys.ndjson`;
  await writeFile(data, text, { flag: 'wx' });
  await writeFile(keys, keysText, { flag: 'wx' });
  return { data, keys };
}

/** The key archive named by --keys, checked. */
async function readKeys(path: string | undefined): Promise<VerifiedKeyArchive | null> {
  if (!path) return null;
  try {
    return verifyKeyArchive(await Bun.file(path).text());
  } catch (err) {
    if (err instanceof KeyArchiveRefused) throw new RestoreRefused(err.message);
    throw err;
  }
}

export async function main(argv: string[], client: RestoreClient): Promise<void> {
  const args = parseArgs(argv);

  const archive = verifyArchive(await Bun.file(args.file).text());
  const { header, records } = archive;
  console.log(
    `Archive OK: ${records.length} keys from "${header.env_prefix}", taken ${header.taken_at} (format ${header.nya_export}).`
  );
  const keys = await readKeys(args.keys);
  if (keys) {
    console.log(`Key archive OK: ${keys.keys.size} keys and ${keys.tombstones.size} tombstones from "${keys.header.env_prefix}", taken ${keys.header.taken_at}.`);
    if (keys.header.taken_at < header.taken_at) console.log('The key archive is older than the data archive: a key made in between would be missing, and the restore is refused if one is needed.');
  }

  const target = checkTarget(args.target, args.confirmProduction);
  const existing = await targetKeys(client);
  console.log(`Target "${target}" holds ${existing.length} keys.`);
  if (existing.length > 0 && !args.overwrite) {
    throw new RestoreRefused('The target holds data. Pass --overwrite to replace it.');
  }

  // Replacing real data with something that looks wrong needs saying twice. A
  // correctly formed archive can still be the wrong one: exported from an empty
  // namespace, or from somewhere other than the target.
  if (existing.length > 0) {
    console.log(`This will replace ${existing.length} keys in "${target}" with ${records.length} from the archive.`);
    if (records.length === 0 && !args.allowEmpty) {
      throw new RestoreRefused(
        'The archive holds no keys, so this would empty the target. Pass --allow-empty if that is what you want.'
      );
    }
    if (header.env_prefix !== target && !args.allowDifferentSource) {
      throw new RestoreRefused(
        `The archive came from "${header.env_prefix}", not "${target}". Pass --allow-different-source to replace "${target}" with it.`
      );
    }
  }

  // Planned, and checked, before the dry run returns, so a dry run says
  // whether the real one would be refused and what it would leave out.
  const plan = planRestore(archive, keys, await targetKeyFacts(client));
  for (const c of plan.left_out) console.log(`Leaving out container ${c}: its account was deleted (its key has a tombstone).`);
  for (const c of plan.maps_dropped) console.log(`Container ${c} is restored without its map entry: its key was made after the key archive, and nothing is under it. It writes under the shared key until the migration pass gives it one.`);
  if (plan.keys_left_out.length > 0) console.log(`Leaving out ${plan.keys_left_out.length} key(s) of containers the data archive doesn't have (made after it was taken).`);
  if (plan.without_key_archive) console.log('No key archive was given, and no value in the archive needs one.');
  checkRegistry(archiveRegistry(plan.records), await targetRegistry(client), args.replaceRegistry);

  if (args.dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }

  if (existing.length > 0) {
    const saved = await backUpTarget(client, target, existing);
    console.log(`Saved the target's current contents to ${saved.data}, with its keys in ${saved.keys}, before replacing them. Keep them as a pair.`);
  }

  const { written, deleted, keys: restoredKeys } = await restoreArchive(client, archive, {
    overwrite: args.overwrite,
    backedUp: existing,
    replaceRegistry: args.replaceRegistry,
    keys,
  });
  console.log(`Restored ${written} keys and ${restoredKeys} data keys into "${target}" (replaced ${deleted}). Redeploy now: a running instance remembers a container’s key for up to a minute. Read-back matches the archive.`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Arguments first, so a usage mistake is reported before a missing-credentials
  // one, and the client is only built once there is something to do.
  (async () => {
    parseArgs(argv);
    await main(argv, rawRedis());
  })().catch((err) => {
    if (err instanceof RestoreRefused) console.error(`Refused: ${err.message}`);
    else console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
