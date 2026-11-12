// Synthetic transactions downloads in Vanguard's QFX layout, for the reader's
// tests (test/vanguard-qfx.test.ts) and the route's. Every figure, account
// number and fund id is made up: no real person's file is kept anywhere in
// this repository.
//
// Laid out as Vanguard writes the file (learnt from a real one's layout,
// never its figures): nine header lines, a blank line, then the whole of the
// OFX on one line, every aggregate ended and no leaf. A signon from
// Vanguard, one INVSTMTRS per account (BROKERID vanguard.com, an 8-digit
// ACCTID, USD), each transaction list stating the same days, DTEND being when
// the file was made, then the security list. Dates carry the time and
// Eastern time's zone. A buy's TOTAL is negative, a sell's UNITS; a
// reinvestment writes its amount in FEES as well as TOTAL; a cash
// transaction (INVBANKTRAN) has TRNTYPE OTHER and no name or memo.
//
// Run directly to write a sample to a file to look at:
//   bun test/vanguard-transactions-qfx.ts <file>

export type QfxTxn =
  | { kind: 'buy'; trade: string; units: number; price: number; total: number; fund?: string }
  | { kind: 'sell'; trade: string; units: number; price: number; total: number; fund?: string; withholding?: number }
  | { kind: 'reinvest'; trade: string; units: number; price: number; total: number; fund?: string; income?: string; fees?: number }
  | { kind: 'income'; trade: string; total: number; fund?: string; income?: string }
  | { kind: 'bank'; posted: string; amount: number; trntype?: string; name?: string }
  /** Written into the transaction list as it is. */
  | { kind: 'raw'; text: string };

export type QfxAccount = { number: string; txns: QfxTxn[]; start?: string; end?: string; currency?: string; broker?: string };

export type QfxOptions = {
  /** The days every transaction list states, as YYYY-MM-DD. */
  start: string;
  end: string;
  /** Header lines end with these. */
  eol?: '\n' | '\r\n';
  /** Funds by id, for the security list. */
  funds?: Record<string, string>;
  /** Written after the statements, inside <OFX>. */
  after?: string;
};

export const FUNDS: Record<string, string> = {
  '000000001': 'Total Stock Market Index Fund Admiral',
  '000000002': 'Total Bond Market Index Fund Admiral',
  '000000003': 'Federal Money Market Fund',
};
const FUND = '000000001';

const when = (day: string) => `${day.replaceAll('-', '')}000000.000[-5:EST]`;
const n = (v: number, places = 2) => v.toFixed(places);
let fitid = 100000;
const invtran = (trade: string, memo: string) => `<INVTRAN><FITID>${fitid++}<DTTRADE>${when(trade)}<DTSETTLE>${when(trade)}<MEMO>${memo}</INVTRAN>`;
const secid = (fund: string) => `<SECID><UNIQUEID>${fund}<UNIQUEIDTYPE>CUSIP</SECID>`;

function txnText(t: QfxTxn, funds: Record<string, string>): string {
  if (t.kind === 'raw') return t.text;
  if (t.kind === 'bank') {
    return `<INVBANKTRAN><STMTTRN><TRNTYPE>${t.trntype ?? 'OTHER'}<DTPOSTED>${when(t.posted)}<TRNAMT>${n(t.amount)}<FITID>${fitid++}${t.name ? `<NAME>${t.name}` : ''}</STMTTRN><SUBACCTFUND>OTHER</INVBANKTRAN>`;
  }
  const fund = t.fund ?? FUND;
  const memo = (funds[fund] ?? 'A fund').toUpperCase();
  if (t.kind === 'buy') {
    return `<BUYMF><INVBUY>${invtran(t.trade, memo)}${secid(fund)}<UNITS>${n(t.units, 3)}<UNITPRICE>${n(t.price, 5)}<TOTAL>${n(t.total)}<SUBACCTSEC>OTHER<SUBACCTFUND>OTHER</INVBUY><BUYTYPE>BUY</BUYMF>`;
  }
  if (t.kind === 'sell') {
    return `<SELLMF><INVSELL>${invtran(t.trade, memo)}${secid(fund)}<UNITS>${n(t.units, 3)}<UNITPRICE>${n(t.price)}<TOTAL>${n(t.total)}<SUBACCTSEC>OTHER<SUBACCTFUND>OTHER<WITHHOLDING>${n(t.withholding ?? 0, 1)}</INVSELL><SELLTYPE>SELL</SELLMF>`;
  }
  if (t.kind === 'reinvest') {
    return `<REINVEST>${invtran(t.trade, memo)}${secid(fund)}<INCOMETYPE>${t.income ?? 'DIV'}<TOTAL>${n(t.total)}<SUBACCTSEC>OTHER<UNITS>${n(t.units, 3)}<UNITPRICE>${n(t.price)}<FEES>${n(t.fees ?? t.total)}</REINVEST>`;
  }
  return `<INCOME>${invtran(t.trade, memo)}${secid(fund)}<INCOMETYPE>${t.income ?? 'DIV'}<TOTAL>${n(t.total)}<SUBACCTSEC>OTHER<SUBACCTFUND>OTHER</INCOME>`;
}

