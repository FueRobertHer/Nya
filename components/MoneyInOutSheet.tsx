'use client';

// Money in and out for one investment account (lib/money-in-out.ts): its own
// sheet, opened from the account's (components/MoneyInOutFigures.tsx), with
// the two totals the person's brokerage shows and the day they are for. Both
// are positive, so no minus sign is needed (the iOS decimal keypad has none,
// as the quick-add form's Spent and Received don't need one); an empty field
// is $0.00, so a net goes in either field alone.
//
// Said as they type: the net; the earliest day Nya can carry the totals from
// (its activity for the account starts then), as an error before it; a
// caution when money in is less than what Nya has seen go in by the day,
// which still saves (it may be a net, or a transfer the brokerage doesn't
// count); and a note naming money that moved in the few days up to the day,
// which a brokerage's figures may not show yet.

import { useId, useRef, useState, type FormEvent } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import FieldError, { amountExample } from './FieldError';
import { Notice } from './TotalCaveats';
import { Why } from './Why';
import { moneyInOutSaved } from './InvestmentActivity';
import type { MoneyInOutTarget } from './MoneyInOutFigures';
import { fieldAmount, formatDay, formatMoney, hideAmountsIn, minorDigits, onDay, signedMoney, toMinorUnits, zeroExample } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import { isCalendarDay, MAX_AMOUNT, normalizedAmountText } from '@/lib/manual-txn-input';
import { movedNear, seenIn } from '@/lib/growth';
import type { MoneyInOut } from '@/lib/money-in-out';

const COULDNT = 'Deposits and withdrawals couldn’t be saved just now. Try again.';

/** A total as typed: zero when empty, null when it isn't an amount. */
function readTotal(text: string, currency: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  const normal = normalizedAmountText(t);
  if (normal === null) return null;
  const n = toMinorUnits(Number(normal), currency);
  return Number.isFinite(n) && n <= MAX_AMOUNT ? n : null;
}

const day = (iso: string) => formatDay(iso, { sentence: true });

async function send(body: Record<string, unknown>): Promise<{ ok: true; totals: MoneyInOut | null } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('/api/money-in-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: typeof data?.error === 'string' ? data.error : COULDNT };
  return { ok: true, totals: (data?.money_in_out ?? null) as MoneyInOut | null };
}

