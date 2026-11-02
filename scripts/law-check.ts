// scripts/law-check.ts
//
// Compares the tax law tables (lib/fire/tax/law/) with the few official
// sources that publish their figures in a form a program can read, and
// watches for the notices the tables don't hold yet:
//
//   bun run law:check [--report <path>]
//
// It reads, for each law year Nya holds and the year after the newest:
//   - the poverty guidelines, from HHS ASPE's API (`creditPoverty` is the year
//     before's guidelines, `medicaidPoverty` that year's), sizes 1 to 8 in the
//     contiguous states, Alaska and Hawaii;
//   - Part B's standard premium and the IRMAA tiers, from CMS's Part B notice
//     in the Federal Register (its first "Full Part B Coverage" table, the one
//     for single and joint returns);
//   - the Social Security wage base, from SSA's cost-of-living notice in the
//     Federal Register.
// Part D's IRMAA amounts are only on CMS's fact sheet, not in the notice, so
// they aren't checked. The federal parameters are cross-checked against
// Tax-Calculator in test/tax-calculator.test.ts instead.
//
// It never changes a table: a figure changes only through a reviewed pull
// request (docs/operations.md, "The tax law tables, each year").
//
// Prints one line per part: match, differ, not out (the notice isn't out
// yet), new (out, but not in the tables yet), unrecognised (a source answered
// in a shape this doesn't know, or a notice the tables cite can't be found)
// or unreachable (a network error, or the source answered 5xx or 429).
// Exits 1 on differ, unrecognised or unreachable, else 0. With --report, it
// also writes a Markdown report to that path when anything differs, is new or
// is unrecognised (the weekly workflow, .github/workflows/law-check.yml, opens
// or updates an issue from it), and writes nothing otherwise.

import { writeFileSync } from 'node:fs';
import { LAW_YEARS } from '@/lib/fire/tax/law/index';
import type { Filing, PartialLaw, PovertyGuidelines, PovertyRegion } from '@/lib/fire/tax/law/types';

/** The parts that have a machine-readable official source. */
export type CheckedPart = 'creditPoverty' | 'medicaidPoverty' | 'medicare' | 'wageBase';

export const CHECKED_PARTS: readonly CheckedPart[] = ['creditPoverty', 'medicaidPoverty', 'medicare', 'wageBase'];

export type Status = 'match' | 'differ' | 'not out' | 'new' | 'unrecognised' | 'unreachable';

export type Row = { year: number; part: CheckedPart; status: Status; detail: string };

/** A source answered, but not in a shape this script knows. */
export class Unrecognised extends Error {}

/** A source couldn't be reached, or answered with a server error. */
export class Unreachable extends Error {}

/** Fetches a URL's body as text, throwing Unreachable or Unrecognised. */
export type Get = (url: string) => Promise<string>;

export const PART_D_NOTE =
  "Part D's IRMAA amounts aren't in CMS's Federal Register notice (only on its fact sheet), so they aren't checked.";

// ---- The poverty guidelines (HHS ASPE) ----

const ASPE = 'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/api';

/** The API's name for each region. */
const ASPE_STATE: Record<PovertyRegion, 'us' | 'ak' | 'hi'> = { contiguous: 'us', AK: 'ak', HI: 'hi' };

const REGIONS: readonly PovertyRegion[] = ['contiguous', 'AK', 'HI'];

const SIZES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export function povertyUrl(year: number, region: PovertyRegion, size: number): string {
  return `${ASPE}/${year}/${ASPE_STATE[region]}/${size}`;
}

/** One answer from the poverty API: the guideline, or `out: false` when the
 *  API has no guidelines for that year yet. It answers a year it doesn't have
 *  (and any other input it doesn't know) with its defaults instead of an
 *  error, so the year, state and size it echoes are checked against the
 *  question. Its value is `data.income` (its documentation says
 *  `poverty_threshold`). */
