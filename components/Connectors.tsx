'use client';

// Bring your own sync (lib/connectors/): connecting a SimpleFIN account, or a
// Lunch Flow account by its API key, that the person pays for themselves,
// choosing which of its accounts Nya tracks, and letting them go. Two parts,
// each mounted once by the dashboard:
//
//   ConnectorSheet  the drawer for every step: pasting a Setup Token or an
//                   API key (the first time, or again when the service no
//                   longer accepts Nya's access), choosing accounts and
//                   what kind each is, saying how to read a card's or a
//                   loan's positive balance,
//                   a Refresh, and disconnecting (keeping the accounts as
//                   manual ones, or removing them). Opened by an "ask" the
//                   dashboard holds: from the connect buttons, the card
//                   below, or a connection health row.
//   ConnectorCards  on the Accounts tab, one card per connection: where it
//                   reaches, when it last answered, what it reported in its
//                   own words, how much older history has come, how many of
//                   the day's requests are left, and its buttons.
//
// Only when the person chooses it: nothing here runs, or asks a service
// anything, until they open it. The words say what each service is, that the
// person pays it (not Nya), what it doesn't bring, that a Setup Token works
// once (a Lunch Flow key is checked once, and kept), and what Nya keeps. A
// balance a service reports is shown with its sign in words ("owed",
// "held"), never as what is owed before that is known.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { formatMoney } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import type { ConnectionView, FetchView, OfferView, AccountView } from '@/lib/connectors/view';
import type { OwedSign } from '@/lib/connectors/store';
import { CONNECTOR_WORDS, type ConnectorKind } from '@/lib/connectors/types';
import type { CarryView } from '@/lib/connectors/continue';

/** What the dashboard asks of the sheet: `connector` is which service a new
 *  connection (or a new token or key for one) is for. */
export type ConnectorAsk =
  | { kind: 'connect'; connector?: ConnectorKind }
  | { kind: 'token'; connection_id: string; connector?: ConnectorKind }
  | { kind: 'accounts'; connection_id: string }
  | { kind: 'refresh'; connection_id: string }
  | { kind: 'sign'; connection_id: string }
  | { kind: 'disconnect'; connection_id: string }
  | { kind: 'uncarry'; connection_id: string; account_id: string };

type Kind = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

/** What each account can be said to be: neither SimpleFIN nor Lunch Flow says. */
export const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'depository', label: 'Checking or savings' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'investment', label: 'Investment (brokerage, IRA, 401k)' },
  { value: 'other', label: 'Other' },
];

/**
 * A first guess at what an account is, from its name and the sign of the
 * balance the service reports (negative is owed), for the person to check: the
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
  orphaned: { connection_id: string; connector?: ConnectorKind; accounts: AccountView[] }[];
  requests: { left: number; resets_in_seconds: number; limit: number } | null;
  max_connections: number;
  /** Banks from a download counted before a link (app/api/connectors). */
  restored_counted?: string[];
  /** Carrying on an account a download brought back (lib/connectors/
   *  continue.ts CarryView). */
  carry_on?: CarryView;
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

/** A balance as its service reported it, its sign said in words: "-$432.10,
 *  owed" or "+$500.00, held". Never "what you owe" before that is known. */
export function reportedWords(balance: number, currency: string): string {
  if (balance < 0) return `${formatMoney(balance, currency)}, owed`;
  return `${balance > 0 ? '+' : ''}${formatMoney(balance, currency)}, held`;
}

const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** A request that brought nothing this time (ProblemKind `retry`), on the
 *  card: what didn't come, and that Nya asks again. */
export const retryLine = (message: string) => `${message.replace(/[.\s]+$/, '')}. Nya asks again at its next update.`;

/** When older history arrives: SimpleFIN's a window a night, Lunch Flow's
 *  in one more request with the next daily update. */
const olderWhen = (connector: ConnectorKind) => (connector === 'lunchflow' ? 'with its next daily update' : 'over the next few nights');

/** What Refresh came to, in words, when an answer came. Not everything it
 *  asked about may have come: then the card says what didn't. */
export function refreshedWords(by: string, f: Pick<FetchView, 'added' | 'problems' | 'missing'>): string {
  const brought = f.added === 0 ? 'nothing new' : `${f.added} new transaction${f.added === 1 ? '' : 's'}`;
  const short = f.problems.length > 0 || f.missing.length > 0;
  return short ? `${by} answered, but not everything came (its card says what): ${brought} so far.` : `${by} answered: ${brought}.`;
}

/** When the day's requests for your own sync come back, in words (" in about 5
 *  hours"), or "" when that isn't known. */
