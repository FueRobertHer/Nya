import { describe, expect, test, mock } from 'bun:test';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { buildDeletionReceipt, mergeCounts, receiptText, receiptSections, receiptFilename, asDeletionReceipt, PLAID_PORTAL } = await import('@/lib/deletion-receipt');
const { DeletionReceiptView } = await import('@/components/DeletionReceipt');
const { DeleteAccountView } = await import('@/components/DeleteAccount');

type Counts = Parameters<typeof mergeCounts>[0];
const COUNTS: Counts = {
  banks_disconnected: 2,
  banks_not_disconnected: 0,
  accounts: 7,
  earlier_accounts: 0,
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
  test('its file is named by the viewer’s own day, like the dates in it', () => {
    // 03:30 UTC on October 7 is still the evening of October 6 in California.
    const late = receipt({ deleted_at: new Date('2026-10-07T03:30:00.000Z') });
    expect(receiptFilename(late, { timeZone: 'America/Los_Angeles' })).toBe('nya-deletion-receipt-2026-10-06.txt');
    expect(receiptText(late, { locale: 'en-US', timeZone: 'America/Los_Angeles' })).toContain('Deleted October 6, 2026');
    expect(receiptFilename(late, { timeZone: 'UTC' })).toBe('nya-deletion-receipt-2026-10-07.txt');
  });

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
        '- Nightly backups: copies taken before the deletion still hold your data. Its values are encrypted, but dates, account and transaction ids, bank names and the merchant names you renamed are in plain text. Each copy is deleted once it is more than 30 days old, and the newest 7 are always kept, so the last one holding your data is gone by November 7, 2026. That holds as long as the nightly backup keeps running.',
        '',
        'What stays, and why',
        `- Plaid’s own copy: Plaid keeps what it collected from your banks under its own privacy policy. Disconnecting ended Nya’s connections; it doesn’t delete Plaid’s records. See and delete what Plaid holds at the Plaid Portal: ${PLAID_PORTAL}`,
        '- Server logs: the host keeps them for a short time. Nya writes counts, dates and errors to them, not amounts or balances.',
        '- Your downloads: a copy you saved with Download my data is yours, and deleting your account doesn’t reach it.',
        '',
      ].join('\n')
    );
  });

  test('the backup date is the deletion plus the honest maximum, and a day for the cron’s timing', () => {
    // 31 days by the pruning rules, and one more: the cron can start up to an
    // hour late, which is past midnight somewhere.
    expect(receipt().backups).toEqual({ kept: true, keep_days: 30, min_kept: 7, until: '2026-11-07T14:05:00.000Z', stopped: false });
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

  test('a figure that couldn’t be counted is unavailable, never zero, and says why', () => {
    const [now] = receiptSections(receipt({ counts: { ...COUNTS, transactions: null } }), US);
    expect(now.lines).toContain('Transactions: unavailable');
    expect(now.lines.at(-1)).toBe('A figure shown as unavailable couldn’t be counted (in time, or at all). What it describes was deleted all the same.');
    expect(receiptSections(receipt(), US)[0].lines.some((l) => l.includes('unavailable'))).toBe(false);
  });

  test('earlier accounts, of banks disconnected before, are counted apart', () => {
    const [now] = receiptSections(receipt({ counts: { ...COUNTS, earlier_accounts: 2 } }), US);
    expect(now.lines).toContain('Accounts: 7');
    expect(now.lines).toContain('Earlier accounts, of banks you had disconnected, kept for their history: 2');
    expect(receiptSections(receipt(), US)[0].lines.some((l) => l.startsWith('Earlier accounts'))).toBe(false);
  });

  test('an earlier attempt: not counted again, or nothing left at all', () => {
    const resumed = receiptSections(receipt({ resumed: true, counts: { ...COUNTS, accounts: null, earlier_accounts: null, transactions: null, investment_transactions: null, history_days: null } }), US)[0];
    expect(resumed.lines).toContain('Accounts: unavailable');
    expect(resumed.lines.at(-1)).toBe(
      'An earlier attempt had already begun this deletion, so what was stored wasn’t counted again (part of it may already have been gone). All of it was deleted.'
    );
    expect(receiptSections(receipt({ found_data: false }), US)[0].lines.at(-1)).toContain('Nothing was stored for this account any more');
    // Once the page has added the earlier attempt's counts, neither applies.
    const merged = { ...receipt({ found_data: false, resumed: true }), includes_earlier_attempt: true };
    expect(receiptSections(merged, US)[0].lines.at(-1)).toBe('Your sign-in: deleted');
  });

  const none = { banks_disconnected: 0, banks_not_disconnected: 0, accounts: 0, earlier_accounts: 0, transactions: 0, investment_transactions: 0, history_days: 0, connections_ended: 0, sign_in_deleted: true };
  const skipped = { ...none, accounts: null, earlier_accounts: null, transactions: null, investment_transactions: null, history_days: null };

  test('two attempts: what the first counted stands, and a sign-in deleted the second time', () => {
    const first = { ...COUNTS, sign_in_deleted: false };
    // The retry found the container gone: nothing left, nothing stored.
    expect(mergeCounts(first, none)).toEqual(COUNTS);
    // The retry found it archived, so it didn't count again.
    expect(mergeCounts(first, skipped)).toEqual(COUNTS);
    // Unknown at first stays unknown, whatever the retry found.
    expect(mergeCounts({ ...first, transactions: null }, none).transactions).toBeNull();
  });

  test('banks are as the latest attempt that still found them saw them, never counted twice', () => {
    // The first disconnected two; the retry finds the same two, which Plaid now says are gone (disconnected).
    expect(mergeCounts({ ...COUNTS, banks_disconnected: 2 }, { ...skipped, banks_disconnected: 2 })).toMatchObject({ banks_disconnected: 2, banks_not_disconnected: 0 });
    // One Plaid refused the first time goes through on the retry.
    expect(mergeCounts({ ...COUNTS, banks_disconnected: 1, banks_not_disconnected: 1 }, { ...skipped, banks_disconnected: 2 })).toMatchObject({ banks_disconnected: 2, banks_not_disconnected: 0 });
    // Swept already: the retry sees no banks, so the first attempt's view stands.
    expect(mergeCounts({ ...COUNTS, banks_disconnected: 1, banks_not_disconnected: 1 }, none)).toMatchObject({ banks_disconnected: 1, banks_not_disconnected: 1 });
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
    expect(html).toContain('November 7, 2026');
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
    expect(form).toContain('Nightly backups keep a copy for up to 31 days: encrypted, except dates, ids, bank names and the merchant names you renamed.');
    expect(form).toContain('use Download my data under Manage accounts first');
    expect(form).toContain('you’ll get a receipt');
    const none = renderToStaticMarkup(<DeleteAccountView status={{ enabled: true, can_delete: true, backup_days: null }} typed="" busy={false} error="" onType={() => {}} onDelete={() => {}} />);
    expect(none).not.toContain('Nightly backups');
  });
});

