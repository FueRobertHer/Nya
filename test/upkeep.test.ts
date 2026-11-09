import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatItems, reportMarkdown, upkeepItems, type ListedSwitch, type SwitchItem, type UpkeepItem } from '@/scripts/upkeep';
import { FLAG_KEYS, flagDef } from '@/lib/flags';

// The weekly upkeep list (scripts/upkeep.ts): the release feature switches
// past their removal date, and what the tax law tables are due for
// (test/law-card.test.tsx), in a report for the Upkeep issue, from the
// repository alone.

// The registry has no release switch today (the Plan's last two went with
// their cleanup), so the list is read on these, beside the registry's own.
const release = (key: string, removeBy: string): ListedSwitch => ({
  key,
  def: { kind: 'release', removeBy, value: 'audience', name: `Switch ${key}`, about: `What ${key} turns on.`, offMeans: 'It goes off.', defaults: { development: 'nobody', preview: 'nobody', production: 'nobody' } },
});
const releases = [release('sooner', '2027-04-30'), release('later', '2027-06-30'), release('also-sooner', '2027-04-30')];
const WITH_RELEASES: ListedSwitch[] = [...FLAG_KEYS.map((key) => ({ key, def: flagDef(key) })), ...releases];
const switchesDue = (today: string, flags?: ListedSwitch[]) => upkeepItems(today, flags).filter((i): i is SwitchItem => i.kind === 'switch');
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe('what is due', () => {
  test('a release switch is due the day after its date, not on it', () => {
    const { key, def } = releases[0];
    const removeBy = def.kind === 'release' ? def.removeBy : '';
    expect(upkeepItems(removeBy, WITH_RELEASES).map((i) => i.key)).not.toContain(key);
    expect(upkeepItems(dayAfter(removeBy), WITH_RELEASES).map((i) => i.key)).toContain(key);
  });

  test('every release switch, the longest overdue first, and never an ops switch', () => {
    const items = switchesDue('9999-12-31', WITH_RELEASES);
    expect(items.map((i) => i.key)).toEqual(['also-sooner', 'sooner', 'later']);
    for (const key of ['csp', 'ops', 'sign-in']) expect(items.map((i) => i.key)).not.toContain(key);
    expect(items[0]).toEqual({ kind: 'switch', key: 'also-sooner', name: 'Switch also-sooner', about: 'What also-sooner turns on.', removeBy: '2027-04-30' });
  });

  test('the registry: no switch is ever due, the Plan’s two taken away', () => {
    expect(switchesDue('9999-12-31')).toEqual([]);
    for (const key of ['plan-items-in-fi', 'plan-child-accounts']) expect(upkeepItems('2027-05-01').map((i) => i.key)).not.toContain(key);
  });

  test('nothing, before any date', () => {
    // Tax-Calculator's pin goes by the tables, not the day.
    expect(upkeepItems('2000-01-01').filter((i) => i.key !== 'law-tax-calculator')).toEqual([]);
    expect(formatItems([], '2000-01-01')).toEqual(['Nothing is due as of 2000-01-01.']);
  });
});

describe('the report', () => {
  test('names each switch due, and the two ways to clear it, with no day in it so the issue stays quiet', () => {
    const items: SwitchItem[] = [...switchesDue('9999-12-31', WITH_RELEASES), { kind: 'switch', key: 'latest', name: 'A later switch', about: 'What it turns on.', removeBy: '2099-01-01' }];
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