export function backIn(requests: { resets_in_seconds: number } | null | undefined): string {
  if (!requests || !(requests.resets_in_seconds > 0)) return '';
  const hours = Math.max(1, Math.ceil(requests.resets_in_seconds / 3600));
  return ` in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** What keeping accounts left out, in words: those no answer ever held a
 *  balance for had nothing to keep, and went. */
export function nothingToKeep(list: string[] | undefined): string {
  if (!list || list.length === 0) return '';
  const one = list.length === 1;
  return ` Removed ${names(list)}: no balance had come for ${one ? 'it' : 'them'} yet, so there was nothing to keep.`;
}
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
  // A new token (or key) is what fixes access the service refuses, or one Nya can't use.
  const refused = !!f && (f.kind === 'refused' || f.kind === 'credentials');
  const n = conn.accounts.length;
  const unsure = conn.accounts.filter((a) => a.needs_sign);
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
          {/* A request that brought nothing this time (its words name the account) clears when Nya asks again: never something to fix at the connector. */}
          {p.retry ? retryLine(p.message) : `${conn.label} reports: “${p.message}”${p.accounts ? ` (${p.accounts.join(', ')})` : ''}`}
        </p>
      ))}
      {f && f.missing.length > 0 && <p className="stale-note">Not in {conn.label}’s latest answer: {f.missing.join(', ')}.</p>}
      {unsure.length > 0 && (
        <p className="stale-note">
          {conn.label} reports <Masked>{names(unsure.map((a) => `${a.name} (+${formatMoney(a.reported ?? 0, a.currency)})`))}</Masked> as money held. Say which way{' '}
          {unsure.length === 1 ? 'it goes: until you do, it isn’t' : 'they go: until you do, they aren’t'} counted.
        </p>
      )}
      {f?.note && <p className="stale-note">{f.note}</p>}
      {conn.history && n > 0 && (
        <p className="panel-note">
          {/* The day history was asked from, never the oldest row: the service may hold fewer days than were asked. */}
          {conn.history.complete
            ? `Everything ${conn.label} has from ${calendarDay(conn.history.from)} on is in.`
            : `Everything ${conn.label} has from ${calendarDay(conn.history.from)} on is in, and older transactions arrive ${olderWhen(conn.connector)}${conn.history.failed ? ` (the last try didn’t get an answer; Nya tries again)` : ''}.`}
        </p>
      )}
      {n === 0 && conn.available.length > 0 && <p className="panel-note">Choose which of the accounts {conn.label} offers to track.</p>}
      {conn.accounts.flatMap((a) => {
        const line = carriedLine(a, conn.label);
        return line
          ? [
              <div key={`carried-${a.account_id}`}>
                <p className={line.warn ? 'stale-note' : 'panel-note'}>{line.text}</p>
                <button className="secondary" onClick={() => onAsk({ kind: 'uncarry', connection_id: conn.connection_id, account_id: a.account_id })} disabled={busy}>
                  Undo carrying {a.name} on
                </button>
              </div>,
            ]
          : [];
      })}
      {note && <p className="status-note">{note}</p>}
      <div className="card-actions">
        {refused ? (
          <button onClick={() => onAsk({ kind: 'token', connection_id: conn.connection_id, connector: conn.connector })} disabled={busy}>
            Connect again
          </button>
        ) : (
          <button className="secondary" onClick={onRefresh} disabled={busy || requests?.left === 0}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
        {unsure.length > 0 && (
          <button onClick={() => onAsk({ kind: 'sign', connection_id: conn.connection_id })} disabled={busy}>
            Answer
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

  if (error) return <div className="card"><div className="error">Your own sync’s connections couldn’t be loaded: {error}</div></div>;
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
            {o.accounts.map((a) => a.name).join(', ')} {o.accounts.length === 1 ? 'is' : 'are'} left from a connection that is gone. Disconnect to keep{' '}
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
  counted = [],
  carry = null,
  continues = {},
  onContinue = () => {},
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
  /** Banks from a download counted before a link: an account tracked here
   *  holds them until it is answered for (lib/user-restore/answers.ts). */
  counted?: readonly string[];
  /** The accounts from a download that wait to be carried on, and which of
   *  them each offer may be (lib/connectors/continue.ts), or null. */
  carry?: { enabled: boolean; waiting: CarryView['waiting']; offers: Record<string, { account_id: string; evidence: 'same' | 'likely' | 'possible' }[]> } | null;
  /** The answer for each offer chosen: '' none yet, 'new', or the id of the
   *  account from the download it carries on. */
  continues?: Record<string, string>;
  onContinue?: (remote_id: string, value: string) => void;
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
              <div>
                {a.name} · {a.institution_name}
                {a.reported !== null && <div className="type-tag"><Masked>{reportedWords(a.reported, a.currency)}</Masked></div>}
              </div>
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
      {stopping > 0 && <EndedPointer count={stopping} />}
      {groups.length > 0 && (
        <section className="panel-section">
          <p className="section-label">{tracked.length > 0 ? 'Not tracked' : `What ${label} offers`}</p>
          {guessed && (
            <p className="panel-note">
              {label} doesn’t say what kind of account each is, so Nya guessed from its name and balance: check each one. Each balance is as {label} reports it,
              owed or held.
            </p>
          )}
          {counted.length > 0 && <p className="panel-note">{countedNote(counted)}</p>}
          {carry && carry.waiting.length > 0 && <p className="panel-note">{carryNote(carry)}</p>}
          {groups.map(([institution, list]) => (
            <div className="institution-group" key={institution}>
              <p className="institution-name">{institution}</p>
              {list.map((o) => (
                <div className="peer-row" key={o.remote_id}>
                  <div>
                    {o.name}
                    {o.balance !== undefined && o.currency && (
                      <div className="type-tag">
                        <Masked>{reportedWords(o.balance, o.currency)}</Masked>
                        {o.balance_at ? ` on ${dayOf(o.balance_at)}` : ''}
                      </div>
                    )}
                    {!o.currency && <div className="type-tag">In a currency Nya doesn’t know ({o.currency_text.slice(0, 40)}): can’t be tracked</div>}
                    {o.elsewhere?.certain && <div className="type-tag">Tracked through your other connection ({o.elsewhere.host}): not tracked twice</div>}
                    {o.elsewhere && !o.elsewhere.certain && (
                      <div className="type-tag">
                        Looks like the account your other connection ({o.elsewhere.host}) tracks: the same bank, name and balance. Tracked twice it would be counted twice, so
                        choose a kind only if it is another account.
                      </div>
                    )}
                    {carry?.enabled && carry.waiting.length > 0 && choices[o.remote_id] && choices[o.remote_id] !== 'stop' && (
                      <select value={continues[o.remote_id] ?? ''} disabled={busy} onChange={(e) => onContinue(o.remote_id, e.target.value)} aria-label={`Is ${o.name} one of the accounts from your download?`}>
                        <option value="">Is it one from your download?</option>
                        <option value="new">No: a new account</option>
                        {(carry.offers[o.remote_id] ?? []).map((f) => {
                          const w = carry.waiting.find((x) => x.account_id === f.account_id)!;
                          return (
                            <option key={f.account_id} value={f.account_id}>
                              {carryChoiceWords(w, f.evidence)}
                            </option>
                          );
                        })}
                      </select>
                    )}
                  </div>
                  <select
                    value={choices[o.remote_id] ?? ''}
                    disabled={busy || !o.currency || !!o.elsewhere?.certain}
                    onChange={(e) => onChoose(o.remote_id, e.target.value as Choice)}
                    aria-label={`Track ${o.name}`}
                  >
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

/** An account from a download, as the question offers it: its bank, name and
 *  currency, its last day there, and how likely it is this one. Pure. */
export function carryChoiceWords(w: CarryView['waiting'][number], evidence: 'same' | 'likely' | 'possible'): string {
  const last = w.last ? `, last transaction ${calendarDay(w.last)}` : '';
  const how = evidence === 'same' ? ' (the same account)' : evidence === 'likely' ? ' (likely)' : '';
  return `Yes: ${w.institution_name} ${w.name}, ${w.currency}${last}${how}`;
}

/** What Choose accounts says while accounts from a download wait to be
 *  carried on: with carrying on turned on, that each account tracked is
 *  asked about; off, that tracking makes a new account whose transactions
 *  count beside theirs. Pure. */
export function carryNote(carry: { enabled: boolean; waiting: CarryView['waiting'] }): string {
  const names = carry.waiting.map((w) => `${w.institution_name} ${w.name}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return carry.enabled
    ? `Your download brought back ${list}, waiting for ${names.length === 1 ? 'its' : 'their'} connection. Say for each account you track whether it is one of them: carried on, it keeps that account’s history, and the transactions from your download aren’t counted twice.`
    : `Your download brought back ${list}, waiting for ${names.length === 1 ? 'its' : 'their'} connection. An account you track here is a new one: if it is one of them, its transactions count beside the ones from your download where both have them.`;
}

