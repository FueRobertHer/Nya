import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Tags and notes in the download of your data (#40): the tags and what was
// said about each transaction as parts of their own, and each transaction's
// tags and note in the JSON and the CSV, as the app shows them, carried
// across a re-link too.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const ctx = TEST_CTX;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { contentKey } = await import('@/lib/transactions');
const { rememberAccounts } = await import('@/lib/last-known');
const { linkAccounts } = await import('@/lib/links');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { ensureTag } = await import('@/lib/tags');
const { changeAnnotation, carriedAnnotationStore } = await import('@/lib/txn-annotations');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');

const stored = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: 'acc_new',
  amount: 12,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-09-02',
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  name: id.toUpperCase(),
  merchant_name: null,
  merchant_entity_id: null,
  website: null,
  logo_url: null,
  personal_finance_category: null,
  personal_finance_category_icon_url: null,
  pending: false,
  payment_channel: null,
  transaction_code: null,
  transaction_type: null,
  check_number: null,
  account_owner: null,
  location: null,
  payment_meta: null,
  counterparties: [],
  category: 'travel',
  account_name: 'Checking',
  institution_name: 'Chase',
  ...over,
});
const MANUAL_ID = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let work = '';
let trip = '';
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 't') }) });
  const txns = { t_hotel: stored('t_hotel'), t_taxi: stored('t_taxi', { amount: 30 }), t_carried: stored('t_carried', { amount: 99, date: '2026-09-01' }) };
  await fake.set(ctxKey('txns:item_a'), await encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts: {}, txns }));
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ account_id: 'acc_new', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1', balance: 1 }] } as any]);
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: NOW.toISOString() } as any);
  await manualTxnStore.set(ctx, 'manual_wallet', {
    version: 1,
    rows: [{ id: MANUAL_ID, account_id: 'manual_wallet', date: '2026-09-03', amount: 25, currency: 'USD', name: 'Farmers market', category: null, note: 'apples', source: 'manual', source_id: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }],
  });
  work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
  trip = (await ensureTag(ctx, { name: 'Vacation 2026' })).tag.id;
  await changeAnnotation(ctx, 't_hotel', { add: [trip, work], note: 'Paid back in October' });
  await changeAnnotation(ctx, MANUAL_ID, { add: [trip] });
  // An earlier account's row, re-linked: its tag carries to the row with the same content.
  await carriedAnnotationStore.set(ctx, 'acc_old', { version: 1, rows: { [contentKey('acc_old', stored('x', { amount: 99, date: '2026-09-01', name: 'T_CARRIED' }))]: { tags: [work], note: 'carried note' } } });
  await linkAccounts(ctx, 'acc_old', 'acc_new', {});
});

const download = async () => buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), NOW);

describe('in the download', () => {
  test('each transaction’s tags by name and its note, as the app shows them, carried ones too', async () => {
    const doc = await download();
    const by = Object.fromEntries(doc.transactions.map((t) => [t.transaction_id, t]));
    expect([by.t_hotel.tags, by.t_hotel.your_note]).toEqual([['Work', 'Vacation 2026'], 'Paid back in October']);
    expect([by.t_carried.tags, by.t_carried.your_note]).toEqual([['Work'], 'carried note']);
    expect([by.t_taxi.tags, by.t_taxi.your_note]).toEqual([[], null]);
    // The tags and the records themselves, as parts of their own.
    expect((doc.tags as any).tags.map((t: any) => t.name)).toEqual(['Work', 'Vacation 2026']);
    expect((doc['transaction-annotations'] as any[]).map((e) => e.id).sort()).toEqual([MANUAL_ID, 't_hotel']);
  });

  test('the CSV gives every row’s tags, a manual row’s too, and a bank row’s note', async () => {
    const [header, ...rows] = parseCsv([...exportFile(await download(), 'transactions-csv').pieces()].join(''));
    expect(header.slice(-11, -8)).toEqual(['tags', 'nya_name', 'excluded']);
    const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[header.indexOf(name)];
    const by = Object.fromEntries(rows.map((r) => [col(r, 'transaction_id'), r]));
    expect([col(by.t_hotel, 'tags'), col(by.t_hotel, 'note')]).toEqual(['Work; Vacation 2026', 'Paid back in October']);
    expect([col(by[MANUAL_ID], 'tags'), col(by[MANUAL_ID], 'note')]).toEqual(['Vacation 2026', 'apples']);
    expect([col(by.t_taxi, 'tags'), col(by.t_taxi, 'note')]).toEqual(['', '']);
  });

  test('a tag deleted is in no transaction’s list, whatever a record still holds', async () => {
    const { deleteTag } = await import('@/lib/tag-delete');
    // Stopped part way: the record still names it; nothing shows it.
    const { changeTagSet, markDeleted } = await import('@/lib/tags');
    await changeTagSet(ctx, (s) => markDeleted(s, work));
    const doc = await download();
    expect(doc.transactions.find((t) => t.transaction_id === 't_hotel')!.tags).toEqual(['Vacation 2026']);
    await deleteTag(ctx, trip);
    expect((await download()).transactions.find((t) => t.transaction_id === 't_hotel')!.tags).toEqual([]);
  });
});

