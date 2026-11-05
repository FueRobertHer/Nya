import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatItems, reportMarkdown, upkeepItems, type SwitchItem, type UpkeepItem } from '@/scripts/upkeep';
import { FLAG_KEYS, flagDef } from '@/lib/flags';

// The weekly upkeep list (scripts/upkeep.ts): the release feature switches
// past their removal date, and what the tax law tables are due for
// (test/law-card.test.tsx), in a report for the Upkeep issue, from the
// repository alone.

const releases = FLAG_KEYS.flatMap((key) => {
  const def = flagDef(key);
  return def.kind === 'release' ? [{ key, removeBy: def.removeBy }] : [];
});
const switchesDue = (today: string) => upkeepItems(today).filter((i): i is SwitchItem => i.kind === 'switch');
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe('what is due', () => {
  test('a release switch is due the day after its date, not on it', () => {
    const { key, removeBy } = releases[0];
    expect(upkeepItems(removeBy).map((i) => i.key)).not.toContain(key);
    expect(upkeepItems(dayAfter(removeBy)).map((i) => i.key)).toContain(key);
  });

  test('every release switch, the longest overdue first, and never an ops switch', () => {
    const items = switchesDue('9999-12-31');
    expect(items.map((i) => i.key).sort()).toEqual(releases.map((r) => r.key).sort());
    for (const key of ['csp', 'ops', 'sign-in']) expect(items.map((i) => i.key)).not.toContain(key);
    const dates = items.map((i) => i.removeBy);
    expect(dates).toEqual([...dates].sort());
    expect(items[0]).toEqual({ kind: 'switch', key: items[0].key, name: flagDef(items[0].key as never).name, about: flagDef(items[0].key as never).about, removeBy: items[0].removeBy });
  });

  test('nothing, before any date', () => {
    // Tax-Calculator's pin goes by the tables, not the day.
    expect(upkeepItems('2000-01-01').filter((i) => i.key !== 'law-tax-calculator')).toEqual([]);
    expect(formatItems([], '2000-01-01')).toEqual(['Nothing is due as of 2000-01-01.']);
  });
});

describe('the report', () => {
  test('names each switch due, and the two ways to clear it, with no day in it so the issue stays quiet', () => {
    const items: SwitchItem[] = [...switchesDue('9999-12-31'), { kind: 'switch', key: 'later', name: 'A later switch', about: 'What it turns on.', removeBy: '2099-01-01' }];
    const report = reportMarkdown(items);
    expect(report).toStartWith(`${items.length} release feature switches are past the dates they were to be removed by:`);
    for (const i of items) expect(report).toContain(`- **${i.name}** (\`${i.key}\`), remove by ${i.removeBy}. ${i.about}`);
    expect(report).toContain('remove the switch in its own pull request');
    expect(report).toContain('move its `removeBy` in `lib/flags.ts`, with the reason');
    expect(report).toContain('This job changes nothing itself.');
    expect(report).not.toContain('9999');
    expect(report).not.toContain(new Date().toISOString().slice(0, 10));
    expect(reportMarkdown(items.slice(0, 1))).toStartWith('One release feature switch is past the date it was to be removed by:');
    expect(report).not.toMatch(/[\u2013\u2014]/);
  });

  test('names what the tax law tables are due for, after the switches, and only the words each has', () => {
    const law: UpkeepItem = { kind: 'law', key: 'law-2027-brackets', name: '2027: Brackets', about: 'Expected in October.' };
    const alone = reportMarkdown([law]);
    expect(alone).toStartWith('The tax law tables are due for these');
    expect(alone).toContain('- **2027: Brackets**. Expected in October.');
    expect(alone).toContain('"The tax law tables, each year" in `docs/operations.md`');
    expect(alone).toContain('This job changes nothing itself.');
    expect(alone).not.toContain('release feature switch');
    const sw: UpkeepItem = { kind: 'switch', key: 'later', name: 'A later switch', about: 'What it turns on.', removeBy: '2099-01-01' };
    const both = reportMarkdown([sw, law]);
    expect(both).toStartWith('One release feature switch');
    expect(both.indexOf('A later switch')).toBeLessThan(both.indexOf('2027: Brackets'));
    expect(both).not.toMatch(/[\u2013\u2014]/);
    expect(formatItems([law], '2026-11-04')).toEqual(['law-2027-brackets (2027: Brackets): Expected in October.']);
  });

  test('as run: writes the report only when something is due, exits 0, and 2 on an argument it doesn’t know', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upkeep-'));
    try {
      const report = join(dir, 'upkeep.md');
      const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'scripts', 'upkeep.ts'), '--report', report]);
      expect(run.exitCode).toBe(0);
      const today = new Date().toISOString().slice(0, 10);
      const due = upkeepItems(today);
      expect(existsSync(report)).toBe(due.length > 0);
      if (due.length > 0) expect(readFileSync(report, 'utf8')).toBe(reportMarkdown(due));
      else expect(run.stdout.toString()).toContain(`Nothing is due as of ${today}.`);
      expect(Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'scripts', 'upkeep.ts'), '--nope']).exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
