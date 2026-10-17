// lib/deletion-receipt.ts
//
// The receipt "Delete my account" ends with: what was deleted now, what
// expires later and when, and what stays and why. lib/account-deletion.ts
// counts, app/api/account assembles it (buildDeletionReceipt), and the page
// shows it, copies it and saves it as text (components/DeletionReceipt.tsx).
//
// Pure, and free of server imports, so the page builds the same text the
// server's numbers describe. Every sentence is one Nya can stand behind: a
// count that couldn't be read says so instead of showing zero, the backup date
// is the honest maximum (lib/backup.ts backupRetention) with what would move
// it, and what Nya can't delete (Plaid's own records) is named with where to
// delete it.

/** Where a person sees, and deletes, what Plaid itself keeps about them. */
export const PLAID_PORTAL = 'https://my.plaid.com';

/** What a deletion removed. A count of what was stored is null when it
 *  couldn't be read to count it: the deletion goes ahead regardless. */
export type DeletionCounts = {
  banks_disconnected: number;
  /** Banks Plaid wouldn't disconnect: their tokens are deleted with the rest,
   *  but Plaid may keep the connection (see the receipt's last section). */
  banks_not_disconnected: number;
  /** The accounts of the banks still connected, and the manual accounts, an
   *  account linked across a reconnect counted once (lib/user-export.ts
   *  countAccounts). */
  accounts: number | null;
  /** Accounts of banks disconnected earlier, kept for their history. */
  earlier_accounts: number | null;
  transactions: number | null;
  investment_transactions: number | null;
  /** Days with any recorded or estimated balance. */
  history_days: number | null;
  /** Connections with people that sharing ended on. */
  connections_ended: number;
  sign_in_deleted: boolean;
};

export type BackupRetention = { kept: false } | { kept: true; keep_days: number; min_kept: number; max_days: number } | null;

/**
 * What the receipt says of the account's data key (docs/operations.md,
 * "Per-container data keys"), from its map entry as the deletion read it
 * before destroying the key (lib/account-deletion.ts keyFactsOf).
 */
export type ReceiptKeys = {
  /** Whether its data was under a key of its own; null when that couldn't be
   *  read on this attempt. */
  own_key: boolean | null;
  /** The latest time a copy can have held some of it under a key shared by
   *  everyone on this copy of Nya (an ISO time), or null for never. */
  shared_from: string | null;
  /** The key backups: rewritten without its key, at a time; left for the
   *  next nightly backup; or none kept on this server. */
  key_backups: { rewritten_at: string } | { pending: true } | { none: true };
};

/**
 * A day added to the backup date people are given. The nightly backup is
 * pruned minutes into a run that a cron can start up to an hour late, so the
 * last copy can outlive the exact figure (lib/backup.ts backupRetention) by
 * that much: past midnight, for some time zones.
 */
export const BACKUP_DATE_MARGIN_DAYS = 1;

/**
 * The most days a nightly backup can keep a copy of data deleted now, while
 * the nightly backup keeps running: backupRetention()'s max_days (lib/backup.ts)
 * and the margin above. The receipt dates by it and the public pages
 * (app/security, app/privacy) state it, so the two always say the same.
 */
export function backupDaysAtMost(retention: { max_days: number }): number {
  return retention.max_days + BACKUP_DATE_MARGIN_DAYS;
}

/**
 * What the public pages say of a data key per account and a deletion
 * (app/security, app/privacy), the same on both. They read no stored data,
 * so they say it conditionally: accounts made on this version have a key of
 * their own, older ones once whoever runs the copy has moved them. Empty
 * without a master key, where there are no data keys at all. Wording the
 * owner signs off (docs/operations.md, "Per-container data keys").
 */
