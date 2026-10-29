'use client';

// components/PlanCurrency.tsx
//
// What the Plan tab says about the currency its typed figures are in
// (lib/fire/plan-currency.ts), in one card:
//   - ask: the currency isn't known (a plan saved before it was recorded, a
//     record that no longer fits, one that can't be read). A button for each
//     currency in sight, the one a record said first ("They're still in
//     USD"), and any other code from the list, so there is always an answer.
//   - first: a plan with nothing typed yet, whose currency can't be told from
//     the accounts: which one the person will type in, before they do.
//   - recorded: the currency, always said, with what it means when the
//     accounts or spending are in another, and Change, which confirms in a
//     drawer what a change means before it is made. Just after a change, the
//     one before is offered back.
// Nothing here converts or relabels on its own: each change is the person's
// word, and every error is announced.

import { useState, type ReactNode, type RefObject } from 'react';
import { Sheet } from './Sheet';
import { everyCurrency, currencyName } from './currency-state';
import { recordedText, relabelText } from '@/lib/fire/plan-currency';
import { Notice } from './TotalCaveats';

export type CurrencyCardMode =
  | { kind: 'ask'; text: string; offer: string[]; was: string | null; canAnswer: boolean }
  | { kind: 'first'; text: string; offer: string[]; picked: string | null }
  | { kind: 'waiting'; text: string }
  | { kind: 'recorded'; currency: string; kept: string | null; relabelTo: string | null; previous: string | null; scenariosIn: number; offer: string[] }
  | { kind: 'none' };

/** Every code this browser knows, with its name, worked out once. */
let choices: { code: string; name: string }[] | null = null;
const everyChoice = () => (choices ??= everyCurrency().map((code) => ({ code, name: currencyName(code) })));

/** Any other code, from the list of every one: the answer when nothing in
 *  sight is the right one, or nothing is in sight at all. */
function AnotherCurrency({ except, disabled, label, verb, onChoose }: { except: string[]; disabled: boolean; label: string; verb: string; onChoose: (c: string) => void }) {
  const codes = everyChoice().filter((c) => !except.includes(c.code));
  const [code, setCode] = useState('');
  return (
    <div className="sheet-form" style={{ marginTop: 12 }}>
      <label className="field">
        {label}
        <select value={code} onChange={(e) => setCode(e.target.value)} disabled={disabled}>
          <option value="">Choose a currency</option>
          {codes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} ({c.name})
            </option>
          ))}
        </select>
      </label>
      <button className="secondary" style={{ marginTop: 8 }} disabled={disabled || !code} onClick={() => onChoose(code)}>
        {code ? `${verb} ${code}` : `${verb} the one chosen`}
      </button>
    </div>
  );
}

const Alert = ({ text }: { text: string }) =>
  text ? (
    <Notice level="critical" role="alert">
      {text}
    </Notice>
  ) : null;

