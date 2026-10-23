import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { decodeFile } from '@/lib/import/text';
import { readAppFile, type AppRead } from '@/lib/import/apps/read';
import { detectApp } from '@/lib/import/apps/detect';
import { appAmount, headerKey, markTransfersByPayee, tagsOf } from '@/lib/import/apps/common';
import { explode, splitMark } from '@/lib/import/apps/splits';
import { appFileText, ACTUAL_CSV_STEPS } from '@/lib/import/apps/file';
import { listZip, MAX_ENTRY_BYTES } from '@/lib/import/apps/zip';
import type { AppReadOptions, AppTxn } from '@/lib/import/apps/types';

// Reading other apps' exports (lib/import/apps/): which app a header is from,
// each app's columns, signs, dates, categories and their kinds, tags, notes,
// transfers, starting balances and split transactions, the mapping step for a
// header this code doesn't know, and the zips YNAB and ZeroSum export. The
// fixtures (test/fixtures/apps/) follow what each module's header cites.

const FIXTURES = join(import.meta.dir, 'fixtures', 'apps');
const text = (name: string) => decodeFile(new Uint8Array(readFileSync(join(FIXTURES, name)))).text;

function read(name: string, options: AppReadOptions = {}): AppRead {
  return readAppFile(text(name), { options, thisYear: 2026 });
}
function ready(name: string, options: AppReadOptions = {}) {
  const r = read(name, options);
  if (r.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
}
const byPayee = (txns: AppTxn[], payee: string) => txns.filter((t) => t.payee === payee);
const one = (txns: AppTxn[], payee: string, account?: string) => {
  const found = byPayee(txns, payee).filter((t) => account === undefined || t.account === account);
  expect(found.length).toBe(1);
  return found[0];
};

/** A zip of these files, deflated, as an app writes one. */
function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

describe('which app an export is from', () => {
  test('each fixture is told by its header', () => {
    const header = (name: string) => text(name).split(/\r?\n/)[0].split(',').map((h) => h.replace(/^"|"$/g, ''));
    expect(detectApp(header('monarch-transactions.csv'))?.app).toBe('monarch');
    expect(detectApp(header('ynab-register.csv'))?.app).toBe('ynab');
    expect(detectApp(header('lunchmoney-transactions.csv'))?.app).toBe('lunchmoney');
    expect(detectApp(header('lunchmoney-titlecase.csv'))?.app).toBe('lunchmoney');
    expect(detectApp(header('actual-export.csv'))?.app).toBe('actual');
    expect(detectApp(header('actual-export-early.csv'))?.app).toBe('actual');
    expect(detectApp(header('zerosum-transactions.csv'))?.app).toBe('zerosum');
  });

  test('header variants: YNAB 4, ZeroSum without groups, Actual before groups and its export of chosen rows', () => {
    expect(detectApp(['Account', 'Flag', 'Check Number', 'Date', 'Payee', 'Category', 'Master Category', 'Sub Category', 'Memo', 'Outflow', 'Inflow', 'Cleared', 'Running Balance'])?.app).toBe('ynab');
    expect(detectApp(['date', 'account', 'payee', 'category', 'memo', 'tags', 'outflow', 'inflow', 'cleared'])?.app).toBe('zerosum');
    expect(detectApp(['Account', 'Date', 'Payee', 'Notes', 'Category', 'Amount', 'Split_Amount', 'Cleared'])?.app).toBe('actual');
    expect(detectApp(['Account', 'Date', 'Payee', 'Notes', 'Category', 'Amount', 'Cleared', 'Reconciled'])?.app).toBe('actual');
    // Monarch with a column it may add later.
    expect(detectApp(['Date', 'Merchant', 'Category', 'Account', 'Original Statement', 'Notes', 'Amount', 'Tags', 'Owner'])?.app).toBe('monarch');
  });

  test('a bank’s CSV, or a header too thin to tell, is none of them', () => {
    expect(detectApp(['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'])).toBeNull();
    expect(detectApp(['Date', 'Description', 'Amount'])).toBeNull();
    // A header like Lunch Money's with only one of its own columns.
    expect(detectApp(['date', 'payee', 'amount', 'currency', 'category', 'notes', 'parent_id'])).toBeNull();
  });

  test('column names compare without case, spacing, underscores or a byte order mark', () => {
    expect(headerKey('﻿Category_Group')).toBe('category group');
    expect(headerKey('  Original   Statement ')).toBe('original statement');
  });
});

describe('Monarch', () => {
  const r = ready('monarch-transactions.csv');
  const txns = r.parsed.txns;

  test('every row, in Plaid’s sign, with its account, merchant, note and tags', () => {
    expect(r.app).toBe('monarch');
    expect(r.detected).toBe(true);
    expect(txns.length).toBe(16);
    expect(r.parsed.problems).toEqual([]);
    const coffee = one(txns, 'Blue Bottle Coffee');
    expect(coffee.amount).toBe(4.5);
    expect(coffee.account).toBe('Chase Sapphire (...4444)');
    expect(coffee.note).toBe('with Sam');
    expect(coffee.tags).toEqual(['Work', 'Reimbursable']);
    expect(coffee.date).toBe('2026-08-29');
    expect(one(txns, 'Acme Corp').amount).toBe(-2500);
    // A refund is money in, in its spending category.
    const refund = one(txns, 'REI');
    expect(refund.amount).toBe(-35);
    expect(refund.category).toEqual({ group: null, name: 'Shopping', kind: null });
    // A quoted merchant and note with commas.
    const pizza = one(txns, "Joe's Pizza, Inc.");
    expect(pizza.note).toBe('birthday dinner, with tip');
    expect(pizza.tags).toEqual(['Vacation']);
    // The bank's own words stay in the raw record.
    expect(pizza.raw).toContain('JOES PIZZA, INC NEW YORK NY');
  });

  test('categories carry the kind Monarch’s defaults have, from their names; Uncategorized is none', () => {
    expect(one(txns, 'Transfer to Savings').category).toEqual({ group: null, name: 'Transfer', kind: 'transfer', from: 'name' });
    expect(one(txns, 'Chase Card Payment').category?.kind).toBe('transfer');
    expect(one(txns, 'Acme Corp').category).toEqual({ group: null, name: 'Paychecks', kind: 'income', from: 'name' });
    expect(one(txns, 'Interest').category?.kind).toBe('income');
    expect(one(txns, 'Mystery Charge').category).toBeNull();
    expect(one(txns, 'Whole Foods').category?.kind).toBeNull();
  });

  test('a split’s parts come in as rows of their own, and the review says why', () => {
    expect(byPayee(txns, 'Costco').map((t) => t.amount)).toEqual([80, 40]);
    expect(r.parsed.splits.rebuilt).toBe(0);
    expect(r.parsed.splits.unmarked).toContain('doesn’t say which rows are the parts of a split');
  });
});

describe('YNAB', () => {
  const r = ready('ynab-register.csv');
  const txns = r.parsed.txns;

  test('outflow less inflow, its dates settled by the file, the budget’s symbol left out', () => {
    expect(r.app).toBe('ynab');
    expect(r.read.date_order).toBe('mdy');
    expect(r.read.order_open).toBe(false);
    expect(r.read.decimal).toBe('.');
    expect(r.parsed.problems).toEqual([]);
    expect(one(txns, 'Acme Corp').amount).toBe(-2500);
    expect(one(txns, 'Landlord').amount).toBe(1850);
    expect(one(txns, 'Landlord').date).toBe('2026-09-05');
    expect(one(txns, 'REI').amount).toBe(-35);
  });

  test('Inflow is income; a category keeps its group; no category is none', () => {
    expect(one(txns, 'Acme Corp').category).toEqual({ group: 'Inflow', name: 'Ready to Assign', kind: 'income', from: 'app' });
    expect(one(txns, 'Landlord').category).toEqual({ group: 'Monthly Bills', name: 'Rent', kind: null });
    expect(one(txns, 'Mystery Shop').category).toBeNull();
    expect(one(txns, 'Mystery Shop').transfer).toBeNull();
  });

  test('"Transfer : X" is a transfer to X, whatever category YNAB gave it, and says so', () => {
    const toSavings = one(txns, 'Transfer : Savings');
    expect(toSavings.transfer).toBe('Savings');
    expect(toSavings.category).toBeNull();
    const ira = one(txns, 'Transfer : Brokerage');
    expect(ira.transfer).toBe('Brokerage');
    expect(ira.category).toBeNull();
    expect(r.parsed.notes.join(' ')).toContain('1 transfer has a category in YNAB');
  });

  test('starting balances and YNAB’s reconciliation adjustments are opening balances', () => {
    expect(byPayee(txns, 'Starting Balance').every((t) => t.starting)).toBe(true);
    expect(one(txns, 'Reconciliation Balance Adjustment').starting).toBe(true);
    expect(one(txns, 'Acme Corp').starting).toBe(false);
  });

  test('a flag is a tag', () => {
    expect(one(txns, 'Landlord').tags).toEqual(['Blue flag']);
  });

  test('"Split (1/3)" lines are one transaction with its parts, adding up exactly', () => {
    expect(r.parsed.splits.rebuilt).toBe(1);
    expect(r.parsed.splits.parts).toBe(3);
    const costco = one(txns, 'Costco');
    expect(costco.amount).toBe(145);
    expect(costco.lines.length).toBe(3);
    expect(costco.tags).toEqual(['Red flag']);
    expect(costco.category).toBeNull();
    expect(costco.parts!.map((p) => [p.amount, p.category?.name, p.note])).toEqual([
      [80, 'Groceries', 'food'],
      [40, 'Household', null],
      [25, 'Birthdays', 'gift card'],
    ]);
    // When it can't be held, its lines come back as they were.
    expect(explode(costco).map((t) => [t.amount, t.category?.name, t.note, t.payee])).toEqual([
      [80, 'Groceries', 'food', 'Costco'],
      [40, 'Household', null, 'Costco'],
      [25, 'Birthdays', 'gift card', 'Costco'],
    ]);
  });

  test('split lines it can’t rebuild come in as rows, each saying why', () => {
    const lines = [
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      // Money out and in at once: a purchase with cash back.
      '"Visa","","09/12/2026","Target","Shop: Stuff","Shop","Stuff","Split (1/2) toys",$30.00,$0.00,"Cleared"',
      '"Visa","","09/12/2026","Target","Inflow: Ready to Assign","Inflow","Ready to Assign","Split (2/2) cash back",$0.00,$20.00,"Cleared"',
      // A run with a line missing.
      '"Visa","","09/13/2026","Safeway","Shop: Food","Shop","Food","Split (1/3) a",$1.00,$0.00,"Cleared"',
      '"Visa","","09/13/2026","Safeway","Shop: Food","Shop","Food","Split (3/3) c",$2.00,$0.00,"Cleared"',
      // A line of nothing is left out of the split it is in.
      '"Visa","","09/14/2026","Kroger","Shop: Food","Shop","Food","Split (1/3) ",$5.00,$0.00,"Cleared"',
      '"Visa","","09/14/2026","Kroger","Shop: Stuff","Shop","Stuff","Split (2/3) ",$0.00,$0.00,"Cleared"',
      '"Visa","","09/14/2026","Kroger","Shop: Stuff","Shop","Stuff","Split (3/3) ",$6.00,$0.00,"Cleared"',
    ].join('\n');
    const got = readAppFile(lines, { options: {}, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    expect(got.parsed.splits.rebuilt).toBe(1);
    expect(got.parsed.splits.dropped).toEqual([7]);
    expect(got.parsed.splits.kept.map((k) => [k.reason.slice(0, 30), k.lines])).toEqual([
      ['Its lines are money out and mo', [2, 3]],
      ['Its lines aren’t all together ', [4, 5]],
    ]);
    // Kept lines keep their memo as written, so they still say they were split.
    expect(got.parsed.txns.find((t) => t.line === 2)?.note).toBe('Split (1/2) toys');
    expect(got.parsed.txns.find((t) => t.payee === 'Kroger')?.amount).toBe(11);
  });

  test('a European budget: day first (asked when its dates don’t say), comma decimals, the euro sign', () => {
    const asked = read('ynab-register-eu.csv');
    expect(asked.status).toBe('date_order');
    const r2 = ready('ynab-register-eu.csv', { date_order: 'dmy' });
    expect(r2.read.decimal).toBe(',');
    expect(one(r2.parsed.txns, 'Vermieter')).toMatchObject({ amount: 1250, date: '2026-09-01', tags: ['Purple flag'] });
    expect(one(r2.parsed.txns, 'Arbeitgeber GmbH').amount).toBe(-3150);
  });

  test('YNAB 4: master and sub categories, and its split marks', () => {
    const file = [
      '"Account","Flag","Check Number","Date","Payee","Category","Master Category","Sub Category","Memo","Outflow","Inflow","Cleared","Running Balance"',
      '"Checking","","","13/05/2015","Shop","Everyday: Food","Everyday","Food","(Split 1/2) bread",$3.00,$0.00,"C",$97.00',
      '"Checking","","","13/05/2015","Shop","Everyday: Home","Everyday","Home","(Split 2/2) soap",$2.00,$0.00,"C",$95.00',
      '"Checking","","","14/05/2015","Employer","Income: Available this month","Income","Available this month","",$0.00,$500.00,"R",$595.00',
    ].join('\n');
    const got = readAppFile(file, { options: {}, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    expect(got.parsed.variant).toBe('register-ynab4');
    expect(got.read.date_order).toBe('dmy');
    expect(got.parsed.splits.rebuilt).toBe(1);
    expect(one(got.parsed.txns, 'Employer').category).toEqual({ group: 'Income', name: 'Available this month', kind: 'income', from: 'app' });
    expect(one(got.parsed.txns, 'Shop').parts!.map((p) => p.category?.name)).toEqual(['Food', 'Home']);
  });
});

describe('Lunch Money', () => {
  const r = ready('lunchmoney-transactions.csv');
  const txns = r.parsed.txns;

  test('read Lunch Money’s way (money out positive), confirmed by its income rows', () => {
    expect(r.app).toBe('lunchmoney');
    expect(r.read.sign).toBe('positive-out');
    expect(r.read.sign_from).toBe('app');
    expect(one(txns, 'Acme Corp').amount).toBe(-2500);
    expect(one(txns, 'Whole Foods').amount).toBe(86.42);
    expect(one(txns, 'REI').amount).toBe(-35);
  });

  test('each row’s currency, upper case; categories with groups and the kinds their names say', () => {
    expect(one(txns, 'Café de Flore').currency).toBe('EUR');
    expect(one(txns, 'Café de Flore').tags).toEqual(['Travel', 'Paris']);
    expect(one(txns, 'Acme Corp').category).toEqual({ group: 'Income', name: 'Paycheck', kind: 'income', from: 'name' });
    expect(one(txns, 'Transfer to savings').category?.kind).toBe('transfer');
    expect(one(txns, 'Unknown Merchant').category).toBeNull();
    expect(r.parsed.notes[0]).toContain('treat as income');
  });

  test('split children by their parent’s id are one transaction; a group is one row at its net', () => {
    expect(r.parsed.splits.rebuilt).toBe(1);
    const costco = txns.find((t) => t.parts !== null)!;
    expect(costco.payee).toBe('Costco Wholesale');
    expect(costco.amount).toBe(120);
    expect(costco.parts!.map((p) => [p.amount, p.category?.name, p.note])).toEqual([
      [80, 'Groceries', 'food'],
      [40, 'Household', 'paper towels'],
    ]);
    const dinner = one(txns, 'Dinner with friends');
    expect(dinner.grouped).toBe(true);
    expect(r.parsed.notes.join(' ')).toContain('1 row is a group');
    expect(txns.length).toBe(10);
  });

  test('a file written the other way round is read so, from its income rows, and the person can turn it', () => {
    const flipped = ready('lunchmoney-titlecase.csv');
    expect(flipped.read.sign).toBe('negative-out');
    expect(flipped.read.sign_from).toBe('file');
    expect(one(flipped.parsed.txns, 'Acme Corp').amount).toBe(-2500);
    expect(one(flipped.parsed.txns, 'Landlord').amount).toBe(1850);
    expect(one(flipped.parsed.txns, 'Landlord').account).toBe('Checking');
    const chosen = ready('lunchmoney-titlecase.csv', { sign: 'positive-out' });
    expect(chosen.read.sign_from).toBe('chosen');
    expect(one(chosen.parsed.txns, 'Landlord').amount).toBe(-1850);
  });

  test('a split whose parent is in the file uses its payee, and never counts it beside its parts', () => {
    const file = [
      'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
      '2026-09-08,Costco run,120.00,usd,,,the parent,Errands,Visa,,,,9100,,',
      '2026-09-08,Costco,80.00,usd,Groceries,Food,,,Visa,Costco,split,9100,9101,,',
      '2026-09-08,Costco,40.00,usd,Household,Home,,,Visa,Costco,split,9100,9102,,',
      // Parts on different days stay rows, and their parent goes.
      '2026-09-01,Trip,50.00,usd,,,,,Visa,,,,9200,,',
      '2026-09-01,Hotel,30.00,usd,Travel,Fun,,,Visa,Trip,split,9200,9201,,',
      '2026-09-02,Taxi,20.00,usd,Travel,Fun,,,Visa,Trip,split,9200,9202,,',
    ].join('\n');
    const got = readAppFile(file, { options: {}, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    expect(got.parsed.txns.map((t) => [t.payee, t.amount, t.parts?.length ?? 0])).toEqual([
      ['Costco run', 120, 2],
      ['Hotel', 30, 0],
      ['Taxi', 20, 0],
    ]);
    expect(got.parsed.txns[0].note).toBe('the parent');
    expect(got.parsed.txns[0].tags).toEqual(['Errands']);
    expect(got.parsed.splits.kept[0].lines).toEqual([6, 7]);
  });
});

describe('Actual Budget', () => {
  const r = ready('actual-export.csv');
  const txns = r.parsed.txns;

  test('its own sign, groups, and its Income group as income', () => {
    expect(r.app).toBe('actual');
    expect(r.parsed.variant).toBe('export-2026');
    expect(r.parsed.problems).toEqual([]);
    expect(one(txns, 'Acme Corp')).toMatchObject({ amount: -2500, category: { group: 'Income', name: 'Income', kind: 'income', from: 'app' } });
    expect(one(txns, 'Whole Foods').amount).toBe(86.42);
    expect(one(txns, 'REI').amount).toBe(-35);
    expect(one(txns, 'Mystery Shop').category).toBeNull();
  });

  test('a payee named for another account in the file is a transfer to it', () => {
    expect(one(txns, 'Savings', 'Checking').transfer).toBe('Savings');
    expect(one(txns, 'Checking', 'Savings').transfer).toBe('Checking');
    expect(one(txns, 'Landlord').transfer).toBeNull();
  });

  test('starting balances; the formula guard taken off a payee', () => {
    expect(byPayee(txns, 'Starting Balance').every((t) => t.starting)).toBe(true);
    expect(one(txns, '=Formula Shop').amount).toBe(9.99);
  });

  test('"(SPLIT INTO 2)" and its parts are one transaction, its total as Actual wrote it', () => {
    expect(r.parsed.splits.rebuilt).toBe(1);
    const costco = one(txns, 'Costco');
    expect(costco.amount).toBe(120);
    expect(costco.note).toBe('big shop');
    expect(costco.lines).toEqual([5, 6, 7]);
    expect(costco.parts!.map((p) => [p.amount, p.category?.group, p.category?.name, p.note])).toEqual([
      [80, 'Usual Expenses', 'Food', 'food'],
      [40, 'Usual Expenses', 'General', null],
    ]);
  });

  test('parts that don’t add up to the total come in as rows, and the split’s own row of 0 is left out', () => {
    const file = [
      'Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared',
      'Checking,2026-09-12,Costco,(SPLIT INTO 2) ,,0,-130,Cleared',
      'Checking,2026-09-12,Costco,(SPLIT 1 OF 2) ,Food,-80,0,Cleared',
      'Checking,2026-09-12,Costco,(SPLIT 2 OF 2) ,General,-40,0,Cleared',
    ].join('\n');
    const got = readAppFile(file, { options: {}, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    expect(got.parsed.variant).toBe('export-2024');
    expect(got.parsed.txns.map((t) => t.amount)).toEqual([80, 40]);
    expect(got.parsed.splits.kept[0].reason).toContain('don’t add up');
  });

  test('an export from before 24.8 brings a split’s parts as rows, and says so', () => {
    const early = ready('actual-export-early.csv');
    expect(early.parsed.variant).toBe('export-early');
    expect(early.parsed.txns.length).toBe(4);
    expect(early.parsed.notes[0]).toContain('before 24.8');
    expect(one(early.parsed.txns, 'Savings').transfer).toBe('Savings');
  });
});

describe('ZeroSum', () => {
  const r = ready('zerosum-transactions.csv');
  const txns = r.parsed.txns;

  test('outflow less inflow, Income as income, tags, a payee named for an account as a transfer', () => {
    expect(r.app).toBe('zerosum');
    expect(r.read.date_order).toBe('mdy');
    expect(one(txns, 'Acme Corp')).toMatchObject({ amount: -2500, category: { group: 'Income', name: 'Ready to Budget', kind: 'income' } });
    expect(one(txns, 'Savings').transfer).toBe('Savings');
    expect(one(txns, 'Visa', 'Checking').transfer).toBe('Visa');
    expect(one(txns, 'Checking', 'Visa').transfer).toBe('Checking');
    expect(one(txns, 'Landlord').tags).toEqual(['Home']);
    expect(byPayee(txns, 'Costco')[0].tags).toEqual(['Costco', 'Bulk']);
    expect(one(txns, 'Starting Balance').starting).toBe(true);
  });

  test('split lines without YNAB’s marks come in as rows, and the review says why', () => {
    expect(byPayee(txns, 'Costco').map((t) => t.amount)).toEqual([80, 40]);
    expect(r.parsed.splits.unmarked).toContain('each line comes in as a transaction of its own');
  });
});

describe('the mapping step, for a header no app’s', () => {
  const file = ['When,Where,Who,What,Out,In,Group,Kind', '2026-09-01,Checking,Shop,note,10.00,,Fun,Games', '2026-09-02,Checking,Boss,,,100.00,Income,Pay'].join('\n');

  test('asks which app, with the file’s columns and first rows', () => {
    const asked = readAppFile(file, { options: {}, thisYear: 2026 });
    expect(asked.status).toBe('mapping');
    if (asked.status !== 'mapping') return;
    expect(asked.app).toBeNull();
    expect(asked.table.header).toEqual(['When', 'Where', 'Who', 'What', 'Out', 'In', 'Group', 'Kind']);
    expect(asked.table.sample.length).toBe(2);
  });

  test('reads it as the app and columns the person says, and says what a mapping lacks', () => {
    const lacking = readAppFile(file, { options: { app: 'ynab', columns: { date: 0, payee: 2 } }, thisYear: 2026 });
    expect(lacking.status === 'mapping' && lacking.problem).toBe('Choose the outflow column.');
    const twice = readAppFile(file, { options: { app: 'ynab', columns: { date: 0, payee: 2, outflow: 4, inflow: 4 } }, thisYear: 2026 });
    expect(twice.status === 'mapping' && twice.problem).toBe('Each column can only be used once.');
    const got = readAppFile(file, { options: { app: 'ynab', columns: { date: 0, account: 1, payee: 2, notes: 3, outflow: 4, inflow: 5, group: 6, category: 7 } }, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    expect(got.detected).toBe(false);
    expect(got.parsed.txns.map((t) => [t.payee, t.amount, t.category?.name, t.category?.kind])).toEqual([
      ['Shop', 10, 'Games', null],
      ['Boss', -100, 'Pay', 'income'],
    ]);
  });
});

describe('what every reader shares', () => {
  test('amounts as the apps write them, a currency’s letters or symbol left out', () => {
    expect(appAmount('$21.05', '.')).toBe(21.05);
    expect(appAmount('-$70.47', '.')).toBe(-70.47);
    expect(appAmount('1.234,56 €', ',')).toBe(1234.56);
    expect(appAmount('kr 1 234,50', ',')).toBe(1234.5);
    expect(appAmount('1 234,50 kr', ',')).toBe(1234.5);
    expect(appAmount('CHF 1’234.50'.replace('’', "'"), '.')).toBe(1234.5);
    expect(appAmount('R$ 10,00', ',')).toBe(10);
    expect(appAmount('12.3', '.')).toBe(12.3);
    expect(appAmount('-25', '.')).toBe(-25);
    expect(appAmount('12 USD', '.')).toBe(12);
    expect(appAmount('twelve', '.')).toBeNull();
    expect(appAmount('', '.')).toBeNull();
  });

  test('tags split on commas, cleaned, repeats and empties left out', () => {
    expect(tagsOf('Work, Reimbursable ,work,,  ')).toEqual(['Work', 'Reimbursable']);
    expect(tagsOf('')).toEqual([]);
  });

  test('YNAB’s split marks', () => {
    expect(splitMark('Split (2/3) gift card')).toEqual({ i: 2, n: 3, memo: 'gift card' });
    expect(splitMark('(Split 1/2) bread')).toEqual({ i: 1, n: 2, memo: 'bread' });
    expect(splitMark('Split (3/2) x')).toBeNull();
    expect(splitMark('Split the bill')).toBeNull();
  });

  test('a payee only written like an account is a transfer only with a side in it, or no category', () => {
    const t = (account: string, payee: string, amount: number, category: string | null, date = '2026-09-01'): AppTxn => ({
      line: 1,
      lines: [1],
      account,
      date,
      amount,
      currency: null,
      payee,
      category: category ? { group: null, name: category, kind: null } : null,
      transfer: null,
      starting: false,
      note: null,
      tags: [],
      parts: null,
      raw: [],
    });
    const txns = [t('Card', 'Amazon', 30, 'Shopping'), t('Amazon', 'Interest', -1, 'Income'), t('Checking', 'Amazon', 50, null), t('Checking', 'Savings', 20, 'Saving'), t('Savings', 'Checking', -20, null, '2026-09-03')];
    markTransfersByPayee(txns);
    expect(txns.map((x) => x.transfer)).toEqual([null, null, 'Amazon', 'Savings', 'Checking']);
  });
});

describe('the file a person brings', () => {
  test('YNAB’s zip: its register is read, its plan left beside it', () => {
    const bytes = zip({ 'My Budget as of 2026-09-30 1200 - Plan.csv': text('ynab-plan.csv'), 'My Budget as of 2026-09-30 1200 - Register.csv': text('ynab-register.csv') });
    const got = appFileText(bytes);
    if ('error' in got) throw new Error(got.error);
    expect(got.entry).toBe('My Budget as of 2026-09-30 1200 - Register.csv');
    expect(readAppFile(got.text, { options: {}, thisYear: 2026 }).status).toBe('ready');
  });

  test('ZeroSum’s zip: its transactions.csv', () => {
    const got = appFileText(zip({ 'budget.csv': 'Month,Category,Budgeted\n', 'transactions.csv': text('zerosum-transactions.csv') }));
    if ('error' in got) throw new Error(got.error);
    expect(got.entry).toBe('transactions.csv');
  });

  test('Actual’s full export (its SQLite database) is answered with how to export its CSV', () => {
    const sqlite = new Uint8Array([...Buffer.from('SQLite format 3\u0000'), 0, 0, 0]);
    expect(appFileText(zip({ 'db.sqlite': sqlite, 'metadata.json': '{"id":"x"}' }))).toEqual({ error: ACTUAL_CSV_STEPS });
    expect(appFileText(sqlite)).toEqual({ error: ACTUAL_CSV_STEPS });
  });

  test('a zip that isn’t whole, holds no transactions, or would inflate past its bound is refused', () => {
    const whole = zip({ 'Register.csv': 'a,b,c\n' });
    expect('error' in appFileText(whole.slice(0, whole.length - 10))).toBe(true);
    const none = appFileText(zip({ 'notes.txt': 'hi' }));
    expect('error' in none && none.error).toContain('no CSV file');
    const big = zip({ 'Register.csv': 'x'.repeat(MAX_ENTRY_BYTES + 1) });
    const refused = appFileText(big);
    expect('error' in refused && refused.error).toContain('larger than');
    // An index that lies about the size it inflates to.
    const lying = zip({ 'Register.csv': 'a,b,c\n1,2,3\n' });
    const entries = listZip(lying);
    if ('error' in entries) throw new Error(entries.error);
    const view = new DataView(lying.buffer);
    const cd = lying.length - 22 - (46 + 'Register.csv'.length);
    view.setUint32(cd + 24, 3, true);
    expect('error' in appFileText(lying)).toBe(true);
  });

  test('a plain CSV is its own text', () => {
    const got = appFileText(new TextEncoder().encode('Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags\n'));
    expect('error' in got).toBe(false);
  });
});

describe('what a linked account needs told (lib/migration/plan.ts)', () => {
  test('a split’s lines that aren’t rebuilt say which split they are of, and its whole where the file gives it', () => {
    // YNAB: a complete run that can't be one (a line of money in) has its total; a broken one has none.
    const ynab = [
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      '"Checking","","09/12/2026","Costco","Food: Groceries","Food","Groceries","Split (1/2) ",$80.00,$0.00,"Cleared"',
      '"Checking","","09/12/2026","Costco","Home: Refund","Home","Refund","Split (2/2) ",$0.00,$5.00,"Cleared"',
      '"Checking","","09/13/2026","Target","Food: Groceries","Food","Groceries","Split (1/3) ",$10.00,$0.00,"Cleared"',
      '"Checking","","09/13/2026","Target","Home: Supplies","Home","Supplies","Split (3/3) ",$12.00,$0.00,"Cleared"',
    ].join('\n');
    const got = readAppFile(ynab, { options: { date_order: 'mdy' }, thisYear: 2026 });
    if (got.status !== 'ready') throw new Error(got.status);
    const costco = got.parsed.txns.filter((t) => t.payee === 'Costco');
    expect(costco.map((t) => t.split_of?.whole?.amount)).toEqual([75, 75]);
    expect(new Set(costco.map((t) => t.split_of?.key)).size).toBe(1);
    expect(got.parsed.txns.filter((t) => t.payee === 'Target').map((t) => t.split_of?.whole ?? null)).toEqual([null, null]);
    // Actual: its own row's total, whatever its parts add up to.
    const actual = readAppFile(
      ['Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared', 'Checking,2026-09-12,Costco,(SPLIT INTO 2) ,,0,-130,Cleared', 'Checking,2026-09-12,Costco,(SPLIT 1 OF 2) ,Food,-80,0,Cleared', 'Checking,2026-09-12,Costco,(SPLIT 2 OF 2) ,General,-40,0,Cleared'].join('\n'),
      { options: {}, thisYear: 2026 }
    );
    if (actual.status !== 'ready') throw new Error(actual.status);
    expect(actual.parsed.txns.map((t) => t.split_of?.whole?.amount)).toEqual([130, 130]);
  });

  test('an export that doesn’t mark splits says what one transaction’s rows share; Monarch’s balance adjustments are its own', () => {
    const monarch = ready('monarch-transactions.csv');
    expect(one(monarch.parsed.txns, 'Whole Foods').group_key).toBe('WHOLEFDS MKT 10234 SEATTLE WA');
    const adjusted = readAppFile(['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', '2026-09-01,Balance Adjustment,Balance Adjustments,Checking,,,25.00,'].join('\n'), { options: {}, thisYear: 2026 });
    if (adjusted.status !== 'ready') throw new Error(adjusted.status);
    expect(adjusted.parsed.txns[0].starting).toBe(true);
    expect(ready('zerosum-transactions.csv').parsed.txns.every((t) => t.group_key === t.payee)).toBe(true);
    expect(ready('actual-export-early.csv').parsed.txns.every((t) => t.group_key === t.payee)).toBe(true);
    expect(ready('ynab-register.csv').parsed.txns.some((t) => t.group_key)).toBe(false);
  });

  test('a split’s line that moved money to another account is a transfer; ZeroSum’s "Transfer : X" is one when X isn’t in the file', () => {
    const actual = readAppFile(
      [
        'Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared',
        'Checking,2026-09-15,Employer,(SPLIT INTO 2) ,,0,2500,Cleared',
        'Checking,2026-09-15,Employer,(SPLIT 1 OF 2) ,Income,2000,0,Cleared',
        'Checking,2026-09-15,Savings,(SPLIT 2 OF 2) ,,500,0,Cleared',
        'Savings,2026-09-15,Checking,,,-500,0,Cleared',
      ].join('\n'),
      { options: {}, thisYear: 2026 }
    );
    if (actual.status !== 'ready') throw new Error(actual.status);
    const pay = actual.parsed.txns.find((t) => t.parts)!;
    expect(pay.parts!.map((p) => p.transfer)).toEqual([null, 'Savings']);
    const zs = readAppFile(['Date,Account,Payee,Category Group,Category,Memo,Tags,Outflow,Inflow,Cleared', '09/01/2026,Checking,Transfer : Brokerage,Savings,Retirement,,,300.00,,Cleared'].join('\n'), { options: { date_order: 'mdy' }, thisYear: 2026 });
    if (zs.status !== 'ready') throw new Error(zs.status);
    expect(zs.parsed.txns[0]).toMatchObject({ transfer: 'Brokerage', category: null });
  });

  test('a split taken apart keeps each line as the file had it', () => {
    const ynab = ready('ynab-register.csv');
    const costco = ynab.parsed.txns.find((t) => t.parts)!;
    const parts = explode(costco);
    expect(parts.map((p) => (p.raw as string[])[3])).toEqual(['Costco', 'Costco', 'Costco']);
    expect(parts.map((p) => (p.raw as string[])[7])).toEqual(['Split (1/3) food', 'Split (2/3) ', 'Split (3/3) gift card']);
  });

  test('a zip entry’s name is kept as text: no marks that turn what follows round, and only so long', () => {
    const long = `${'‮'}${'R'.repeat(300)}\u0007 - Register.csv`;
    const entries = listZip(zip({ [long]: 'x' }));
    if ('error' in entries) throw new Error(entries.error);
    expect(entries[0].name).not.toMatch(/[‮\u0007]/);
    expect(entries[0].name.length).toBeLessThanOrEqual(200);
  });
});