export function parsePoverty(body: string, year: number, region: PovertyRegion, size: number): { out: false } | { out: true; income: number } {
  const asked = `${year}/${ASPE_STATE[region]}/${size}`;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Unrecognised(`ASPE's answer for ${asked} isn't JSON`);
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null) throw new Unrecognised(`ASPE's answer for ${asked} has no data`);
  const d = data as Record<string, unknown>;
  for (const key of ['year', 'state', 'household_size', 'income']) {
    if (typeof d[key] !== 'string' && typeof d[key] !== 'number') throw new Unrecognised(`ASPE's answer for ${asked} has no ${key}`);
  }
  const answered = `${d.year}/${String(d.state).toLowerCase()}/${d.household_size}`;
  if (String(d.state).toLowerCase() !== ASPE_STATE[region] || String(d.household_size) !== String(size)) {
    throw new Unrecognised(`ASPE answered ${answered} when asked ${asked}`);
  }
  if (String(d.year) !== String(year)) return { out: false };
  const income = String(d.income);
  if (!/^\d+$/.test(income) || Number(income) <= 0) throw new Unrecognised(`ASPE's income for ${asked} is ${JSON.stringify(d.income)}`);
  return { out: true, income: Number(income) };
}

/** A year's guidelines, by region, for sizes 1 to 8. */
export type PovertySizes = Record<PovertyRegion, number[]>;

async function fetchGuidelines(year: number, get: Get): Promise<PovertySizes | null> {
  const found: Partial<PovertySizes> = {};
  let out = 0;
  let notOut = 0;
  for (const region of REGIONS) {
    const answers = await Promise.all(SIZES.map(async (size) => parsePoverty(await get(povertyUrl(year, region, size)), year, region, size)));
    found[region] = answers.map((a) => (a.out ? a.income : 0));
    for (const a of answers) {
      if (a.out) out++;
      else notOut++;
    }
  }
  if (out === 0) return null;
  if (notOut > 0) throw new Unrecognised(`ASPE has ${out} of the ${year} guidelines' 24 figures and not the other ${notOut}`);
  return found as PovertySizes;
}

/** A table's guidelines for sizes 1 to 8: first + (n - 1) * added. */
export function povertySizes(g: PovertyGuidelines): PovertySizes {
  const sizes = (region: PovertyRegion) => SIZES.map((n) => g[region].first + (n - 1) * g[region].added);
  return { contiguous: sizes('contiguous'), AK: sizes('AK'), HI: sizes('HI') };
}

/** The guidelines as `first + added` per region, or the sizes themselves where
 *  they aren't evenly spaced. */
function describeSizes(sizes: PovertySizes): string {
  return REGIONS.map((region) => {
    const s = sizes[region];
    const added = s[1] - s[0];
    const even = s.every((v, i) => v === s[0] + i * added);
    return `${ASPE_STATE[region]} ${even ? `${money(s[0])} + ${money(added)}` : s.map(money).join(', ')}`;
  }).join('; ');
}

/** Where a table's guidelines differ from the official ones, size by size. */
export function povertyDifferences(ours: PovertySizes, official: PovertySizes): string[] {
  const out: string[] = [];
  for (const region of REGIONS) {
    SIZES.forEach((size, i) => {
      if (ours[region][i] !== official[region][i]) {
        out.push(`${ASPE_STATE[region]} size ${size} ours ${money(ours[region][i])}, official ${money(official[region][i])}`);
      }
    });
  }
  return out;
}

// ---- The Federal Register ----

const FR_SEARCH = 'https://www.federalregister.gov/api/v1/documents.json';

const FR_FIELDS = ['title', 'citation', 'publication_date', 'document_number', 'type', 'full_text_xml_url', 'raw_text_url'];

export type FrDocument = {
  title: string;
  citation: string;
  publication_date: string;
  full_text_xml_url: string | null;
  raw_text_url: string | null;
};

/** CMS's yearly Part B notice. */
export function partBTitle(year: number): string {
  return `Medicare Program; Medicare Part B Monthly Actuarial Rates, Premium Rates, and Annual Deductible Beginning January 1, ${year}`;
}

/** SSA's yearly cost-of-living notice, which sets the wage base. */
export function ssaTitle(year: number): string {
  return `Cost-of-Living Increase and Other Determinations for ${year}`;
}