const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { indexTaxonomy } = await import('@/lib/categories');
const { addRule, changeRules, newRuleId } = await import('@/lib/rules');
const { readTagSet } = await import('@/lib/tags');
const { ofxFile } = await import('@/lib/ofx-export');

/** An account's OFX statement, as the download writes it: each transaction's
 *  lines by its FITID, and the notes. */
async function statement(account_id: string) {
  const data = await collectUserData({ ctx, userId: 'user_me' });
  const made = ofxFile(data, buildUserExport(data, NOW), account_id, NOW);
  if ('refused' in made) throw new Error(made.refused);
  const text = [...made.file.pieces()].join('');
  const entry = (id: string) => text.split('<STMTTRN>').find((x) => x.includes(`<FITID>${id}\r\n`)) ?? '';
  const field = (id: string, tag: string) => entry(id).match(new RegExp(`<${tag}>([^\r\n]*)`))?.[1] ?? null;
  return { field, notes: made.file.notes };
}

describe('rules in the download', () => {

  /** The rows as the app shows them, its categories stored as its first load stores them. */
  const appRows = async () => {
    const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, withAccountIds: true, since: '2000-01-01' });
    return (await finishActivity(ctx, bank.payload, bank.hidden, { since: '2000-01-01', grow: true })).transactions;
  };
  const rule = async (input: unknown) => {
    const ix = indexTaxonomy(await ensureTaxonomy(ctx));
    const tags = await readTagSet(ctx);
    await changeRules(ctx, (s) => addRule(s, input, { ix, tags }, newRuleId).set);
  };

  test('every transaction, a bank’s and one entered by hand, is what the app shows: category, name, tags, exclusion', async () => {
    await appRows();
    const shopping = (await ensureTaxonomy(ctx)).categories.find((c) => c.name === 'general merchandise')!.id;
    await rule({ conditions: [{ field: 'amount', op: 'gt', value: 20 }], actions: { set_category: shopping, set_name: 'Big spend', add_tags: [work], hide: true } });
    const app = await appRows();
    const doc = await download();
    expect(doc.rules).toMatchObject({ version: 1, rules: [{ actions: { set_name: 'Big spend', hide: true } }] });
    const tagName = new Map([[work, 'Work'], [trip, 'Vacation 2026']]);
    for (const t of doc.transactions) {
      const shown = app.find((x) => x.transaction_id === t.transaction_id)!;
      expect([t.transaction_id, t.nya_category_id, t.nya_name, t.excluded, t.excluded_by_rule, t.tags, t.rule_ids] as unknown[]).toEqual([
        t.transaction_id,
        shown.category_id,
        shown.name,
        shown.excluded === true,
        shown.excluded_by_rule === true,
        (shown.tags ?? []).map((id) => tagName.get(id)),
        shown.rule_ids ?? [],
      ] as unknown[]);
    }
    expect(doc.transactions.find((t) => t.transaction_id === 't_taxi')).toMatchObject({ nya_category_id: shopping, nya_name: 'Big spend', excluded: true, excluded_by_rule: true, tags: ['Work'] });
    // Entered by hand: filed by the rule (it has no category of its own), hidden, its name its own.
    const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    const col = (r: string[], name: string) => r[header.indexOf(name)];
    const typed = rows.find((r) => col(r, 'transaction_id') === MANUAL_ID)!;
    expect([col(typed, 'nya_category_id'), col(typed, 'nya_name'), col(typed, 'excluded'), col(typed, 'tags')] as unknown[]).toEqual([shopping, 'Farmers market', 'true', 'Work; Vacation 2026']);
    const appTyped = app.find((x) => x.transaction_id === MANUAL_ID)!;
    expect([appTyped.category_id, appTyped.excluded, appTyped.tags]).toEqual([shopping, true, [work, trip]]);
  });

  test('a rule names an imported row in the file as in the app, never one the person named; an account with no institution is “Manual” to a rule in both', async () => {
    const at = NOW.toISOString();
    const [plain, named] = ['manual-txn:6b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3', 'manual-txn:7c2d3e4f-5061-4b7c-8d9e-9fa0b1c2d3e4'];
    await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: '', type: 'depository', subtype: 'cash', balance: 5, updated_at: at } as any);
    await manualTxnStore.set(ctx, 'manual_jar', {
      version: 1,
      rows: [
        { id: plain, account_id: 'manual_jar', date: '2026-09-04', amount: 5, currency: 'USD', name: 'POS JAR 1', category: null, note: null, source: 'import:csv', source_id: 'k1', created_at: at, updated_at: at },
        { id: named, account_id: 'manual_jar', date: '2026-09-05', amount: 6, currency: 'USD', name: 'Pocket money', named: 'Pocket money', category: null, note: null, source: 'import:csv', source_id: 'k2', created_at: at, updated_at: at },
      ],
    });
    await appRows();
    await rule({ conditions: [{ field: 'institution', op: 'equals', value: 'Manual' }], actions: { set_name: 'Jar spend', hide: true } });
    const app = await appRows();
    const [header, ...rows] = parseCsv([...exportFile(await download(), 'transactions-csv').pieces()].join(''));
    const col = (r: string[], name: string) => r[header.indexOf(name)];
    const csv = (id: string) => rows.find((r) => col(r, 'transaction_id') === id)!;
    const shown = (id: string) => app.find((x) => x.transaction_id === id)!;
    expect([shown(plain).name, shown(plain).excluded, shown(named).name, shown(named).excluded]).toEqual(['Jar spend', true, 'Pocket money', true]);
    expect([col(csv(plain), 'nya_name'), col(csv(plain), 'excluded'), col(csv(named), 'nya_name'), col(csv(named), 'excluded')]).toEqual(['Jar spend', 'true', 'Pocket money', 'true']);
  });
});

