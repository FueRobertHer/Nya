'use client';

// Bring your own sync (lib/connectors/): connecting a SimpleFIN account the
// person pays for themselves, choosing which of its accounts Nya tracks, and
// letting them go. Two parts, each mounted once by the dashboard:
//
//   ConnectorSheet  the drawer for every step: pasting a Setup Token (the
//                   first time, or again when SimpleFIN no longer accepts
//                   Nya's access), choosing accounts and what kind each is,
//                   a Refresh, and disconnecting (keeping the accounts as
//                   manual ones, or removing them). Opened by an "ask" the
//                   dashboard holds: from the connect buttons, the card
//                   below, or a connection health row.
//   ConnectorCards  on the Accounts tab, one card per connection: where it
//                   reaches, when it last answered, what it reported in its
//                   own words, how much older history has come, how many of
//                   the day's requests are left, and its buttons.
//
// Only when the person chooses it: nothing here runs, or asks SimpleFIN
// anything, until they open it. The words say what SimpleFIN is, that the
// person pays it (not Nya), that a Setup Token works once, and what Nya keeps.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { formatMoney } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import type { ConnectionView, OfferView, AccountView } from '@/lib/connectors/view';

/** What the dashboard asks of the sheet. */
export type ConnectorAsk =
  | { kind: 'connect' }
  | { kind: 'token'; connection_id: string }
  | { kind: 'accounts'; connection_id: string }
  | { kind: 'refresh'; connection_id: string }
  | { kind: 'disconnect'; connection_id: string };

type Kind = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

/** What each account can be said to be: SimpleFIN doesn't say. */
export const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'depository', label: 'Checking or savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'investment', label: 'Investment (brokerage, IRA, 401k)' },
  { value: 'other', label: 'Other' },
];

/**
 * A first guess at what an account is, from its name and the sign of the
 * balance SimpleFIN reports (negative is owed), for the person to check: the
 * choice is shown as a guess, never kept unless they keep it.
 */
export function guessKind(name: string, balance?: number): Kind {
  const n = name.toLowerCase();
  if (/\b(visa|mastercard|master card|amex|american express|discover|credit|card)\b/.test(n)) return 'credit';
  if (/\b(mortgage|loan|heloc|auto|student|line of credit)\b/.test(n)) return 'loan';
  if (/\b(brokerage|ira|roth|401\s?\(?k\)?|403\s?\(?b\)?|hsa|invest\w*|stocks?|retirement|pension)\b/.test(n)) return 'investment';
  if (balance !== undefined && balance < 0) return 'credit';
  return 'depository';
}

type ListBody = {
  connections: ConnectionView[];
  orphaned: { connection_id: string; accounts: AccountView[] }[];
  requests: { left: number; resets_in_seconds: number; limit: number } | null;
  max_connections: number;
};

/** A request to a connector route: its body, or the error it answered with. */
async function send(path: string, method: string, body?: unknown): Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error ?? 'Something went wrong. Try again.', status: res.status };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Could not reach the server.', status: 0 };
  }
}

const dayOf = (iso: string | null | undefined) => (iso ? (instantDay(iso) ?? iso.slice(0, 10)) : null);
/** "Sep 12" from a YYYY-MM-DD, at local midnight. */
const calendarDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// ---- The card on the Accounts tab ----

