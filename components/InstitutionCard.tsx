'use client';

// One institution's card on the Accounts tab: its header and subtotal, its
// account rows, and the notices about its connection. Each row is one button
// that opens the account's sheet (components/AccountSheet.tsx), where its
// details and actions are: nothing inside a row is another control.

import { ReconnectSoonNote } from './ConnectionHealth';
import { AccountQuestions, type useAccountLifecycle } from './AccountLifecycle';
import { Masked } from './HideAmounts';
import { institutionNote } from './currency-text';
import { HoldingsTable } from './AccountSheet';
import { connectorLabel } from '@/lib/connectors/types';
import { balancesNow, needsConverting } from '@/lib/fx/view';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import { dominantCurrency } from '@/lib/format';
import { institutionCash } from '@/lib/cash';
import {
  accountKind,
  balanceDay,
  canEnableLiabilities,
  fmt,
  fmtStaleDay,
  heldLine,
  liabilitySummary,
  signedBalance,
  type Institution,
} from './accounts-format';

export const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export type InstitutionCardProps = {
  inst: Institution;
  /** Every institution as loaded, hidden accounts included, for the questions about them. */
  institutions: Institution[];
  base: NetWorthBase | null;
  shownCurrency: string | null;
  connecting: boolean;
  expandedHoldings: Set<string>;
  unallowedIds: Set<string>;
  lifecycle: Pick<ReturnType<typeof useAccountLifecycle>, 'busy' | 'open' | 'stillOpen' | 'confirmEnd' | 'reopen'>;
  /** Opens the account's sheet. */
  onOpenAccount: (account_id: string) => void;
  toggleHoldings: (item_id: string) => void;
  setOptionsTarget: (inst: Institution) => void;
  startReconnect: (item_id: string) => void;
  startAllowTransactions: (item_id: string) => void;
  startEnableLiabilities: (item_id: string) => void;
  startManageAccounts: (item_id: string) => void;
};

