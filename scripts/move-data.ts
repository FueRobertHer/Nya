// scripts/move-data.ts
//
// Copy the stored data into its container, at the cutover (#53). Run locally:
//
//   REDIS_PREFIX=production CONTAINER_ID=<id> bun run move-data --target production --confirm-production
//
// Without --run it only reports what it would do. With --run it copies,
// each write checked and recorded with it in one step. Run it again right before
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
//   --allow-empty          go ahead although the environment holds none of the
//                          keys every environment in use has (a wrong
//                          .env.local or REDIS_PREFIX usually)
//   --propagate-deletes    delete the container's copies of old keys deleted
//                          since they were copied (a few at most)
//   --retire               before deleting the old keys: mark the container
//                          so no run is ever made again (only once a report
//                          shows nothing left to do)
//   --resolve <name>       settle a conflict reconciled by hand: keep what the
//                          container holds now (see the README)

import { rawRedis } from '@/lib/storage';
import { deploymentContainer } from '@/lib/sessions';
import { MoveRefused, checkMoveTarget, moveData, retireMove, resolveConflict, type MoveClient } from '@/lib/move';

export type MoveArgs = {
  target?: string;
  confirmProduction: boolean;
  run: boolean;
  allowEmpty: boolean;
  propagateDeletes: boolean;
  retire: boolean;
  resolve?: string;
};

export function parseArgs(argv: string[]): MoveArgs {
  const args: MoveArgs = { confirmProduction: false, run: false, allowEmpty: false, propagateDeletes: false, retire: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--run') args.run = true;
    else if (a === '--allow-empty') args.allowEmpty = true;
    else if (a === '--propagate-deletes') args.propagateDeletes = true;
    else if (a === '--retire') args.retire = true;
    else if (a === '--resolve') {
      args.resolve = argv[++i];
      if (!args.resolve) throw new MoveRefused('--resolve needs the key name.');
    }
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
  if ((args.retire ? 1 : 0) + (args.run ? 1 : 0) + (args.resolve ? 1 : 0) > 1) {
    throw new MoveRefused('--run, --retire and --resolve each go alone.');
  }
  if (args.resolve) {
    const e = await resolveConflict(client, { container: dep.container }, args.resolve);
    console.log(`${e.key} settled: now ${e.action}${e.reason ? ` (${e.reason})` : ''}. What the container holds is kept. Report again before the next run.`);
    return;
  }
  if (args.retire) {
    await retireMove(client, { container: dep.container });
    console.log(`Container ${dep.container} retired from the move: no run will be made again. The old keys can now be deleted.`);
    return;
  }
  const report = await moveData(client, { container: dep.container }, {
    run: args.run,
    allowEmpty: args.allowEmpty,
    propagateDeletes: args.propagateDeletes,
  });
  console.log(`Environment "${env}", container ${report.container}.`);
  console.log(
    `Copy: ${report.copied}. Refresh: ${report.refreshed}. Delete: ${report.deleted}. ` +
      `Up to date: ${report.up_to_date}. Newer in the container, kept: ${report.kept}. Conflicts: ${report.conflicts.length}.`
  );
  for (const e of report.entries) if (e.action === 'kept') console.log(`Kept: ${e.key} (${e.reason}).`);
  for (const c of report.conflicts) console.log(`Conflict: ${c.key} (${c.reason}).`);
  if (!args.run) {
    console.log('Report only: nothing written. Pass --run to copy (any warning above means a run would be refused).');
    return;
  }
  console.log('Copied. The old keys are untouched.');
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
