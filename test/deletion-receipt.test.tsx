import { describe, expect, test, mock } from 'bun:test';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { buildDeletionReceipt, mergeCounts, receiptText, receiptSections, asDeletionReceipt, PLAID_PORTAL } = await import('@/lib/deletion-receipt');
const { DeletionReceiptView } = await import('@/components/DeletionReceipt');
const { DeleteAccountView } = await import('@/components/DeleteAccount');

type Counts = Parameters<typeof mergeCounts>[0];
const COUNTS: Counts = {
  banks_disconnected: 2,
  banks_not_disconnected: 0,
  accounts: 7,
  transactions: 1234,
  investment_transactions: 56,
  history_days: 400,
  connections_ended: 1,
  sign_in_deleted: true,
};
const AT = new Date('2026-10-06T14:05:00.000Z');
const US = { locale: 'en-US', timeZone: 'UTC' };
const receipt = (over: Partial<Parameters<typeof buildDeletionReceipt>[0]> = {}) =>
  buildDeletionReceipt({
    counts: COUNTS,
    found_data: true,
    resumed: false,
    deleted_at: AT,
    retention: { kept: true, keep_days: 30, min_kept: 7, max_days: 31 },
    stopped: false,
    ...over,
  });

describe('the receipt', () => {
  test('what was deleted now, what expires later and when, and what stays and why', () => {
    expect(receiptText(receipt(), US)).toBe(
      [
        'Nya account deletion receipt',
        '',
        'Deleted October 6, 2026 at 2:05 PM',
        '',
        'Deleted now',
        '- Banks disconnected at Plaid: 2',
        '- Accounts: 7',
        '- Transactions: 1,234',
        '- Investment transactions: 56',
        '- Days of balance history: 400',
        '- Sharing ended: 1 connection',
        '- Your sign-in: deleted',
        '',
        'Expires later',
        '- Nightly backups: copies taken before the deletion still hold your data, encrypted. Each copy is deleted once it is more than 30 days old, and the newest 7 are always kept, so the last one holding your data is gone by November 6, 2026. That holds as long as the nightly backup keeps running.',
        '',
        'What stays, and why',
        `- Plaid’s own copy: Plaid keeps what it collected from your banks under its own privacy policy. Disconnecting ended Nya’s connections; it doesn’t delete Plaid’s records. See and delete what Plaid holds at the Plaid Portal: ${PLAID_PORTAL}`,
        '- Server logs: the host keeps them for a short time. Nya writes counts, dates and errors to them, not amounts or balances.',
        '- Your downloads: a copy you saved with Download my data is yours, and deleting your account doesn’t reach it.',
        '',
      ].join('\n')
    );
  });

  test('the backup date is the deletion plus the honest maximum', () => {
    expect(receipt().backups).toEqual({ kept: true, keep_days: 30, min_kept: 7, until: '2026-11-06T14:05:00.000Z', stopped: false });
  });

  test('backups that have stopped, or that this server doesn’t keep, or can’t say', () => {
    const [, stopped] = receiptSections(receipt({ stopped: true }), US);
    expect(stopped.lines[0]).toEndWith('The nightly backup isn’t running right now, and old copies are deleted only when it runs, so that date moves later by as long as it stays stopped.');
    expect(receiptSections(receipt({ retention: { kept: false } }), US)[1].lines).toEqual(['Nightly backups: this server keeps none, so no copy of your data is left in one.']);
    expect(receiptSections(receipt({ retention: null }), US)[1].lines[0]).toContain('couldn’t be worked out');
  });

  test('a bank Plaid wouldn’t disconnect is counted, and pointed at the Plaid Portal', () => {
    const [now, , stays] = receiptSections(receipt({ counts: { ...COUNTS, banks_disconnected: 1, banks_not_disconnected: 1 } }), US);
    expect(now.lines).toContain('Banks Plaid wouldn’t disconnect: 1 (see What stays)');
    expect(stays.lines[1]).toBe(
      '1 bank couldn’t be disconnected at Plaid. Nya deleted the token it used to reach it, but Plaid may keep the connection until you remove it at the Plaid Portal.'
    );
  });

  test('a count that couldn’t be read says so instead of showing zero', () => {
    const [now] = receiptSections(receipt({ counts: { ...COUNTS, transactions: null } }), US);
    expect(now.lines).toContain('Transactions: not counted (it couldn’t be read to count it, and was deleted all the same)');
  });

  test('an earlier attempt: what was left, or nothing left at all', () => {
    expect(receiptSections(receipt({ resumed: true }), US)[0].lines.at(-1)).toBe('An earlier attempt had already deleted part of this, so these counts are what was left.');
    expect(receiptSections(receipt({ found_data: false }), US)[0].lines.at(-1)).toContain('Nothing was stored for this account any more');
    // Once the page has added the earlier attempt's counts, neither applies.
    const merged = { ...receipt({ found_data: false, resumed: true }), includes_earlier_attempt: true };
    expect(receiptSections(merged, US)[0].lines.at(-1)).toBe('Your sign-in: deleted');
  });

  test('two attempts add up, and unknown stays unknown', () => {
    const first = { ...COUNTS, sign_in_deleted: false };
    const second = { banks_disconnected: 0, banks_not_disconnected: 0, accounts: 0, transactions: null, investment_transactions: 0, history_days: 0, connections_ended: 0, sign_in_deleted: true };
    expect(mergeCounts(first, second)).toEqual({ ...COUNTS, transactions: null, sign_in_deleted: true });
  });

  test('only a receipt-shaped value is taken back from storage', () => {
    expect(asDeletionReceipt(JSON.parse(JSON.stringify(receipt())))).toEqual(receipt());
    for (const junk of [null, 'x', {}, { deleted_at: 'not a date', deleted: COUNTS }, { deleted_at: AT.toISOString() }]) expect(asDeletionReceipt(junk)).toBeNull();
  });
});

