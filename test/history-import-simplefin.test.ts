import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount } from './simplefin-fake';

// Importing history into a linked account (#52) is for accounts linked
// through Plaid. An account SimpleFIN keeps up to date brings its older
// transactions itself, matched by SimpleFIN's own ids, which a file's rows
// can't be matched against: the route refuses it, saying so, and writes
// nothing; a manual account is told where its own import is.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount, newManualId } = await import('@/lib/manual');
const { importedTxnStore, historyImportSummaryStore } = await import('@/lib/history-import/store');
const routes = await import('@/app/api/history-import/route');

const ctx = TEST_CTX;
const NOW = Date.now();
const DAY = 86_400_000;
const ago = (n: number) => Math.floor(Date.parse(`${new Date(NOW - n * DAY).toISOString().slice(0, 10)}T12:00:00Z`) / 1000);

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
});

const STATEMENT = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>0001111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240131</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240115</DTPOSTED><TRNAMT>-12.00</TRNAMT><FITID>F1</FITID><NAME>OLD SHOP</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
function upload(meta: Record<string, unknown>): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(STATEMENT) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}

describe('an account SimpleFIN keeps up to date', () => {
  test('is refused for importing history from a file, saying why, and nothing is written', async () => {
    server.accounts = [fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: [] })];
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('t1'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW);
    const [account_id] = [...(await connectorAccountsStore.getAll(ctx)).keys()];
    expect(account_id).toBeDefined();

    for (const action of ['preview', 'import']) {
      const res = await routes.POST(upload({ action, account_id, ...(action === 'import' ? { review: '0123456789abcdef0123456789abcdef' } : {}) }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('kept up to date through SimpleFIN');
    }
    const listed = await routes.GET(new Request(`http://localhost/api/history-import?account_id=${account_id}`));
    expect(listed.status).toBe(400);
    expect((await listed.json()).error).toContain('kept up to date through SimpleFIN');
    expect((await importedTxnStore.getAll(ctx)).size).toBe(0);
    expect((await historyImportSummaryStore.getAll(ctx)).size).toBe(0);
  });

  test('a manual account is told where its own import is', async () => {
    const id = newManualId();
    await saveManualAccount(ctx, { account_id: id, name: 'Cash jar', institution_name: 'Home', type: 'depository', subtype: null, balance: 40, updated_at: new Date(NOW).toISOString() });
    const res = await routes.POST(upload({ action: 'preview', account_id: id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This is a manual account: import a file into it with Import on its row.');
  });
});