export function vanguardQfx(accounts: QfxAccount[], o: QfxOptions): string {
  const eol = o.eol ?? '\r\n';
  const funds = o.funds ?? FUNDS;
  const header = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE'];
  const statements = accounts
    .map(
      (a, i) =>
        `<INVSTMTTRNRS><TRNUID>${i + 1}<STATUS><CODE>0<SEVERITY>INFO</STATUS><INVSTMTRS><DTASOF>${when(o.end)}<CURDEF>${a.currency ?? 'USD'}<INVACCTFROM><BROKERID>${a.broker ?? 'vanguard.com'}<ACCTID>${a.number}</INVACCTFROM><INVTRANLIST><DTSTART>${when(a.start ?? o.start)}<DTEND>${when(a.end ?? o.end)}${a.txns.map((t) => txnText(t, funds)).join('')}</INVTRANLIST><INVPOSLIST></INVPOSLIST><INVBAL><AVAILCASH>0.0<MARGINBALANCE>0.0<SHORTBALANCE>0.0</INVBAL></INVSTMTRS></INVSTMTTRNRS>`
    )
    .join('');
  const seclist = Object.entries(funds)
    .map(([id, name]) => `<MFINFO><SECINFO>${secid(id)}<SECNAME>${name}<TICKER>VXXXX<UNITPRICE>1.0<DTASOF>${when(o.end)}<MEMO>${name}</SECINFO><MFTYPE>OPENEND<YIELD>0.0</MFINFO>`)
    .join('');
  const body = `<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO<MESSAGE>Successful Sign On</STATUS><DTSERVER>${o.end.replaceAll('-', '')}120000[-5:EST]<LANGUAGE>ENG<FI><ORG>Vanguard<FID>15103</FI></SONRS></SIGNONMSGSRSV1><INVSTMTMSGSRSV1>${statements}</INVSTMTMSGSRSV1><SECLISTMSGSRSV1><SECLIST>${seclist}</SECLIST></SECLISTMSGSRSV1>${o.after ?? ''}</OFX>`;
  return `${header.join(eol)}${eol}${eol}${body}${eol}`;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: bun test/vanguard-transactions-qfx.ts <file>');
  const text = vanguardQfx(
    [
      {
        number: '11114421',
        txns: [
          { kind: 'bank', posted: '2026-01-05', amount: 2000 },
          { kind: 'buy', trade: '2026-01-06', units: 6.25, price: 320, total: -2000 },
          { kind: 'reinvest', trade: '2026-03-25', units: 0.5, price: 330, total: 165 },
          { kind: 'sell', trade: '2026-04-02', units: -1, price: 1, total: 1 },
          { kind: 'income', trade: '2026-04-30', total: 3.21, income: 'INTEREST', fund: '000000003' },
        ],
      },
      { number: '22223307', txns: [{ kind: 'bank', posted: '2026-02-10', amount: 7000 }] },
    ],
    { start: '2025-05-13', end: '2026-11-12' }
  );
  await Bun.write(out, text);
  console.log(`Wrote ${out}`);
}
