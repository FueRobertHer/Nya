'use client';

// The banks a download brought back that aren't linked, on the Bring back a
// download card (components/RestoreCard.tsx): where each account's
// transactions stand, and the answers that count them
// (app/api/user-restore/answers, lib/user-restore/answering.ts): this bank
// is gone, so count its transactions as an ended account's; don't count
// them; a connection made since isn't one of them, or which one it is; a
// connector account carries one on. Words in components/restore-state.ts.

import { useState } from 'react';
import type { AnswersView, AnsweredBank, HolderView } from '@/lib/user-restore/answering';
import { accountLine, allAnswered, answeredHolders, calendarDay, holderWords, openHolders, toCount, accountWords } from './restore-state';

/** An answer as the route takes it (app/api/user-restore/answers). */
export type AnswerBody = Record<string, unknown>;

type EndKind = 'closed' | 'left' | 'untracked';

const owes = (type: string | null) => type === 'credit' || type === 'loan';

export default function RestoreAnswers({
  view,
  busy,
  onAnswer,
  onStopFollowing,
}: {
  view: AnswersView;
  busy: boolean;
  /** Sends one answer; the card reads its state again after. */
  onAnswer: (body: AnswerBody) => Promise<void>;
  /** Step one's Stop following: an end, nothing counted. */
  onStopFollowing: (accounts: { account_id: string }[], from: string) => Promise<void>;
}) {
  const open = openHolders(view);
  const answered = answeredHolders(view);
  const everyone = allAnswered(view);
  return (
    <div className="restore-section">
      <div className="section-label">Banks from your download</div>
      <p className="panel-note">
        Their transactions count once each account is linked to its new one when you connect the bank again (the Accounts tab offers it), or once you say the bank
        is gone: then they count as an ended account’s, up to the day you give. While a bank waits, no net worth total is recorded.
      </p>
      {view.unreadable && (
        <p className="stale-note">What you answered about these banks, or what was connected since, can’t be read right now: their transactions aren’t counted meanwhile.</p>
      )}
      {view.banks.map((b) => (
        <BankAnswers key={b.institution_name} bank={b} holders={view.holders} busy={busy} onAnswer={onAnswer} onStopFollowing={onStopFollowing} />
      ))}

      {open.length > 0 && (
        <>
          <div className="section-label">Connected since</div>
          <p className="panel-note">
            A connection made since the restore could hold the same transactions, so a bank you counted isn’t counted while one waits for your answer: its name
            can say that it may be the same bank, never that it isn’t.
          </p>
          {open.map((h) => (
            <HolderQuestion key={`${h.kind}:${h.id}`} holder={h} view={view} busy={busy} onAnswer={onAnswer} everyone={everyone} />
          ))}
        </>
      )}

      {answered.length > 0 && (
        <>
          <div className="section-label">Said not to be among them</div>
          {answered.map(({ holder, account_ids }) => (
            <div key={`${holder.kind}:${holder.id}`} className="restore-bank">
              <p className="panel-note">
                {holderWords(holder)}: not {account_ids.length === 1 ? 'that account' : `those ${account_ids.length} accounts`}, you said.
              </p>
              <button className="secondary" disabled={busy} onClick={() => void onAnswer({ action: 'ask-again', connection: { kind: holder.kind, id: holder.id }, account_ids })}>
                Ask about {holderWords(holder)} again
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function BankAnswers({
  bank,
  holders,
  busy,
  onAnswer,
  onStopFollowing,
}: {
  bank: AnsweredBank;
  holders: readonly HolderView[];
  busy: boolean;
  onAnswer: (body: AnswerBody) => Promise<void>;
  onStopFollowing: (accounts: { account_id: string }[], from: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<EndKind>('untracked');
  const [on, setOn] = useState(bank.prefill ?? bank.latest);
  const [owedOk, setOwedOk] = useState(false);
  const { ids, needEnd } = toCount(bank);
  const counted = bank.accounts.filter((a) => a.counted);
  const owing = needEnd.some((a) => owes(a.type));
  const end = kind === 'untracked' ? { state: 'untracked', from: on } : { state: kind, on };
  const dayOk = !!on && on <= bank.latest;
  // The Items holding these accounts, for one answer for all of them (an
  // account the file ended, which its bank won't return, needs one too).
  const itemHolders = holders.filter((h) => h.kind === 'item' && bank.accounts.some((a) => a.counted && Array.isArray(a.held_by) && a.held_by.includes(h.id)));
  return (
    <div className="restore-bank">
      <div className="restore-bank-name">{bank.institution_name}</div>
      <ul className="restore-list">
        {bank.accounts.map((a) => (
          <li key={a.account_id}>{accountLine(a, holders)}</li>
        ))}
      </ul>

      {ids.length > 0 && (
        <>
          <p className="panel-note">
            Is {bank.institution_name} gone? Its transactions can count as an ended account’s, up to the day you give. Nya has them up to your download, so{' '}
            {calendarDay(bank.latest)} at the latest.
          </p>
          {needEnd.length > 0 && (
            <>
              <label className="field">
                What happened
                <select value={kind} onChange={(e) => setKind(e.target.value as EndKind)} disabled={busy}>
                  <option value="untracked">I stopped following it</option>
                  <option value="closed">It closed</option>
                  <option value="left">It’s no longer mine</option>
                </select>
              </label>
              <label className="field">
                {kind === 'untracked' ? 'From' : 'On'}
                <input type="date" value={on} max={bank.latest} onChange={(e) => setOn(e.target.value)} disabled={busy} />
              </label>
              {owing && (
                <label className="plan-check">
                  <input type="checkbox" checked={owedOk} onChange={(e) => setOwedOk(e.target.checked)} /> Stop counting what its cards and loans owe from then too
                </label>
              )}
            </>
          )}
          {needEnd.length < ids.length && needEnd.length > 0 && <p className="panel-note">Its accounts that ended already keep their own end.</p>}
          <div className="card-actions">
            <button disabled={busy || (needEnd.length > 0 && (!dayOk || (owing && !owedOk)))} onClick={() => void onAnswer({ action: 'count', account_ids: ids, ...(needEnd.length > 0 ? { end } : {}) })}>
              Count {bank.institution_name}’s transactions
            </button>
            {needEnd.length > 0 && kind === 'untracked' && (
              <button className="secondary" disabled={busy || !dayOk} onClick={() => void onStopFollowing(needEnd, on)}>
                Stop following, without counting them
              </button>
            )}
          </div>
        </>
      )}

      {itemHolders.map((h) => (
        <div key={h.id} className="card-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void onAnswer({ action: 'apart', connection: { kind: 'item', id: h.id }, account_ids: bank.accounts.map((a) => a.account_id) })}
          >
            None of these are at {holderWords(h)}
          </button>
        </div>
      ))}

      {bank.accounts
        .filter((a) => a.handed_to)
        .map((a) => (
          <div key={a.account_id} className="card-actions">
            <button className="secondary" disabled={busy} onClick={() => void onAnswer({ action: 'take-back', account_id: a.account_id })}>
              {accountWords(a)} isn’t carried on there
            </button>
          </div>
        ))}

      {counted.length > 0 && (
        <div className="card-actions">
          <button className="secondary" disabled={busy} onClick={() => void onAnswer({ action: 'uncount', account_ids: counted.map((a) => a.account_id) })}>
            Don’t count {bank.institution_name}’s transactions
          </button>
        </div>
      )}
    </div>
  );
}

function HolderQuestion({
  holder,
  view,
  busy,
  onAnswer,
  everyone,
}: {
  holder: HolderView;
  view: AnswersView;
  busy: boolean;
  onAnswer: (body: AnswerBody) => Promise<void>;
  everyone: string[];
}) {
  const connection = { kind: holder.kind, id: holder.id };
  if (holder.kind === 'item') {
    return (
      <div className="restore-bank">
        <p className="panel-note">
          Is {holder.institution} one of the banks from your download?
          {holder.accounts && holder.accounts.length > 0 ? ` Its accounts: ${holder.accounts.map((a) => accountWords(a)).join(', ')}.` : ''}
        </p>
        <div className="card-actions">
          <button className="secondary" disabled={busy} onClick={() => void onAnswer({ action: 'apart', connection, account_ids: everyone })}>
            None of them
          </button>
          {view.banks.length > 1 &&
            view.banks.map((b) => (
              <button
                key={b.institution_name}
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void onAnswer({ action: 'apart', connection, account_ids: view.banks.filter((x) => x !== b).flatMap((x) => x.accounts.map((a) => a.account_id)) })
                }
              >
                It is {b.institution_name}
              </button>
            ))}
        </div>
        <p className="panel-note">
          If it is: link each account to its new one on the Accounts tab (Earlier accounts), or say which aren’t at this connection under its bank above.
        </p>
      </div>
    );
  }
  // A connector account: which account from the download it carries on, if
  // any. One without an end is ended the day after its last transaction or
  // balance brought back (stop following), as the bank's count prefills.
  return (
    <div className="restore-bank">
      <p className="panel-note">Is {holderWords(holder)} one of the accounts from your download?</p>
      <div className="card-actions">
        <button className="secondary" disabled={busy} onClick={() => void onAnswer({ action: 'apart', connection, account_ids: everyone })}>
          No, none of them
        </button>
        {view.banks.flatMap((b) =>
          b.accounts
            .filter((a) => !a.handed_to)
            .map((a) => (
              <button
                key={a.account_id}
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void onAnswer({
                    action: 'hand-over',
                    account_id: a.account_id,
                    to: holder.id,
                    ...(a.end ? {} : { end: { state: 'untracked', from: b.prefill ?? b.latest } }),
                  })
                }
              >
                It carries on {b.institution_name} {accountWords(a)}
              </button>
            ))
        )}
      </div>
      <p className="panel-note">
        Carried on, the account from your download counts its transactions only before that account’s own begin, and those that account holds itself don’t count
        twice: as its history reaches further back, fewer of them count.
      </p>
    </div>
  );
}
