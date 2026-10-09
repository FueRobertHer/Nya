// lib/import/ofx.ts
//
// OFX and QFX statements (#43): the format most US banks offer beside CSV, and
// the better one. Each transaction carries the bank's own id (FITID), so a
// re-import is exact, and the schema says what every field means. Pure, safe to
// import from client code.
//
// A TOLERANT PARSER, never an XML one. OFX 1.x is SGML: leaf elements have no
// end tag ("<TRNAMT>-4.50" and the next tag), and banks mix in end tags where
// they like, put a whole file on one line, or write 2.x files that are not
// quite well-formed XML. So the file is read as a stream of tags and text:
//   - a tag followed by text is a leaf, whose value is that text (trimmed,
//     with OFX's entities decoded), ended by the next tag; its own end tag,
//     if one follows, is taken with it;
//   - a tag followed straight by another tag is an aggregate when OFX defines
//     it as one, or the file ends it somewhere (2.x ends everything), and an
//     empty leaf otherwise; an end tag closes the nearest open aggregate of
//     that name and anything left open inside it, and is ignored when none
//     is open;
//   - comments, processing instructions (2.x's <?xml?> and <?OFX?>) and the
//     1.x header lines before <OFX> are skipped.
// A field a transaction should have but that a misplaced empty element has
// swallowed is still found inside it.
//
// REPAIRS ARE SAID. OFX requires an aggregate's end tag (only a leaf may go
// without one), and some banks leave them out anyway: most often each
// transaction's </STMTTRN>. A transaction, a statement and a transaction list
// never hold one of their own kind, so opening one while one is open ends the
// open one first; an end tag ends whatever was left open inside its
// aggregate; the end of the file ends what is still open. Each repair is kept
// (repairNotes) and the preview says so, and every <STMTTRN> a statement
// opens is counted, so a transaction the repairs still couldn't read is
// reported as a line that can't be read rather than lost without a word.
//
// WHAT IS READ. Bank statements (STMTRS, under BANKMSGSRSV1) and credit card
// statements (CCSTMTRS, under CREDITCARDMSGSRSV1), however many a file holds:
// a file with more than one asks which to import. From each, the currency
// (CURDEF), the account it is for (BANKACCTFROM or CCACCTFROM, so a file for
// another account can be caught), the dates it covers, the ledger balance with
// its date, and its transactions (STMTTRN): FITID, DTPOSTED (DTUSER where a bank
// leaves it out), TRNAMT, NAME (else the extended name, the payee's name or
// the memo), MEMO, and a transaction's own currency where it gives one
// (CURRENCY, whose amounts are in that currency). Investment statements are
// not read.
//
// SIGNS. OFX writes amounts as the account holder sees them: negative is money
// out, on a card as on a bank account (a purchase lowers what you have and
// raises what you owe). Plaid's sign is the opposite, so TRNAMT is negated. A
// card statement's ledger balance is negative while money is owed. A bank
// that writes its signs the other way round is caught by the preview (and a
// hint, when its debits are mostly positive), and the sheet can flip them.
//
// THE BANK'S OWN TYPE (TRNTYPE) is a fact, not a guess, where its meaning
// doesn't depend on the bank (bankType): XFER is a transfer between the
// person's accounts, ATM cash taken out (or paid in) at a machine, FEE and
// SRVCHG a bank's fees, and PAYMENT on a credit card statement a payment
// toward the card. They set the fields the spending rules read
// (lib/spending.ts), as a linked bank's rows carry them: a category ("transfer
// out", "bank fees", "loan payments"), and for an ATM Plaid's code "atm", so
// the Plan counts the cash as spent (lib/fire/inputs.ts). Every other type
// (DEBIT, CREDIT, POS, CHECK, a PAYMENT from a bank account, which may pay a
// bill) says nothing a total can rely on, and is left without a category.

import { MAX_FIELD_CHARS, MAX_STATEMENTS, type Problem, type RawRecord } from './record';
import { ofxDay } from './dates';
import { readAmount } from './amounts';

type Leaf = { kind: 'leaf'; name: string; value: string; line: number; long: boolean };
type Agg = {
  kind: 'agg';
  name: string;
  children: OfxNode[];
  line: number;
  /** On a statement (STMTRS, CCSTMTRS): how many <STMTTRN> tags it opens,
   *  whatever was built from them. */
  listed?: number;
};
export type OfxNode = Leaf | Agg;