/** A search for notices with this exact title (as a quoted phrase). */
export function frSearchUrl(title: string): string {
  const params = new URLSearchParams();
  params.set('conditions[term]', `"${title}"`);
  params.append('conditions[type][]', 'NOTICE');
  for (const field of FR_FIELDS) params.append('fields[]', field);
  params.set('per_page', '20');
  return `${FR_SEARCH}?${params}`;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The one notice with exactly this title, or null when there is none yet. A
 *  phrase search also finds longer titles (a correction's), which are left
 *  out; two notices with the same title is a shape this doesn't know. */
export function parseFrSearch(body: string, title: string): FrDocument | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Unrecognised(`The Federal Register's search for "${title}" isn't JSON`);
  }
  const { count, results } = (json ?? {}) as { count?: unknown; results?: unknown };
  if (typeof count !== 'number') throw new Unrecognised(`The Federal Register's search for "${title}" has no count`);
  if (count === 0) return null;
  if (!Array.isArray(results)) throw new Unrecognised(`The Federal Register's search for "${title}" counts ${count} but lists none`);
  const want = squash(title).toLowerCase();
  const matches = results.filter(
    (r): r is FrDocument =>
      typeof r === 'object' && r !== null && typeof r.title === 'string' && squash(r.title).toLowerCase() === want,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Unrecognised(`The Federal Register has ${matches.length} notices titled "${title}"`);
  const doc = matches[0];
  if (typeof doc.citation !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(doc.publication_date))) {
    throw new Unrecognised(`The Federal Register's entry for "${title}" has no citation or date`);
  }
  return doc;
}

