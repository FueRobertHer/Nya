'use client';

// The Shared expenses card (#49), on the Activity tab: the people the person
// splits costs with, what each owes or is owed per currency, and what to do
// about it. Rows that may have paid something back are offered here
// (lib/shared-expenses/match.ts, worked out in the browser over the rows
// already loaded), never confirmed on their own; transactions carrying a
// person's tag that aren't shared yet are offered in one tap; a shared or
// paying transaction that is gone from the accounts is said, with what can be
// done about it. The sheets it opens are SharedSheets, below, mounted beside
// it on every segment of the tab.
//
// Nya keeps the list; the money moves in Venmo, Cash App or however the
// people pay each other. Balances are figures only when everything could be
// read (app/api/shared-expenses reads strictly).
//
// With no one in it yet, and nothing kept that couldn't be read, the card is
// the empty state (components/EmptyState.tsx, the screen review after step
// 5): what it is for and Add someone as its one primary. Add someone is one
// button either way (`addRef`), so the person's sheet, closing once the
// button it opened from is gone (the first person saved takes the empty
// state with it), gives focus to the Add someone that is there now.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Masked } from './HideAmounts';
import { shownName } from '@/lib/merchant-name';
import EmptyState from './EmptyState';
import type { Txn } from './MonthBreakdown';
import { formatMoney, hideAmountsIn, signedMoney } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import type { Taxonomy } from '@/lib/categories';
import type { Tag } from '@/lib/tags';
import { proposals, type MatchPerson, type Proposal } from '@/lib/shared-expenses/match';
import { MAX_BATCH, REMOVED_NAME } from '@/lib/shared-expenses/model';
import type { MoveTo, ShareResult } from '@/lib/shared-expenses/rows';
import type { Balance } from '@/lib/shared-expenses/balances';
import { convert, isStale, ownRateOn, type FxTable } from '@/lib/fx/rates';
import { balanceText, letGoText, reasonsText, whoseText } from './shared-expenses-text';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';
import ShareCostSheet from './ShareCostSheet';
import { ConfirmPaymentSheet, SettleSheet } from './ConfirmPaymentSheet';
import PersonSheet from './PersonSheet';
import IouSheet from './IouSheet';
import HandoffSheet from './HandoffSheet';

/** What the transactions' read says of shared expenses (lib/activity.ts). */
export type SharedFacts = Pick<ShareResult, 'gone' | 'twice'> & Partial<Pick<ShareResult, 'away' | 'coming' | 'moves'>>;

/** A person's balances in the home currency, at the newest rates: an
 *  estimate to read, never stored, asked for or matched on; null without a
 *  home currency, a rate, or anything but the home currency to convert. */
export function aboutInHome(balances: readonly Balance[], fx: FxTable | null | undefined): { amount: number; currency: string; stale: boolean; own: string[] } | null {
  const home = fx?.home;
  if (!fx || !home || !fx.latest || balances.length === 0 || balances.every((b) => b.currency === home)) return null;
  const day = fx.latest.date;
  let sum = 0;
  for (const b of balances) {
    const c = convert(fx, b.amount, b.currency, home, day, { tidy: true });
    if (!c.ok) return null;
    sum += c.amount;
  }
  // The currencies a rate of the person's own prices, said by name.
  const own = [...new Set(balances.map((b) => b.currency))].filter((c) => c !== home && ownRateOn(fx, c, day) !== null).sort();
  return { amount: sum, currency: home, stale: isStale(fx, Date.now()), own };
}

/** How many proposals the card lists at once. */
const PROPOSALS_SHOWN = 5;

const STORE_KEYS: Readonly<Record<string, 'people' | 'shares' | 'ious' | 'payments' | 'dismissed'>> = {
  'expense-people': 'people',
  'expense-shares': 'shares',
  'expense-ious': 'ious',
  'expense-payments': 'payments',
  'expense-dismissed': 'dismissed',
};
const STORE_WORDS: Readonly<Record<string, [string, string]>> = {
  'expense-people': ['person', 'people'],
  'expense-shares': ['shared transaction', 'shared transactions'],
  'expense-ious': ['IOU', 'IOUs'],
  'expense-payments': ['payment', 'payments'],
  'expense-dismissed': ['row set aside', 'rows set aside'],
};

function shownDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Posted money out carrying a tag, with no share yet, nor anything else
 *  that says how it counts (a split, a group, a payment). */
export function taggedNotShared(txns: readonly Txn[], tag: string, shared: ReadonlySet<string>): Txn[] {
  return txns.filter(
    (t) =>
      (t.tags ?? []).includes(tag) &&
      !t.pending &&
      t.amount > 0 &&
      !t.shared &&
      !t.settles &&
      !t.shared_part &&
      !t.shared_iou &&
      t.split_of === undefined &&
      !t.group_members &&
      !t.group_id &&
      !shared.has(t.transaction_id)
  );
}

export default function SharedExpensesCard({
  shared,
  txns,
  facts,
  tags,
  taxonomy,
  currency,
  fx = null,
}: {
  shared: SharedExpenses;
  txns: Txn[] | null;
  facts: SharedFacts | null;
  tags: readonly Tag[];
  taxonomy: Taxonomy | null;
  /** The currency a new IOU is in, until changed. */
  currency: string;
  /** The exchange rates (app/api/transactions `fx`), for a balance in other
   *  currencies said about in the home one. */
  fx?: FxTable | null;
}) {
  const { card, failed, setOpen, send } = shared;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [own, setOwn] = useState<{ venmo: string; cashtag: string } | null>(null);
  const today = localDate();
  // A person's sheet closed: it gives focus back to the button that opened
  // it as its own effect ends, which runs before this one. When it couldn't
  // (the empty state's button, gone once the first person is in), focus goes
  // to Add someone as it is drawn now, rather than to nothing.
  const addRef = useRef<HTMLButtonElement>(null);
  const personOpen = shared.open?.kind === 'person';
  const wasOpen = useRef(personOpen);
  useEffect(() => {
    const closed = wasOpen.current && !personOpen;
    wasOpen.current = personOpen;
    if (!closed) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) addRef.current?.focus({ preventScroll: true });
  }, [personOpen]);

  const names = useMemo(() => new Map((card?.people ?? []).map((p) => [p.id, p.name ?? REMOVED_NAME])), [card]);
  const nameOf = (id: string) => names.get(id) ?? REMOVED_NAME;

  // Rows that may have paid something back, worked out here (see the header).
  const offered = useMemo<Proposal[]>(() => {
    if (!card || !txns || !card.balances) return [];
    const people: MatchPerson[] = card.people.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.venmo ? { venmo: p.venmo } : {}),
      ...(p.cashtag ? { cashtag: p.cashtag } : {}),
      ...(p.app ? { app: p.app } : {}),
      requests: p.requests,
      archived: p.archived,
    }));
    const found = proposals(txns, people, card.items, { dismissed: new Set(card.dismissed.map((d) => d.transaction_id)), paying: new Set(card.payments.map((p) => p.transaction_id)) });
    // One counted as income until confirmed first: it counts beside the
    // part already out of spending.
    return [...found.filter((p) => p.counted), ...found.filter((p) => !p.counted)];
  }, [card, txns]);

  if (!card) {
    return (
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Shared expenses</div>
        </div>
        {failed ? <p className="error">{failed}</p> : <p className="empty-note">Loading…</p>}
      </div>
    );
  }

  // Listed: everyone not archived or forgotten, and anyone with something
  // open (an archived person given something on another device meanwhile).
  const openWith = (id: string) => (card.balances?.[id] ?? []).length > 0;
  const live = card.people.filter((p) => (!p.archived && !p.removed) || openWith(p.id));
  const archived = card.people.filter((p) => p.archived && !openWith(p.id));
  const sharedIds = new Set(card.shares.map((s) => s.transaction_id));
  const byId = new Map((txns ?? []).map((t) => [t.transaction_id, t]));
  const unread = Object.entries(card.unread);
  const removable = unread.filter(([store, u]) => STORE_KEYS[store] && u.unreadable.length > 0);

  async function act(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown, moves = true) {
    setBusy(true);
    setError('');
    const sent = await send(path, method, body, { moves });
    setBusy(false);
    if (sent.error) setError(sent.error);
    return !sent.error;
  }

  // A gone one's candidates to move to, as the read worked them out
  // (lib/shared-expenses/rows.ts moves), each with the account it is on,
  // which the move sends and the server checks.
  const movesFor = (moves: readonly MoveTo[] | undefined): (MoveTo & { t: Txn })[] =>
    (moves ?? []).flatMap((m) => {
      const t = byId.get(m.transaction_id);
      return t ? [{ ...m, t }] : [];
    });
  // Waiting: on an account disconnected and linked to nothing yet, or, after
  // a re-link, for their transactions to come in.
  const awayShares = (facts?.away?.shares ?? []).map((id) => card.shares.find((s) => s.transaction_id === id)).filter((s) => !!s);
  const awayPayments = (facts?.away?.payments ?? []).map((id) => card.payments.find((p) => p.transaction_id === id)).filter((p) => !!p);
  const coming = (facts?.coming?.shares.length ?? 0) + (facts?.coming?.payments.length ?? 0);

  const goneShares = (facts?.gone.shares ?? []).map((id) => card.shares.find((s) => s.transaction_id === id)).filter((s) => !!s);
  const gonePayments = (facts?.gone.payments ?? []).map((id) => card.payments.find((p) => p.transaction_id === id)).filter((p) => !!p);

  // No one yet, and nothing that couldn't be read (whose warning and its
  // remove buttons the card keeps as it is): the empty state.
  const empty = card.people.length === 0 && unread.length === 0;
  const addSomeone = () => setOpen({ kind: 'person', id: null });
  const settingsUnread = card.settings_unread && (
    <p className="stale-note">Your setting for shared expenses couldn’t be read, so every transaction counts as your bank shows it until it can be.</p>
  );

  return (
    <div className="card shared-card">
      {empty ? (
        <EmptyState
          heading="h2"
          title="No shared expenses yet"
          line="Keep track of what people owe you and what you owe them."
          action={{ label: 'Add someone', opens: true, ref: addRef, onSelect: addSomeone }}
        >
          {settingsUnread}
        </EmptyState>
      ) : (
        <>
          <div className="inst-header">
            <div className="inst-name">Shared expenses</div>
          </div>

          {card.people.length === 0 && (
            // How the money moves is the card's last line, for everyone: said once.
            <p className="panel-note">Keep track of what people owe you and what you owe them.</p>
          )}
          {settingsUnread}
        </>
      )}
      {unread.length > 0 && (
        <div className="stale-note">
          Some of what you keep here couldn’t be read:{' '}
          {unread
            .map(([store, u]) => {
              const n = u.unreadable.length + u.unrecognised.length;
              const [one, many] = STORE_WORDS[store] ?? ['entry', 'entries'];
              return `${n} ${n === 1 ? one : many}`;
            })
            .join(', ')}
          . Nothing was changed.{card.balances === null ? ' Balances aren’t shown until everything can be read: one that can’t could be anyone’s.' : ''}
          {removable.length > 0 && !removing && (
            <>
              {' '}
              <button className="link-btn" onClick={() => setRemoving(true)} disabled={busy}>
                Remove what is damaged
              </button>
            </>
          )}
          {removing && (
            <div className="button-pair">
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    for (const [store, u] of removable) await act(SHARED_ROUTES.card, 'POST', { action: 'remove-unreadable', store: STORE_KEYS[store], ids: u.unreadable });
                    setRemoving(false);
                  })()
                }
              >
                Remove them for good
              </button>
              <button className="secondary" onClick={() => setRemoving(false)} disabled={busy}>
                Keep them
              </button>
            </div>
          )}
        </div>
      )}

      {live.length > 0 && (
        <ul className="shared-people">
          {live.map((p) => {
            const balances = card.balances?.[p.id] ?? [];
            const name = p.name ?? REMOVED_NAME;
            return (
              <li key={p.id} className="shared-person">
                <button className="link-btn shared-person-name" onClick={() => setOpen({ kind: 'person', id: p.id })}>
                  {name}
                </button>
                {p.archived && <span className="type-tag">Archived, with something still open</span>}
                {card.balances === null ? (
                  <span className="type-tag">Balance not shown while some of it can’t be read</span>
                ) : balances.length === 0 ? (
                  <span className="type-tag">Settled up</span>
                ) : (
                  <>
                  {balances.map((b) => {
                    const letGo = letGoText(b.amount, b.oldest, today);
                    return (
                      <div key={b.currency} className="shared-balance">
                        <span className={b.amount > 0 ? 'inflow' : undefined}>
                          <Masked>{balanceText(name, b.amount, (n) => formatMoney(n, b.currency))}</Masked>
                        </span>
                        {b.over > 0 &&
                          card.items
                            .filter((i) => i.person === p.id && i.currency === b.currency && i.over)
                            .map((i) => {
                              // Closed past its amount (two payments confirmed on two devices at
                              // once, say): which payments, and one to reopen.
                              const by = card.payments.filter((pay) => pay.allocations.some((a) => a.item === i.id));
                              return (
                                <div key={`over:${i.id}`} className="type-tag">
                                  “{i.what}” was closed past what it was{by.length > 0 ? `, by ${by.length === 1 ? 'a payment' : `${by.length} payments`}` : ''}.{' '}
                                  {by.map((pay) => (
                                    <button
                                      key={pay.transaction_id}
                                      className="link-btn"
                                      disabled={busy}
                                      onClick={() => void act(SHARED_ROUTES.payments, 'DELETE', { transaction_id: pay.transaction_id })}
                                    >
                                      Reopen the payment of {shownDay(pay.row.date)}
                                    </button>
                                  ))}
                                </div>
                              );
                            })}
                        {letGo && (
                          <div className="type-tag">
                            {letGo}{' '}
                            <button className="link-btn" onClick={() => setOpen({ kind: 'settle', person: p.id, currency: b.currency, letGo: true })}>
                              Let it go
                            </button>
                          </div>
                        )}
                        {b.amount !== 0 && !p.removed && (
                          <div className="card-actions">
                            <button className="secondary" onClick={() => setOpen({ kind: 'handoff', person: p.id, currency: b.currency })}>
                              {b.amount > 0 ? 'Ask for it' : 'Pay'}
                            </button>
                            <button className="secondary" onClick={() => setOpen({ kind: 'settle', person: p.id, currency: b.currency })}>
                              Mark settled
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(() => {
                    const about = aboutInHome(balances, fx);
                    if (!about) return null;
                    return (
                      <span className="type-tag">
                        <Masked>{`About ${formatMoney(Math.abs(about.amount), about.currency)} ${about.amount >= 0 ? 'owed to you' : 'you owe'} in all, at the latest exchange rates${about.own.length > 0 ? ` (your own for ${about.own.join(' and ')})` : ''}: an estimate`}</Masked>
                        {about.stale ? ', and the rates may be out of date' : ''}
                      </span>
                    );
                  })()}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {offered.length > 0 && (
        <>
          <div className="section-label">Paid back?</div>
          <ul className="shared-proposals">
            {offered.slice(0, PROPOSALS_SHOWN).map((pr) => {
              const t = byId.get(pr.row);
              if (!t) return null;
              const who = pr.several ? pr.several.map(nameOf).join(', ') : nameOf(pr.person);
              const asked = (card.people.find((p) => p.id === pr.person)?.requests.length ?? 0) > 0;
              return (
                <li key={`${pr.row}:${pr.person}`} className="shared-proposal">
                  <div>
                    {shownName(t)} · {shownDay(t.date)} ·{' '}
                    <span className={pr.amount < 0 ? 'inflow' : undefined}>
                      <Masked>{signedMoney(-pr.amount, pr.currency, { always: true })}</Masked>
                    </span>
                  </div>
                  <div className="type-tag">
                    {pr.tier === 'strong' ? 'Looks like' : pr.tier === 'likely' ? 'Maybe' : 'Could be'} {who} {pr.amount < 0 ? 'paying you back' : 'being paid'}.{' '}
                    {reasonsText(pr, nameOf(pr.person), asked)}
                    {pr.also.length > 0 ? `. ${whoseText([nameOf(pr.person), ...pr.also.map(nameOf)])}` : ''}
                    {pr.counted ? '. Until you confirm it, it counts as money in.' : ''}
                  </div>
                  <div className="card-actions">
                    <button
                      className="secondary"
                      onClick={() => setOpen({ kind: 'paid', t, person: pr.person, allocations: pr.preselect ? pr.allocations : [], also: pr.also, fromProposal: true })}
                    >
                      Confirm…
                    </button>
                    <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.payments, 'PATCH', { action: 'dismiss', transaction_id: pr.row }, false)}>
                      Not a repayment
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {offered.length > PROPOSALS_SHOWN && <p className="type-tag">And {offered.length - PROPOSALS_SHOWN} more, once these are done.</p>}
        </>
      )}

      {txns &&
        live
          .filter((p) => p.tag && !p.removed)
          .map((p) => {
            const tag = tags.find((x) => x.id === p.tag!.id);
            if (!tag) return null;
            const rows = taggedNotShared(txns, tag.id, sharedIds);
            if (rows.length === 0) return null;
            const how = p.tag!.how;
            const name = p.name ?? REMOVED_NAME;
            return (
              <div key={`tag:${p.id}`} className="panel-note">
                {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} tagged {tag.name} {rows.length === 1 ? 'isn’t' : 'aren’t'} shared yet.{' '}
                <button
                  className="link-btn"
                  disabled={busy}
                  onClick={() => void act(SHARED_ROUTES.shares, 'PATCH', { action: 'many', person: p.id, ids: rows.slice(0, MAX_BATCH).map((t) => t.transaction_id), how })}
                >
                  Share {rows.length === 1 ? 'it' : 'them'} {how.kind === 'half' ? 'half' : how.kind === 'even' ? `${how.ways} ways` : ''} with {name}
                </button>
              </div>
            );
          })}

      {goneShares.map((s) => {
        const moves = movesFor(facts?.moves?.shares[s.transaction_id]);
        return (
          <div key={`gone:${s.transaction_id}`} className="stale-note">
            {s.what}, {shownDay(s.date)}: its transaction isn’t in your accounts any more. What is owed of it stays, in the balance, until you say.
            <div className="card-actions">
              {moves.map((m) => (
                <button
                  key={m.transaction_id}
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(SHARED_ROUTES.shares, 'PATCH', { action: 'move', transaction_id: s.transaction_id, to: m.transaction_id, account: m.account_id })}
                >
                  Move to {shownName(m.t)}, {shownDay(m.t.date)}, {m.t.account_name}
                </button>
              ))}
              <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.shares, 'PATCH', { action: 'keep', transaction_id: s.transaction_id }, false)}>
                Keep it
              </button>
              <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.shares, 'DELETE', { transaction_id: s.transaction_id })}>
                Remove it
              </button>
            </div>
          </div>
        );
      })}
      {gonePayments.map((p) => {
        const moves = movesFor(facts?.moves?.payments[p.transaction_id]);
        return (
          <div key={`gone-pay:${p.transaction_id}`} className="stale-note">
            A payment you confirmed on {shownDay(p.row.date)} isn’t in your accounts any more. What it paid back stays paid, until you say.
            <div className="card-actions">
              {moves.map((m) => (
                <button
                  key={m.transaction_id}
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(SHARED_ROUTES.payments, 'PATCH', { action: 'move', transaction_id: p.transaction_id, to: m.transaction_id, account: m.account_id })}
                >
                  Move to {shownName(m.t)}, {shownDay(m.t.date)}, {m.t.account_name}
                </button>
              ))}
              <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.payments, 'PATCH', { action: 'keep', transaction_id: p.transaction_id }, false)}>
                Keep it
              </button>
              <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.payments, 'DELETE', { transaction_id: p.transaction_id })}>
                Reopen it
              </button>
            </div>
          </div>
        );
      })}
      {/* On a bank disconnected: it carries once the bank is back and linked.
          Keep it, for a bank that won't be: what is owed stays, no longer
          said to wait (and still carries if it comes back). Never Remove:
          its transaction may yet come back. */}
      {awayShares.map((s) => (
        <div key={`away:${s.transaction_id}`} className="stale-note">
          {s.what}, {shownDay(s.date)}: on an account you disconnected. Once you add the bank back and link the account to its earlier one, it carries across to the same
          transaction. What is owed of it stays as it is meanwhile.
          <div className="card-actions">
            <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.shares, 'PATCH', { action: 'keep', transaction_id: s.transaction_id }, false)}>
              Keep it without the bank
            </button>
          </div>
        </div>
      ))}
      {awayPayments.map((p) => (
        <div key={`away-pay:${p.transaction_id}`} className="stale-note">
          A payment you confirmed on {shownDay(p.row.date)} is on an account you disconnected. Once you add the bank back and link the account to its earlier one, it carries
          across to the same transaction. What it paid back stays paid meanwhile.
          <div className="card-actions">
            <button className="secondary" disabled={busy} onClick={() => void act(SHARED_ROUTES.payments, 'PATCH', { action: 'keep', transaction_id: p.transaction_id }, false)}>
              Keep it without the bank
            </button>
          </div>
        </div>
      ))}
      {/* After a re-link, before their transactions have come: nothing to do
          yet, and never Remove, since each is likely on its way. */}
      {coming > 0 && (
        <p className="stale-note">
          {coming === 1 ? 'A shared transaction, or a payment you confirmed, from before you re-linked waits' : `${coming} shared transactions or payments you confirmed from before you re-linked wait`}{' '}
          for {coming === 1 ? 'its transaction' : 'their transactions'} to come in from your bank: {coming === 1 ? 'it carries' : 'they carry'} across once{' '}
          {coming === 1 ? 'it does' : 'they do'}. What is owed stays as it is meanwhile.
        </p>
      )}
      {(facts?.twice ?? []).map((tw) => {
        const t = byId.get(tw.bank);
        return (
          <div key={`twice:${tw.bank}`} className="stale-note">
            {t ? `${shownName(t)}, ${shownDay(t.date)}` : 'A transaction'} is shared twice: as the bank’s, and as the row imported from a file that it stands for. The bank’s share
            counts.
            <div className="card-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    for (const id of tw.imported) if (!(await act(SHARED_ROUTES.shares, 'DELETE', { transaction_id: id }))) return;
                  })()
                }
              >
                Remove the imported row’s share
              </button>
            </div>
          </div>
        );
      })}

      {error && (
        <div className="error">
          <Masked>{hideAmountsIn(error)}</Masked>
        </div>
      )}

      <div className="card-actions">
        {!empty && (
          <button ref={addRef} className="secondary" onClick={addSomeone}>
            Add someone
          </button>
        )}
        {live.length > 0 && (
          <button className="secondary" onClick={() => setOpen({ kind: 'iou', id: null })}>
            Add an IOU
          </button>
        )}
        <button className="link-btn" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}>
          {showSettings ? 'Hide settings' : 'Settings'}
        </button>
      </div>

      {showSettings && (
        <div className="sheet-form">
          <fieldset className="lifecycle-choices" disabled={busy || card.settings_unread}>
            <legend className="section-label">In your totals, a shared transaction counts</legend>
            <label className="lifecycle-choice">
              <input type="radio" name="shared-counting" checked={card.counting === 'part'} onChange={() => void act(SHARED_ROUTES.card, 'PUT', { counting: 'part' })} />
              <span>
                <span className="lifecycle-choice-name">Your part</span>
                <span className="lifecycle-choice-note">
                  What others owe you of it isn’t your spending, and their paying you back isn’t income. Your spending stays lower by what others owe you until they pay it or you let
                  it go.
                </span>
              </span>
            </label>
            <label className="lifecycle-choice">
              <input type="radio" name="shared-counting" checked={card.counting === 'bank'} onChange={() => void act(SHARED_ROUTES.card, 'PUT', { counting: 'bank' })} />
              <span>
                <span className="lifecycle-choice-name">As your bank shows it</span>
                <span className="lifecycle-choice-note">The whole amount, and what they pay you back as money in. Balances are kept either way.</span>
              </span>
            </label>
          </fieldset>
          <label className="field">
            Your Venmo username, for messages asking to be paid
            <input
              className="text-input"
              value={own?.venmo ?? card.own.venmo ?? ''}
              maxLength={31}
              onChange={(e) => setOwn({ venmo: e.target.value, cashtag: own?.cashtag ?? card.own.cashtag ?? '' })}
              autoComplete="off"
            />
          </label>
          <label className="field">
            Your Cash App cashtag
            <input
              className="text-input"
              value={own?.cashtag ?? card.own.cashtag ?? ''}
              maxLength={31}
              onChange={(e) => setOwn({ venmo: own?.venmo ?? card.own.venmo ?? '', cashtag: e.target.value })}
              autoComplete="off"
            />
          </label>
          {own && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(SHARED_ROUTES.card, 'PUT', { own_venmo: own.venmo.trim().replace(/^@/, ''), own_cashtag: own.cashtag.trim().replace(/^\$/, '') }, false).then((ok) => ok && setOwn(null))
              }
            >
              Save
            </button>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="recurring-dismissed">
          <button className="link-btn" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            {archived.length} archived · {showArchived ? 'Hide' : 'Show'}
          </button>
          {showArchived && (
            <ul className="recurring-dismissed-list">
              {archived.map((p) => (
                <li key={p.id}>
                  <span>{p.name ?? REMOVED_NAME}</span>
                  <button className="link-btn" onClick={() => setOpen({ kind: 'person', id: p.id })}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="helper">Nya never sends, receives or holds money: it keeps the list, and the money moves however you pay each other.</p>
    </div>
  );
}

/** Every sheet the card opens, and the rows of Activity's list open too
 *  (Share the cost, This paid back, an IOU's row): mounted on every segment,
 *  so a row on Transactions opens its sheet while the card is on Shared. */
export function SharedSheets({
  shared,
  tags,
  taxonomy,
  currency,
}: {
  shared: SharedExpenses;
  tags: readonly Tag[];
  taxonomy: Taxonomy | null;
  /** The currency a new IOU is in, until changed. */
  currency: string;
}) {
  const { open, setOpen } = shared;
  return (
    <>
      <ShareCostSheet t={open?.kind === 'share' ? open.t : null} shared={shared} onClose={() => setOpen(null)} />
      <ConfirmPaymentSheet
        t={open?.kind === 'paid' ? open.t : null}
        person={open?.kind === 'paid' ? open.person : undefined}
        preset={open?.kind === 'paid' ? open.allocations : undefined}
        also={open?.kind === 'paid' ? open.also : undefined}
        fromProposal={open?.kind === 'paid' ? open.fromProposal : undefined}
        shared={shared}
        onClose={() => setOpen(null)}
      />
      <SettleSheet
        person={open?.kind === 'settle' ? open.person : null}
        currency={open?.kind === 'settle' ? open.currency : currency}
        letGo={open?.kind === 'settle' ? open.letGo : undefined}
        shared={shared}
        onClose={() => setOpen(null)}
      />
      <PersonSheet id={open?.kind === 'person' ? open.id : null} open={open?.kind === 'person'} tags={tags} shared={shared} onClose={() => setOpen(null)} />
      <IouSheet
        id={open?.kind === 'iou' ? open.id : null}
        person={open?.kind === 'iou' ? open.person : undefined}
        open={open?.kind === 'iou'}
        currency={currency}
        taxonomy={taxonomy}
        shared={shared}
        onClose={() => setOpen(null)}
      />
      <HandoffSheet person={open?.kind === 'handoff' ? open.person : null} currency={open?.kind === 'handoff' ? open.currency : currency} shared={shared} onClose={() => setOpen(null)} />
    </>
  );
}