/** A place where the file's structure had to be repaired (see the header):
 *  an aggregate left without its end tag, or an end tag with nothing open to
 *  end. */
export type OfxRepair = { line: number; kind: 'unended' | 'stray-end'; name: string };

/** The aggregates OFX defines that a bank or card statement may hold. Any
 *  other element counts as one only if the file ends it somewhere. */
const AGGREGATES = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI', 'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKACCTTO',
  'BANKTRANLIST', 'STMTTRN', 'PAYEE', 'CURRENCY', 'ORIGCURRENCY', 'LEDGERBAL', 'AVAILBAL', 'BALLIST', 'BAL',
  'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM', 'CCACCTTO', 'IMAGEDATA', 'MKTGINFO',
  'INVSTMTMSGSRSV1', 'INVSTMTTRNRS', 'INVSTMTRS', 'INVACCTFROM', 'INVTRANLIST', 'INVPOSLIST', 'INVBAL',
]);

type Token = { t: 'open'; name: string; line: number; empty: boolean } | { t: 'close'; name: string; line: number } | { t: 'text'; text: string; line: number };

/** Line breaks in a piece of text: CRLF once, a lone CR or LF each once. */
function breaks(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13 && s.charCodeAt(i + 1) !== 10) n++;
  }
  return n;
}

const TAG = /<(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})(?:\s[^<>]{0,200}?)?\s*(\/?)>/y;

/** The file as tags and the text between them (see the header). */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let line = 1;
  let i = 0;
  let pending = '';
  let pendingLine = 1;
  const flush = () => {
    if (pending) out.push({ t: 'text', text: pending, line: pendingLine });
    pending = '';
  };
  const addText = (s: string) => {
    if (!pending) pendingLine = line;
    pending += s;
    line += breaks(s);
  };
  const skip = (to: number) => {
    line += breaks(text.slice(i, to));
    i = to;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) addText(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      skip(end < 0 ? text.length : end + 3);
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      const inner = text.slice(i + 9, end < 0 ? text.length : end);
      // Taken as it is: entities inside CDATA aren't entities.
      addText(inner.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      skip(end < 0 ? text.length : end + 1);
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(text);
    if (!m) {
      // A "<" that starts no tag is text.
      addText('<');
      i++;
      continue;
    }
    flush();
    const name = m[2].toUpperCase();
    if (m[1] === '/') out.push({ t: 'close', name, line });
    else out.push({ t: 'open', name, line, empty: m[3] === '/' });
    skip(i + m[0].length);
  }
  flush();
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** OFX's character references decoded; one it doesn't define stays as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|[A-Za-z]{2,6});/g, (all, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[ref.toLowerCase()] ?? all;
  });
}

/** A leaf, its value as written (trimmed, entities decoded, never longer
 *  than a field may be, and marked when it was). */
function leaf(name: string, raw: string, line: number): Leaf {
  const value = decodeEntities(raw).trim();
  return { kind: 'leaf', name, value: value.slice(0, MAX_FIELD_CHARS), line, long: value.length > MAX_FIELD_CHARS };
}

/** How deep aggregates may nest. A real statement nests six or seven deep;
 *  a file nesting thousands would only be there to exhaust the stack of the
 *  functions that walk the tree, so past this an element is read as a leaf. */
const MAX_DEPTH = 32;

/** Aggregates that never hold one of their own kind (see the header). */
const NEVER_NESTED = new Set(['STMTTRN', 'STMTRS', 'CCSTMTRS', 'STMTTRNRS', 'CCSTMTTRNRS', 'BANKTRANLIST']);