export default function InstitutionCard({
  inst,
  institutions,
  base,
  shownCurrency,
  connecting,
  expandedHoldings,
  unallowedIds,
  lifecycle,
  onOpenAccount,
  toggleHoldings,
  setOptionsTarget,
  startReconnect,
  startAllowTransactions,
  startEnableLiabilities,
  startManageAccounts,
}: InstitutionCardProps) {
  // One verdict for the row badge, the per-holding chip and the
  // Holdings header, so they can't disagree about the same money.
  // `inst` is already filtered, so a hidden brokerage takes its
  // cash with it.
  const instCash = institutionCash(inst.accounts, inst.holdings);
  const looseHoldings = inst.holdings.filter((h) => !h.account_id);
  const instTotal = inst.accounts.reduce((sum, a) => sum + signedBalance(a), 0);
  const instCurrency = dominantCurrency(
    inst.accounts.map((a) => ({ iso_currency_code: a.currency }))
  );
  const instMixed =
    new Set(inst.accounts.map((a) => a.currency).filter(Boolean)).size > 1;
  // Mixed, with a home currency chosen: converted into it, at
  // the newest rates, as the hero is (lib/fx/view.ts).
  const instRows = inst.accounts.map((a) => ({ amount: signedBalance(a), currency: a.currency }));
  const instConverted = instMixed && base && needsConverting(instRows, base.fx, instCurrency) ? balancesNow(instRows, base.fx, instCurrency) : null;
  // Every row, hidden ones too, for the questions about them
  // (#50), and whether each one held was answered Still open.
  const allRows = institutions.find((i) => i.item_id === inst.item_id)?.accounts ?? inst.accounts;
  const heldRows = allRows.filter((a) => a.held);
  const heldStillOpen = heldRows.length > 0 && heldRows.every((a) => a.question?.still_open);
  return (
    <div className="card" key={inst.item_id}>
      <div className="inst-header">
        <div className="inst-name">
          {inst.institution_name}
          {inst.manual && <span className="manual-badge">{inst.connector ? `via ${inst.health?.detail?.label ?? connectorLabel(inst.connector)}` : 'Manual'}</span>}
        </div>
        <div className="inst-header-right">
          <div className="inst-total">
            <Masked>{fmt(instConverted ? instConverted.total : instTotal, instConverted ? instConverted.currency : instCurrency)}</Masked>
          </div>
          {/* Add or remove accounts and Disconnect. Manual
              groupings aren't Plaid Items, so there's nothing
              to disconnect; they're removed per account. */}
          {!inst.manual && (
            <button
              className="secondary inst-options"
              onClick={() => setOptionsTarget(inst)}
              aria-label={`Options for ${inst.institution_name}`}
            >
              Options
            </button>
          )}
        </div>
      </div>

      {instMixed && (
        <div className="chart-note">
          {instConverted ? institutionNote(instConverted) : <>Mixed currencies; total isn&apos;t converted.</>}
        </div>
      )}

      {inst.accounts.length > 0 && (
        <ul className="list-rows">
          {inst.accounts.map((a) => {
            const liabLine = liabilitySummary(a);
            // Undefined on an account that is cash by design:
            // institutionCash drops those, since 100% cash in a
            // cash management account is the account working.
            const cash = instCash.byAccount[a.account_id];
            // Missing from its bank's answer, held until the question
            // below is answered (#50): said, not passed off as now.
            const held = heldLine(a);
            // A Plaid balance is implicitly "now"; a typed or synced
            // one says when it was set.
            const day = held ? null : balanceDay(a, inst);
            const overdue = !!liabLine && !!a.liability?.is_overdue;
            return (
              <li key={a.account_id}>
                <button className="list-row" onClick={() => onOpenAccount(a.account_id)}>
                  <span className="list-row-text">
                    <span className="list-row-title">
                      {a.name}
                      {a.mask && <span className="acct-mask"> ••{a.mask}</span>}
                    </span>
                    <span className="list-row-sub">
                      {overdue && (
                        <>
                          <span className="badge neg">Overdue</span>
                          {' · '}
                        </>
                      )}
                      {liabLine ? <Masked>{liabLine}</Masked> : accountKind(a, inst, shownCurrency)}
                      {held && <> <span className="badge warn">{held}</span></>}
                      {day && <> <span className="badge">{day}</span></>}
                      {/* Money in the settlement fund rather than invested;
                          amber only for an amount worth acting on
                          (lib/cash.ts). Its share is in the sheet. */}
                      {cash && cash.cash > 0 && (
                        <>
                          {' '}
                          <span className={`badge${cash.flagged ? ' warn' : ''}`}>
                            <Masked>{fmt(cash.cash, a.currency)}</Masked>
                            {cash.flagged ? ' uninvested' : ' in cash'}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="list-row-value">
                    <Masked>{a.held && a.balance == null ? '--' : fmt(signedBalance(a), a.currency)}</Masked>
                  </span>
                  {CHEVRON}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Positions a payload cached before they named their account
          can't go in an account's sheet, so they stay here. */}
      {looseHoldings.length > 0 && (
        <>
          <button
            className="holdings-toggle"
            onClick={() => toggleHoldings(inst.item_id)}
            aria-expanded={expandedHoldings.has(inst.item_id)}
          >
            <span className="holdings-title">
              Holdings
              <span className="holdings-count">{looseHoldings.length}</span>
            </span>
            <span className="holdings-summary">
              <Masked>{fmt(looseHoldings.reduce((sum, h) => sum + (h.value ?? 0), 0), instCurrency)}</Masked>
              <svg
                className={`chevron${expandedHoldings.has(inst.item_id) ? ' open' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </button>
          {expandedHoldings.has(inst.item_id) && <HoldingsTable holdings={looseHoldings} flagged={instCash.flaggedAccounts} />}
        </>
      )}

      {/* Plaid's week of notice that this connection will end:
          the badge, the date and Reconnect, while it still works. */}
      <ReconnectSoonNote inst={inst} connecting={connecting} onReconnect={startReconnect} />

      {/* Recovering the balances adds a date to the error; it
          does not replace the error. The distinction matters:
          "could not fetch balances" usually clears itself,
          while "needs to be reconnected" never does until you
          act, and collapsing both into a soft "couldn't
          refresh" would let a dead connection look healthy for
          as long as the recovered numbers stay plausible --
          the same failure this feature exists to prevent, moved
          from the total to the label. So reauth keeps the red
          treatment and its own wording, and only a transient
          failure with real numbers behind it goes amber. */}
      {inst.error && (
        <div
          className={
            // Amber is for "real numbers, just dated". A card
            // missing rows isn't that: its subtotal is wrong,
            // not merely old, so it keeps the red treatment.
            inst.stale_as_of && !inst.needs_reauth && !inst.stale_missing
              ? 'stale-note'
              : 'error'
          }
        >
          {inst.error}
          {inst.stale_as_of && ` · balances as of ${fmtStaleDay(inst.stale_as_of, inst.stale_as_of_at)}`}
          {/* The shortfall is disclosed, not hidden: a card
              drawn short understates debt, which overstates
              net worth. Why a row is missing is unknowable
              here (see lib/last-known.ts), so say the count
              rather than guess at a reason. */}
          {!!inst.stale_missing &&
            ` · ${inst.stale_missing} account${
              inst.stale_missing === 1 ? '' : 's'
            } couldn't be shown, so this total is incomplete`}
          {inst.stale_too_old &&
            ` · last known balances are from ${fmtStaleDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to show`}
        </div>
      )}

      {/* Its own block, NOT part of the error above, because
          there is no error: this institution answered and the
          balances on the card are fresh. It just answered with
          fewer accounts than it used to have, so the subtotal
          is short and nothing is being written to history
          until that resolves.

          Amber rather than red for the same reason the stale
          case is: the numbers shown are real. What is wrong is
          that there are not all of them. */}
      {!!inst.unconfirmed_missing && !inst.error && (
        <div className="stale-note">
          {inst.unconfirmed_missing} account
          {inst.unconfirmed_missing === 1 ? '' : 's'} this institution used to
          report {inst.unconfirmed_missing === 1 ? "isn't" : "aren't"} in its latest
          response · {inst.unconfirmed_missing === 1 ? 'it is' : 'they are'} held at{' '}
          {inst.unconfirmed_missing === 1 ? 'its' : 'their'} last known balance
          {/* Answered Still open: held for the account, two weeks at most. */}
          {heldStillOpen
            ? ` until ${inst.unconfirmed_missing === 1 ? 'it comes' : 'they come'} back, two weeks from your answer at most, and history is paused until then`
            : ` until you say whether ${inst.unconfirmed_missing === 1 ? 'it' : 'they'} closed, and history is paused until then`}
        </div>
      )}

      {/* The questions about its accounts (#50): missing
          from its answer, at zero for weeks, or ended and
          still reported. From every row, a hidden one's too:
          its absence holds every total all the same. */}
      <AccountQuestions
        accounts={[...allRows, ...(inst.ended_reported ?? [])]}
        institution={inst.institution_name}
        busy={lifecycle.busy}
        onOpen={lifecycle.open}
        onStillOpen={lifecycle.stillOpen}
        onConfirmEnd={lifecycle.confirmEnd}
        onReopen={lifecycle.reopen}
      />

      {/* Tells someone who just tapped Enable why the button
          vanished without any payment details appearing. */}
      {inst.liabilities === 'loading' && (
        <p className="empty-note">
          Payment details are still importing from this institution.
        </p>
      )}

      {inst.new_accounts_available && !inst.manual && (
        <p className="empty-note">
          {inst.institution_name} has accounts you haven&apos;t added yet.
        </p>
      )}

      {unallowedIds.has(inst.item_id) && (
        <p className="empty-note">
          You didn&apos;t allow Nya to see transactions from the bank or card accounts here.
        </p>
      )}

      {/* One container, independent actions. Enable must NOT
          sit inside a needs_reauth gate: a healthy institution
          is exactly the case it exists for. */}
      {(inst.needs_reauth ||
        canEnableLiabilities(inst) ||
        unallowedIds.has(inst.item_id) ||
        (!inst.manual && inst.new_accounts_available)) && (
        <div className="card-actions">
          {inst.needs_reauth && (
            <button onClick={() => startReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${inst.institution_name}`}>
              Reconnect
            </button>
          )}
          {unallowedIds.has(inst.item_id) && (
            <button
              className="secondary"
              onClick={() => startAllowTransactions(inst.item_id)}
              disabled={connecting}
              aria-label={`Allow transactions from ${inst.institution_name}`}
            >
              Allow transactions
            </button>
          )}
          {canEnableLiabilities(inst) && (
            <button
              className="secondary"
              onClick={() => startEnableLiabilities(inst.item_id)}
              disabled={connecting}
            >
              Enable payment details
            </button>
          )}
          {/* Adds accounts to THIS Item rather than connecting
              the institution again (a second, separately
              billed Item). Here whenever Plaid has found new
              accounts; always under Options. */}
          {!inst.manual && inst.new_accounts_available && (
            <button
              className="secondary"
              onClick={() => startManageAccounts(inst.item_id)}
              disabled={connecting}
            >
              Review accounts
            </button>
          )}
        </div>
      )}
    </div>
  );
}