describe('an OFX statement', () => {
  const rule = async (input: unknown) => {
    const ix = indexTaxonomy(await ensureTaxonomy(ctx));
    const tags = await readTagSet(ctx);
    await changeRules(ctx, (s) => addRule(s, input, { ix, tags }, newRuleId).set);
  };

  test('says each transaction as the app shows it: a rule’s name and hide, your note on a bank’s, and its tags', async () => {
    await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_TAXI' }], actions: { set_name: 'Taxi', add_tags: [work], hide: true } });
    const bank = await statement('acc_new');
    expect([bank.field('t_taxi', 'NAME'), bank.field('t_taxi', 'MEMO')]).toEqual(['Taxi', 'Hidden from budgets and reports by a rule in Nya; T_TAXI; Tags: Work']);
    // Your note on a bank's transaction, and its tags in the order you made them.
    expect([bank.field('t_hotel', 'NAME'), bank.field('t_hotel', 'MEMO')]).toEqual(['T_HOTEL', 'Paid back in October; Tags: Work, Vacation 2026']);
    // A note and a tag carried from an earlier account.
    expect(bank.field('t_carried', 'MEMO')).toBe('carried note; Tags: Work');
    // A manual account's: its own note, its tags.
    const wallet = await statement('manual_wallet');
    expect([wallet.field(MANUAL_ID, 'NAME'), wallet.field(MANUAL_ID, 'MEMO')]).toEqual(['Farmers market', 'apples; Tags: Vacation 2026']);
    // Excluded by you: said as yours.
    await changeAnnotation(ctx, 't_hotel', { excluded: true });
    expect((await statement('acc_new')).field('t_hotel', 'MEMO')).toBe('Excluded from budgets and reports in Nya; Paid back in October; Tags: Work, Vacation 2026');
  });

  test('a memo longer than OFX allows is cut, and the notes say its end may be missing', async () => {
    await changeAnnotation(ctx, 't_taxi', { note: 'n'.repeat(400) });
    const { field, notes } = await statement('acc_new');
    expect(field('t_taxi', 'MEMO')!.length).toBe(255);
    expect(notes).toContain('1 transaction’s memo is longer than OFX’s 255 characters, so each is cut there, and its end (your note, its tags) may be missing. The CSV and JSON downloads have them whole.');
  });
});

