'use client';

// The Currency card, under Manage on the Accounts tab (lib/fx/settings.ts):
// the home currency (choose, change, or stop converting), the ECB's newest
// rates' day and whether Nya couldn't fetch newer ones, and the person's own
// rates (list, add, change, remove), each with the ECB's beside it where the
// ECB publishes the currency, so a bank's markup shows. Settings that can't
// be read are said, and removed only when damaged, once confirmed.
//
// A rate is not an amount of the person's money, so the rates here show
// while amounts are hidden (lib/format.ts formatRate).

import { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import CurrencyChoiceSheet from './CurrencyChoiceSheet';
import { ecbCross, errorOf, useCurrencySettings, type CurrencyLoad, type CurrencySettingsView } from './currency-state';
import { rateDay } from './currency-text';
import { formatRate } from '@/lib/format';
import { rateTextError } from '@/lib/fx/rate-text';
import type { OwnRate } from '@/lib/fx/rates';

type Props = {
  /** The person's accounts' currencies, most first. */
  currencies: readonly string[];
  manual: readonly { name: string; currency: string }[];
  /** Opened from a note on Home: show it, and scroll to it. */
  focus?: boolean;
  onFocused?: () => void;
  /** The home currency or a rate changed: Home's figures load again. */
  onChanged: () => void;
};

/** A rate being typed, as the sheet holds it. */
export type RateDraft = { currency: string; rate: string; quote: string; every: boolean; from: string };

/** What is waiting to be confirmed on the card. */
export type Confirming = 'stop' | 'repair' | { remove: string } | null;

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** A rate of the person's own, as the card lists it: "1 BTC = 61,000 USD,
 *  from Oct 1, 2026". */
export function ownRateText(o: OwnRate): string {
  return `${formatRate(Number(o.rate), o.currency, o.quote)}, ${o.from ? `from ${rateDay(o.from)}` : 'every day, past ones included'}`;
}

/** The ECB's newest rate beside one of the person's own, or what the ECB
 *  doesn't publish. */
export function ecbBeside(o: Pick<OwnRate, 'currency' | 'quote'>, ecb: CurrencySettingsView['ecb']): string {
  const cross = ecbCross(ecb.rates, o.currency, o.quote);
  if (cross !== null) return `The ECB’s ${ecb.date ? `of ${rateDay(ecb.date)}` : 'newest'}: ${formatRate(cross, o.currency, o.quote)}`;
  return o.currency === 'EUR' || o.currency in ecb.rates ? 'The ECB has no rate for it now' : `The ECB doesn’t publish ${o.currency}`;
}

/** Why a draft can't be saved yet, or null when it can. */
export function draftProblem(d: RateDraft): string | null {
  const code = d.currency.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(code)) return 'Type the currency’s code, like BTC.';
  if (code === d.quote) return 'A rate is in another currency than the one it prices.';
  if (!d.rate.trim()) return 'Type the rate, like 0.92.';
  const bad = rateTextError(d.rate.trim());
  if (bad) return bad;
  if (!d.every && !d.from) return 'Choose the day it starts, or every day.';
  return null;
}

type Handlers = {
  onChoose: () => void;
  onConfirm: (c: Confirming) => void;
  onStop: () => void;
  onRepair: () => void;
  onRemove: (currency: string) => void;
  onEdit: (o?: OwnRate) => void;
};