export default function MoneyInOutSheet({
  target,
  onClose,
  onDone,
}: {
  target: MoneyInOutTarget | null;
  /** Closed from its header, the backdrop or Escape. */
  onClose: () => void;
  /** Saved, cleared or cancelled: back to the account's sheet. */
  onDone: () => void;
}) {
  // What the sheet keeps showing while it slides out.
  const last = useRef<MoneyInOutTarget | null>(target);
  if (target) last.current = target;
  const shown = last.current;
  return (
    <>
      {shown && (
        <MoneyInOutForm
          // A fresh form for each account and each set of totals it opens on.
          key={`${shown.account_id}:${shown.totals?.set_at ?? ''}`}
          open={!!target}
          target={shown}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </>
  );
}

function MoneyInOutForm({ open, target, onClose, onDone }: { open: boolean; target: MoneyInOutTarget; onClose: () => void; onDone: () => void }) {
  const { totals, flows, flows_from } = target;
  const currency = target.currency || 'USD';
  const places = minorDigits(currency);
  const shownTotal = (n: number | undefined) => (n ? fieldAmount(n, places) : '');
  const [inText, setInText] = useState(shownTotal(totals?.in));
  const [outText, setOutText] = useState(shownTotal(totals?.out));
  const [asOf, setAsOf] = useState(totals?.as_of ?? localDate());
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const money = (n: number) => formatMoney(n, target.currency);

  const inn = readTotal(inText, currency);
  const out = readTotal(outText, currency);
  const today = localDate();
  const dayError = !isCalendarDay(asOf)
    ? 'Pick the day these totals are for'
    : asOf < flows_from
      ? `Pick ${formatDay(flows_from)} or later: Nya has no activity for this account before then.`
      : asOf > today
        ? 'The day can’t be in the future'
        : null;
  const typed = inText.trim() !== '' || outText.trim() !== '';
  const seen = dayError ? 0 : seenIn(flows, asOf);
  const low = typed && inn !== null && !dayError && seen - inn >= 0.005;
  const near = dayError ? [] : movedNear(flows, asOf);
  const nearWords = near.map((f) =>
    f.amount > 0 ? `the ${money(f.amount)} that went in ${onDay(day(f.date))}` : `the ${money(-f.amount)} that came out ${onDay(day(f.date))}`
  );

  const close = () => !busy && onClose();
  const finish = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    const answer = await send(body);
    setBusy(false);
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    moneyInOutSaved(target.account_id, target.item_id, answer.totals);
    onDone();
  };
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (busy || inn === null || out === null || dayError) return;
    void finish({ account_id: target.account_id, in: inn, out, as_of: asOf, currency: target.currency });
  };

  return (
    <Sheet
      open={open}
      title="Deposits and withdrawals"
      onClose={close}
      footer={
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={() => !busy && onDone()} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <form id={`${id}-form`} className="sheet-form" onSubmit={save} noValidate>
        <p className="helper">{target.label}</p>
        <div className="stack tight">
          <label className="field">
            Deposits
            <input
              inputMode="decimal"
              autoComplete="off"
              value={inText}
              onChange={(e) => setInText(e.target.value)}
              placeholder={zeroExample(places)}
              aria-invalid={attempted && inn === null}
              aria-describedby={`${id}-in`}
              disabled={busy}
            />
          </label>
          {attempted && inn === null ? (
            <FieldError id={`${id}-in`}>{`Enter an amount, like ${amountExample(places)}`}</FieldError>
          ) : (
            <p className="helper" id={`${id}-in`}>
              Contributions, transfers and rollovers in, 401(k) loan repayments, and your employer’s match.
            </p>
          )}
          {low && (
            <Notice level="caution" role="status">
              <Masked>
                {`Check that it counts transfers, rollovers and your employer’s match: it’s less than the ${money(seen)} Nya has seen go in from ${day(flows_from)} to ${day(asOf)}. If it’s your net, you can save it as it is.`}
              </Masked>
            </Notice>
          )}
        </div>
        <div className="stack tight">
          <label className="field">
            Withdrawals
            <input
              inputMode="decimal"
              autoComplete="off"
              value={outText}
              onChange={(e) => setOutText(e.target.value)}
              placeholder={zeroExample(places)}
              aria-invalid={attempted && out === null}
              aria-describedby={`${id}-out`}
              disabled={busy}
            />
          </label>
          {attempted && out === null ? (
            <FieldError id={`${id}-out`}>{`Enter an amount, like ${amountExample(places)}`}</FieldError>
          ) : (
            <p className="helper" id={`${id}-out`}>
              Transfers and rollovers out, 401(k) loans, and distributions. Only know the net? Enter it under Deposits (or here, if more came out) and leave the other empty.
            </p>
          )}
        </div>
        {typed && inn !== null && out !== null && (
          <p className="helper">
            <output>
              <Masked>{`Deposits & withdrawals: ${signedMoney(inn - out, target.currency)}`}</Masked>
            </output>
          </p>
        )}
        <div className="stack tight">
          <label className="field">
            As of
            <input
              type="date"
              value={asOf}
              min={flows_from}
              max={today}
              onChange={(e) => setAsOf(e.target.value)}
              aria-invalid={!!dayError}
              aria-describedby={`${id}-day`}
              disabled={busy}
            />
          </label>
          {dayError ? (
            <FieldError id={`${id}-day`}>{dayError}</FieldError>
          ) : (
            <p className="helper" id={`${id}-day`}>
              {formatDay(flows_from)} or later: Nya has this account’s activity from then.
            </p>
          )}
        </div>
        {nearWords.length > 0 && (
          <Notice level="info" role="status">
            <Masked>{`Make sure your brokerage’s figures include ${nearWords.join(' and ')}: Nya counts ${nearWords.length > 1 ? 'them' : 'it'} in these totals.`}</Masked>
          </Notice>
        )}
        {error && (
          <Notice level="critical" role="alert">
            <Masked>{hideAmountsIn(error)}</Masked>
          </Notice>
        )}
        {totals && (
          <div>
            <button type="button" className="btn ghost" onClick={() => void finish({ account_id: target.account_id, clear: true })} disabled={busy}>
              Clear deposits and withdrawals
            </button>
          </div>
        )}
        <Why>
          From these, Nya works out your deposits and withdrawals on each day it has activity for: it takes off what moved between that day and this one, and adds what moves after, so new ones count as they happen. Dividends, interest and fees count in your returns, not as deposits or withdrawals. Your brokerage may call deposits contributions. If it shows only deposits and withdrawals as one figure, enter it under Deposits (or under Withdrawals, if more came out) and leave the other empty: that figure and your returns stay right. These aren’t your cost basis, which grows with reinvested dividends, nor the Plan’s Roth figure, which leaves out conversions.
        </Why>
      </form>
    </Sheet>
  );
}
