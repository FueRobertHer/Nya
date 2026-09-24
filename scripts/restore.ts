// scripts/restore.ts
//
// Restore an archive from /api/ops/export into Redis. Run locally:
//
//   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --target restore-test
//
// The Upstash credentials come from .env.local (`vercel env pull .env.local`),
// which Bun loads on its own. Every environment shares one database, so those
// credentials reach production too: the prefix is what decides where this
// writes, and it has to be named twice (REDIS_PREFIX and --target) to agree.
//
// Flags:
//   --target <name>        required; must match REDIS_PREFIX
//   --overwrite            replace a target that already holds data
//   --confirm-production   required on top of the above to write production
//   --dry-run              verify the archive and the target, write nothing
//
// See lib/restore.ts for the checks and their order.

import { writeFile } from 'node:fs/promises';
import { rawRedis } from '@/lib/storage';
import { exportLines } from '@/lib/export';
import {
  RestoreRefused,
  checkTarget,
  restoreArchive,
  targetKeys,
  verifyArchive,
  type RestoreClient,
} from '@/lib/restore';

export type RestoreArgs = {
  file: string;
  target?: string;
  overwrite: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): RestoreArgs {
  const args: RestoreArgs = { file: '', overwrite: false, confirmProduction: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--')) throw new RestoreRefused(`Unknown flag ${a}.`);
    else if (!args.file) args.file = a;
    else throw new RestoreRefused(`Unexpected argument ${a}.`);
  }
  if (!args.file) throw new RestoreRefused('Usage: bun run restore <archive.ndjson> --target <prefix>');
  return args;
}

/** Export the target to a local file before anything in it is deleted, and
 *  prove that file is complete before relying on it. */
async function backUpTarget(client: RestoreClient, target: string): Promise<string> {
  let text = '';
  for await (const line of exportLines(client)) text += line;
  verifyArchive(text); // throws if the pre-restore copy is itself unusable
  const path = `nya-pre-restore-${target}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
  await writeFile(path, text, { flag: 'wx' });
  return path;
}

export async function main(argv: string[], client: RestoreClient): Promise<void> {
  const args = parseArgs(argv);

  const archive = verifyArchive(await Bun.file(args.file).text());
  const { header, records } = archive;
  console.log(
    `Archive OK: ${records.length} keys from "${header.env_prefix}", taken ${header.taken_at}.`
  );

  const target = checkTarget(args.target, args.confirmProduction);
  const existing = await targetKeys(client);
  console.log(`Target "${target}" holds ${existing.length} keys.`);
  if (existing.length > 0 && !args.overwrite) {
    throw new RestoreRefused('The target holds data. Pass --overwrite to replace it.');
  }

  if (args.dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }

  if (existing.length > 0) {
    const path = await backUpTarget(client, target);
    console.log(`Saved the target's current contents to ${path} before replacing them.`);
  }

  const { written, deleted } = await restoreArchive(client, archive, { overwrite: args.overwrite });
  console.log(`Restored ${written} keys into "${target}" (replaced ${deleted}). Read-back matches the archive.`);
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
