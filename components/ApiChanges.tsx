'use client';

// Changes made with your tokens (lib/api-changes.ts, app/api/api-changes),
// under the API tokens card: every change a token made in the last 30 days,
// newest first, in a sentence each (components/api-change-words.ts), with the
// token's name ("since revoked" once it is), whether it came through the API
// or an AI assistant, and Undo or why not, and Forget.
//
// UNDO asks first, and is made only while what the change changed is still as
// it left it: the server says what changed since when it isn't. FORGET asks
// first too: it removes Nya's copy of what the change changed, before and
// after, at once, for one change or all of one token's; the line stays.
//
// Shown while this copy lets tokens write, and while any change is kept: a
// change made before writing was turned off can still be undone. Otherwise
// nothing is drawn, and the card above reads as it always did.

import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
import { cannotUndo, changeSentence, viaWords, type AccountNames, type ListedChange } from './api-change-words';
import { CHANGES_KEEP_DAYS } from '@/lib/api-limits';

export type ChangeList =
  | { kind: 'loading' }
  | { kind: 'ready'; changes: ListedChange[]; next: string | null; unreadable: string[]; unrecognised: string[]; accounts: AccountNames; writes: boolean }
  | { kind: 'error'; message: string };

/** What the person is being asked to confirm. */
export type Asking = { kind: 'undo' | 'forget' | 'remove'; change: ListedChange | null; id: string } | null;