export function keyDeletionText(input: { envelope: boolean; backups: BackupRetention; databaseDays: number | null }): { key: string[]; notReached: string[] } {
  if (!input.envelope) return { key: [], notReached: [] };
  const own =
    'Each account made on this version of Nya has a data key of its own, and an account made before it has one once whoever runs this copy has moved it; until then, its data is under a key shared by everyone on this copy.';
  const key = input.backups?.kept
    ? [
        own,
        'Deleting an account destroys its own key, so nothing encrypted under it can be decrypted from any copy Nya keeps, normally within minutes of the deletion and at the latest after the next nightly backup that succeeds. The encrypted copies stay in backups, unreadable, until they are deleted, and the plain text in them stays readable until then. Copies under a shared key stay readable with it until they are deleted. The receipt says which applies to the account.',
      ]
    : [own, 'Deleting an account destroys its own key with the rest of its data.'];
  const days = input.databaseDays;
  const notReached = [
    ...(input.backups?.kept ? ['A backup of the keys that whoever runs this copy of Nya downloaded by hand, for as long as they keep it.'] : []),
    ...(days === null
      ? ['The database host’s own backups, which hold the whole database, keys included, for as long as its setting keeps them: how long couldn’t be worked out on this copy of Nya.']
      : days > 0
        ? [`The database host’s own backups, which hold the whole database, keys included, for ${days === 1 ? '1 day' : `${days} days`}.`]
        : []),
    ...(input.backups?.kept ? ['A backup taken while an older version of Nya ran, which holds every key.'] : []),
    'A record that the account existed: its random id and the day its key was destroyed, kept for good, so that a restored backup never brings the account back.',
  ];
  return { key, notReached };
}

export type DeletionReceipt = {
  /** When it finished: an ISO time. */
  deleted_at: string;
  /** Whether anything was stored to delete when this attempt ran. */
  found_data: boolean;
  /** An earlier attempt had already started, so the counts are what was left. */
  resumed: boolean;
  /** The counts include an earlier, unfinished attempt's, kept by the page. */
  includes_earlier_attempt: boolean;
  deleted: DeletionCounts;
  backups:
    | { kept: false }
    | { kept: true; keep_days: number; min_kept: number; until: string; stopped: boolean }
    /** The retention setting couldn't be read. */
    | null;
  /** Its data key, when it had a container: what was destroyed, and until
   *  when copies under a shared key stay readable (null: none do; absent
   *  from a receipt the release before made). */
  keys?: ReceiptKeys & { shared_until: string | null };
  /** The database host's own backups (DATABASE_BACKUP_DAYS): kept that many
   *  days, each the whole database. Absent when they are off; null when the
   *  setting can't be read. */
  database?: { days: number; until: string } | null;
};

/** The receipt for a deletion that just finished. `stopped`: the nightly
 *  backup isn't running (lib/backup.ts backupProblem), so nothing is being
 *  pruned until it is. */
export function buildDeletionReceipt(input: {
  counts: DeletionCounts;
  found_data: boolean;
  resumed: boolean;
  deleted_at: Date;
  retention: BackupRetention;
  stopped: boolean;
  keys?: ReceiptKeys | null;
  /** DATABASE_BACKUP_DAYS (lib/backup.ts databaseBackupDays): 0 when off,
   *  null when it can't be read. */
  database_days?: number | null;
}): DeletionReceipt {
  const { retention } = input;
  const dbDays = input.database_days === undefined ? 0 : input.database_days;
  // A copy under a shared key is gone once the newest nightly copy that can
  // hold it is: backupDaysAtMost after it was taken.
  const sharedUntil = (from: string | null): string | null =>
    from === null || !retention?.kept ? null : new Date(Date.parse(from) + backupDaysAtMost(retention) * 86_400_000).toISOString();
  return {
    ...(input.keys ? { keys: { ...input.keys, shared_until: sharedUntil(input.keys.shared_from) } } : {}),
    ...(dbDays === null ? { database: null } : dbDays > 0 ? { database: { days: dbDays, until: new Date(input.deleted_at.getTime() + dbDays * 86_400_000).toISOString() } } : {}),
    deleted_at: input.deleted_at.toISOString(),
    found_data: input.found_data,
    resumed: input.resumed,
    includes_earlier_attempt: false,
    deleted: input.counts,
    backups:
      retention === null
        ? null
        : !retention.kept
          ? { kept: false }
          : {
              kept: true,
              keep_days: retention.keep_days,
              min_kept: retention.min_kept,
              until: new Date(input.deleted_at.getTime() + backupDaysAtMost(retention) * 86_400_000).toISOString(),
              stopped: input.stopped,
            },
  };
}

/** What was stored, across two attempts: counted by the first (a retry
 *  doesn't count again, and answers null), plus whatever a retry still found
 *  (0 once the container is gone). Unknown at first stays unknown. */
const stored = (earlier: number | null, later: number | null) => (earlier === null ? null : later === null ? earlier : earlier + later);