/** The tokens as a tree (see the header), and what had to be repaired. */
function buildTree(tokens: Token[]): { root: Agg; repairs: OfxRepair[] } {
  const closes = new Set(tokens.flatMap((t) => (t.t === 'close' ? [t.name] : [])));
  const root: Agg = { kind: 'agg', name: '#root', children: [], line: 1 };
  const repairs: OfxRepair[] = [];
  const stack: Agg[] = [root];
  const top = () => stack[stack.length - 1];
  /** Ends every aggregate open from `at` up, noting each OFX aggregate the
   *  file left without its end tag. */
  const endFrom = (at: number) => {
    for (let k = stack.length - 1; k >= at; k--) if (AGGREGATES.has(stack[k].name)) repairs.push({ line: stack[k].line, kind: 'unended', name: stack[k].name });
    stack.length = at;
  };
  const openAt = (name: string) => {
    for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) return k;
    return -1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'text') continue; // whitespace between tags, or stray text
    if (tok.t === 'close') {
      const at = openAt(tok.name);
      if (at > 0) {
        endFrom(at + 1);
        stack.length = at;
      } else if (AGGREGATES.has(tok.name)) repairs.push({ line: tok.line, kind: 'stray-end', name: tok.name });
      continue;
    }
    if (tok.name === 'STMTTRN') {
      // Counted on its statement whatever it turns out to be, so one the
      // tree can't hold is still known to be there.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === 'STMTRS' || stack[k].name === 'CCSTMTRS') {
          stack[k].listed = (stack[k].listed ?? 0) + 1;
          break;
        }
      }
    }
    if (tok.empty) {
      top().children.push(leaf(tok.name, '', tok.line));
      continue;
    }
    const next = tokens[i + 1];
    if (next?.t === 'text' && next.text.trim() !== '') {
      top().children.push(leaf(tok.name, next.text, tok.line));
      i++;
      const after = tokens[i + 1];
      if (after?.t === 'close' && after.name === tok.name) i++;
      continue;
    }
    let j = i + 1;
    while (tokens[j]?.t === 'text') j++;
    const sig = tokens[j];
    if (sig?.t === 'close' && sig.name === tok.name) {
      top().children.push(leaf(tok.name, '', tok.line));
      i = j;
      continue;
    }
    if (AGGREGATES.has(tok.name) || closes.has(tok.name)) {
      // One of its own kind still open was left unended: it ends here.
      if (NEVER_NESTED.has(tok.name)) {
        const open = openAt(tok.name);
        if (open > 0) endFrom(open);
      }
      if (stack.length < MAX_DEPTH) {
        const agg: Agg = { kind: 'agg', name: tok.name, children: [], line: tok.line };
        top().children.push(agg);
        stack.push(agg);
        continue;
      }
    }
    top().children.push(leaf(tok.name, '', tok.line));
  }
  // What the file leaves open at its end.
  endFrom(1);
  return { root, repairs };
}

/** What the repairs were, in words for the preview, most telling first. */
export function repairNotes(repairs: readonly OfxRepair[]): string[] {
  const unendedTxns = repairs.filter((r) => r.kind === 'unended' && r.name === 'STMTTRN').length;
  const otherUnended = repairs.filter((r) => r.kind === 'unended' && r.name !== 'STMTTRN');
  const stray = repairs.filter((r) => r.kind === 'stray-end');
  const names = (list: readonly OfxRepair[]) => {
    const distinct = [...new Set(list.map((r) => r.name))];
    return distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ' and others' : '');
  };
  const notes: string[] = [];
  if (unendedTxns > 0) {
    notes.push(
      unendedTxns === 1
        ? 'One transaction in this file has no end tag (</STMTTRN>), so it was read up to the next one. Check the rows below.'
        : `${unendedTxns.toLocaleString('en-US')} transactions in this file have no end tag (</STMTTRN>), so each was read up to the next one. Check the rows below.`
    );
  }
  if (otherUnended.length > 0) {
    notes.push(
      `This file leaves ${otherUnended.length === 1 ? 'a part' : `${otherUnended.length.toLocaleString('en-US')} parts`} without an end tag (${names(otherUnended)}), so ${otherUnended.length === 1 ? 'it was' : 'they were'} read as ending where the next part starts or the file ends.`
    );
  }
  if (stray.length > 0) {
    notes.push(`${stray.length === 1 ? 'An end tag' : `${stray.length.toLocaleString('en-US')} end tags`} in this file (${names(stray)}) had nothing to end, and ${stray.length === 1 ? 'was' : 'were'} skipped.`);
  }
  return notes;
}