/** When, in the viewer's own time. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const unreached = 'Nya could not be reached. Check your connection and try again.';

async function send(method: 'POST' | 'DELETE', body: unknown): Promise<string | null> {
  try {
    const res = await fetch('/api/api-changes', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    return typeof data?.error === 'string' ? data.error : 'That didn’t work. Try again.';
  } catch {
    return unreached;
  }
}

export default function ApiChanges({ writes }: { writes: boolean }) {
  const [list, setList] = useState<ChangeList>({ kind: 'loading' });
  const [more, setMore] = useState(false);

  const load = useCallback(async (cursor: string | null = null) => {
    try {
      const res = await fetch(`/api/api-changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.changes)) {
        setList({ kind: 'error', message: typeof data?.error === 'string' ? data.error : 'The changes your tokens made couldn’t be loaded.' });
        return;
      }
      setList((prev) => ({
        kind: 'ready',
        changes: cursor && prev.kind === 'ready' ? [...prev.changes, ...data.changes] : data.changes,
        next: data.next ?? null,
        unreadable: data.unreadable ?? [],
        unrecognised: data.unrecognised ?? [],
        accounts: data.accounts ?? {},
        writes: data.writes === true,
      }));
    } catch {
      setList({ kind: 'error', message: 'The changes your tokens made couldn’t be loaded.' });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (asking: NonNullable<Asking>, all = false): Promise<string | null> => {
    const failed =
      asking.kind === 'remove'
        ? await send('DELETE', { id: asking.id })
        : asking.kind === 'undo'
          ? await send('POST', { action: 'undo', id: asking.id })
          : all && asking.change?.token
            ? await send('POST', { action: 'forget-token', id: asking.id })
            : await send('POST', { action: 'forget', id: asking.id });
    if (!failed) await load();
    return failed;
  };

  const loadMore = async (cursor: string) => {
    setMore(true);
    await load(cursor);
    setMore(false);
  };

  return <ApiChangesView list={list} writes={writes} act={act} onMore={loadMore} loadingMore={more} />;
}

export function ApiChangesView({
  list,
  writes,
  act,
  onMore,
  loadingMore,
}: {
  list: ChangeList;
  /** Whether this copy lets tokens write, as the tokens card was told. */
  writes: boolean;
  act: (asking: NonNullable<Asking>, all?: boolean) => Promise<string | null>;
  onMore: (cursor: string) => void;
  loadingMore: boolean;
}) {
  useAmountsHidden(); // drawn again when amounts are hidden or shown
  const [asking, setAsking] = useState<Asking>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kept = list.kind === 'ready' && (list.changes.length > 0 || list.unreadable.length > 0 || list.unrecognised.length > 0);
  // Nothing at all while writing is off and nothing is kept: the app reads
  // as it did before tokens could write.
  if (!writes && !kept && !(list.kind === 'ready' && list.writes)) return null;

  const confirm = async (all = false) => {
    if (!asking) return;
    setBusy(true);
    setError(null);
    const failed = await act(asking, all);
    setBusy(false);
    if (failed) setError(failed);
    else setAsking(null);
  };
  const close = () => {
    if (busy) return;
    setAsking(null);
    setError(null);
  };
  const byId = new Map(list.kind === 'ready' ? list.changes.map((c) => [c.id, c]) : []);
  const names = list.kind === 'ready' ? list.accounts : {};

  return (
    <div className="card api-changes-card">
      <div className="inst-header">
        <div className="inst-name">Changes made with your tokens</div>
      </div>
      <p className="panel-note">
        Every change a token made in the last {CHANGES_KEEP_DAYS} days, newest first. Undo one while what it changed is still as
        the change left it. Forget one to remove Nya’s copy of what it changed: it stays listed, and can’t be undone.
      </p>
      {list.kind === 'loading' && <p className="panel-note">Loading the changes…</p>}
      {list.kind === 'error' && <div className="error">{list.message}</div>}
      {list.kind === 'ready' && (
        <>
          {list.changes.length === 0 && list.unreadable.length === 0 && list.unrecognised.length === 0 && (
            <p className="empty-note">No changes in the last {CHANGES_KEEP_DAYS} days.</p>
          )}
          {list.changes.length > 0 && (
            <ul className="api-change-list">
              {list.changes.map((c) => {
                const why = cannotUndo(c);
                const who = c.token ? `${c.token.label}${c.revoked ? ' (since revoked)' : ''}` : 'You';
                return (
                  <li key={c.id} className="api-change">
                    <div className="api-change-text" id={`api-change-${c.id}`}>
                      <Masked>{changeSentence(c, names, c.undoes ? byId.get(c.undoes) : undefined)}</Masked>
                      {c.state !== 'done' && <span className="api-change-state"> It may not have been made.</span>}
                    </div>
                    <div className="as-of">
                      {who} {viaWords(c.via)} · {when(c.at)}
                      {c.undone_by ? ' · undone' : ''}
                      {c.forgotten_at ? ' · forgotten' : ''}
                    </div>
                    <div className="api-change-actions">
                      {why === null ? (
                        <button className="secondary" onClick={() => setAsking({ kind: 'undo', change: c, id: c.id })} aria-describedby={`api-change-${c.id}`}>
                          Undo
                        </button>
                      ) : (
                        c.op !== 'undo' && !c.undone_by && <span className="api-change-why">{why}</span>
                      )}
                      {!c.forgotten_at && c.state === 'done' && (
                        <button className="secondary" onClick={() => setAsking({ kind: 'forget', change: c, id: c.id })} aria-describedby={`api-change-${c.id}`}>
                          Forget
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {list.unreadable.map((id) => (
            <div key={id} className="stale-note api-token-problem">
              A change couldn’t be read, so it can’t be undone.{' '}
              <button className="link-btn danger-link" onClick={() => setAsking({ kind: 'remove', change: null, id })}>
                Remove it
              </button>
            </div>
          ))}
          {list.unrecognised.length > 0 && (
            <p className="stale-note">
              {list.unrecognised.length === 1 ? 'A change was' : 'Some changes were'} recorded by another version of Nya, which this one can’t read.
              Nothing was changed.
            </p>
          )}
          {list.next && (
            <button className="secondary api-change-more" onClick={() => onMore(list.next!)} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Show older changes'}
            </button>
          )}
        </>
      )}
      <ChangeSheet asking={asking} names={names} busy={busy} error={error} onCancel={close} onConfirm={confirm} />
    </div>
  );
}

/** Asks before an undo, a forget, or removing a change that can't be read. */
export function ChangeSheet({
  asking,
  names,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  asking: Asking;
  names: AccountNames;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (all?: boolean) => void;
}) {
  const title = asking?.kind === 'undo' ? 'Undo this change?' : asking?.kind === 'forget' ? 'Forget what it changed?' : 'Remove the change?';
  const label = asking?.change?.token?.label;
  return (
    <Sheet open={!!asking} title={title} onClose={onCancel}>
      {asking && (
        <>
          {asking.change && (
            <p className="panel-note" style={{ marginTop: 0 }}>
              <Masked>{changeSentence(asking.change, names)}</Masked>
            </p>
          )}
          <p className="panel-note">
            {asking.kind === 'undo'
              ? 'It is changed back only if nothing has changed it since, in the app or by another program; if something has, nothing is changed and you are told what. The undo is listed too.'
              : asking.kind === 'forget'
                ? `Nya keeps a copy of what each change changed, before and after, for ${CHANGES_KEEP_DAYS} days, so it can be undone. Forgetting removes the copy now. The change stays listed, without it, and can no longer be undone.`
                : 'Its record can’t be read, so it can’t be undone or shown. Removing it deletes what is left of it.'}
          </p>
          {error && <div className="error">{error}</div>}
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className={asking.kind === 'undo' ? undefined : 'danger'} onClick={() => onConfirm(false)} disabled={busy}>
              {busy ? 'Working…' : asking.kind === 'undo' ? 'Undo' : asking.kind === 'forget' ? 'Forget this one' : 'Remove'}
            </button>
          </div>
          {asking.kind === 'forget' && label && (
            <button className="link-btn danger-link api-change-forget-all" onClick={() => onConfirm(true)} disabled={busy}>
              Forget every change {label} made
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}