/**
 * An earlier attempt's counts and a later one's, for a deletion that took two
 * tries. The banks are as the latest attempt that still found them saw them: a
 * retry sees every one again (those the first disconnected now report
 * themselves gone, which counts as disconnected), so adding the two would
 * count them twice; once they are swept, the first attempt's view stands.
 */
export function mergeCounts(earlier: DeletionCounts, later: DeletionCounts): DeletionCounts {
  const banks = later.banks_disconnected + later.banks_not_disconnected > 0 ? later : earlier;
  return {
    banks_disconnected: banks.banks_disconnected,
    banks_not_disconnected: banks.banks_not_disconnected,
    accounts: stored(earlier.accounts, later.accounts),
    earlier_accounts: stored(earlier.earlier_accounts, later.earlier_accounts),
    transactions: stored(earlier.transactions, later.transactions),
    investment_transactions: stored(earlier.investment_transactions, later.investment_transactions),
    history_days: stored(earlier.history_days, later.history_days),
    connections_ended: earlier.connections_ended + later.connections_ended,
    sign_in_deleted: later.sign_in_deleted,
  };
}

/** A receipt from somewhere that can't be trusted to be one (the page's own
 *  storage): its shape checked, or null. */
export function asDeletionReceipt(v: unknown): DeletionReceipt | null {
  const r = v as DeletionReceipt | null;
  if (!r || typeof r !== 'object' || typeof r.deleted_at !== 'string' || Number.isNaN(Date.parse(r.deleted_at))) return null;
  if (!r.deleted || typeof r.deleted !== 'object' || typeof r.deleted.banks_disconnected !== 'number') return null;
  return r;
}

