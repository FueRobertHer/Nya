'use client';

// Your data (app/your-data): every kind of thing Nya keeps about the person,
// as /api/data-inventory counts it (lib/inventory-read.ts): how much of each,
// whether it is encrypted and with which key, whether it is in the download,
// how long it is kept and who else can see it. Numbers only: the answer holds
// no stored value, so there is nothing here for hide amounts to cover; counts
// and sizes are no amounts, and stay shown.
//
// What couldn't be read says so, in place of a figure, never as nothing. The
// kinds with nothing stored are listed too, folded away under each heading,
// so the list is every kind there is, not only the ones in use.

import { useEffect, useState } from 'react';
import { plainNumber } from '@/lib/format';

type Encryption =
  | { kind: 'plain' }
  | { kind: 'token' }
  | { kind: 'wrapped' }
  | { kind: 'encrypted'; own: number; shared: number; unclear: number; not_ciphertext: number };

export type InventoryRow = {
  id: string;
  name: string;
  about: string | null;
  where: 'yours' | 'environment';
  status: 'read' | 'unreadable' | 'not-counted';
  count: number | null;
  unit: [string, string];
  chars: number | null;
  encryption: Encryption;
  download: { included: boolean; text: string };
  backed_up: boolean;
  kept: string[];
  kept_detail: string | null;
  seen: string[];
  plain: string | null;
};

export type Inventory = {
  as_of: string;
  key: { own: boolean; since: string | null; moved: string | null } | null;
  measured: boolean;
  backups: 'kept' | 'none' | 'invalid';
  groups: { id: string; title: string; rows: InventoryRow[] }[];
  unknown: { keys: number; chars: number | null } | null;
  elsewhere: InventoryRow[];
};