/** Strips tags and decodes the entities the Federal Register's XML and text use. */
function plain(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const dollars = (s: string) => Number(s.replace(/,/g, ''));

// ---- Part B and IRMAA (CMS) ----

/** Part B as the notice prints it: the standard premium and, per filing
 *  status, each tier's threshold and total monthly premium, in dollars. */
export type PartB = {
  partB: number;
  irmaa: Record<Filing, readonly { over: number; atLeast: boolean; partB: number }[]>;
};

/** One threshold cell: "Less than or equal to $109,000", "Greater than
 *  $109,000 and less than or equal to $137,000", "Greater than $205,000 and
 *  less than $500,000" or "Greater than or equal to $500,000". */
type Band = { from: number | null; atLeast: boolean; to: number | null; toIncluded: boolean };

function parseBand(cell: string): Band | null {
  let m = /^Less than or equal to \$([\d,]+)$/.exec(cell);
  if (m) return { from: null, atLeast: false, to: dollars(m[1]), toIncluded: true };
  m = /^Greater than \$([\d,]+) and less than (or equal to )?\$([\d,]+)$/.exec(cell);
  if (m) return { from: dollars(m[1]), atLeast: false, to: dollars(m[3]), toIncluded: m[2] !== undefined };
  m = /^Greater than or equal to \$([\d,]+)$/.exec(cell);
  if (m) return { from: dollars(m[1]), atLeast: true, to: null, toIncluded: false };
  return null;
}

/** Whole cents from "$202.90" or "81.20". */
function cents(cell: string): number | null {
  const m = /^\$?([\d,]+)\.(\d\d)$/.exec(cell);
  return m ? dollars(m[1]) * 100 + Number(m[2]) : null;
}

const HEADINGS = [/individual tax returns/i, /joint tax returns/i, /income-related monthly adjustment amount/i, /total monthly premium amount/i];

/** The standard premium and IRMAA tiers from the notice's XML: its first
 *  table titled "Full Part B Coverage", whose columns are the single and joint
 *  thresholds, the adjustment and the total. The married filing separately
 *  table (3 columns) and the immunosuppressive drug tables are left out. The
 *  bands must run on without a gap, and each total must be the standard
 *  premium plus its adjustment, or the table isn't the one this knows. */
export function parsePartB(xml: string, year: number): PartB {
  const subject = /<SUBJECT>([\s\S]*?)<\/SUBJECT>/.exec(xml);
  if (!subject || squash(plain(subject[1])) !== partBTitle(year)) {
    throw new Unrecognised(`The Part B notice for ${year} doesn't have its title as its subject`);
  }
  const tables = [...xml.matchAll(/<GPOTABLE\b([^>]*)>([\s\S]*?)<\/GPOTABLE>/g)];
  const full = tables.find((t) => squash(plain(/<TTITLE>([\s\S]*?)<\/TTITLE>/.exec(t[2])?.[1] ?? '')) === 'Full Part B Coverage');
  if (!full) throw new Unrecognised(`The Part B notice for ${year} has no "Full Part B Coverage" table`);
  const heads = [...full[2].matchAll(/<CHED\b[^>]*>([\s\S]*?)<\/CHED>/g)].map((m) => squash(plain(m[1])));
  if (!/\bCOLS="4"/.test(full[1]) || heads.length !== 4 || !HEADINGS.every((re, i) => re.test(heads[i]))) {
    throw new Unrecognised(`The Part B notice for ${year}'s first "Full Part B Coverage" table isn't single, joint, adjustment, total`);
  }
  const rows = [...full[2].matchAll(/<ROW>([\s\S]*?)<\/ROW>/g)].map((r) =>
    [...r[1].matchAll(/<ENT\b[^>]*>([\s\S]*?)<\/ENT>/g)].map((e) => squash(plain(e[1]))),
  );
  const bad = (why: string) => new Unrecognised(`The Part B notice for ${year}'s "Full Part B Coverage" table: ${why}`);
  if (rows.length < 2) throw bad(`${rows.length} rows`);
  const parsed = rows.map((cells, i) => {
    if (cells.length !== 4) throw bad(`row ${i + 1} has ${cells.length} cells`);
    const single = parseBand(cells[0]);
    const joint = parseBand(cells[1]);
    const adjustment = cents(cells[2]);
    const total = cents(cells[3]);
    if (!single || !joint || adjustment === null || total === null) throw bad(`row ${i + 1} reads "${cells.join(' | ')}"`);
    return { single, joint, adjustment, total };
  });
  const standard = parsed[0].total;
  if (parsed[0].adjustment !== 0) throw bad('the first row has an adjustment');
  for (const filing of ['single', 'joint'] as const) {
    parsed.forEach((row, i) => {
      const band = row[filing];
      const before = parsed[i - 1]?.[filing];
      const last = i === parsed.length - 1;
      const runsOn = before
        ? band.from === before.to && band.atLeast === !before.toIncluded
        : band.from === null;
      if (!runsOn || (band.to === null) !== last) throw bad(`the ${filing} bands don't run on at row ${i + 1}`);
    });
  }
  parsed.forEach((row, i) => {
    if (row.total !== standard + row.adjustment) throw bad(`row ${i + 1}'s total isn't the standard premium plus its adjustment`);
  });
  const tiers = (filing: Filing) =>
    parsed.slice(1).map((row) => ({ over: row[filing].from!, atLeast: row[filing].atLeast, partB: row.total / 100 }));
  return { partB: standard / 100, irmaa: { single: tiers('single'), joint: tiers('joint') } };
}

/** Where a table's Part B and IRMAA figures differ from the notice's. */
export function partBDifferences(ours: PartB, official: PartB): string[] {
  const out: string[] = [];
  const c = (n: number) => Math.round(n * 100);
  if (c(ours.partB) !== c(official.partB)) out.push(`standard premium ours ${premium(ours.partB)}, official ${premium(official.partB)}`);
  for (const filing of ['single', 'joint'] as const) {
    const a = ours.irmaa[filing];
    const b = official.irmaa[filing];
    if (a.length !== b.length) {
      out.push(`${filing} tiers ours ${a.length}, official ${b.length}`);
      continue;
    }
    a.forEach((tier, i) => {
      const at = `${filing} tier ${i + 1}`;
      if (tier.over !== b[i].over) out.push(`${at} threshold ours ${money(tier.over)}, official ${money(b[i].over)}`);
      if (tier.atLeast !== b[i].atLeast) out.push(`${at} ours ${tier.atLeast ? 'at least' : 'over'}, official ${b[i].atLeast ? 'at least' : 'over'}`);
      if (c(tier.partB) !== c(b[i].partB)) out.push(`${at} premium ours ${premium(tier.partB)}, official ${premium(b[i].partB)}`);
    });
  }
  return out;
}

// ---- The wage base (SSA) ----

/** The OASDI contribution and benefit base from the notice's text. The
 *  notice says it twice ("The OASDI contribution and benefit base is $192,300
 *  for remuneration paid in 2027", and again after the computation); every
 *  statement must agree. */
export function parseWageBase(text: string, year: number): number {
  const flat = squash(plain(text).replace(/\[\[Page \d+\]\]/g, ' '));
  if (!flat.includes(ssaTitle(year))) throw new Unrecognised(`SSA's notice for ${year} doesn't carry its title`);
  const found = [...flat.matchAll(/OASDI contribution and benefit base is \$([\d,]+)/gi)].map((m) => dollars(m[1]));
  if (found.length === 0) throw new Unrecognised(`SSA's notice for ${year} doesn't say "The OASDI contribution and benefit base is $..."`);
  if (found.some((v) => v !== found[0])) throw new Unrecognised(`SSA's notice for ${year} gives the base as ${found.map(money).join(' and ')}`);
  return found[0];
}

// ---- The check ----

/** What an official source says for one part of one law year: not out yet,
 *  or its value with where it was printed. */
type Official<T> = { out: false; what: string } | { out: true; what: string; value: T; where: string };

async function officialPoverty(guidelinesYear: number, get: Get): Promise<Official<PovertySizes>> {
  const what = `HHS ${guidelinesYear} guidelines`;
  const sizes = await fetchGuidelines(guidelinesYear, get);
  return sizes ? { out: true, what, value: sizes, where: 'ASPE API' } : { out: false, what };
}

async function officialNotice<T>(title: string, what: string, get: Get, read: (doc: FrDocument) => Promise<T>): Promise<Official<T>> {
  const doc = parseFrSearch(await get(frSearchUrl(title)), title);
  if (!doc) return { out: false, what };
  return { out: true, what, value: await read(doc), where: `${doc.citation}, ${doc.publication_date}` };
}

async function officialFor(part: CheckedPart, year: number, get: Get): Promise<Official<Value>> {
  switch (part) {
    case 'creditPoverty':
      return officialPoverty(year - 1, get);
    case 'medicaidPoverty':
      return officialPoverty(year, get);
    case 'medicare':
      return officialNotice(partBTitle(year), `CMS's Part B notice for ${year}`, get, async (doc) => {
        if (!doc.full_text_xml_url) throw new Unrecognised(`The Part B notice for ${year} has no XML`);
        return parsePartB(await get(doc.full_text_xml_url), year);
      });
    case 'wageBase':
      return officialNotice(ssaTitle(year), `SSA's notice for ${year}`, get, async (doc) => {
        if (!doc.raw_text_url) throw new Unrecognised(`SSA's notice for ${year} has no text`);
        return parseWageBase(await get(doc.raw_text_url), year);
      });
  }
}

type Value = PovertySizes | PartB | number;

/** A table's figures for a part, in the shape its official source gives. */
function oursFor(part: CheckedPart, law: PartialLaw): Value | undefined {
  if (part === 'medicare' || part === 'wageBase') return law[part];
  const guidelines = law[part];
  return guidelines && povertySizes(guidelines);
}

function summary(part: CheckedPart, value: Value): string {
  if (part === 'wageBase') return money(value as number);
  if (part === 'medicare') {
    const v = value as PartB;
    return `Part B ${premium(v.partB)}, ${v.irmaa.single.length} single and ${v.irmaa.joint.length} joint IRMAA tiers`;
  }
  return describeSizes(value as PovertySizes);
}

function differences(part: CheckedPart, ours: Value, official: Value): string[] {
  if (part === 'wageBase') return ours === official ? [] : [`ours ${money(ours as number)}, official ${money(official as number)}`];
  if (part === 'medicare') return partBDifferences(ours as PartB, official as PartB);
  return povertyDifferences(ours as PovertySizes, official as PovertySizes);
}

async function checkPart(part: CheckedPart, year: number, law: PartialLaw | undefined, get: Get): Promise<Row> {
  const row = (status: Status, detail: string): Row => ({ year, part, status, detail });
  const ours = law && oursFor(part, law);
  const held = law
    ? `ours: none yet (published ${law.sources[part].published ?? 'null'}, due ${law.sources[part].due})`
    : `ours: no ${year} table`;
  try {
    const official = await officialFor(part, year, get);
    if (ours === undefined) {
      return official.out
        ? row('new', `${official.what} now out (${official.where}): ${summary(part, official.value)}; ${held}`)
        : row('not out', `${official.what}; ${held}`);
    }
    if (!official.out) return row('unrecognised', `${official.what} can't be found, but the table holds ${summary(part, ours)}`);
    const found = differences(part, ours, official.value);
    return found.length === 0
      ? row('match', `${official.what} (${official.where}): ${summary(part, official.value)}`)
      : row('differ', `${official.what} (${official.where}): ${found.join('; ')}`);
  } catch (e) {
    if (e instanceof Unrecognised) return row('unrecognised', e.message);
    if (e instanceof Unreachable) return row('unreachable', e.message);
    throw e;
  }
}

/** Every law year's checked parts, then the next year's notices. Each URL is
 *  fetched once per run. */
export async function checkLaw(years: readonly PartialLaw[], get: Get): Promise<Row[]> {
  const seen = new Map<string, Promise<string>>();
  const once: Get = (url) => {
    let body = seen.get(url);
    if (!body) seen.set(url, (body = get(url)));
    return body;
  };
  const next = Math.max(...years.map((law) => law.year)) + 1;
  const rows: Row[] = [];
  for (const year of [...years.map((law) => law.year), next]) {
    const law = years.find((l) => l.year === year);
    for (const part of CHECKED_PARTS) rows.push(await checkPart(part, year, law, once));
  }
  return rows;
}

/** Whether a person needs to look: a figure differs, a notice is out that the
 *  tables don't hold, or a source answered in a shape this doesn't know. An
 *  unreachable source alone fails the run without a report: it is usually
 *  passing, and the next week's run tries again. */
export function needsAttention(rows: readonly Row[]): boolean {
  return rows.some((r) => r.status === 'differ' || r.status === 'new' || r.status === 'unrecognised');
}

export function exitCode(rows: readonly Row[]): number {
  return rows.some((r) => r.status === 'differ' || r.status === 'unrecognised' || r.status === 'unreachable') ? 1 : 0;
}

export function formatRows(rows: readonly Row[]): string[] {
  return rows.map((r) => `${r.year} ${r.part.padEnd(15)} ${r.status.padEnd(12)} ${r.detail}`);
}

export function reportMarkdown(rows: readonly Row[]): string {
  return [
    "The weekly law check (`bun run law:check`) compared Nya's tax law tables (`lib/fire/tax/law/`) with the official sources:",
    '',
    '```',
    ...formatRows(rows),
    '```',
    '',
    PART_D_NOTE,
    '',
    '- **differ**: a table disagrees with its source. Check the source and fix the table.',
    '- **new**: a notice the tables don\'t hold yet is out. Add it to the year\'s file with its source and date.',
    "- **unrecognised**: a source answered in a shape the check doesn't know, or a notice a table holds can't be found. The check (`scripts/law-check.ts`) needs a look.",
    '',
    'Each figure changes only through a reviewed pull request: see "The tax law tables, each year" in `docs/operations.md`.',
    '',
  ].join('\n');
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function premium(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Fetches with a time limit. A network error, a 5xx or a 429 is unreachable
 *  (likely passing); any other answer that isn't 2xx means the source moved
 *  or changed, which is unrecognised. */
export const fetchText: Get = async (url) => {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'Nya law check' }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Unreachable(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500 || res.status === 429) throw new Unreachable(`${url} answered ${res.status}`);
  if (!res.ok) throw new Unrecognised(`${url} answered ${res.status}`);
  return res.text();
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let report: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report' && argv[i + 1]) report = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}. Usage: bun run law:check [--report <path>]`);
      process.exit(2);
    }
  }
  const rows = await checkLaw(LAW_YEARS, fetchText);
  for (const line of formatRows(rows)) console.log(line);
  console.log(PART_D_NOTE);
  if (report !== null && needsAttention(rows)) {
    writeFileSync(report, reportMarkdown(rows));
    console.log(`Wrote ${report}.`);
  }
  process.exit(exitCode(rows));
}