export type ReceiptSection = { title: string; lines: string[] };
export type ReceiptFormat = { locale?: string; timeZone?: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The receipt, section by section, in the viewer's own dates. */
export function receiptSections(r: DeletionReceipt, opts: ReceiptFormat = {}): ReceiptSection[] {
  const number = new Intl.NumberFormat(opts.locale);
  const day = (iso: string) => new Intl.DateTimeFormat(opts.locale, { dateStyle: 'long', timeZone: opts.timeZone }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat(opts.locale, { dateStyle: 'long', timeStyle: 'short', timeZone: opts.timeZone }).format(new Date(iso));
  const count = (n: number | null) => (n === null ? 'unavailable' : number.format(n));
  const d = r.deleted;
  const unavailable = [d.accounts, d.transactions, d.investment_transactions, d.history_days].some((n) => n === null);

  const now = [
    `Banks disconnected at Plaid: ${number.format(d.banks_disconnected)}`,
    ...(d.banks_not_disconnected > 0 ? [`Banks Plaid wouldn’t disconnect: ${number.format(d.banks_not_disconnected)} (see What stays)`] : []),
    `Accounts: ${count(d.accounts)}`,
    ...(d.earlier_accounts ? [`Earlier accounts, of banks you had disconnected, kept for their history: ${number.format(d.earlier_accounts)}`] : []),
    `Transactions: ${count(d.transactions)}`,
    `Investment transactions: ${count(d.investment_transactions)}`,
    `Days of balance history: ${count(d.history_days)}`,
    `Sharing ended: ${plural(d.connections_ended, 'connection', 'connections')}`,
    `Your sign-in: ${d.sign_in_deleted ? 'deleted' : 'not deleted'}`,
  ];
  if (!r.found_data && !r.includes_earlier_attempt) {
    now.push('Nothing was stored for this account any more: an earlier attempt had already deleted it, or nothing was ever stored.');
  } else if (r.resumed && !r.includes_earlier_attempt) {
    now.push('An earlier attempt had already begun this deletion, so what was stored wasn’t counted again (part of it may already have been gone). All of it was deleted.');
  } else if (unavailable) {
    now.push('A figure shown as unavailable couldn’t be counted (in time, or at all). What it describes was deleted all the same.');
  }

  const b = r.backups;
  const later =
    b === null
      ? ['Nightly backups: how long they keep a copy couldn’t be worked out on this server. Ask whoever runs it.']
      : !b.kept
        ? ['Nightly backups: this server keeps none, so no copy of your data is left in one.']
        : [
            `Nightly backups: copies taken before the deletion still hold your data. Its values are encrypted, but dates, account and transaction ids, bank names and the merchant names you renamed are in plain text. Each copy is deleted once it is more than ${plural(b.keep_days, 'day', 'days')} old, and the newest ${b.min_kept} are always kept, so the last one holding your data is gone by ${day(b.until)}. ` +
              (b.stopped
                ? 'The nightly backup isn’t running right now, and old copies are deleted only when it runs, so that date moves later by as long as it stays stopped.'
                : 'That holds as long as the nightly backup keeps running.'),
          ];

  const k = r.keys;
  if (k) {
    if (k.own_key === true) {
      later.push(
        'Your data key: your data was encrypted under a key of its own, which was destroyed with your account. ' +
          ('rewritten_at' in k.key_backups
            ? `The backups of the keys were rewritten without it at ${time(k.key_backups.rewritten_at)}, so nothing encrypted under it can be decrypted from any copy Nya keeps (a deleted backup can still be served from the storage’s cache for up to a minute).`
            : 'pending' in k.key_backups
              ? 'The backups of the keys are rewritten without it by the next nightly backup that succeeds. Until then, a copy taken before the deletion can still be decrypted with this server’s master key.'
              : 'This server keeps no backups of the keys, so it is gone everywhere Nya keeps one.')
      );
    } else if (k.own_key === false) {
      later.push('Your data key: your data was encrypted under a key shared by everyone on this copy of Nya, not one of its own, so no key of yours was destroyed: copies of it stay readable with this server’s keys until they are deleted, as below.');
    } else {
      later.push('Your data key: whether your data was under a key of its own couldn’t be read on this attempt, so what follows assumes it wasn’t.');
    }
    if (b !== null && b.kept) {
      later.push(
        k.shared_until === null
          ? 'Copies under a shared key: none. No nightly backup holds any of your data under a key shared by everyone on this server.'
          : `Copies under a shared key: nightly backups can hold some of your data under a key shared by everyone on this server, readable with its master key, until ${day(k.shared_until)}.`
      );
    }
  }
  const db = r.database;
  if (db === null) later.push('The database host’s own backups: how long they keep a copy couldn’t be worked out on this server. Ask whoever runs it.');
  else if (db) later.push(`The database host’s own backups: each holds the whole database, keys included, for ${plural(db.days, 'day', 'days')}, so a copy holding your data readably can exist until ${day(db.until)}.`);

  const stays = [
    `Plaid’s own copy: Plaid keeps what it collected from your banks under its own privacy policy. Disconnecting ended Nya’s connections; it doesn’t delete Plaid’s records. See and delete what Plaid holds at the Plaid Portal: ${PLAID_PORTAL}`,
    ...(d.banks_not_disconnected > 0
      ? [
          `${plural(d.banks_not_disconnected, 'bank', 'banks')} couldn’t be disconnected at Plaid. Nya deleted the token it used to reach ${d.banks_not_disconnected === 1 ? 'it' : 'them'}, but Plaid may keep the connection until you remove it at the Plaid Portal.`,
        ]
      : []),
    'Server logs: the host keeps them for a short time. Nya writes counts, dates and errors to them, not amounts or balances.',
    'Your downloads: a copy you saved with Download my data is yours, and deleting your account doesn’t reach it.',
  ];

  return [
    { title: 'Deleted now', lines: now },
    { title: 'Expires later', lines: later },
    { title: 'What stays, and why', lines: stays },
  ];
}

/** The receipt as plain text, to copy or save. */
export function receiptText(r: DeletionReceipt, opts: ReceiptFormat = {}): string {
  const when = new Intl.DateTimeFormat(opts.locale, { dateStyle: 'long', timeStyle: 'short', timeZone: opts.timeZone }).format(new Date(r.deleted_at));
  const body = receiptSections(r, opts).map((s) => [s.title, ...s.lines.map((l) => `- ${l}`)].join('\n'));
  return [`Nya account deletion receipt`, `Deleted ${when}`, ...body].join('\n\n') + '\n';
}

/** The receipt's file name, dated by the viewer's calendar like the text in
 *  it: the UTC day is already tomorrow from a US evening on. */
export function receiptFilename(r: DeletionReceipt, opts: ReceiptFormat = {}): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: opts.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(r.deleted_at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `nya-deletion-receipt-${part('year')}-${part('month')}-${part('day')}.txt`;
}