/** A carried-on account on its connection's card: what it carries on, and
 *  what the first answers found, plainly when none matched. Pure. */
export function carriedLine(a: AccountView, label: string): { text: string; warn: boolean } | null {
  const c = a.continued;
  if (!c) return null;
  const what = `${a.name} carries on ${c.from.institution_name} ${c.from.name} from your download`;
  const sent = c.matched + c.added;
  if (c.until && sent > 0 && c.matched === 0) {
    return { text: `None of the ${sent} transactions ${label} sent from before ${calendarDay(c.until)} are in your download: if ${a.name} isn’t the same account, undo carrying it on.`, warn: true };
  }
  if (c.until && sent > 0) {
    return { text: `${what}: ${c.matched} of the ${sent} transactions ${label} sent from before ${calendarDay(c.until)} were in it${c.added > 0 ? `, and ${c.added} more were added` : ''}.`, warn: false };
  }
  return { text: `${what}: its transactions are matched to those from your download as ${label} sends them.`, warn: false };
}

/** What undoing carrying an account on does, said before it is confirmed
 *  (lib/connectors/continue.ts UNDO). Pure. */
export function uncarryWords(a: AccountView, label: string): string {
  const c = a.continued!;
  const added = ` The transactions ${label} added since go, with what you said about them: download your data first to keep a copy.`;
  return `${c.from.institution_name} ${c.from.name} goes back as your download brought it, waiting for its connection, and its transactions get back what they were. ${a.name} is offered to track again.${added} Balances recorded meanwhile stay as they were: the account’s own line holds ${a.name}’s on those days.`;
}