/** Every aggregate named `name` under `node`, in file order. */
function findAll(node: Agg, name: string, out: Agg[] = []): Agg[] {
  for (const c of node.children) {
    if (c.kind !== 'agg') continue;
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** A child aggregate by name. */
function child(node: Agg | undefined, name: string): Agg | undefined {
  return node?.children.find((c): c is Agg => c.kind === 'agg' && c.name === name);
}

/** A field's leaf: a child of the node, or inside an element the file left
 *  open by mistake (one OFX doesn't define as an aggregate). */
function leafOf(node: Agg | undefined, name: string): Leaf | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (c.kind === 'leaf' && c.name === name) return c;
  for (const c of node.children) {
    if (c.kind === 'agg' && !AGGREGATES.has(c.name)) {
      const found = leafOf(c, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** A field's value, or null when it is absent or empty. */
function valueOf(node: Agg | undefined, name: string): string | null {
  const v = leafOf(node, name)?.value;
  return v ? v : null;
}

/** Whether anything under the node is longer than a field may be. */
function hasLong(node: OfxNode): boolean {
  return node.kind === 'leaf' ? node.long : node.children.some(hasLong);
}

/** The node as plain data, for the raw record: a leaf's value, an aggregate's
 *  fields by name (a name repeated becomes a list). An account number (a
 *  transfer's other account, BANKACCTTO or CCACCTTO) keeps only its last four
 *  characters, as the statement's own does: Nya never keeps a whole one. */
export function plainOf(node: OfxNode): unknown {
  if (node.kind === 'leaf') return node.name === 'ACCTID' ? accountMask(node.value) : node.value;
  const out: Record<string, unknown> = {};
  const repeated = new Set<string>();
  for (const c of node.children) {
    const v = plainOf(c);
    if (!Object.hasOwn(out, c.name)) out[c.name] = v;
    else if (repeated.has(c.name)) (out[c.name] as unknown[]).push(v);
    else {
      out[c.name] = [out[c.name], v];
      repeated.add(c.name);
    }
  }
  return out;
}

/** An OFX amount: digits with a point, or a comma where a bank's locale uses
 *  one, and a sign; grouping marks only where a bank adds them anyway. */
export function ofxAmount(text: string | null): number | null {
  if (!text) return null;
  const s = text.replace(/\s/g, '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  const mark = comma > dot ? ',' : '.';
  const read = readAmount(s, mark);
  return read && read.direction === undefined ? read.value : null;
}

/** A three-letter currency code, upper case, or null. */
function currencyCode(text: string | null): string | null {
  const s = text?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

export type OfxAccount = {
  /** The bank's routing number (BANKID), which is public; null on a card. */
  bank_id: string | null;
  /** The account number as the file gives it. Kept in memory only: what is
   *  stored is its last four characters (accountMask). */
  account_id: string | null;
  /** CHECKING, SAVINGS, MONEYMRKT, CREDITLINE, CD; null on a card. */
  account_type: string | null;
};

export type OfxStatement = {
  /** Its place among the file's statements, counting from 0. */
  index: number;
  kind: 'bank' | 'creditcard';
  line: number;
  currency: string | null;
  account: OfxAccount;
  /** The days it covers (DTSTART, DTEND), when it says. */
  start: string | null;
  end: string | null;
  /** The ledger balance as written (a card's is negative while money is owed)
   *  and the day it is as of. */
  ledger: { amount: number; as_of: string | null } | null;
  transactions: Agg[];
  /** How many <STMTTRN> tags it opens: more than `transactions` when some
   *  couldn't be built into one. */
  listed: number;
};

export type OfxFile = { statements: OfxStatement[]; problems: Problem[]; repairs: OfxRepair[]; error: string | null };

/** What the file says went wrong at the bank, from a STATUS aggregate. */
function statusProblem(node: Agg | undefined): string | null {
  const status = child(node, 'STATUS');
  const code = valueOf(status, 'CODE');
  if (!status || code === null || code === '0') return null;
  const message = valueOf(status, 'MESSAGE');
  return `the bank reported error ${code.slice(0, 12)}${message ? ` (${message.slice(0, 120)})` : ''}`;
}

/** The statements in an OFX or QFX file (see the header). */
export function parseOfx(text: string): OfxFile {
  const { root, repairs } = buildTree(tokenize(text));
  const problems: Problem[] = [];
  const statements: OfxStatement[] = [];
  let found = 0;
  const walk = (node: Agg) => {
    for (const c of node.children) {
      if (c.kind !== 'agg' || found > MAX_STATEMENTS) continue;
      if (c.name === 'STMTRS' || c.name === 'CCSTMTRS') {
        // Counted first, and none built past the bound.
        if (++found <= MAX_STATEMENTS) statements.push(statementOf(c, c.name === 'STMTRS' ? 'bank' : 'creditcard', statements.length));
      } else walk(c);
    }
  };
  walk(root);
  if (found > MAX_STATEMENTS) {
    return {
      statements: [],
      problems,
      repairs,
      error: `This file holds more than ${MAX_STATEMENTS} statements, more than one import can choose from. Export one account at a time.`,
    };
  }
  // A response the bank answered with an error instead of a statement.
  for (const name of ['STMTTRNRS', 'CCSTMTTRNRS']) {
    for (const rs of findAll(root, name)) {
      if (child(rs, 'STMTRS') || child(rs, 'CCSTMTRS')) continue;
      const why = statusProblem(rs);
      if (why) problems.push({ line: rs.line, reason: `A statement is missing: ${why}.` });
    }
  }
  if (statements.length > 0) return { statements, problems, repairs, error: null };
  if (findAll(root, 'INVSTMTRS').length > 0) {
    return { statements, problems, repairs, error: 'This is an investment statement, which can’t be imported yet: only bank and credit card statements can.' };
  }
  const signon = statusProblem(findAll(root, 'SONRS')[0]);
  if (signon) return { statements, problems, repairs, error: `This file holds no statement: ${signon}.` };
  if (problems.length > 0) return { statements, problems, repairs, error: 'This file holds no statement the bank could produce.' };
  return { statements, problems, repairs, error: 'This OFX file holds no bank or credit card statement.' };
}

function statementOf(node: Agg, kind: OfxStatement['kind'], index: number): OfxStatement {
  // Found wherever they are in the statement: a bank that leaves an
  // aggregate unended puts the next one inside it.
  const from = findAll(node, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM')[0];
  const list = findAll(node, 'BANKTRANLIST')[0];
  const ledger = findAll(node, 'LEDGERBAL')[0];
  const balance = ofxAmount(valueOf(ledger, 'BALAMT'));
  const asOf = valueOf(ledger, 'DTASOF');
  return {
    index,
    kind,
    line: node.line,
    currency: currencyCode(valueOf(node, 'CURDEF')),
    account: {
      bank_id: kind === 'bank' ? valueOf(from, 'BANKID') : null,
      account_id: valueOf(from, 'ACCTID'),
      account_type: kind === 'bank' ? (valueOf(from, 'ACCTTYPE')?.toUpperCase() ?? null) : null,
    },
    start: list ? ofxDayOrNull(valueOf(list, 'DTSTART')) : null,
    end: list ? ofxDayOrNull(valueOf(list, 'DTEND')) : null,
    ledger: balance === null ? null : { amount: balance, as_of: ofxDayOrNull(asOf) },
    // A statement's transactions are its list's (anywhere in it, since a
    // transaction never holds another); a bank that left the list out still
    // has them read.
    transactions: findAll(list ?? node, 'STMTTRN'),
    listed: node.listed ?? 0,
  };
}

const ofxDayOrNull = (v: string | null) => (v ? ofxDay(v) : null);

/** The last four characters of an account number: what is shown and stored. */
export function accountMask(account_id: string | null): string | null {
  const s = account_id?.replace(/[\s-]/g, '') ?? '';
  return s ? s.slice(-4) : null;
}

/** A statement as the import sheet lists it when a file holds several. */
export function statementLabel(s: Pick<OfxStatement, 'kind' | 'account'>): string {
  const mask = accountMask(s.account.account_id);
  const type = s.kind === 'creditcard' ? 'Credit card' : (ACCOUNT_TYPES[s.account.account_type ?? ''] ?? 'Bank account');
  return mask ? `${type} ending ${mask}` : type;
}

const ACCOUNT_TYPES: Record<string, string> = {
  CHECKING: 'Checking',
  SAVINGS: 'Savings',
  MONEYMRKT: 'Money market',
  CREDITLINE: 'Line of credit',
  CD: 'Certificate of deposit',
};

/** What a transaction's TRNTYPE says outright (see the header), as the fields
 *  a row carries, or null. `amount` is in Plaid's sign: positive is money
 *  out. */
export function bankType(
  type: string | null,
  kind: OfxStatement['kind'],
  amount: number
): { category: string; transaction_code: string | null } | null {
  switch (type) {
    case 'XFER':
      return { category: amount > 0 ? 'transfer out' : 'transfer in', transaction_code: null };
    case 'ATM':
      // Plaid's code for it, which the Plan reads as cash taken out.
      return { category: amount > 0 ? 'transfer out' : 'transfer in', transaction_code: 'atm' };
    case 'FEE':
    case 'SRVCHG':
      return { category: 'bank fees', transaction_code: null };
    case 'PAYMENT':
      // On a card it pays the card off; from a bank account it may pay any
      // bill, which is spending.
      return kind === 'creditcard' ? { category: 'loan payments', transaction_code: null } : null;
    default:
      return null;
  }
}

/** A statement's transactions as RawRecords, with the ones that can't be
 *  read, and whether its signs look reversed. `flip` reads every amount the
 *  other way round, for a bank that writes them so. */
export function ofxRecords(s: OfxStatement, opts: { flip?: boolean } = {}): { records: RawRecord[]; problems: Problem[]; reversedHint: boolean } {
  const records: RawRecord[] = [];
  const problems: Problem[] = [];
  let debits = 0;
  let positiveDebits = 0;
  // A transaction opened but not built into one (nested past the depth the
  // tree holds, or an empty element): never lost without a word.
  const unbuilt = s.listed - s.transactions.length;
  if (unbuilt > 0) {
    problems.push({
      line: s.line,
      reason:
        unbuilt === 1
          ? `This statement lists ${s.listed.toLocaleString('en-US')} transactions, and one of them can’t be read: the file is damaged there.`
          : `This statement lists ${s.listed.toLocaleString('en-US')} transactions, and ${unbuilt.toLocaleString('en-US')} of them can’t be read: the file is damaged there.`,
    });
  }
  for (const t of s.transactions) {
    const raw = plainOf(t);
    const fail = (reason: string) => problems.push({ line: t.line, reason, raw });
    if (hasLong(t)) {
      fail(`A field is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so this transaction can’t be read.`);
      continue;
    }
    const correction = valueOf(t, 'CORRECTACTION');
    if (correction) {
      fail(`It corrects an earlier transaction (${correction.slice(0, 10)}), so it isn’t imported: check that transaction by hand.`);
      continue;
    }
    const posted = valueOf(t, 'DTPOSTED');
    const dateText = posted ?? valueOf(t, 'DTUSER');
    if (!dateText) {
      fail('It has no date.');
      continue;
    }
    const date = ofxDay(dateText);
    if (!date) {
      fail(`Its date (${dateText.slice(0, 40)}) can’t be read.`);
      continue;
    }
    const amountText = valueOf(t, 'TRNAMT');
    const value = ofxAmount(amountText);
    if (value === null) {
      fail(amountText ? `Its amount (${amountText.slice(0, 40)}) can’t be read.` : 'It has no amount.');
      continue;
    }
    const type = valueOf(t, 'TRNTYPE')?.toUpperCase() ?? null;
    if (type === 'DEBIT') {
      debits++;
      if (value > 0) positiveDebits++;
    }
    const memo = valueOf(t, 'MEMO');
    const check = valueOf(t, 'CHECKNUM');
    const name = valueOf(t, 'NAME') ?? valueOf(t, 'EXTDNAME') ?? valueOf(child(t, 'PAYEE'), 'NAME');
    const description = name ?? memo ?? (check ? `Check ${check}` : null) ?? (type ? type.charAt(0) + type.slice(1).toLowerCase() : '');
    const fitid = valueOf(t, 'FITID');
    // A transaction in another currency than the statement's says so, and
    // its amount is in that currency.
    const currency = currencyCode(valueOf(child(t, 'CURRENCY'), 'CURSYM')) ?? s.currency;
    // OFX's sign is the holder's: negative is money out. Plaid's is the other.
    const amount = opts.flip ? value : -value;
    const typed = bankType(type, s.kind, amount);
    records.push({
      source: 'ofx',
      ...(fitid ? { source_id: fitid } : {}),
      date,
      ...(posted && ofxDay(posted) ? { posted_date: ofxDay(posted)! } : {}),
      amount,
      description,
      raw,
      ...(currency ? { currency } : {}),
      category: typed?.category ?? null,
      ...(typed?.transaction_code ? { transaction_code: typed.transaction_code } : {}),
      note: name && memo && memo.toLowerCase() !== name.toLowerCase() ? memo : null,
      line: t.line,
    });
  }
  // Debits are money out, so a file whose debits are mostly positive writes
  // its amounts the other way round.
  return { records, problems, reversedHint: debits >= 3 && positiveDebits / debits > 0.8 };
}