/** The card, from what was loaded: for tests, and the card above. */
export function CurrencyCardBody({ load, busy, confirm, error, ...on }: { load: CurrencyLoad; busy: boolean; confirm: Confirming; error: string | null } & Handlers) {
  const view = load.kind === 'ready' ? load.view : null;
  return (
    <>
      <div className="inst-header">
        <div className="inst-name">Currency</div>
        {view && !view.problem && <div className="inst-total">{view.home ?? 'not converting'}</div>}
      </div>
      {load.kind === 'loading' && <p className="panel-note">Loading…</p>}
      {load.kind === 'error' && <div className="error">{load.message}</div>}
      {view?.problem ? (
        <>
          <p className="stale-note">
            {view.problem === 'unreadable'
              ? 'Your currency settings couldn’t be read, so nothing is converted until they can be.'
              : 'Your currency settings were saved by a newer version of Nya, so nothing is converted here. They are kept as they are.'}
          </p>
          {view.removable &&
            (confirm === 'repair' ? (
              <div className="button-pair">
                <button disabled={busy} onClick={on.onRepair}>
                  Remove them
                </button>
                <button className="secondary" onClick={() => on.onConfirm(null)}>
                  Keep them
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => on.onConfirm('repair')}>
                Remove the damaged settings…
              </button>
            ))}
        </>
      ) : (
        view && (
          <>
            <p className="panel-note">
              {view.home
                ? `Your net worth is shown in ${view.home}, with accounts in other currencies converted at the European Central Bank’s daily reference rates${view.own.length > 0 ? ', or your own' : ''}. Your budgets, goals and the Plan stay as they are, in their own currencies.`
                : 'Nya shows each balance in its own currency, and adds your net worth up in the currency most of your accounts are in, unconverted. Choose a home currency to see your net worth converted into it at the European Central Bank’s daily reference rates.'}
            </p>
            <p className="as-of">
              {view.ecb.date ? `The ECB’s newest rates: ${rateDay(view.ecb.date)}.` : 'Nya has no ECB rates yet.'}
              {view.ecb.date && view.ecb.stale ? ' Nya couldn’t fetch newer ones, so converted figures may be out of date.' : ''}
            </p>
            {confirm === 'stop' ? (
              <>
                <p className="panel-note">Every figure goes back to its own currency, as before you chose one. Your own rates are kept.</p>
                <div className="button-pair">
                  <button disabled={busy} onClick={on.onStop}>
                    Stop converting
                  </button>
                  <button className="secondary" onClick={() => on.onConfirm(null)}>
                    Keep {view.home}
                  </button>
                </div>
              </>
            ) : (
              <div className="button-pair">
                <button className="secondary" onClick={on.onChoose} disabled={busy}>
                  {view.home ? 'Change' : 'Choose a home currency'}
                </button>
                {view.home && (
                  <button className="secondary" onClick={() => on.onConfirm('stop')} disabled={busy}>
                    Stop converting
                  </button>
                )}
              </div>
            )}

            <h3 className="section-label currency-rates-title">Your rates</h3>
            {view.own.length === 0 ? (
              <p className="panel-note">None. Set one for a currency the ECB doesn’t publish (a cryptocurrency, say), or to use your bank’s rate instead of the ECB’s.</p>
            ) : (
              <ul className="own-rates">
                {view.own.map((o) => (
                  <li key={o.currency} className="own-rate-row">
                    <div>
                      <div className="own-rate-rate">{ownRateText(o)}</div>
                      <div className="as-of">{ecbBeside(o, view.ecb)}</div>
                    </div>
                    <div className="own-rate-actions">
                      {typeof confirm === 'object' && confirm?.remove === o.currency ? (
                        <>
                          <button className="link-btn danger-link" disabled={busy} onClick={() => on.onRemove(o.currency)}>
                            Remove
                          </button>
                          <button className="link-btn" onClick={() => on.onConfirm(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="link-btn" onClick={() => on.onEdit(o)} disabled={busy}>
                            Change
                          </button>
                          <button className="link-btn" onClick={() => on.onConfirm({ remove: o.currency })} disabled={busy}>
                            Remove…
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button className="secondary" onClick={() => on.onEdit()} disabled={busy}>
              Add a rate
            </button>
            <p className="panel-note">
              The ECB’s rates are reference rates, published for information each working day around 16:00 CET; a weekend or a holiday takes the last working
              day’s. A bank’s own rate can differ: that is what your own rates are for. Changing a rate changes every figure it reaches, past days included, since
              nothing converted is kept. Each total converts each currency once, so the parts of one can differ from it by a cent.
            </p>
          </>
        )
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

/** The sheet's form for a rate of the person's own. */
export function OwnRateForm({
  draft,
  onDraft,
  view,
  currencies,
  busy,
  error,
  onSave,
  onCancel,
}: {
  draft: RateDraft;
  onDraft: (d: RateDraft) => void;
  view: CurrencySettingsView | null;
  currencies: readonly string[];
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const code = draft.currency.trim().toUpperCase();
  const quotes = view ? ['EUR', ...Object.keys(view.ecb.rates).sort()] : ['EUR'];
  const rateError = draft.rate.trim() ? rateTextError(draft.rate.trim()) : null;
  const problem = draftProblem(draft);
  return (
    <div className="sheet-form own-rate-form">
      <label className="field">
        Currency
        <input
          value={draft.currency}
          onChange={(e) => onDraft({ ...draft, currency: e.target.value.toUpperCase() })}
          maxLength={10}
          list="own-rate-currencies"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="BTC"
          disabled={busy}
        />
      </label>
      <datalist id="own-rate-currencies">
        {currencies.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="currency-rate-pair">
        <label className="field">
          1 {code || 'unit'} is
          <input value={draft.rate} onChange={(e) => onDraft({ ...draft, rate: e.target.value })} inputMode="decimal" placeholder="0.92" disabled={busy} />
        </label>
        <label className="field">
          In
          <select value={draft.quote} onChange={(e) => onDraft({ ...draft, quote: e.target.value })} disabled={busy}>
            {quotes.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rateError && <p className="stale-note">{rateError}</p>}
      {view && code && code !== draft.quote && <p className="as-of">{ecbBeside({ currency: code, quote: draft.quote }, view.ecb)}</p>}
      <label className="quick-add-check">
        <input type="checkbox" checked={draft.every} onChange={(e) => onDraft({ ...draft, every: e.target.checked })} disabled={busy} />
        <span>Every day, past ones included</span>
      </label>
      {!draft.every && (
        <label className="field">
          From
          <input type="date" value={draft.from} max={tomorrow()} onChange={(e) => onDraft({ ...draft, from: e.target.value })} disabled={busy} />
        </label>
      )}
      <p className="panel-note">
        {draft.every ? 'It is used for every day, past ones too, instead of the ECB’s.' : 'From that day on it is used instead of the ECB’s; before it, the ECB’s rate where it publishes one.'} A
        rate in a currency other than the euro goes through the ECB’s rate for that currency each day.
      </p>
      <div className="button-pair">
        <button onClick={onSave} disabled={busy || problem !== null}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default function CurrencyCard({ currencies, manual, focus = false, onFocused, onChanged }: Props) {
  const { load, reload, accept } = useCurrencySettings(true);
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState<RateDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirming>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus || !ref.current) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onFocused?.();
  }, [focus, onFocused]);

  const view = load.kind === 'ready' ? load.view : null;

  /** A write, then Home's figures and this card read again. */
  const send = async (url: string, init: RequestInit, done: (data: any) => void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        setError(await errorOf(res, 'It wasn’t saved. Try again.'));
        return;
      }
      done(await res.json().catch(() => ({})));
      setConfirm(null);
      onChanged();
      reload();
    } catch {
      setError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const edit = (o?: OwnRate) => {
    setError(null);
    setDraft(
      o
        ? { currency: o.currency, rate: o.rate, quote: o.quote, every: o.from === null, from: o.from ?? today() }
        : { currency: '', rate: '', quote: view?.home && view.home !== 'EUR' && view.ecb.rates[view.home] ? view.home : 'EUR', every: false, from: today() }
    );
  };
  const saveRate = () => {
    if (!draft || draftProblem(draft)) return;
    void send(
      '/api/currency/rates',
      { method: 'PUT', body: JSON.stringify({ currency: draft.currency.trim().toUpperCase(), rate: draft.rate.trim(), quote: draft.quote, from: draft.every ? null : draft.from }) },
      (d) => {
        accept({ own: d.own ?? [] });
        setDraft(null);
      }
    );
  };

  return (
    <div className="card currency-card" ref={ref}>
      <CurrencyCardBody
        load={load}
        busy={busy}
        confirm={confirm}
        error={draft ? null : error}
        onChoose={() => setChoosing(true)}
        onConfirm={setConfirm}
        onStop={() => void send('/api/currency', { method: 'PUT', body: JSON.stringify({ home: null }) }, () => accept({ home: null }))}
        onRepair={() => void send('/api/currency', { method: 'DELETE' }, () => accept({ home: null, own: [], problem: null, removable: false }))}
        onRemove={(c) => void send(`/api/currency/rates?currency=${encodeURIComponent(c)}`, { method: 'DELETE' }, (d) => accept({ own: d.own ?? [] }))}
        onEdit={edit}
      />

      <CurrencyChoiceSheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title={view?.home ? 'Home currency' : 'Show your totals in one currency'}
        initial={view?.home ?? currencies[0] ?? null}
        first={currencies}
        manual={manual}
        onSaved={(home) => {
          accept({ home });
          onChanged();
          reload();
        }}
      />

      <Sheet
        open={!!draft}
        title={draft && view?.own.some((o) => o.currency === draft.currency) ? `Your rate for ${draft.currency}` : 'A rate of your own'}
        onClose={() => !busy && setDraft(null)}
      >
        {draft && <OwnRateForm draft={draft} onDraft={setDraft} view={view} currencies={currencies} busy={busy} error={error} onSave={saveRate} onCancel={() => setDraft(null)} />}
      </Sheet>
    </div>
  );
}