/** One connection's card, from what the list route sent. Pure. */
export function ConnectorCardView({
  conn,
  requests,
  busy,
  note,
  onAsk,
  onRefresh,
}: {
  conn: ConnectionView;
  requests: ListBody['requests'];
  busy: boolean;
  /** What the last Refresh came to, if one was made here. */
  note: string | null;
  onAsk: (ask: ConnectorAsk) => void;
  onRefresh: () => void;
}) {
  const f = conn.last_fetch;
  // A new token is what fixes access SimpleFIN refuses, or one Nya can't use.
  const refused = !!f && (f.kind === 'refused' || f.kind === 'credentials');
  const n = conn.accounts.length;
  return (
    <div className="card connector-card">
      <div className="inst-header">
        <div className="inst-name">
          {conn.label}
          <span className="manual-badge">Your own sync</span>
        </div>
      </div>
      <p className="panel-note connector-meta">
        {conn.host}
        {` · ${n} account${n === 1 ? '' : 's'} tracked`}
        {conn.last_answer_at ? ` · last answered ${dayOf(conn.last_answer_at)}` : ' · no answer yet'}
        {requests ? ` · ${requests.left} of ${requests.limit} requests left today` : ''}
      </p>
      {f && !f.ok && <p className="stale-note">{f.message}</p>}
      {f?.problems.map((p) => (
        <p className="stale-note" key={p.message}>
          {conn.label} reports: “{p.message}”{p.accounts ? ` (${p.accounts.join(', ')})` : ''}
        </p>
      ))}
      {f && f.missing.length > 0 && <p className="stale-note">Not in {conn.label}’s latest answer: {f.missing.join(', ')}.</p>}
      {f?.note && <p className="stale-note">{f.note}</p>}
      {conn.history && n > 0 && (
        <p className="panel-note">
          {conn.history.complete
            ? `Transactions from ${calendarDay(conn.history.from)}, as far back as ${conn.label} has them.`
            : `Transactions from ${calendarDay(conn.history.from)} so far: older ones arrive over the next few nights${conn.history.failed ? ` (the last try didn’t get an answer; Nya tries again)` : ''}.`}
        </p>
      )}
      {n === 0 && conn.available.length > 0 && <p className="panel-note">Choose which of the accounts {conn.label} offers to track.</p>}
      {note && <p className="status-note">{note}</p>}
      <div className="card-actions">
        {refused ? (
          <button onClick={() => onAsk({ kind: 'token', connection_id: conn.connection_id })} disabled={busy}>
            Connect again
          </button>
        ) : (
          <button className="secondary" onClick={onRefresh} disabled={busy || requests?.left === 0}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
        <button className="secondary" onClick={() => onAsk({ kind: 'accounts', connection_id: conn.connection_id })} disabled={busy}>
          Choose accounts
        </button>
        <button className="secondary" onClick={() => onAsk({ kind: 'disconnect', connection_id: conn.connection_id })} disabled={busy}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

/** The cards: one per connection, read when the tab shows and after each
 *  change (`refreshKey`). Nothing at all when there is no connection. */
export function ConnectorCards({ refreshKey, onAsk, onChanged }: { refreshKey: unknown; onAsk: (ask: ConnectorAsk) => void; onChanged: () => void }) {
  const [data, setData] = useState<ListBody | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await send('/api/connectors', 'GET');
    if (res.ok) {
      setData(res.data);
      setError('');
    } else setError(res.error);
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const refresh = useCallback(
    async (connection_id: string) => {
      setRefreshing(connection_id);
      const res = await send('/api/connectors/refresh', 'POST', { connection_id });
      setRefreshing(null);
      const f = res.ok ? (res.data.connection as ConnectionView | null)?.last_fetch : null;
      setNotes((n) => ({
        ...n,
        [connection_id]: !res.ok ? res.error : f && f.ok ? `Refreshed: ${f.added === 0 ? 'nothing new' : `${f.added} new transaction${f.added === 1 ? '' : 's'}`}.` : '',
      }));
      await load();
      if (res.ok) onChanged();
    },
    [load, onChanged]
  );

  if (error) return <div className="card"><div className="error">SimpleFIN connections couldn’t be loaded: {error}</div></div>;
  if (!data) return null;
  return (
    <>
      {data.connections.map((conn) => (
        <ConnectorCardView
          key={conn.connection_id}
          conn={conn}
          requests={data.requests}
          busy={refreshing === conn.connection_id}
          note={notes[conn.connection_id] || null}
          onAsk={onAsk}
          onRefresh={() => refresh(conn.connection_id)}
        />
      ))}
      {data.orphaned.map((o) => (
        <div className="card" key={o.connection_id}>
          <p className="stale-note">
            {o.accounts.map((a) => a.name).join(', ')} {o.accounts.length === 1 ? 'is' : 'are'} left from a SimpleFIN connection that is gone. Disconnect to keep{' '}
            {o.accounts.length === 1 ? 'it' : 'them'} as manual accounts or remove {o.accounts.length === 1 ? 'it' : 'them'}.
          </p>
          <div className="card-actions">
            <button className="secondary" onClick={() => onAsk({ kind: 'disconnect', connection_id: o.connection_id })}>
              Disconnect
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// ---- The sheet ----

/** What each account is to be: '' for not tracked, 'stop' for one tracked now. */
type Choice = Kind | '' | 'stop';

/** The accounts to choose from: those tracked now (with their kind, or
 *  "stop"), then those offered (not tracked, or a kind). Pure. */
export function ChooseView({
  label,
  tracked,
  offers,
  choices,
  keep,
  busy,
  guessed,
  onChoose,
  onKeep,
}: {
  label: string;
  tracked: AccountView[];
  offers: OfferView[];
  choices: Record<string, Choice>;
  keep: boolean;
  busy: boolean;
  /** The kinds shown were guessed: say so. */
  guessed: boolean;
  onChoose: (id: string, choice: Choice) => void;
  onKeep: (keep: boolean) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, OfferView[]>();
    for (const o of offers) by.set(o.institution, [...(by.get(o.institution) ?? []), o]);
    return [...by];
  }, [offers]);
  const stopping = tracked.filter((a) => choices[a.account_id] === 'stop').length;
  return (
    <>
      {tracked.length > 0 && (
        <section className="panel-section">
          <p className="section-label">Tracked</p>
          {tracked.map((a) => (
            <div className="peer-row" key={a.account_id}>
              <span>
                {a.name} · {a.institution_name}
                {a.balance !== null && <span className="type-tag">{formatMoney(a.balance, a.currency)}</span>}
              </span>
              <select value={choices[a.account_id] ?? a.type} disabled={busy} onChange={(e) => onChoose(a.account_id, e.target.value as Choice)} aria-label={`What ${a.name} is`}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
                <option value="stop">Stop tracking</option>
              </select>
            </div>
          ))}
        </section>
      )}
      {stopping > 0 && (
        <fieldset className="download-formats" disabled={busy}>
          <legend className="section-label">The {stopping === 1 ? 'account' : 'accounts'} you stop tracking</legend>
          <label className="download-format">
            <input type="radio" name="connector-keep" checked={keep} onChange={() => onKeep(true)} />
            <span>
              <span className="download-format-name">Keep as manual {stopping === 1 ? 'account' : 'accounts'}</span>
              <span className="download-format-note">Balance, transactions and history stay; you update {stopping === 1 ? 'it' : 'them'} by hand from now on.</span>
            </span>
          </label>
          <label className="download-format">
            <input type="radio" name="connector-keep" checked={!keep} onChange={() => onKeep(false)} />
            <span>
              <span className="download-format-name">Remove</span>
              <span className="download-format-note">{stopping === 1 ? 'It goes, with its' : 'They go, with their'} transactions. Past net-worth totals keep what {stopping === 1 ? 'it' : 'they'} held.</span>
            </span>
          </label>
        </fieldset>
      )}
      {groups.length > 0 && (
        <section className="panel-section">
          <p className="section-label">{tracked.length > 0 ? 'Not tracked' : `What ${label} offers`}</p>
          {guessed && <p className="panel-note">{label} doesn’t say what kind of account each is, so Nya guessed from its name and balance: check each one. A card or loan is shown as what you owe.</p>}
          {groups.map(([institution, list]) => (
            <div className="institution-group" key={institution}>
              <p className="institution-name">{institution}</p>
              {list.map((o) => (
                <div className="peer-row" key={o.remote_id}>
                  <span>
                    {o.name}
                    {o.balance !== undefined && o.currency && (
                      <span className="type-tag">
                        {formatMoney(o.balance, o.currency)}
                        {o.balance_at ? ` on ${dayOf(o.balance_at)}` : ''}
                      </span>
                    )}
                    {!o.currency && <span className="type-tag">In a currency Nya doesn’t know ({o.currency_text.slice(0, 40)}): can’t be tracked</span>}
                  </span>
                  <select value={choices[o.remote_id] ?? ''} disabled={busy || !o.currency} onChange={(e) => onChoose(o.remote_id, e.target.value as Choice)} aria-label={`Track ${o.name}`}>
                    <option value="">Not tracked</option>
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      {tracked.length === 0 && offers.length === 0 && <p className="empty-note">{label} listed no accounts. Add some in {label}, then refresh.</p>}
    </>
  );
}

/** The words of the first step: what SimpleFIN is and what connecting does. */
export function ConnectIntro({ again }: { again: boolean }) {
  return again ? (
    <p className="panel-note" style={{ marginTop: 0 }}>
      SimpleFIN no longer accepts the access Nya had. Create a new Setup Token for Nya in SimpleFIN Bridge and paste it here: the same accounts carry on, with their history.
    </p>
  ) : (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        SimpleFIN Bridge connects to your bank and lets apps you choose read your accounts, balances and transactions. You pay SimpleFIN for it ($15 a year), not Nya, and it reaches banks Plaid
        doesn’t. Redbark, for Australia and New Zealand, works the same way.
      </p>
      <p className="panel-note">
        In SimpleFIN Bridge, create a Setup Token for Nya and paste it below. A token works once: Nya exchanges it for read-only access to the accounts you shared there, keeps that
        access encrypted, and never sees your bank password. Nya asks SimpleFIN once a day, a few times at most.
      </p>
    </>
  );
}

type Step =
  | { kind: 'token'; connection_id: string | null }
  | { kind: 'choose'; connection_id: string; offers: OfferView[]; tracked: AccountView[]; label: string; note: string | null; guessed: boolean }
  | { kind: 'disconnect'; connection_id: string; label: string; accounts: AccountView[] }
  | { kind: 'working'; text: string }
  | { kind: 'done'; text: string };

/** Each offer's guessed kind, as the choices start. */
function guesses(offers: OfferView[]): Record<string, Choice> {
  return Object.fromEntries(offers.filter((o) => o.currency).map((o) => [o.remote_id, guessKind(o.name, o.balance)]));
}

export function ConnectorSheet({ ask, onClose, onChanged }: { ask: ConnectorAsk | null; onClose: () => void; onChanged: (tracked: boolean) => void }) {
  const [step, setStep] = useState<Step | null>(null);
  const [token, setToken] = useState('');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [keep, setKeep] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Read through a ref, so a new callback from the dashboard's render never
  // starts the ask over.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // The step shown: the last one while the drawer slides out, so it doesn't
  // empty on the way.
  const last = useRef<Step | null>(null);
  if (step) last.current = step;

  /** One connection, read afresh from the list. */
  const readOne = useCallback(async (connection_id: string): Promise<{ conn: ConnectionView | null; orphan: AccountView[] | null } | string> => {
    const res = await send('/api/connectors', 'GET');
    if (!res.ok) return res.error;
    const body = res.data as ListBody;
    const conn = body.connections.find((c) => c.connection_id === connection_id) ?? null;
    const orphan = body.orphaned.find((o) => o.connection_id === connection_id)?.accounts ?? null;
    return { conn, orphan };
  }, []);

  // Each ask starts its step.
  useEffect(() => {
    if (!ask) return;
    setError('');
    setToken('');
    setConfirm('');
    setKeep(true);
    setChoices({});
    if (ask.kind === 'connect') return setStep({ kind: 'token', connection_id: null });
    if (ask.kind === 'token') return setStep({ kind: 'token', connection_id: ask.connection_id });
    let cancelled = false;
    (async () => {
      if (ask.kind === 'refresh') {
        setStep({ kind: 'working', text: 'Asking SimpleFIN…' });
        const res = await send('/api/connectors/refresh', 'POST', { connection_id: ask.connection_id });
        if (cancelled) return;
        const f = res.ok ? (res.data.connection as ConnectionView | null)?.last_fetch : null;
        setStep({ kind: 'done', text: !res.ok ? res.error : f?.ok ? `SimpleFIN answered: ${f.added === 0 ? 'nothing new' : `${f.added} new transaction${f.added === 1 ? '' : 's'}`}.` : f?.message ?? 'SimpleFIN didn’t answer.' });
        if (res.ok) changed.current(false);
        return;
      }
      setStep({ kind: 'working', text: 'Loading…' });
      const read = await readOne(ask.connection_id);
      if (cancelled) return;
      if (typeof read === 'string') return setStep({ kind: 'done', text: read });
      const { conn, orphan } = read;
      if (ask.kind === 'disconnect') {
        return setStep({ kind: 'disconnect', connection_id: ask.connection_id, label: conn?.label ?? 'SimpleFIN', accounts: conn?.accounts ?? orphan ?? [] });
      }
      if (!conn) return setStep({ kind: 'done', text: 'That connection no longer exists.' });
      setStep({ kind: 'choose', connection_id: conn.connection_id, offers: conn.available, tracked: conn.accounts, label: conn.label, note: null, guessed: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [ask, readOne]);

  const close = () => {
    if (busy) return;
    setStep(null);
    onClose();
  };

  const submitToken = async (connection_id: string | null) => {
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/connect', 'POST', { connector: 'simplefin', token, ...(connection_id ? { connection_id } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setToken('');
    const conn = res.data.connection as ConnectionView | null;
    const f = conn?.last_fetch;
    const listed = f && !f.ok ? `Connected, but SimpleFIN didn’t list the accounts: ${f.message} Try again with Refresh on its card.` : null;
    if (connection_id) {
      onChanged(false);
      return setStep({ kind: 'done', text: listed ?? 'Connected again. Your accounts carry on with their history.' });
    }
    onChanged(false);
    const offers = res.data.offers as OfferView[];
    if (listed || offers.length === 0) return setStep({ kind: 'done', text: listed ?? 'Connected, but SimpleFIN listed no accounts. Add some in SimpleFIN Bridge, then choose them here.' });
    setChoices(guesses(offers));
    setStep({ kind: 'choose', connection_id: res.data.connection_id, offers, tracked: [], label: conn?.label ?? 'SimpleFIN', note: null, guessed: true });
  };

  const submitChoices = async (s: Extract<Step, { kind: 'choose' }>) => {
    const track = s.offers.flatMap((o) => (choices[o.remote_id] && choices[o.remote_id] !== 'stop' ? [{ remote_id: o.remote_id, type: choices[o.remote_id] }] : []));
    const retype = s.tracked.flatMap((a) => {
      const c = choices[a.account_id];
      return c && c !== 'stop' && c !== a.type ? [{ account_id: a.account_id, type: c }] : [];
    });
    const stop = s.tracked.filter((a) => choices[a.account_id] === 'stop').map((a) => a.account_id);
    if (track.length + retype.length + stop.length === 0) return close();
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/accounts', 'PUT', {
      connection_id: s.connection_id,
      ...(track.length ? { track } : {}),
      ...(retype.length ? { retype } : {}),
      ...(stop.length ? { stop: { account_ids: stop, keep } } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(track.length > 0 || stop.length > 0 || retype.length > 0);
    const parts: string[] = [];
    if (track.length) parts.push(`Tracking ${track.length} account${track.length === 1 ? '' : 's'}: the last 90 days are in, and older transactions arrive over the next few nights.`);
    if (res.data.skipped === 'budget') parts.push('Nya has used today’s requests to SimpleFIN, so their balances come with tomorrow’s update.');
    if (retype.length) parts.push(`Changed what ${retype.length === 1 ? 'one account is' : `${retype.length} accounts are`}.`);
    if (res.data.kept) parts.push(`Kept ${res.data.kept} as manual account${res.data.kept === 1 ? '' : 's'}.`);
    if (res.data.removed) parts.push(`Removed ${res.data.removed}.`);
    setStep({ kind: 'done', text: parts.join(' ') });
  };

  const submitDisconnect = async (s: Extract<Step, { kind: 'disconnect' }>) => {
    setBusy(true);
    setError('');
    const res = await send('/api/connectors', 'DELETE', { connection_id: s.connection_id, keep });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(true);
    setStep({
      kind: 'done',
      text: `Disconnected: Nya deleted its access and stops asking. ${keep ? `${res.data.kept} account${res.data.kept === 1 ? ' is' : 's are'} now manual.` : `${res.data.removed} account${res.data.removed === 1 ? '' : 's'} removed.`} SimpleFIN still lists Nya as an app until you remove it there.`,
    });
  };

  const view = step ?? last.current;
  const title =
    view?.kind === 'token'
      ? view.connection_id
        ? 'Connect SimpleFIN again'
        : 'Connect with SimpleFIN'
      : view?.kind === 'choose'
        ? 'Choose accounts'
        : view?.kind === 'disconnect'
          ? `Disconnect ${view.label}?`
          : 'SimpleFIN';

  return (
    <Sheet open={!!ask && !!step} title={title} onClose={close}>
      {view?.kind === 'token' && (
        <>
          <ConnectIntro again={!!view.connection_id} />
          <label className="field connector-token">
            Setup Token
            <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={4} disabled={busy} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => submitToken(view.connection_id)} disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </>
      )}
      {view?.kind === 'choose' && (
        <>
          <ChooseView
            label={view.label}
            tracked={view.tracked}
            offers={view.offers}
            choices={choices}
            keep={keep}
            busy={busy}
            guessed={view.guessed}
            onChoose={(id, c) => setChoices((all) => ({ ...all, [id]: c }))}
            onKeep={setKeep}
          />
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => submitChoices(view)} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
      {view?.kind === 'disconnect' && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Nya deletes the access {view.label} gave it and stops asking. What becomes of {view.accounts.length === 1 ? 'its account' : `its ${view.accounts.length} accounts`} is your choice.
          </p>
          <fieldset className="download-formats" disabled={busy}>
            <label className="download-format">
              <input type="radio" name="connector-disconnect" checked={keep} onChange={() => setKeep(true)} />
              <span>
                <span className="download-format-name">Keep them as manual accounts</span>
                <span className="download-format-note">Balances, transactions and history stay, and you update them by hand from now on.</span>
              </span>
            </label>
            <label className="download-format">
              <input type="radio" name="connector-disconnect" checked={!keep} onChange={() => setKeep(false)} />
              <span>
                <span className="download-format-name">Remove them</span>
                <span className="download-format-note">They go, with their transactions. Past net-worth totals keep what they held, as for any bank you disconnect.</span>
              </span>
            </label>
          </fieldset>
          <p className="panel-note">
            Type <strong>{view.label}</strong> to confirm. To end its access on {view.label}’s side too, remove Nya in your {view.label} account.
          </p>
          <label className="field">
            Name
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={view.label} disabled={busy} autoCapitalize="off" autoCorrect="off" />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="danger" onClick={() => submitDisconnect(view)} disabled={busy || confirm.trim().toLowerCase() !== view.label.toLowerCase()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </>
      )}
      {view?.kind === 'working' && <div className="spinner" role="status" aria-label={view.text} />}
      {view?.kind === 'done' && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {view.text}
          </p>
          <button onClick={close}>Done</button>
        </>
      )}
    </Sheet>
  );
}
