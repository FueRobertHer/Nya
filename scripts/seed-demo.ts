// scripts/seed-demo.ts
//
// Resets the demo accounts, Alex and Sam (docs/authentication.md, "Demo
// accounts"), to a year of realistic data on Plaid's sandbox: several banks,
// a card, investments with holdings, loans, budgets, goals and a Plan
// (lib/demo-seed/profiles.ts). Everything they held before is replaced, and
// running it again resets them again, with the dates moved up to today.
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
//   --dry-run         check everything and say what would be replaced; write nothing

import { DEMO_NAMES } from '@/lib/demo';
import { getItems } from '@/lib/storage';
import { SeedRefused, checkSeedEnvironment, seedTargets } from '@/lib/demo-seed/guard';
import { demoProfile, type DemoName } from '@/lib/demo-seed/profiles';
import { seedDemoAccount } from '@/lib/demo-seed/seed';

export type SeedArgs = { target?: string; only: DemoName[]; dryRun: boolean };

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
    } else if (a === '--dry-run') args.dryRun = true;
    else throw new SeedRefused(`Unknown argument ${a}.`);
  }
  return args;
}

export async function main(argv: string[], today: string = new Date().toISOString().slice(0, 10)): Promise<void> {
  const args = parseArgs(argv);
  checkSeedEnvironment(args.target);
  const targets = await seedTargets(args.only);
  for (const t of targets) {
    const profile = demoProfile(t.name, today);
    const banks = (await getItems(t.ctx)).map((i) => i.institution_name);
    console.log(`${t.name}: replacing ${banks.length > 0 ? banks.join(', ') : 'no linked banks'} and everything else stored, with ${profile.institutions.map((i) => i.name).join(', ')}.`);
    if (args.dryRun) continue;
    const report = await seedDemoAccount(t.ctx, t.userId, profile, today, { log: (line) => console.log(line) });
    if (report.waiting.length > 0) console.log(`  Plaid was still preparing the history of ${report.waiting.join(', ')}: it appears within a few minutes.`);
    console.log(`${t.name}: done.`);
  }
  if (args.dryRun) console.log('Dry run: nothing was changed.');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof SeedRefused) console.error(`Refused: ${err.message}`);
    else console.error(`Seed failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
