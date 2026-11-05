// lib/law-card.ts
//
// What the tax law tables (lib/fire/tax/law/) say about themselves, by date:
// the admin page's Tax law card (components/AdminPage.tsx), the row it adds to
// Needs attention, there and on Home, and what the weekly upkeep job lists
// (scripts/upkeep.ts). One reading, so the three can't disagree.
//
// A client file imports only this file's types, and the server hands it the
// answer, so the tables stay out of the dashboard's bundle.

import { isComplete, lawFor, LAW_YEARS, missingParts } from './fire/tax/law';
import { LAW_PARTS, type LawPart, type PartialLaw } from './fire/tax/law/types';

/** One part of a law year, as its sheet lists it. */
export type LawPartRow = { part: LawPart; name: string; source: string; when: string };

/** A year's badge: neutral while it is only on its way. */
export type LawBadge = { text: string; caution: boolean };

/** One law year, as the card's row and the sheet it opens say it. No parts:
 *  there is no table for that year yet, so nothing to open. */
export type LawYearRow = { year: number; title: string; sub: string; badge: LawBadge | null; parts: LawPartRow[] };

/** What Needs attention says of the law, in place of nothing. */
export type LawAttention = { title: string; sub: string };

export type LawCard = { years: LawYearRow[]; attention: LawAttention | null };

/** One thing the upkeep issue lists: what is due, and how it is cleared. */
export type LawDue = { key: string; name: string; about: string };

/** Each part by name, and as a list of what is still to come says it. */
const PARTS: Record<LawPart, { name: string; short: string }> = {
  brackets: { name: 'Brackets, standard deduction and gains bands', short: 'brackets' },
  statute: { name: 'Set by statute', short: 'the statute’s parts' },
  aca: { name: 'ACA applicable percentages', short: 'ACA percentages' },
  creditPoverty: { name: 'Poverty guidelines for the credit', short: 'the credit’s poverty guidelines' },
  medicaidPoverty: { name: 'Poverty guidelines for Medicaid', short: 'Medicaid’s poverty guidelines' },
  medicaidStates: { name: 'Medicaid lines by state', short: 'Medicaid’s state lines' },
  stateIncomeTax: { name: 'States with an income tax', short: 'the states with an income tax' },
  medicare: { name: 'Part B premium and IRMAA tiers', short: 'Medicare' },
  wageBase: { name: 'Social Security wage base', short: 'the wage base' },
  uniform: { name: 'RMD ages and the Uniform Lifetime Table', short: 'the RMD table' },
  curve: { name: 'Premium age curve', short: 'the age curve' },
  healthGrowth: { name: 'Health growth default', short: 'the health growth default' },
};

/** The first of a year's parts comes out about July of the year before (the
 *  ACA's percentages), so from then the year wants a table to hold it. */
const FIRST_WINDOW = '-07-01';

const yearOf = (today: string) => Number(today.slice(0, 4));

const inWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

const dayWords = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const toCome = (parts: LawPart[]) => inWords(parts.map((p) => PARTS[p].short));

/** What a year is still waiting for that was due out before it began. The
 *  poverty guidelines Medicaid uses come out that January, every year, so no
 *  table can hold them by December 1 and they don't make it late. */
const dueBeforeItBegins = (law: PartialLaw) => missingParts(law).filter((part) => (law.sources[part].opens ?? '') < `${law.year}-01-01`);

/** A year's parts, those still to come first. */
function partRows(law: PartialLaw): LawPartRow[] {
  const missing = new Set(missingParts(law));
  const row = (part: LawPart): LawPartRow => {
    const s = law.sources[part];
    return { part, name: PARTS[part].name, source: s.source, when: s.published ? `Published ${dayWords(s.published)}` : `Expected ${s.due}` };
  };
  return [...LAW_PARTS.filter((p) => missing.has(p)), ...LAW_PARTS.filter((p) => !missing.has(p))].map(row);
}

/** Tables a year needs and doesn't have: this year's, and from about July the
 *  next's. Never one before the first table. */
function tablesWanting(today: string, years: readonly PartialLaw[]): number[] {
  const year = yearOf(today);
  return [year, ...(today >= `${year}${FIRST_WINDOW}` ? [year + 1] : [])].filter((y) => y >= years[0].year && !years.some((l) => l.year === y));
}

/** A year not whole yet: "Behind" once it has begun; for the next year, "Due by
 *  Jan 1", a caution from December 1, or "Due in January" once all it waits for
 *  comes out then; nothing while it is further off. `due`: how many of its
 *  missing parts were due out before it began. */
function badgeOf(year: number, today: string, due: number): LawBadge | null {
  const now = yearOf(today);
  if (year <= now) return { text: 'Behind', caution: true };
  if (year !== now + 1) return null;
  if (due === 0) return { text: 'Due in January', caution: false };
  return { text: 'Due by Jan 1', caution: today >= `${now}-12-01` };
}