/** What tracking an account costs while banks from a download count before
 *  a link (lib/user-restore/answers.ts THE HOLD BY CONNECTION): until you say
 *  whether it is one of them, their transactions from the download aren't
 *  counted. Pure. */
export function countedNote(banks: readonly string[]): string {
  const names = banks.length === 1 ? banks[0] : `${banks.slice(0, -1).join(', ')} and ${banks[banks.length - 1]}`;
  return `An account you track here could be one of the banks from your download (${names}): until you say whether it is, under Manage, Bring back a download, their transactions from your download aren’t counted.`;
}

/**
 * What Nya keeps of an account let go, kept or removed (connector-ended,
 * lib/connectors/manage.ts releaseAccounts), and where to forget it: the list
 * on the Reports page, opened by the link (`?stopped`). Said where accounts
 * are let go, so the record a report reads later is no surprise. Pure.
 */
export function EndedPointer({ count }: { count: number }) {
  const one = count === 1;
  return (
    <p className="panel-note">
      Either way, Nya keeps {one ? 'its' : 'each one’s'} name, bank and the day you let {one ? 'it' : 'them'} go, so a report on a period {one ? 'it was' : 'they were'} tracked in
      can say what may be missing. To forget {one ? 'it' : 'one'}, open <a href="/reports?stopped=1">Accounts you stopped tracking</a> on the Reports page.
    </p>
  );
}

/** Where the person pastes what connects the service, named for it. A key is
 *  a secret that stays the same, so it is typed out of sight; a token is
 *  long, and spent once claimed, so it is shown. */
export function CredentialField({ connector, value, busy, onChange }: { connector: ConnectorKind; value: string; busy: boolean; onChange: (value: string) => void }) {
  return (
    <label className="field connector-token">
      {CONNECTOR_WORDS[connector].credential}
      {connector === 'lunchflow' ? (
        <input type="password" value={value} onChange={(e) => onChange(e.target.value)} disabled={busy} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      ) : (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4} disabled={busy} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      )}
    </label>
  );
}

/** The words of the first step: what the service is and what connecting does. */
export function ConnectIntro({ again, connector = 'simplefin' }: { again: boolean; connector?: ConnectorKind }) {
  if (connector === 'lunchflow') return <LunchFlowIntro again={again} />;
  return again ? (
    <p className="panel-note" style={{ marginTop: 0 }}>
      SimpleFIN no longer accepts the access Nya had. Create a new Setup Token for Nya in SimpleFIN Bridge and paste it here: the same accounts carry on, with their history.
    </p>
  ) : (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        SimpleFIN Bridge connects to your banks and lets apps you choose read your accounts, balances and transactions. You pay SimpleFIN for it ($15 a year), not Nya, and it may
        reach banks Plaid doesn’t. Another server that speaks its protocol works too, such as Redbark for Australia and New Zealand: a separate service, with its own price.
      </p>
      <p className="panel-note">
        It brings no pending transactions, no holdings for investment accounts (only their balances) and no categories, and it updates about once a day.
      </p>
      <p className="panel-note">
        In SimpleFIN Bridge, create a Setup Token for Nya and paste it below. A token works once: Nya exchanges it for read-only access to the accounts you shared there, keeps that
        access encrypted, and never sees your bank password. Nya asks SimpleFIN about once a day, and never more than a few times a day.
      </p>
    </>
  );
}

/** Lunch Flow's words for the first step (lib/connectors/lunchflow.ts). */
export function LunchFlowIntro({ again }: { again: boolean }) {
  return again ? (
    <p className="panel-note" style={{ marginTop: 0 }}>
      Lunch Flow no longer accepts the API key Nya had, or Nya can’t use it. In Lunch Flow, copy the API key of your API destination (or add a new API destination) and paste it here:
      the same accounts carry on, with their history.
    </p>
  ) : (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Lunch Flow connects to banks in many countries, through providers such as GoCardless, Akahu and MX, and lets apps you choose read your accounts, balances and transactions.
        You pay Lunch Flow for it (about $35 a year for two bank connections when this was written), not Nya, and it may reach banks Plaid doesn’t.
      </p>
      <p className="panel-note">
        It brings no pending transactions, no holdings for investment accounts (only their balances) and no categories, and it updates from your banks about once a day. Lunch Flow
        gives no date with a balance, so each one shows the day Nya received it.
      </p>
      <p className="panel-note">
        In Lunch Flow, add an API destination and paste its API key below. Nya checks the key with Lunch Flow once, keeps it encrypted, never shows it again, and never sees your bank
        password. Nya asks Lunch Flow about once a day, and never more than a few times a day. Deleting that destination in Lunch Flow ends Nya’s access there.
      </p>
    </>
  );
}

