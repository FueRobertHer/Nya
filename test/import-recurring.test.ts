import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Rows imported from a file (app/api/import) reach recurring detection, the
// cash forecast and the calendar as a typed manual row does: on their account,
// with its name and type (lib/manual-txns.ts), so an imported checking
// account's bills count as cash, an imported card statement's charges don't,
// and the card's payment received on the statement (OFX PAYMENT, "loan
// payments") is never income.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// /api/transactions syncs Plaid; nothing is linked here, so it answers nothing.
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { detectRecurring } = await import('@/lib/recurring');
const { calendarMonth } = await import('@/lib/calendar');
const { cashPosition, countsInForecast, forecastEvents } = await import('@/lib/forecast');
const { localDate } = await import('@/lib/local-date');
const routes = await import('@/app/api/import/route');
const transactions = await import('@/app/api/transactions/route');
type ManualAccount = import('@/lib/manual').ManualAccount;

const CHECKING: ManualAccount = {
  account_id: 'manual_checking-1',
  name: 'Checking',
  institution_name: 'Cascade CU',
  type: 'depository',
  subtype: 'checking',
  balance: 3000,
  updated_at: '2026-10-01T12:00:00.000Z',
};
const VISA: ManualAccount = { ...CHECKING, account_id: 'manual_visa-1', name: 'Visa', type: 'credit', subtype: 'credit card', balance: 500 };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

type Trn = { type: string; date: string; amount: number; name: string };
/** An OFX 2.x statement with these transactions, each with its TRNTYPE. */
function ofx(trns: Trn[], card = false): string {
  const list = trns
    .map((t, i) => `<STMTTRN><TRNTYPE>${t.type}</TRNTYPE><DTPOSTED>${compact(t.date)}120000</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>F${i}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  const from = card ? '<CCACCTFROM><ACCTID>4111000011112222</ACCTID></CCACCTFROM>' : '<BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0001234567</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>';
  const [rs, trnrs, msgs] = card ? ['CCSTMTRS', 'CCSTMTTRNRS', 'CREDITCARDMSGSRSV1'] : ['STMTRS', 'STMTTRNRS', 'BANKMSGSRSV1'];
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><${msgs}><${trnrs}><STATUS><CODE>0</CODE></STATUS><${rs}><CURDEF>USD</CURDEF>${from}<BANKTRANLIST>\n${list}\n</BANKTRANLIST></${rs}></${trnrs}></${msgs}></OFX>`;
}

async function importFile(account_id: string, text: string): Promise<number> {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(text)]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', action: 'import', account_id, options: {} }));
  const res = await routes.POST(new Request('http://localhost/api/import', { method: 'POST', body: form }));
  expect(res.status).toBe(200);
  return (await res.json()).imported;
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  for (const a of [CHECKING, VISA]) await saveManualAccount(TEST_CTX, a);
});

describe('imported rows in recurring detection, the forecast and the calendar', () => {
  test('a checking account\'s bills count as cash; a card statement\'s charges and its payment received do not', async () => {
    // Four months, thirty days apart, the latest a week ago.
    const months = [-97, -67, -37, -7];
    const checking: Trn[] = months.flatMap((d) => [
      { type: 'DEBIT', date: day(d), amount: -1500, name: 'LANDLORD' },
      { type: 'CREDIT', date: day(d + 2), amount: 2000, name: 'ACME PAYROLL' },
      // Cash taken out on the same day each month is never a bill.
      { type: 'ATM', date: day(d + 1), amount: -100, name: 'ATM WITHDRAWAL' },
    ]);
    const card: Trn[] = months.flatMap((d) => [
      { type: 'DEBIT', date: day(d + 3), amount: -15.49, name: 'NETFLIX.COM' },
      // The payment received on the card's side: "loan payments" on a card.
      { type: 'PAYMENT', date: day(d + 4), amount: 300, name: 'PAYMENT - THANK YOU' },
    ]);
    expect(await importFile(CHECKING.account_id, ofx(checking))).toBe(12);
    expect(await importFile(VISA.account_id, ofx(card, true))).toBe(8);

    const body = await (await transactions.GET(new Request('http://localhost/api/transactions'))).json();
    const shown = body.transactions as { name: string; source: string; account_name: string; account_type: string; category: string | null; transaction_code: string | null }[];
    // Each on its account, with the account's type, as a typed row is.
    const facts = (name: string) => shown.filter((t) => t.name === name).map((t) => [t.source, t.account_name, t.account_type, t.category, t.transaction_code]);
    expect(facts('LANDLORD')[0]).toEqual(['import:ofx', 'Checking', 'depository', null, null]);
    expect(facts('ATM WITHDRAWAL')[0]).toEqual(['import:ofx', 'Checking', 'depository', 'transfer out', 'atm']);
    expect(facts('NETFLIX.COM')[0]).toEqual(['import:ofx', 'Visa', 'credit', null, null]);
    expect(facts('PAYMENT - THANK YOU')[0]).toEqual(['import:ofx', 'Visa', 'credit', 'loan payments', null]);

    const series = detectRecurring([...shown, ...body.recurring_history] as never);
    expect(series.map((s) => [s.name, s.kind, s.account, s.accountType, countsInForecast(s)])).toEqual([
      ['LANDLORD', 'bill', 'Checking', 'depository', true],
      ['NETFLIX.COM', 'bill', 'Visa', 'credit', false],
      ['ACME PAYROLL', 'income', 'Checking', 'depository', true],
    ]);

    // The forecast counts rent and pay from checking, never the card's own charge.
    const today = localDate();
    const institutions = [
      { institution_name: 'Cascade CU', manual: true, accounts: [{ ...CHECKING, currency: 'USD' }, { ...VISA, currency: 'USD' }] },
    ];
    const position = cashPosition(institutions, shown as never);
    expect(position.included.map((a) => a.name)).toEqual(['Checking']);
    const until = day(60);
    const { events } = forecastEvents({ series, planned: [], currency: position.currency, today, until });
    expect([...new Set(events.map((e) => e.name))].sort()).toEqual(['ACME PAYROLL', 'LANDLORD']);

    // The calendar lists the card's charge on its day, but doesn't add it.
    const next = series.find((s) => s.name === 'NETFLIX.COM')!.nextDate;
    const month = calendarMonth({ month: next.slice(0, 7), today, txns: [], series, planned: [], currency: 'USD' });
    const netflix = month.days.get(next)!.entries.find((e) => e.name === 'NETFLIX.COM')!;
    expect(netflix).toMatchObject({ kind: 'expected', off: 'not-cash', accountType: 'credit', uncounted: true });
  });
});
