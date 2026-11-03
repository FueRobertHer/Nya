// scripts/upkeep.ts
//
// What in the repository is past the date it was due:
//
//   bun run upkeep [--report <path>]
//
// Today that is the release feature switches (lib/flags.ts) whose removal date
// has passed: each is removed in its own pull request, or its date moved, with
// the reason, by the pull request that slips it. The tax law sources' dates
// join it with the Tax law card (the tax plan's T2).
//
// It reads only the repository, never the network or a stored value, and
// changes nothing. Prints one line per thing due, or that nothing is. With
// --report, it writes a Markdown report to that path when something is due
// (the weekly workflow, .github/workflows/upkeep.yml, opens or updates the
// Upkeep issue from it, and closes the issue once a run writes none), and
// writes nothing otherwise. Exits 0 either way, since the issue is the signal,
// and 2 on an argument it doesn't know.

import { writeFileSync } from 'node:fs';
import { FLAG_KEYS, flagDef } from '@/lib/flags';

/** A release flag past its removal date. */
export type UpkeepItem = { key: string; name: string; about: string; removeBy: string };

/** The release flags whose removal date is before `today` (a UTC day,
 *  YYYY-MM-DD), the longest overdue first: a flag is due the day after its
 *  date. Ops flags have none. */
export function upkeepItems(today: string): UpkeepItem[] {
  const items: UpkeepItem[] = [];
  for (const key of FLAG_KEYS) {
    const def = flagDef(key);
    if (def.kind === 'release' && def.removeBy < today) items.push({ key, name: def.name, about: def.about, removeBy: def.removeBy });
  }
  return items.sort((a, b) => a.removeBy.localeCompare(b.removeBy) || a.key.localeCompare(b.key));
}

/** One line per thing due, or one that says nothing is. */
export function formatItems(items: UpkeepItem[], today: string): string[] {
  if (items.length === 0) return [`Nothing is due as of ${today}.`];
  return items.map((i) => `${i.key} (${i.name}): remove by ${i.removeBy}, past due.`);
}

/** The issue's body. Without the day it ran, so the same things due week
 *  after week give the same report, and the issue stays quiet. */
export function reportMarkdown(items: UpkeepItem[]): string {
  return [
    items.length === 1 ? 'One release feature switch is past the date it was to be removed by:' : `${items.length} release feature switches are past the dates they were to be removed by:`,
    '',
    ...items.map((i) => `- **${i.name}** (\`${i.key}\`), remove by ${i.removeBy}. ${i.about}`),
    '',
    'For each, either:',
    '',
    '- remove the switch in its own pull request: the code it guards, its entry in `lib/flags.ts`, and its variable from each environment (see "Feature switches" in `docs/operations.md`); or',
    '- move its `removeBy` in `lib/flags.ts`, with the reason, in the pull request that slips it.',
    '',
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