export function PlanCurrencyCard({
  mode,
  failure = null,
  disabled,
  regionRef,
  onAnswer,
  onPick,
}: {
  mode: CurrencyCardMode;
  /** Why the tab couldn't record it itself, when it tried. */
  failure?: string | null;
  /** A save or a record is under way: nothing here starts another. */
  disabled: boolean;
  /** The card, for focus once an answer is recorded. */
  regionRef?: RefObject<HTMLDivElement | null>;
  /** Records the person's answer; true once it is recorded, or why not. */
  onAnswer: (currency: string) => Promise<true | string>;
  /** Before a first amount: the currency the person will type in (null to
   *  choose again). Recorded with that first amount's save. */
  onPick: (currency: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The change drawer: open, and the currency chosen in it, to confirm.
  const [changing, setChanging] = useState<{ to: string | null } | null>(null);
  const off = disabled || busy;
  const answer = async (c: string) => {
    setBusy(true);
    setError('');
    const r = await onAnswer(c);
    setBusy(false);
    if (r !== true) setError(r);
    return r === true;
  };
  if (mode.kind === 'none') return null;
  // One element in every mode, so focus moved to it survives a change of
  // mode; quiet when nothing about the currency needs the person.
  const region = (body: ReactNode, quiet = false) => (
    <div className={quiet ? 'plan-currency-quiet' : 'card'} role="region" aria-label="Your plan’s currency" tabIndex={-1} ref={regionRef}>
      {body}
    </div>
  );

  if (mode.kind === 'waiting') {
    return region(
      <p className="panel-note" style={{ marginTop: 0 }} role="status">
        {mode.text}
      </p>
    );
  }

  if (mode.kind === 'ask') {
    return region(
      <>
        <div className="stack tight">
          <div className="inst-header">
            <div className="inst-name">Which currency are your plan’s figures in?</div>
          </div>
          <p className="panel-note">{mode.text}</p>
          <Alert text={failure ?? ''} />
          <Alert text={error} />
        </div>
        {mode.canAnswer && (
          <>
            {mode.offer.length > 0 && (
              <div className="action-row" style={{ marginTop: 12 }}>
                {mode.offer.map((c) => (
                  <button key={c} className="secondary" disabled={off} onClick={() => void answer(c)}>
                    {c === mode.was ? `They’re still in ${c}` : `They’re in ${c}`}
                  </button>
                ))}
              </div>
            )}
            <AnotherCurrency except={mode.offer} disabled={off} label={mode.offer.length > 0 ? 'Or another currency' : 'The currency they’re in'} verb="They’re in" onChoose={(c) => void answer(c)} />
          </>
        )}
      </>
    );
  }

  if (mode.kind === 'first') {
    return region(
      <>
        <div className="inst-header">
          <div className="inst-name">Which currency will your plan’s figures be in?</div>
        </div>
        {mode.picked ? (
          <>
            <p className="panel-note">You’ll type your plan’s figures in {mode.picked}: it is recorded with the first one you save, and they stay in it, whatever your accounts are in.</p>
            <button className="secondary" style={{ marginTop: 8 }} disabled={off} onClick={() => onPick(null)}>
              Choose another
            </button>
          </>
        ) : (
          <>
            <p className="panel-note">{mode.text}</p>
            {mode.offer.length > 0 && (
              <div className="action-row" style={{ marginTop: 12 }}>
                {mode.offer.map((c) => (
                  <button key={c} className="secondary" disabled={off} onClick={() => onPick(c)}>
                    In {c}
                  </button>
                ))}
              </div>
            )}
            <AnotherCurrency except={mode.offer} disabled={off} label={mode.offer.length > 0 ? 'Or another currency' : 'The currency you’ll type them in'} verb="In" onChoose={(c) => onPick(c)} />
          </>
        )}
      </>
    );
  }

  // Recorded. Said always; one line when the accounts, the spending and the
  // last answer all agree with it, so the tab doesn't open on a notice.
  const others = mode.offer.filter((c) => c !== mode.currency);
  const to = changing?.to ?? null;
  const quiet = !mode.kept && !(mode.previous && mode.previous !== mode.currency) && !(mode.relabelTo && mode.relabelTo !== mode.currency);
  const change = (
    <button className={quiet ? 'btn ghost' : 'plan-edit'} disabled={off} onClick={() => setChanging({ to: null })} aria-label="Change the currency your plan’s figures are in">
      Change
    </button>
  );
  return region(
    <>
      <div className="stack tight">
        {quiet ? (
          <p className="plan-currency-line">
            <span>{recordedText(mode.currency)}</span>
            {change}
          </p>
        ) : (
          <p className="panel-note">{mode.kept ?? recordedText(mode.currency)}</p>
        )}
        {mode.previous && mode.previous !== mode.currency && (
          <p className="panel-note">
            Changed from {mode.previous}. If that was a mistake, say so and they’re read in {mode.previous} again.{' '}
            <button className="link-btn" disabled={off} onClick={() => void answer(mode.previous!)}>
              They’re in {mode.previous}
            </button>
          </p>
        )}
        {!quiet && (
          <div className="action-row">
            {mode.relabelTo && mode.relabelTo !== mode.currency && (
              <button className="secondary" disabled={off} onClick={() => setChanging({ to: mode.relabelTo })}>
                They’re in {mode.relabelTo}
              </button>
            )}
            {change}
          </div>
        )}
        {!changing && <Alert text={error} />}
      </div>
      <Sheet open={!!changing} title="The currency your plan’s figures are in" onClose={() => setChanging(null)}>
        {changing && to === null && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              They’re recorded as {mode.currency}. Change it only if the figures you typed are in another currency: nothing is converted.
            </p>
            {others.length > 0 && (
              <div className="action-row" style={{ marginTop: 12 }}>
                {others.map((c) => (
                  <button key={c} className="secondary" onClick={() => setChanging({ to: c })}>
                    They’re in {c}
                  </button>
                ))}
              </div>
            )}
            <AnotherCurrency except={[mode.currency, ...others]} disabled={off} label={others.length > 0 ? 'Or another currency' : 'The currency they’re in'} verb="They’re in" onChoose={(c) => setChanging({ to: c })} />
          </>
        )}
        {changing && to !== null && (
          <>
            <div className="stack tight">
              <p className="panel-note">Read your plan’s figures as {to}, not {mode.currency}?</p>
              <p className="panel-note">{relabelText(mode.currency, to, mode.scenariosIn)}</p>
              <Alert text={error} />
            </div>
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setChanging(null)} disabled={busy}>
                Cancel
              </button>
              <button
                disabled={off}
                onClick={async () => {
                  if (await answer(to)) setChanging(null);
                }}
              >
                {busy ? 'Saving…' : `Read them as ${to}`}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </>,
    quiet
  );
}