/** A stored size in words. */
export function sizeText(n: number): string {
  if (n < 1024) return `${plainNumber(n)} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** How many of a kind there are, and their size, or why not. */
export function figures(r: InventoryRow): string {
  if (r.status === 'unreadable') return 'Couldn’t be read just now';
  if (r.status === 'not-counted' || r.count === null) return 'Not counted here';
  const count = `${plainNumber(r.count)} ${r.count === 1 ? r.unit[0] : r.unit[1]}`;
  return r.chars === null ? count : `${count}, ${sizeText(r.chars)}`;
}

/** Whether a kind is encrypted, and under which key, in words. */
export function encryptionText(r: InventoryRow): string {
  const e = r.encryption;
  if (e.kind === 'plain') return 'No: kept as plain text.';
  if (e.kind === 'token') return 'The token that reaches each bank is encrypted; the rest of each record is plain text.';
  if (e.kind === 'wrapped') return 'The key is kept locked by the master key, which is never in the database; its id and dates are plain text.';
  const parts: string[] = [];
  const total = e.own + e.shared + e.unclear + e.not_ciphertext;
  if (total === 0) return 'Yes, whenever any is stored.';
  if (e.own === total) return 'Yes, with your account’s own key.';
  if (e.shared === total) return 'Yes, with a key this copy of Nya shares between accounts.';
  if (e.own > 0) parts.push(`${plainNumber(e.own)} with your account’s own key`);
  if (e.shared > 0) parts.push(`${plainNumber(e.shared)} with a key this copy of Nya shares`);
  if (e.unclear > 0) parts.push(`${plainNumber(e.unclear)} with a key whose id can’t be read`);
  if (e.not_ciphertext > 0) parts.push(`${plainNumber(e.not_ciphertext)} that don’t look encrypted, so can’t be read`);
  return `Yes: ${parts.join('; ')}.`;
}

/** What the account's data key is, in words. */
export function keyText(key: Inventory['key']): string {
  if (key === null) return 'Which key your account’s encrypted values are under couldn’t be read just now.';
  if (!key.own) return 'Your account’s encrypted values are under keys this copy of Nya shares between accounts: your account doesn’t have a key of its own.';
  const made = key.since ? ` It was made on ${day(key.since)}.` : '';
  if (key.moved) return `Your account has a data key of its own, and every encrypted value of yours has been under it since ${day(key.moved)}.${made}`;
  return `Your account has a data key of its own.${made} What was stored before it may still be under a key this copy of Nya shares until whoever runs it moves it: each kind below says which.`;
}

/** Whether the nightly backups copy a kind, as this copy of Nya keeps them. */
export function backupText(r: InventoryRow, backups: Inventory['backups']): string | null {
  if (backups === 'none') return null;
  if (!r.backed_up) return 'Left out of them.';
  return backups === 'kept' ? 'Copied into each one, as it is stored.' : 'Copied into them once they are taken again: their retention setting is not valid just now.';
}

function Row({ r, backups }: { r: InventoryRow; backups: Inventory['backups'] }) {
  const backed = backupText(r, backups);
  return (
    <details className="inventory-row">
      <summary>
        <span className="inventory-name">{r.name}</span>
        <span className={r.status === 'unreadable' ? 'inventory-figures stale' : 'inventory-figures'}>{figures(r)}</span>
      </summary>
      {r.about && <p className="type-tag">{r.about}</p>}
      <dl className="info-status inventory-facts">
        <dt>Encrypted</dt>
        <dd>{encryptionText(r)}</dd>
        {r.plain && (
          <>
            <dt>Plain text</dt>
            <dd>{r.plain}</dd>
          </>
        )}
        <dt>Your download</dt>
        <dd>{r.download.text}</dd>
        {backed && (
          <>
            <dt>Nightly backups</dt>
            <dd>{backed}</dd>
          </>
        )}
        <dt>How long it is kept</dt>
        <dd>
          As the <a href="/privacy">Privacy page</a> says under {r.kept.map((k) => `“${k}”`).join(' and ')}.{r.kept_detail ? ` ${r.kept_detail}` : ''}
        </dd>
        <dt>Who else can see it</dt>
        <dd>{r.seen.length > 0 ? `${r.seen.join('; ')}.` : 'Nobody else.'}</dd>
        {r.where === 'environment' && (
          <>
            <dt>Where</dt>
            <dd>Kept for this whole copy of Nya, beside other accounts’ records, so its size isn’t measured for you.</dd>
          </>
        )}
      </dl>
    </details>
  );
}

/** A kind is shown at once when it holds something, or when it can't be
 *  said that it holds nothing. */
const shown = (r: InventoryRow) => r.status !== 'read' || (r.count ?? 0) > 0;

export function InventoryView({ inv }: { inv: Inventory }) {
  return (
    <>
      <section className="card">
        <div className="inst-header">
          <div className="inst-name">Who can read all of it</div>
        </div>
        <p className="panel-note">
          Whoever runs this copy of Nya, and the services it runs on: Upstash, the database, and Vercel, the host, which keeps the nightly backups. The{' '}
          <a href="/security">Security page</a> says what each of them can read. Each kind below says who else can see it.
        </p>
        <p className="panel-note">{keyText(inv.key)}</p>
        <p className="as-of">Counted {when(inv.as_of)}</p>
      </section>

      {!inv.measured && (
        <p className="stale-note" role="status">
          What is stored in your account couldn’t be read just now, so none of it is counted below. Nothing was changed. Try again later.
        </p>
      )}

      {inv.groups.map((g) => {
        const stored = g.rows.filter(shown);
        const none = g.rows.filter((r) => !shown(r));
        return (
          <section className="card inventory-group" key={g.id}>
            <div className="inst-header">
              <div className="inst-name">{g.title}</div>
            </div>
            {stored.map((r) => (
              <Row key={r.id} r={r} backups={inv.backups} />
            ))}
            {none.length > 0 && (
              <details className="inventory-none">
                <summary>
                  {stored.length > 0 ? 'Nothing stored of ' : 'Nothing stored yet of these '}
                  {plainNumber(none.length)} {stored.length > 0 ? (none.length === 1 ? 'more kind' : 'more kinds') : none.length === 1 ? 'kind' : 'kinds'}
                </summary>
                {none.map((r) => (
                  <Row key={r.id} r={r} backups={inv.backups} />
                ))}
              </details>
            )}
          </section>
        );
      })}

      {inv.unknown && (
        <section className="card">
          <div className="inst-header">
            <div className="inst-name">Data this version of Nya doesn’t name</div>
          </div>
          <p className="panel-note">
            {plainNumber(inv.unknown.keys)} {inv.unknown.keys === 1 ? 'key' : 'keys'}
            {inv.unknown.chars === null ? ', whose size couldn’t be measured,' : `, ${sizeText(inv.unknown.chars)},`} that none of the kinds above is: left by
            another version of Nya, perhaps. It is deleted with your account, and isn’t in your download. Whoever runs this copy of Nya can look at it.
          </p>
        </section>
      )}

      <section className="card">
        <div className="inst-header">
          <div className="inst-name">Kept, but not about you by name</div>
        </div>
        {inv.elsewhere.map((r) => (
          <Row key={r.id} r={r} backups={inv.backups} />
        ))}
      </section>

      <section className="card">
        <div className="inst-header">
          <div className="inst-name">Not kept here</div>
        </div>
        <p className="panel-note">
          Your sign-in (your email address, and your name and picture if you sign in with another account) is kept by Clerk, the sign-in service, when this copy
          of Nya uses it. {inv.backups === 'none' ? 'This copy of Nya takes no nightly backups. ' : 'Each kind above says whether the nightly backups copy it. '}Your device
          keeps your accounts, their balances and your net-worth history as the app last showed them, until you sign out on it.
        </p>
      </section>
    </>
  );
}

export default function DataInventory() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/data-inventory', { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : '');
        if (live) setInv(body as Inventory);
      } catch (err) {
        if (live) setError(err instanceof Error && err.message ? err.message : 'Could not list what Nya keeps just now.');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="wrap report-wrap">
      <div className="report-top">
        <nav className="report-nav" aria-label="Back to Nya">
          <a href="/">← Nya</a>
        </nav>
      </div>
      <h1>Your data</h1>
      <p className="sub">
        Every kind of thing Nya keeps about you: how much of it there is, whether it is encrypted and with which key, whether it is in your download, how long it is
        kept and who else can see it. Numbers only: nothing here shows what is stored.
      </p>
      {error && <div className="error">{error}</div>}
      {!inv && !error && <p className="empty-note">Counting…</p>}
      {inv && <InventoryView inv={inv} />}
    </main>
  );
}
