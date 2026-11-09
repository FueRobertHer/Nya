// scripts/upkeep.ts
//
// What in the repository is past the date it was due:
//
//   bun run upkeep [--report <path>]
//
// The release feature switches (lib/flags.ts) whose removal date has passed:
// each is removed in its own pull request, or its date moved, with the reason,
// by the pull request that slips it. And the tax law tables (lib/law-card.ts):
// a part whose window has opened and that no table has, a law year needed by
// January 1 and not complete by December 1, the health growth default once CMS
// is due to publish, and Tax-Calculator's pin once a complete law year passes
// it.
//
// It reads only the repository, never the network or a stored value, and
// changes nothing. Prints one line per thing due, or that nothing is. With
// --report, it writes a Markdown report to that path when something is due
// (the weekly workflow, .github/workflows/upkeep.yml, opens or updates the
// Upkeep issue from it, and closes the issue once a run writes none), and
// writes nothing otherwise. Exits 0 either way, since the issue is the signal,
// and 2 on an argument it doesn't know.

import { writeFileSync } from 'node:fs';
import { FLAG_KEYS, flagDef, type FlagDef } from '@/lib/flags';
import { lawDue, taxCalculatorDue, type LawDue } from '@/lib/law-card';
import { LAST_KNOWN_YEAR } from '@/test/fixtures/taxcalc/pin';

/** A release flag past its removal date. */
export type SwitchItem = { kind: 'switch'; key: string; name: string; about: string; removeBy: string };

/** Something in the tax law tables that is due. */
export type LawItem = LawDue & { kind: 'law' };

export type UpkeepItem = SwitchItem | LawItem;

/** A switch as the list reads it. */
export type ListedSwitch = { key: string; def: FlagDef };

/** The registry's switches, in its order. */
const REGISTRY: readonly ListedSwitch[] = FLAG_KEYS.map((key) => ({ key, def: flagDef(key) }));

/** What is due on `today` (a UTC day, YYYY-MM-DD): first the release flags
 *  whose removal date is before it, the longest overdue first (a flag is due
 *  the day after its date, and ops flags have none), then the tax law tables.
 *  `flags` is the registry's, but for a test. */
export function upkeepItems(today: string, flags: readonly ListedSwitch[] = REGISTRY): UpkeepItem[] {
  const switches: SwitchItem[] = [];
  for (const { key, def } of flags) {
    if (def.kind === 'release' && def.removeBy < today) switches.push({ kind: 'switch', key, name: def.name, about: def.about, removeBy: def.removeBy });
  }
  switches.sort((a, b) => a.removeBy.localeCompare(b.removeBy) || a.key.localeCompare(b.key));
  const pin = taxCalculatorDue(LAST_KNOWN_YEAR);
  const law = [...lawDue(today), ...(pin ? [pin] : [])].map((d): LawItem => ({ ...d, kind: 'law' }));
  return [...switches, ...law];
}

/** One line per thing due, or one that says nothing is. */
export function formatItems(items: UpkeepItem[], today: string): string[] {
  if (items.length === 0) return [`Nothing is due as of ${today}.`];
  return items.map((i) => (i.kind === 'switch' ? `${i.key} (${i.name}): remove by ${i.removeBy}, past due.` : `${i.key} (${i.name}): ${i.about}`));
}

/** The issue's body. Without the day it ran, so the same things due week
 *  after week give the same report, and the issue stays quiet. */
export function reportMarkdown(items: UpkeepItem[]): string {
  const switches = items.filter((i): i is SwitchItem => i.kind === 'switch');
  const law = items.filter((i): i is LawItem => i.kind === 'law');
  return [
    ...(switches.length === 0
      ? []
      : [
          switches.length === 1 ? 'One release feature switch is past the date it was to be removed by:' : `${switches.length} release feature switches are past the dates they were to be removed by:`,
          '',
          ...switches.map((i) => `- **${i.name}** (\`${i.key}\`), remove by ${i.removeBy}. ${i.about}`),
          '',
          'For each, either:',
          '',
          '- remove the switch in its own pull request: the code it guards, its entry in `lib/flags.ts`, and its variable from each environment (see "Feature switches" in `docs/operations.md`); or',
          '- move its `removeBy` in `lib/flags.ts`, with the reason, in the pull request that slips it.',
          '',
        ]),
    ...(law.length === 0
      ? []
      : [
          'The tax law tables are due for these (see "The tax law tables, each year" in `docs/operations.md`):',
          '',
          ...law.map((i) => `- **${i.name}**. ${i.about}`),
          '',
          'Each is cleared by a reviewed pull request that changes the tables.',
          '',
        ]),
    'This job changes nothing itself. It closes this issue on the first weekly run with nothing due.',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let report: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report' && argv[i + 1]) report = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}. Usage: bun run upkeep [--report <path>]`);
      process.exit(2);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const items = upkeepItems(today);
  for (const line of formatItems(items, today)) console.log(line);
  if (report !== null && items.length > 0) {
    writeFileSync(report, reportMarkdown(items));
    console.log(`Wrote ${report}.`);
  }
}