type Step =
  | { kind: 'token'; connection_id: string | null; connector: ConnectorKind }
  | { kind: 'choose'; connection_id: string; connector: ConnectorKind; offers: OfferView[]; tracked: AccountView[]; label: string; note: string | null; guessed: boolean }
  | { kind: 'disconnect'; connection_id: string; connector: ConnectorKind | null; label: string; accounts: AccountView[] }
  | { kind: 'sign'; connection_id: string; label: string; accounts: AccountView[]; lead: string | null }
  | { kind: 'uncarry'; connection_id: string; account: AccountView; label: string }
  | { kind: 'working'; text: string }
  | { kind: 'done'; text: string };

/** Whether an offer chosen still waits for the answer to whether it is an
 *  account from a download (lib/connectors/continue.ts). */
function unanswered(s: Extract<Step, { kind: 'choose' }>, choices: Record<string, Choice>, carry: CarryView | null, continues: Record<string, string>): boolean {
  if (!carry?.enabled || carry.waiting.length === 0) return false;
  return s.offers.some((o) => choices[o.remote_id] && choices[o.remote_id] !== 'stop' && !continues[o.remote_id]);
}

/** The tracked accounts being stopped whose sign waits for an answer: kept,
 *  they need it first (lib/connectors/manage.ts releaseAccounts). */
function stoppingUnsure(s: Extract<Step, { kind: 'choose' }>, choices: Record<string, Choice>): AccountView[] {
  return s.tracked.filter((a) => a.needs_sign && choices[a.account_id] === 'stop');
}

/** The sign step for a connection, when an account of it needs one: what
 *  was done just before (`lead`) said first. */
function signStep(conn: ConnectionView | null, lead: string | null): Step | null {
  const accounts = conn?.accounts.filter((a) => a.needs_sign) ?? [];
  return conn && accounts.length > 0 ? { kind: 'sign', connection_id: conn.connection_id, label: conn.label, accounts, lead } : null;
}

/** The question for each card or loan its service reports as money held. Pure. */
export function SignView({
  label,
  accounts,
  signs,
  busy,
  onSign,
}: {
  label: string;
  accounts: AccountView[];
  signs: Record<string, OwedSign>;
  busy: boolean;
  onSign: (account_id: string, sign: OwedSign) => void;
}) {
  return (
    <>
      <p className="panel-note">
        {label}’s usual way is to report what you owe as a negative balance, so a card or loan with a positive one is either money held (a card paid past zero) or a server that
        reports what you owe as positive. Say which, once for each: until you do, it isn’t counted.
        {label === CONNECTOR_WORDS.lunchflow.label &&
          ' Some banks give Lunch Flow a card’s credit left to spend in place of its balance: if that is the figure here, neither answer is right, so stop tracking the card with Choose accounts.'}
      </p>
      {accounts.map((a) => {
        const amount = formatMoney(Math.abs(a.reported ?? 0), a.currency);
        return (
          <fieldset className="download-formats" disabled={busy} key={a.account_id}>
            <legend className="section-label">
              {a.name} · {a.institution_name}: <Masked>{reportedWords(a.reported ?? 0, a.currency)}</Masked>
            </legend>
            <label className="download-format">
              <input type="radio" name={`connector-sign-${a.account_id}`} checked={signs[a.account_id] === 'owed_positive'} onChange={() => onSign(a.account_id, 'owed_positive')} />
              <span>
                <span className="download-format-name">I owe <Masked>{amount}</Masked></span>
                <span className="download-format-note">{label} reports what you owe on it as positive: Nya counts it as a debt, from now on.</span>
              </span>
            </label>
            <label className="download-format">
              <input type="radio" name={`connector-sign-${a.account_id}`} checked={signs[a.account_id] === 'as_reported'} onChange={() => onSign(a.account_id, 'as_reported')} />
              <span>
                <span className="download-format-name">It’s money held, <Masked>{amount}</Masked></span>
                <span className="download-format-note">A credit, as on a card paid past zero: Nya counts it as yours.</span>
              </span>
            </label>
          </fieldset>
        );
      })}
    </>
  );
}

/** Where the person ends Nya's access on the service's side, which Nya can't
 *  do for them: said once disconnected, and before. */
export function endsThere(connector: ConnectorKind | null): string {
  if (connector === 'lunchflow') return 'Its API key still works at Lunch Flow until you delete that API destination there.';
  return 'SimpleFIN still lists Nya as an app until you remove it there.';
}

/** The same, as the disconnect sheet says it before the person confirms. */
function endsAt(connector: ConnectorKind | null, label: string): string {
  if (connector === 'lunchflow') return 'To end its access on Lunch Flow’s side too, delete its API destination in Lunch Flow.';
  return `To end its access on ${label}’s side too, remove Nya in your ${label} account.`;
}