/** What Needs attention says: a year begun with its table not whole, or from
 *  December 1 the next year with something missing that was due before it
 *  begins. Nothing otherwise, so a year on its way is only the card's business. */
export function lawAttention(today: string, years: readonly PartialLaw[] = LAW_YEARS): LawAttention | null {
  const year = yearOf(today);
  const stays = `Worked-out tax stays on ${lawFor(year, years).law.year}’s until every part is in.`;
  if (year >= years[0].year) {
    const current = years.find((l) => l.year === year);
    if (!current) return { title: `No ${year} tax law table`, sub: stays };
    if (!isComplete(current)) return { title: `${year} tax law isn’t all in`, sub: `Still to come: ${toCome(missingParts(current))}. ${stays}` };
  }
  if (today < `${year}-12-01`) return null;
  const next = years.find((l) => l.year === year + 1);
  if (!next) return { title: `${year + 1} tax law is due by January 1`, sub: `No table yet. ${stays}` };
  const late = dueBeforeItBegins(next);
  return late.length === 0 ? null : { title: `${year + 1} tax law is due by January 1`, sub: `Still to come: ${toCome(late)}. ${stays}` };
}

/** The card: the law in use and the years after it, oldest first. */
export function lawCard(today: string, years: readonly PartialLaw[] = LAW_YEARS): LawCard {
  const year = yearOf(today);
  const inUse = lawFor(year, years).law;
  const rows: LawYearRow[] = years
    .filter((l) => l.year >= inUse.year)
    .map((law) => {
      const title = `${law.year} tax law`;
      const parts = partRows(law);
      if (isComplete(law)) {
        const sub = law === inUse ? 'In use · every part in, each with its source' : `Every part in, each with its source · in use from January 1, ${law.year}`;
        return { year: law.year, title, sub, badge: null, parts };
      }
      const missing = missingParts(law);
      return {
        year: law.year,
        title,
        sub: `${LAW_PARTS.length - missing.length} of ${LAW_PARTS.length} parts in · still to come: ${toCome(missing)}`,
        badge: badgeOf(law.year, today, dueBeforeItBegins(law).length),
        parts,
      };
    });
  for (const y of tablesWanting(today, years)) {
    rows.push({ year: y, title: `${y} tax law`, sub: 'No table yet', badge: badgeOf(y, today, LAW_PARTS.length), parts: [] });
  }
  rows.sort((a, b) => a.year - b.year);
  return { years: rows, attention: lawAttention(today, years) };
}

/** What in the law tables the upkeep issue lists: a part whose window has
 *  opened and that no table has, a table a year needs, a year Needs attention
 *  names, and the health growth default once CMS's June projections are due. */
export function lawDue(today: string, years: readonly PartialLaw[] = LAW_YEARS): LawDue[] {
  const due: LawDue[] = [];
  for (const law of years) {
    for (const part of missingParts(law)) {
      const s = law.sources[part];
      if (s.opens && s.opens <= today) due.push({ key: `law-${law.year}-${part}`, name: `${law.year}: ${PARTS[part].name}`, about: `Expected ${s.due}, from ${s.source}.` });
    }
  }
  for (const y of tablesWanting(today, years)) {
    due.push({ key: `law-${y}-table`, name: `${y}: no table yet`, about: `Add \`lib/fire/tax/law/${y}.ts\` with the parts that are out, and their \`opens\` dates for the rest.` });
  }
  const attention = lawAttention(today, years);
  if (attention) due.push({ key: 'law-year', name: attention.title, about: attention.sub });
  const newest = years
    .map((l) => l.sources.healthGrowth.published)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  if (newest && today >= `${yearOf(newest) + 1}-06-01`) {
    due.push({
      key: 'law-health-growth',
      name: 'Health growth default',
      about: `CMS’s National Health Expenditure projections come out about June, and the default rests on the ones from ${dayWords(newest)}. Check it against the new ones, and set its source and date.`,
    });
  }
  return due;
}

/** Tax-Calculator's pin, once a complete law year passes the last year it marks
 *  as known (`lastKnown`, test/fixtures/taxcalc/pin.ts). */
export function taxCalculatorDue(lastKnown: number, years: readonly PartialLaw[] = LAW_YEARS): LawDue | null {
  const passed = years.filter((l) => l.year > lastKnown && isComplete(l)).at(-1);
  if (!passed) return null;
  return {
    key: 'law-tax-calculator',
    name: 'Tax-Calculator’s pin',
    about: `The ${passed.year} table is complete, and the pin knows only to ${lastKnown}. Move it once Tax-Calculator’s \`LAST_KNOWN_YEAR\` reaches ${passed.year}.`,
  };
}
