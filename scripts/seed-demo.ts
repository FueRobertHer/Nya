// scripts/seed-demo.ts
//
// Resets the demo accounts, Alex and Sam (docs/authentication.md, "Demo
// accounts"), to a year of realistic data on Plaid's sandbox: several banks,
// a card, investments with holdings, loans, budgets, goals and a Plan. Each
// gets its own scenario (lib/demo-seed/scenarios.ts) unless --scenario names
// one. Everything they held before is replaced, and running it again resets
// them again, with the dates moved up to today. The Demo data card in
// Settings does the same for the signed-in demo account, under the same
// limit (lib/demo-seed/reset.ts): one reset per account in ten minutes.
//
// Run it with the environment of the deployment to seed, pulled into a file
// of its own and named with --env-file, so Bun loads that file and no other
// (without it, Bun would load .env.development.local and friends):
//
//   vercel env pull .env.preview.local --environment=preview
//   bun --env-file=.env.preview.local scripts/seed-demo.ts --target preview
//
// It refuses Production and anything but Vercel's Preview or Development
// (lib/demo-seed/guard.ts): the prefix it would write to must be the one
// --target names, and each demo account must have signed in there once.
//
// Flags:
//   --target <name>   required; the environment's Redis prefix (preview)
//   --only <name>     seed just Alex or just Sam
//   --scenario <id>   the scenario for each, instead of its own
//   --dry-run         check everything and say what would be replaced; write nothing

import { DEMO_NAMES } from '@/lib/demo';
import { getItems } from '@/lib/storage';
import { SeedRefused, checkSeedEnvironment, seedTargets } from '@/lib/demo-seed/guard';
import type { DemoName } from '@/lib/demo-seed/profiles';
import { DEFAULT_SCENARIO, SCENARIOS, scenarioById } from '@/lib/demo-seed/scenarios';
import { ResetLimited, resetDemoAccount, resetState } from '@/lib/demo-seed/reset';

export type SeedArgs = { target?: string; only: DemoName[]; scenario?: string; dryRun: boolean };

export function parseArgs(argv: string[]): SeedArgs {
  const args: SeedArgs = { only: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--only') {
      const given = (argv[++i] ?? '').toLowerCase();
      const name = DEMO_NAMES.find((n) => n.toLowerCase() === given);
      if (!name) throw new SeedRefused(`--only takes ${DEMO_NAMES.join(' or ')}.`);
      if (!args.only.includes(name)) args.only.push(name);
    } else if (a === '--scenario') {
      const id = argv[++i];
      if (!scenarioById(id)) throw new SeedRefused(`--scenario takes ${SCENARIOS.map((s) => s.id).join(' or ')}.`);
      args.scenario = id;
    } else if (a === '--dry-run') args.dryRun = true;
    else throw new SeedRefused(`Unknown argument ${a}.`);
  }
  return args;
}

export async function main(argv: string[], today: string = new Date().toISOString().slice(0, 10)): Promise<void> {
  const args = parseArgs(argv);
  checkSeedEnvironment(args.target);
  const targets = await seedTargets(args.only);
  const limited: string[] = [];
  for (const t of targets) {
    const scenario = scenarioById(args.scenario ?? DEFAULT_SCENARIO[t.name])!;
    const banks = (await getItems(t.ctx)).map((i) => i.institution_name);
    console.log(`${t.name}: replacing ${banks.length > 0 ? banks.join(', ') : 'no linked banks'} and everything else stored, with ${scenario.title}.`);
    const { secondsLeft } = await resetState(t.ctx);
    if (secondsLeft > 0) {
      // The next account may still be reset.
      console.log(`  ${new ResetLimited(secondsLeft).message}`);
      limited.push(t.name);
      continue;
    }
    if (args.dryRun) continue;
    const report = await resetDemoAccount(t, scenario, today, { log: (line) => console.log(line) });
    if (report.waiting.length > 0) console.log(`  Plaid was still preparing the history of ${report.waiting.join(', ')}: it appears within a few minutes.`);
    console.log(`${t.name}: done.`);
  }
  if (args.dryRun) console.log('Dry run: nothing was changed.');
  if (limited.length > 0) throw new SeedRefused(`${limited.join(' and ')} ${limited.length === 1 ? 'was' : 'were'} reset too recently, and left as ${limited.length === 1 ? 'it was' : 'they were'}.`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof SeedRefused || err instanceof ResetLimited) console.error(`Refused: ${err.message}`);
    else console.error(`Seed failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