describe('rules, tags or what was said about a transaction that can’t be read', () => {
  const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';
  const unchanged = 'Nothing was changed: what could not be read is still stored as it was.';
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const [error, warn] = [console.error, console.warn];
    console.error = console.warn = () => {};
    try {
      return await fn();
    } finally {
      [console.error, console.warn] = [error, warn];
    }
  };
  const rule = async (input: unknown) => {
    const ix = indexTaxonomy(await ensureTaxonomy(ctx));
    const tags = await readTagSet(ctx);
    await changeRules(ctx, (s) => addRule(s, input, { ix, tags }, newRuleId).set);
  };
  const csvOf = async () => {
    const file = exportFile(await quietly(download), 'transactions-csv');
    const [header, ...rows] = parseCsv([...file.pieces()].join(''));
    const cell = (id: string, column: string) => rows.find((r) => r[header.indexOf('transaction_id')] === id)![header.indexOf(column)];
    return { file, cell };
  };

  test('rules: the CSV and the OFX statement apply none, as the app, and say so, called incomplete', async () => {
    await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_TAXI' }], actions: { set_name: 'Taxi', hide: true } });
    await fake.set(ctxKey('rules'), DAMAGED);
    const { file, cell } = await csvOf();
    expect([cell('t_taxi', 'nya_name'), cell('t_taxi', 'excluded')]).toEqual(['T_TAXI', 'false']);
    expect(file.incomplete).toEqual(['rules']);
    expect(file.notes).toEqual([
      `Your rules could not be read (the stored data is damaged), so no rule is applied to the transactions in this file: their names, categories, tags and whether they count are as the bank and you have them, as the app shows them until they can be read. ${unchanged}`,
    ]);
    // The JSON file says it in its own words.
    expect((await quietly(download)).notes).toContain(
      `Your rules could not be read (the stored data is damaged), so this file does not have them. No rule is applied to the transactions in this file, as the app applies none until they can be read. ${unchanged}`
    );
    const data = await quietly(() => collectUserData({ ctx, userId: 'user_me' }));
    const made = ofxFile(data, buildUserExport(data, NOW), 'acc_new', NOW);
    if ('refused' in made) throw new Error(made.refused);
    expect(made.file.incomplete).toEqual(['rules']);
    expect(made.file.notes).toContain(
      `Your rules could not be read, so none is applied to this statement: its names, and which transactions are marked as left out, are as the bank and you have them, as the app shows them until they can be read. The JSON download lists them under problems. ${unchanged}`
    );
    expect(fake.strings.get(ctxKey('rules'))).toBe(DAMAGED);
  });

  test('tags: no transaction has any in the CSV or the OFX statement, and each says so, called incomplete', async () => {
    await fake.set(ctxKey('tags'), DAMAGED);
    const { file, cell } = await csvOf();
    expect(cell('t_hotel', 'tags')).toBe('');
    expect(file.incomplete).toEqual(['tags']);
    expect(file.notes).toEqual([`Your tags could not be read (the stored data is damaged), so no transaction in this file has tags, as the app shows none until they can be read. ${unchanged}`]);
    const data = await quietly(() => collectUserData({ ctx, userId: 'user_me' }));
    const made = ofxFile(data, buildUserExport(data, NOW), 'acc_new', NOW);
    if ('refused' in made) throw new Error(made.refused);
    expect(made.file.incomplete).toEqual(['tags']);
    expect(made.file.notes).toContain(`Your tags could not be read, so no transaction’s memo has its tags, as the app shows none until they can be read. The JSON download lists them under problems. ${unchanged}`);
    expect([...made.file.pieces()].join('')).not.toContain('Tags:');
  });

  test('what was said about a transaction, or carried to it: the CSV says which part, called incomplete', async () => {
    await fake.hset(ctxKey('transaction-annotations'), { t_hotel: DAMAGED });
    await fake.hset(ctxKey('carried-annotations'), { acc_old: DAMAGED });
    const { file, cell } = await csvOf();
    expect([cell('t_hotel', 'note'), cell('t_hotel', 'tags'), cell('t_hotel', 'excluded')]).toEqual(['', '', '']);
    expect(file.incomplete.sort()).toEqual(['carried-annotations', 'transaction-annotations']);
    expect(file.notes).toEqual(
      expect.arrayContaining([
        `Not all of your notes, tags and exclusions could be read: 1 entry whose stored data is damaged. Those transactions are in this file without the tags you put on them, and whether you excluded them is empty: they count, as the app counts them. Your note on one the bank, SimpleFIN or Lunch Flow brought is missing too, as is yours on one imported into a linked account (its file’s own note, if it had one, is there instead); a note written with one you entered, or imported into a manual account, is on its row. A bank’s transaction standing for one you imported into a linked account is without the tags and note you put on that one, and whether it is excluded is empty unless you excluded or included the bank’s itself. The JSON download lists them under problems. ${unchanged}`,
        `Not all of your notes, tags and exclusions carried from earlier accounts could be read: 1 entry whose stored data is damaged. The transactions they carry to are in this file without them (an exclusion, tags, a note), as the app shows them until they can be read. The JSON download lists them under problems. ${unchanged}`,
      ])
    );
    // The balances CSV holds none of it, and isn't called incomplete for it.
    expect(exportFile(await quietly(download), 'balances-csv').incomplete).toEqual([]);
  });

  test('a record that can’t be read: a bank’s statement is without your note on it, a manual account’s keeps the note written with it', async () => {
    await fake.hset(ctxKey('transaction-annotations'), { t_hotel: DAMAGED, [MANUAL_ID]: DAMAGED });
    const data = await quietly(() => collectUserData({ ctx, userId: 'user_me' }));
    const doc = buildUserExport(data, NOW);
    const noteOf = (account_id: string) => {
      const made = ofxFile(data, doc, account_id, NOW);
      if ('refused' in made) throw new Error(made.refused);
      return { notes: made.file.notes, text: [...made.file.pieces()].join('') };
    };
    const bank = noteOf('acc_new');
    expect(bank.notes).toContain(
      `Whether 1 of these transactions is excluded from budgets and reports could not be read, so it isn’t marked either way, and the tags you put on it aren’t in its memo, nor is your note on it. The JSON download lists them under problems. ${unchanged}`
    );
    expect(bank.text).not.toContain('Paid back in October');
    const wallet = noteOf('manual_wallet');
    expect(wallet.notes).toContain(
      `Whether 1 of these transactions is excluded from budgets and reports could not be read, so it isn’t marked either way, and the tags you put on it aren’t in its memo (its note, written with it, is). The JSON download lists them under problems. ${unchanged}`
    );
    expect(wallet.text).toContain('<MEMO>apples\r\n');
    // The CSV likewise: the bank's row without your note, the one entered by hand with its own.
    const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    const note = (id: string) => rows.find((r) => r[header.indexOf('transaction_id')] === id)![header.indexOf('note')];
    expect([note('t_hotel'), note(MANUAL_ID)]).toEqual(['', 'apples']);
  });
});