describe('the receipt, on screen', () => {
  const html = renderToStaticMarkup(<DeletionReceiptView receipt={receipt()} onDone={() => {}} doneLabel="Done" format={US} />);

  test('every section, with the Plaid Portal as a link, and ways to keep it', () => {
    expect(html).toContain('Your account was deleted');
    for (const title of ['Deleted now', 'Expires later', 'What stays, and why']) expect(html).toContain(title);
    expect(html).toContain(`<a href="${PLAID_PORTAL}" target="_blank" rel="noreferrer">${PLAID_PORTAL}</a>`);
    expect(html).toContain('November 6, 2026');
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('>Download as text</button>');
    expect(html).toContain('>Done</button>');
  });

  test('shown in place of the form when it can’t be kept for the sign-in page', () => {
    const inPlace = renderToStaticMarkup(
      <DeleteAccountView status={{ enabled: true, can_delete: true }} typed="" busy={false} error="" onType={() => {}} onDelete={() => {}} receipt={receipt()} />
    );
    expect(inPlace).toContain('Your account was deleted');
    expect(inPlace).toContain('>Sign out</button>');
    expect(inPlace).not.toContain('Type DELETE');
  });

  test('before deleting: the honest backup window, and a nudge to download first', () => {
    const form = renderToStaticMarkup(
      <DeleteAccountView status={{ enabled: true, can_delete: true, backup_days: 31 }} typed="" busy={false} error="" onType={() => {}} onDelete={() => {}} />
    );
    expect(form).toContain('Nightly backups keep an encrypted copy for up to 31 days.');
    expect(form).toContain('use Download my data under Manage accounts first');
    expect(form).toContain('you’ll get a receipt');
    const none = renderToStaticMarkup(<DeleteAccountView status={{ enabled: true, can_delete: true, backup_days: null }} typed="" busy={false} error="" onType={() => {}} onDelete={() => {}} />);
    expect(none).not.toContain('Nightly backups');
  });
});
