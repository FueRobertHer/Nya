// scripts/move-data.ts
//
// Copy the stored data into its container, at the cutover (#53). Run locally:
//
//   REDIS_PREFIX=production CONTAINER_ID=<id> bun run move-data --target production --confirm-production
//
// Without --run it only reports what it would do. With --run it copies, reads
// every copy back, and records what it copied. Run it again right before
// deploying the release that reads containers, to pick up anything written
// since; it refuses, writing nothing, if that release has already written a
// key it would overwrite. See lib/move.ts, and "Moving the data into
// containers" in the README for the whole procedure.
//
// The Upstash credentials come from .env.local (`vercel env pull .env.local`),
// which Bun loads on its own. The container is this deployment's, by the rule
// sessions use: CONTAINER_ID, or the only active container.
//
// Flags:
//   --target <name>        required; must match REDIS_PREFIX
//   --confirm-production   required on top of the above to write production
//   --run                  copy (otherwise: report only)

import { rawRedis } from '@/lib/storage';
import { deploymentContainer } from '@/lib/sessions';
import { MoveRefused, checkMoveTarget, moveData, type MoveClient } from '@/lib/move';

export type MoveArgs = { target?: string; confirmProduction: boolean; run: boolean };

export function parseArgs(argv: string[]): MoveArgs {
  const args: MoveArgs = { confirmProduction: false, run: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--run') args.run = true;
    else throw new MoveRefused(`Unknown argument ${JSON.stringify(a)}.`);
  }
  return args;
}

export async function main(argv: string[], client: MoveClient): Promise<void> {
  const args = parseArgs(argv);
  const env = checkMoveTarget(args.target, args.confirmProduction);
  const dep = await deploymentContainer();
  if (dep.kind !== 'container') {
    throw new MoveRefused(dep.kind === 'none' ? 'No container exists yet. Create one first (see "Containers" in the README).' : dep.reason);
  }
  const report = await moveData(client, { container: dep.container }, { run: args.run });
  console.log(`Environment "${env}", container ${report.container}.`);
  console.log(`To copy: ${report.copied}. To refresh: ${report.refreshed}. Already up to date: ${report.up_to_date}.`);
  for (const c of report.conflicts) console.log(`Conflict: ${c.key} (${c.reason}).`);
  if (!args.run) {
    console.log(report.conflicts.length > 0 ? 'Report only. A run would be refused.' : 'Report only: nothing written. Pass --run to copy.');
    return;
  }
  console.log('Copied and read back. The old keys are untouched.');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  (async () => {
    parseArgs(argv);
    await main(argv, rawRedis() as unknown as MoveClient);
  })().catch((err) => {
    if (err instanceof MoveRefused) console.error(`Refused: ${err.message}`);
    else console.error(`Move failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