/** Each offer's guessed kind, as the choices start. */
function guesses(offers: OfferView[]): Record<string, Choice> {
  return Object.fromEntries(offers.filter((o) => o.currency && !o.elsewhere).map((o) => [o.remote_id, guessKind(o.name, o.balance)]));
}

export function ConnectorSheet({ ask, onClose, onChanged }: { ask: ConnectorAsk | null; onClose: () => void; onChanged: (tracked: boolean) => void }) {
  const [step, setStep] = useState<Step | null>(null);
  const [token, setToken] = useState('');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  /** Banks from a download counted before a link (ListBody), for the words
   *  in Choose accounts. */
  const [counted, setCounted] = useState<string[]>([]);
  /** Carrying on an account from a download (ListBody `carry_on`), and the
   *  answer for each offer chosen. */
  const [carry, setCarry] = useState<CarryView | null>(null);
  const [continues, setContinues] = useState<Record<string, string>>({});
  const [signs, setSigns] = useState<Record<string, OwedSign>>({});
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
  const readOne = useCallback(async (connection_id: string): Promise<{ conn: ConnectionView | null; orphan: AccountView[] | null; orphanOf: ConnectorKind | null } | string> => {
    const res = await send('/api/connectors', 'GET');
    if (!res.ok) return res.error;
    const body = res.data as ListBody;
    setCounted(body.restored_counted ?? []);
    setCarry(body.carry_on ?? null);
    const conn = body.connections.find((c) => c.connection_id === connection_id) ?? null;
    const left = body.orphaned.find((o) => o.connection_id === connection_id);
    return { conn, orphan: left?.accounts ?? null, orphanOf: left?.connector ?? null };
  }, []);

  // Each ask starts its step.
  useEffect(() => {
    if (!ask) return;
    setError('');
    setToken('');
    setConfirm('');
    setKeep(true);
    setChoices({});
    setSigns({});
    setContinues({});
    if (ask.kind === 'connect') return setStep({ kind: 'token', connection_id: null, connector: ask.connector ?? 'simplefin' });
    if (ask.kind === 'token') return setStep({ kind: 'token', connection_id: ask.connection_id, connector: ask.connector ?? 'simplefin' });
    let cancelled = false;
    (async () => {
      if (ask.kind === 'refresh') {
        setStep({ kind: 'working', text: 'Asking…' });
        const res = await send('/api/connectors/refresh', 'POST', { connection_id: ask.connection_id });
        if (cancelled) return;
        const conn = res.ok ? (res.data.connection as ConnectionView | null) : null;
        const f = conn?.last_fetch;
        const by = conn?.label ?? 'It';
        setStep({ kind: 'done', text: !res.ok ? res.error : f?.ok ? refreshedWords(by, f) : f?.message ?? `${by} didn’t answer.` });
        if (res.ok) changed.current(false);
        return;
      }
      setStep({ kind: 'working', text: 'Loading…' });
      const read = await readOne(ask.connection_id);
      if (cancelled) return;
      if (typeof read === 'string') return setStep({ kind: 'done', text: read });
      const { conn, orphan, orphanOf } = read;
      if (ask.kind === 'disconnect') {
        const connector = conn?.connector ?? orphanOf;
        return setStep({ kind: 'disconnect', connection_id: ask.connection_id, connector, label: conn?.label ?? CONNECTOR_WORDS[connector ?? 'simplefin'].label, accounts: conn?.accounts ?? orphan ?? [] });
      }
      if (!conn) return setStep({ kind: 'done', text: 'That connection no longer exists.' });
      if (ask.kind === 'sign') return setStep(signStep(conn, null) ?? { kind: 'done', text: 'Nothing to answer: every balance is counted.' });
      if (ask.kind === 'uncarry') {
        const account = conn.accounts.find((a) => a.account_id === ask.account_id && a.continued);
        return setStep(account ? { kind: 'uncarry', connection_id: conn.connection_id, account, label: conn.label } : { kind: 'done', text: 'That account isn’t carried on from your download.' });
      }
      setStep({ kind: 'choose', connection_id: conn.connection_id, connector: conn.connector, offers: conn.available, tracked: conn.accounts, label: conn.label, note: null, guessed: false });
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

  const submitToken = async (s: Extract<Step, { kind: 'token' }>) => {
    const { connection_id, connector } = s;
    const label = CONNECTOR_WORDS[connector].label;
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/connect', 'POST', { connector, token, ...(connection_id ? { connection_id } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setToken('');
    const conn = res.data.connection as ConnectionView | null;
    const f = conn?.last_fetch;
    const listed = f && !f.ok ? `Connected, but ${label} didn’t list the accounts: ${f.message} Try again with Refresh on its card.` : null;
    // Spent requests mean no answer yet, never that the new token failed.
    const later =
      res.data.skipped === 'budget'
        ? ` Nya has used today’s requests for your own sync; more are available${backIn(res.data.requests)}, and Refresh on its card then brings your accounts up to date.`
        : '';
    if (connection_id) {
      onChanged(false);
      return setStep({ kind: 'done', text: listed ?? `Connected again. Your accounts carry on with their history.${later}` });
    }
    onChanged(false);
    const offers = res.data.offers as OfferView[];
    if (res.data.skipped === 'budget') {
      return setStep({
        kind: 'done',
        text: `Connected, but Nya has used today’s requests for your own sync, so it couldn’t list your accounts yet. More are available${backIn(res.data.requests)}: then Refresh on its card lists them to choose from.`,
      });
    }
    const where = connector === 'lunchflow' ? 'Lunch Flow' : 'SimpleFIN Bridge';
    if (listed || offers.length === 0) return setStep({ kind: 'done', text: listed ?? `Connected, but ${label} listed no accounts. Add some in ${where}, then choose them here.` });
    setChoices(guesses(offers));
    // What tracking one holds, read with the list (readOne), best effort.
    void readOne(res.data.connection_id);
    setStep({ kind: 'choose', connection_id: res.data.connection_id, connector, offers, tracked: [], label: conn?.label ?? label, note: null, guessed: true });
  };

  const submitChoices = async (s: Extract<Step, { kind: 'choose' }>) => {
    const asking = !!carry?.enabled && carry.waiting.length > 0;
    const track = s.offers.flatMap((o) =>
      choices[o.remote_id] && choices[o.remote_id] !== 'stop'
        ? [{ remote_id: o.remote_id, type: choices[o.remote_id], ...(asking ? { continues: continues[o.remote_id] === 'new' ? null : continues[o.remote_id] } : {}) }]
        : []
    );
    const retype = s.tracked.flatMap((a) => {
      const c = choices[a.account_id];
      return c && c !== 'stop' && c !== a.type ? [{ account_id: a.account_id, type: c }] : [];
    });
    const stop = s.tracked.filter((a) => choices[a.account_id] === 'stop').map((a) => a.account_id);
    if (track.length + retype.length + stop.length === 0) return close();
    // A card or loan kept while its sign waits needs its answer first (it comes in the same request).
    const sign = keep ? s.tracked.flatMap((a) => (choices[a.account_id] === 'stop' && a.needs_sign && signs[a.account_id] ? [{ account_id: a.account_id, sign: signs[a.account_id] }] : [])) : [];
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/accounts', 'PUT', {
      connection_id: s.connection_id,
      ...(track.length ? { track } : {}),
      ...(retype.length ? { retype } : {}),
      ...(sign.length ? { sign } : {}),
      ...(stop.length ? { stop: { account_ids: stop, keep } } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(track.length > 0 || stop.length > 0 || retype.length > 0);
    const parts: string[] = [];
    // SimpleFIN's history comes 90 days a window; Lunch Flow's two years at
    // once, as far back as Nya keeps history (lib/connectors/sync.ts HISTORY_DAYS).
    const sofar = s.connector === 'lunchflow' ? 'everything Lunch Flow has from the last two years is in' : 'the last three months are in, and older transactions arrive over the next few nights';
    if (track.length) parts.push(`Tracking ${track.length} account${track.length === 1 ? '' : 's'}: ${sofar}.`);
    if (res.data.skipped === 'budget') {
      parts.push(`Nya has used today’s requests for your own sync, so their balances come once more are available${backIn(res.data.requests)}: Refresh on its card then, or the daily update brings them.`);
    }
    if (retype.length) parts.push(`Changed what ${retype.length === 1 ? 'one account is' : `${retype.length} accounts are`}.`);
    if (res.data.kept) parts.push(`Kept ${res.data.kept} as manual account${res.data.kept === 1 ? '' : 's'}.`);
    const empty = res.data.nothing_to_keep as string[] | undefined;
    if (keep && empty?.length) parts.push(nothingToKeep(empty).trim());
    else if (res.data.removed) parts.push(`Removed ${res.data.removed}.`);
    // A card or loan reported as money held is asked about at once.
    const next = signStep(res.data.connection as ConnectionView | null, parts.join(' ') || null);
    if (next) return setStep(next);
    setStep({ kind: 'done', text: parts.join(' ') });
  };

  const submitSigns = async (s: Extract<Step, { kind: 'sign' }>) => {
    const sign = s.accounts.flatMap((a) => (signs[a.account_id] ? [{ account_id: a.account_id, sign: signs[a.account_id] }] : []));
    if (sign.length === 0) return close();
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/accounts', 'PUT', { connection_id: s.connection_id, sign });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(true);
    const left = s.accounts.length - sign.length;
    setStep({
      kind: 'done',
      text: `Saved: Nya counts ${sign.length === 1 ? 'it' : 'them'} that way from now on.${left > 0 ? ` ${left} still ${left === 1 ? 'waits' : 'wait'} for your answer.` : ''}`,
    });
  };

  const submitDisconnect = async (s: Extract<Step, { kind: 'disconnect' }>) => {
    // A card or loan kept while its sign waits needs its answer first (it comes in the same request).
    const sign = keep ? s.accounts.flatMap((a) => (a.needs_sign && signs[a.account_id] ? [{ account_id: a.account_id, sign: signs[a.account_id] }] : [])) : [];
    setBusy(true);
    setError('');
    const res = await send('/api/connectors', 'DELETE', { connection_id: s.connection_id, keep, ...(sign.length ? { sign } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(true);
    const kept = keep ? `${res.data.kept} account${res.data.kept === 1 ? ' is' : 's are'} now manual.${nothingToKeep(res.data.nothing_to_keep)}` : `${res.data.removed} account${res.data.removed === 1 ? '' : 's'} removed.`;
    setStep({
      kind: 'done',
      text: `Disconnected: Nya deleted its access and stops asking. ${kept} ${endsThere(s.connector)}`,
    });
  };

  const submitUncarry = async (s: Extract<Step, { kind: 'uncarry' }>) => {
    setBusy(true);
    setError('');
    const res = await send('/api/connectors/carried', 'POST', { account_id: s.account.account_id, confirm: true });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged(true);
    const from = s.account.continued!.from;
    setStep({
      kind: 'done',
      text: `Undone: ${from.institution_name} ${from.name} is as your download brought it back, waiting for its connection, and ${s.account.name} is offered again.${res.data.removed ? ` ${res.data.removed} transaction${res.data.removed === 1 ? '' : 's'} ${s.label} added went.` : ''}`,
    });
  };

  const view = step ?? last.current;
  const title =
    view?.kind === 'token'
      ? view.connection_id
        ? `Connect ${CONNECTOR_WORDS[view.connector].label} again`
        : `Connect with ${CONNECTOR_WORDS[view.connector].label}`
      : view?.kind === 'choose'
        ? 'Choose accounts'
        : view?.kind === 'disconnect'
          ? `Disconnect ${view.label}?`
          : view?.kind === 'sign'
            ? 'Owed or held?'
            : view?.kind === 'uncarry'
              ? `Undo carrying ${view.account.name} on?`
              : 'Your own sync';

  return (
    <Sheet open={!!ask && !!step} title={title} onClose={close}>
      {view?.kind === 'token' && (
        <>
          <ConnectIntro again={!!view.connection_id} connector={view.connector} />
          <CredentialField connector={view.connector} value={token} busy={busy} onChange={setToken} />
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => submitToken(view)} disabled={busy || !token.trim()}>
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
            counted={counted}
            carry={carry ? { enabled: carry.enabled, waiting: carry.waiting, offers: carry.offers[view.connection_id] ?? {} } : null}
            continues={continues}
            onContinue={(id, v) => setContinues((all) => ({ ...all, [id]: v }))}
          />
          {keep && stoppingUnsure(view, choices).length > 0 && (
            <SignView label={view.label} accounts={stoppingUnsure(view, choices)} signs={signs} busy={busy} onSign={(id, sign) => setSigns((all) => ({ ...all, [id]: sign }))} />
          )}
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => submitChoices(view)} disabled={busy || (keep && stoppingUnsure(view, choices).some((a) => !signs[a.account_id])) || unanswered(view, choices, carry, continues)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
      {view?.kind === 'uncarry' && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>{uncarryWords(view.account, view.label)}</p>
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="danger" onClick={() => submitUncarry(view)} disabled={busy}>
              {busy ? 'Undoing…' : 'Undo carrying it on'}
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
          {view.accounts.length > 0 && <EndedPointer count={view.accounts.length} />}
          {keep && view.accounts.some((a) => a.needs_sign) && (
            <SignView
              label={view.label}
              accounts={view.accounts.filter((a) => a.needs_sign)}
              signs={signs}
              busy={busy}
              onSign={(id, sign) => setSigns((all) => ({ ...all, [id]: sign }))}
            />
          )}
          <p className="panel-note">
            Type <strong>{view.label}</strong> to confirm. {endsAt(view.connector, view.label)}
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
            <button
              className="danger"
              onClick={() => submitDisconnect(view)}
              disabled={busy || confirm.trim().toLowerCase() !== view.label.toLowerCase() || (keep && view.accounts.some((a) => a.needs_sign && !signs[a.account_id]))}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </>
      )}
      {view?.kind === 'sign' && (
        <>
          {view.lead && (
            <p className="panel-note" style={{ marginTop: 0 }}>
              {view.lead}
            </p>
          )}
          <SignView label={view.label} accounts={view.accounts} signs={signs} busy={busy} onSign={(id, sign) => setSigns((all) => ({ ...all, [id]: sign }))} />
          {error && <div className="error">{error}</div>}
          <div className="button-pair">
            <button className="secondary" onClick={close} disabled={busy}>
              Later
            </button>
            <button onClick={() => submitSigns(view)} disabled={busy || view.accounts.every((a) => !signs[a.account_id])}>
              {busy ? 'Saving…' : 'Save'}
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