// A data key per container (docs/operations.md, "Per-container data keys"):
// what the receipt says of the key, from the map entry the deletion read.
describe('the receipt, on the data key', () => {
  const lines = (r: ReturnType<typeof receipt>) => receiptSections(r, US).find((s) => s.title === 'Expires later')!.lines;

  const stays = (r: ReturnType<typeof receipt>) => receiptSections(r, US).find((s) => s.title === 'What stays, and why')!.lines;

  test('a key of its own, destroyed, and the key backups rewritten: nothing under it can be decrypted from any copy', () => {
    const r = receipt({ keys: { own_key: true, shared_from: null, key_in: null, key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' } } });
    expect(r.keys).toEqual({ own_key: true, shared_from: null, key_in: null, key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' }, shared_until: null, key_until: null });
    expect(lines(r)).toContain(
      'Your data key: your data was encrypted under a key of its own, which was destroyed with your account. The backups of the keys were rewritten without it at October 6, 2026 at 2:05 PM, so nothing encrypted under it can be decrypted from any copy Nya keeps (a deleted backup can still be served from the storage’s cache for up to a minute).'
    );
    expect(lines(r)).toContain('Copies under a shared key: none. No nightly backup holds any of your data under a key shared by everyone on this server.');
    // A backup of the keys downloaded by hand is out of the deletion's reach, as the pages say.
    expect(stays(r)).toContain(
      'A backup of the keys downloaded by hand: deleting your account doesn’t reach one that whoever runs this copy of Nya downloaded before the deletion. It holds your key, so with it a copy of your data from before the deletion can still be decrypted, for as long as they keep it.'
    );
  });

  test('the key backups left for the next nightly backup, or none kept', () => {
    const pending = lines(receipt({ keys: { own_key: true, shared_from: null, key_in: null, key_backups: { pending: true } } })).join('\n');
    expect(pending).toContain('The backups of the keys are rewritten without it by the next nightly backup that succeeds. Until then, a copy taken before the deletion can still be decrypted with this server’s master key.');
    const none = lines(receipt({ keys: { own_key: true, shared_from: null, key_in: null, key_backups: { none: true } } })).join('\n');
    expect(none).toContain('This server keeps no backups of the keys, so it is gone everywhere Nya keeps one.');
  });

  test('a backup an older version of Nya took holds the key: never “nothing can be decrypted”, and until when it can', () => {
    // Taken on October 1 while rolled back: kept 32 days at most.
    const held = receipt({ keys: { own_key: true, shared_from: AT.toISOString(), key_in: '2026-10-01T16:00:00.000Z', key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' } } });
    expect(held.keys!.key_until).toBe('2026-11-02T16:00:00.000Z');
    const text = lines(held).join('\n');
    expect(text).toContain(
      'Your data key: your data was encrypted under a key of its own, which was destroyed with your account. The backups of the keys were rewritten without it at October 6, 2026 at 2:05 PM, but a backup taken while an older version of Nya ran holds your key until November 2, 2026: until then, every copy of your data can be decrypted with this server’s master key.'
    );
    expect(text).not.toContain('nothing encrypted under it can be decrypted');
    expect(text).toContain('Copies under a shared key: nightly backups can hold some of your data under a key shared by everyone on this server, readable with its master key, until November 7, 2026.');
    // Left for the nightly backup too.
    const pending = lines(receipt({ keys: { own_key: true, shared_from: AT.toISOString(), key_in: '2026-10-01T16:00:00.000Z', key_backups: { pending: true } } })).join('\n');
    expect(pending).toContain('Until then, a copy taken before the deletion can still be decrypted with this server’s master key. Also, a backup taken while an older version of Nya ran holds your key until November 2, 2026');
    // Kept past its date (backups stopped, or the newest seven kept): until it is deleted.
    const late = receipt({ keys: { own_key: true, shared_from: AT.toISOString(), key_in: '2026-09-01T16:00:00.000Z', key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' } }, stopped: true });
    expect(lines(late).join('\n')).toContain('holds your key until it is deleted: until then, every copy of your data can be decrypted');
  });

  test('backups that couldn’t be listed: the receipt says what it couldn’t check, and the latest it can matter', () => {
    const r = receipt({ keys: { own_key: true, shared_from: AT.toISOString(), key_in: 'unchecked', key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' } } });
    expect(r.keys!.key_until).toBe('2026-11-07T14:05:00.000Z');
    expect(lines(r).join('\n')).toContain(
      'but whether a backup taken while an older version of Nya ran holds your key couldn’t be checked: if one does, every copy of your data can be decrypted with this server’s master key until November 7, 2026.'
    );
  });

  test('values that were under a shared key: readable until the last nightly copy that can hold them is gone', () => {
    // Given its key by the migration pass on October 1: copies from before then can hold it under the shared key.
    const r = receipt({ keys: { own_key: true, shared_from: '2026-10-01T00:00:00.000Z', key_in: null, key_backups: { rewritten_at: '2026-10-06T14:05:30.000Z' } } });
    expect(r.keys!.shared_until).toBe('2026-11-02T00:00:00.000Z');
    expect(lines(r)).toContain('Copies under a shared key: nightly backups can hold some of your data under a key shared by everyone on this server, readable with its master key, until November 2, 2026.');
  });

  test('no key of its own: nothing was destroyed, and every copy stays readable until it goes', () => {
    const r = receipt({ keys: { own_key: false, shared_from: AT.toISOString(), key_in: null, key_backups: { none: true } } });
    expect(r.keys!.shared_until).toBe('2026-11-07T14:05:00.000Z');
    expect(lines(r).join('\n')).toContain('your data was encrypted under a key shared by everyone on this copy of Nya, not one of its own');
    expect(stays(r).join('\n')).not.toContain('A backup of the keys downloaded by hand');
    expect(lines(r).join('\n')).toContain('until November 7, 2026.');
  });

  test('a key it couldn’t tell about is said, and the dates assume the worst', () => {
    const r = receipt({ keys: { own_key: null, shared_from: AT.toISOString(), key_in: null, key_backups: { none: true } } });
    expect(lines(r).join('\n')).toContain('whether your data was under a key of its own couldn’t be read on this attempt');
  });

  test('the database host’s own backups, when they are kept, or can’t be said', () => {
    const kept = receipt({ database_days: 3 });
    expect(kept.database).toEqual({ days: 3, until: '2026-10-09T14:05:00.000Z' });
    expect(lines(kept)).toContain('The database host’s own backups: each holds the whole database, keys included, for 3 days, so a copy holding your data readably can exist until October 9, 2026.');
    expect(receipt({ database_days: 0 }).database).toBeUndefined();
    const unknown = receipt({ database_days: null });
    expect(unknown.database).toBeNull();
    expect(lines(unknown).join('\n')).toContain('The database host’s own backups: how long they keep a copy couldn’t be worked out on this server.');
  });

  test('before deleting: whether the data is under a key of its own, and the database host’s backups', () => {
    const view = (status: object) =>
      renderToStaticMarkup(<DeleteAccountView status={{ enabled: true, can_delete: true, ...status }} typed="" busy={false} error="" onType={() => {}} onDelete={() => {}} />);
    expect(view({ own_key: true })).toContain('Your data is encrypted under a key of its own, which is destroyed with your account');
    expect(view({ own_key: true })).toContain('and the receipt names any copy that still holds the key');
    expect(view({ own_key: false })).toContain('Your data is encrypted under a key shared by everyone on this copy of Nya, until whoever runs it moves it to one of its own');
    expect(view({ own_key: null })).not.toContain('encrypted under a key');
    expect(view({ database_days: 3 })).toContain('The database host also keeps its own backups, of everything, for 3 days.');
    expect(view({ database_days: 0 })).not.toContain('database host');
  });
});
