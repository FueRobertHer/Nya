"use client";

// Activity tab: month-by-month breakdown of the last ~12 months of
// transactions. A scrollable "Net by month" column row selects the month —
// each column's height is that month's net magnitude and its color the sign
// (green positive, red negative). Below it, a two-line chart traces cumulative
// income vs spend across the days of the selected month. Then a summary shows
// money in / money out / net (transfers and loan payments excluded, so
// credit-card payments don't double-count as both spending and income, and so
// is anything the person excluded; every total is in one currency and says
// what it left out in others: lib/spending.ts); top spending categories
// draw as single-hue horizontal bars (magnitude lives in length, not color);
// and finally the searchable transaction list, where a manual row can be
// edited and any row excluded from budgets and reports.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import MonthFlowChart from "./MonthFlowChart";
import { compactMoney, formatMoney, signedMoney } from "@/lib/format";
import { countsInTotals, currencyOf, isExcluded, leftOutByCurrency, leftOutText, totalsCurrency } from "@/lib/spending";
import { instantDay, localMonth } from "@/lib/local-date";
import { monthGapNotes, type Incomplete, type Stopped } from "@/lib/month-coverage";
import { missingEmptyNotes, missingMonthNotes, noSpending, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from "@/lib/no-transactions";
import { sourceLabel } from "@/lib/manual-txn-input";

// Stable empty defaults, as in Insights: a fresh literal per render would be
// a new identity each time.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

export type Txn = {
  transaction_id: string;
  date: string;
  name: string;
  amount: number;
  pending: boolean;
  account_name: string;
  // As in lib/transactions.ts: the account's type, for the cash forecast.
  account_type?: string | null;
  institution_name: string;
  category: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  vendor_key: string;
  logo_url: string | null;
  category_icon_url: string | null;
  subcategory: string | null;
  category_confidence: string | null;
  transaction_code: string | null;
  payment_channel: string | null;
  datetime: string | null;
  website: string | null;
  check_number: string | null;
  account_owner: string | null;
  city: string | null;
  region: string | null;
  counterparty: string | null;
  payment_processor: string | null;
  payment_reference: string | null;
  // As in lib/transactions.ts: on manual rows, and on rows the person excluded.
  source?: string;
  account_id?: string;
  note?: string | null;
  excluded?: boolean | null;
};

// Amounts in their currency (lib/format.ts), never assumed to be dollars.

// Compact, signed, for the net-bar value labels: +$1.2K / -$340.
function fmtCompactSigned(n: number, currency: string | null): string {
  return `${n < 0 ? "-" : "+"}${compactMoney(Math.abs(n), currency)}`;
}

// Plaid's convention: positive amounts are money leaving the account, so the
// displayed value flips sign (positive = money in).
function fmtTxnAmount(amount: number, currency: string | null): string {
  return signedMoney(-amount, currency, { always: true });
}

// The per-day net, in display terms (positive = net money in), one figure per
// currency the day's rows are in, the totals' first: never added across
// currencies. Zero renders without a sign.
function fmtDayNet(nets: Map<string | null, number>, currency: string | null): string {
  return [...nets.keys()]
    .sort((a, b) => (a === currency ? -1 : b === currency ? 1 : String(a) < String(b) ? -1 : 1))
    .map((c) => {
      const n = nets.get(c)!;
      return signedMoney(Math.abs(n) < 0.005 ? 0 : n, c);
    })
    .join(" · ");
}

function fmtTxnDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: "short" } : { month: "short", year: "2-digit" },
  );
}

// Plaid categorizes with a confidence level; LOW/UNKNOWN rows are worth a
// glance, so the row nudges the user toward the existing recategorize flow.
const LOW_CONFIDENCE = new Set(["LOW", "UNKNOWN"]);
function isLowConfidence(t: Txn): boolean {
  return !!t.category_confidence && LOW_CONFIDENCE.has(t.category_confidence);
}

// Money moving between your own accounts isn't income or spending, and a
// transaction the person excluded counts in no total: both decided in
// lib/spending.ts, which every total uses. isTransfer is re-exported for code
// that imported it from here.
export { isTransfer } from "@/lib/spending";

// A short "HH:MM" from Plaid's ISO datetime, in the viewer's locale. Null when
// the row carries only a posting date.
function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Base category options for recategorization, merged with whatever
// categories appear in the data (categoryOptions).
const BASE_CATEGORIES = [
  "food and drink",
  "general merchandise",
  "transportation",
  "travel",
  "rent and utilities",
  "entertainment",
  "personal care",
  "medical",
  "general services",
  "income",
  "transfer in",
  "transfer out",
  "loan payments",
  "other",
];

/** The categories to choose from: the base ones and every one in the data,
 *  sorted. Shared with the quick-add form (components/ManualTxnSheet.tsx). */
export function categoryOptions(txns: Txn[] | null): string[] {
  const set = new Set(BASE_CATEGORIES);
  (txns ?? []).forEach((t) => {
    if (t.category) set.add(t.category);
  });
  return [...set].sort();
}

// "What is this charge?" detail panel, shown inside the expanded row. Surfaces
// the Plaid fields that answer the question — the real merchant behind a
// processor, channel, place, time, website, reference/check numbers, and (for
// joint accounts) the owner — skipping any the row doesn't carry.
function TxnDetail({ t }: { t: Txn }) {
  const rows: { label: string; value: React.ReactNode }[] = [];
  const time = fmtTime(t.datetime);

  if (t.counterparty) rows.push({ label: "Merchant", value: t.counterparty });
  if (t.payment_processor)
    rows.push({ label: "Processed by", value: t.payment_processor });
  if (t.payment_channel)
    rows.push({ label: "Channel", value: t.payment_channel });
  if (t.city)
    rows.push({
      label: "Where",
      value: t.region ? `${t.city}, ${t.region}` : t.city,
    });
  if (time) rows.push({ label: "Time", value: time });
  if (t.website)
    rows.push({
      label: "Website",
      value: (
        <a
          href={`https://${t.website.replace(/^https?:\/\//, "")}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t.website.replace(/^https?:\/\//, "")}
        </a>
      ),
    });
  if (t.payment_reference)
    rows.push({ label: "Reference", value: t.payment_reference });
  if (t.check_number) rows.push({ label: "Check #", value: t.check_number });
  if (t.account_owner) rows.push({ label: "Owner", value: t.account_owner });
  if (t.note) rows.push({ label: "Note", value: t.note });

  if (rows.length === 0) return null;

  return (
    <dl className="txn-detail">
      {rows.map((r) => (
        <div className="txn-detail-row" key={r.label}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function MonthBreakdown({
  txns,
  notes,
  loading,
  onRecategorize,
  onRename,
  onAddTransaction,
  onImport,
  onEditTransaction,
  onToggleExcluded,
  actionError = null,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
}: {
  txns: Txn[] | null;
  notes: string[];
  loading: boolean;
  onRecategorize: (transaction_id: string, category: string) => void;
  onRename: (vendor_key: string, name: string) => void;
  /** Opens the quick-add form; left out when there is no manual account to
   *  add to, which hides the button. */
  onAddTransaction?: () => void;
  /** Opens the import sheet (components/ImportSheet.tsx); left out, like the
   *  quick-add form's, when there is no manual account to import into. */
  onImport?: () => void;
  /** Opens a manual row's edit form. */
  onEditTransaction?: (t: Txn) => void;
  /** Leaves a transaction out of budgets and reports, or puts it back. */
  onToggleExcluded?: (t: Txn, excluded: boolean) => void;
  /** Why the last change to a transaction didn't save. */
  actionError?: string | null;
  /** Connections that bring in no transactions (lib/no-transactions.ts): an
   *  empty list says why rather than "no transactions", rows entered by hand
   *  or imported name them under the month instead, and a bank account or
   *  card whose transactions don't come in is named under every month. */
  withoutTransactions?: NoTransactionsView;
  /** Institutions whose rows this load lacks, or lacks the oldest of
   *  (/api/transactions), and connections whose transactions have stopped
   *  (their health): the month's totals say so (lib/month-coverage.ts). */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
}) {
  const [month, setMonth] = useState<string | null>(null); // YYYY-MM; null = latest
  const [query, setQuery] = useState("");
  const [recatId, setRecatId] = useState<string | null>(null); // txn being edited
  const [renameDraft, setRenameDraft] = useState(""); // rename input for the open row

  const pickable = useMemo(() => categoryOptions(txns), [txns]);

  const months = useMemo(() => {
    const set = new Set<string>();
    (txns ?? []).forEach((t) => set.add(t.date.slice(0, 7)));
    return [...set].sort().reverse().slice(0, 12);
  }, [txns]);

  // The latest month not after this one: a row dated tomorrow, on the last
  // day of a month, doesn't open the tab on the next.
  const thisMonth = localMonth();
  const selected = month ?? months.find((m) => m <= thisMonth) ?? months[0] ?? null;

  const monthTxns = useMemo(
    () => (txns ?? []).filter((t) => t.date.slice(0, 7) === selected),
    [txns, selected],
  );

  // Every total on the tab sums amounts in one currency, the one most of the
  // transactions are in, the same for every month so the trend compares
  // like with like; the month's rows in others are named, not added
  // (lib/spending.ts).
  const currency = useMemo(() => totalsCurrency(txns ?? []), [txns]);
  const leftOut = useMemo(() => leftOutText(leftOutByCurrency(monthTxns, currency), currency), [monthTxns, currency]);

  // Rows the person excluded, and rows whether they did couldn't be read
  // (counted, so the total may include one): both said under the summary.
  const { excludedCount, unknownCount } = useMemo(() => {
    let excludedCount = 0;
    let unknownCount = 0;
    for (const t of monthTxns) {
      if (t.excluded === true) excludedCount++;
      else if (t.excluded === null) unknownCount++;
    }
    return { excludedCount, unknownCount };
  }, [monthTxns]);

  const { moneyIn, moneyOut, categories } = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    const byCategory: Record<string, number> = {};
    for (const t of monthTxns) {
      if (!countsInTotals(t, currency)) continue;
      if (t.amount < 0) {
        inflow += -t.amount;
      } else {
        outflow += t.amount;
        const cat = t.category ?? "other";
        byCategory[cat] = (byCategory[cat] ?? 0) + t.amount;
      }
    }
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return { moneyIn: inflow, moneyOut: outflow, categories };
  }, [monthTxns, currency]);

  // Online vs in-store spending, from Plaid's payment_channel. Only rows that
  // carry a channel count toward the split (unknown ones are left out rather
  // than guessed), so the two need not sum to the month's total outflow.
  const channelSplit = useMemo(() => {
    let online = 0;
    let inStore = 0;
    for (const t of monthTxns) {
      if (t.amount <= 0 || !countsInTotals(t, currency)) continue;
      if (t.payment_channel === "online") online += t.amount;
      else if (t.payment_channel === "in store") inStore += t.amount;
    }
    return { online, inStore };
  }, [monthTxns, currency]);

  // Top places by spend, from transaction location. Disambiguates same-named
  // merchants and gives a light geo view without a map dependency.
  const topCities = useMemo(() => {
    const byCity: Record<string, number> = {};
    for (const t of monthTxns) {
      if (t.amount <= 0 || !countsInTotals(t, currency) || !t.city) continue;
      const label = t.region ? `${t.city}, ${t.region}` : t.city;
      byCity[label] = (byCity[label] ?? 0) + t.amount;
    }
    return Object.entries(byCity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [monthTxns, currency]);

  // Net per month (oldest → newest) for the trend columns. Bar height tracks
  // net magnitude and bar color tracks its sign (green positive, red negative),
  // so a month you overspent reads as a tall red bar and one you saved as a
  // tall green one.
  const trend = useMemo(
    () =>
      [...months].reverse().map((m) => {
        let inflow = 0;
        let outflow = 0;
        for (const t of txns ?? []) {
          if (t.date.slice(0, 7) !== m || !countsInTotals(t, currency)) continue;
          if (t.amount < 0) inflow += -t.amount;
          else outflow += t.amount;
        }
        return { month: m, net: inflow - outflow };
      }),
    [txns, months, currency],
  );

  // Keep the newest month in view when the row overflows (older months scroll
  // off to the left).
  const trendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = trendRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trend.length]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return monthTxns;
    return monthTxns.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.category ?? "").includes(q) ||
        t.account_name.toLowerCase().includes(q) ||
        t.institution_name.toLowerCase().includes(q),
    );
  }, [monthTxns, query]);

  // Group the visible rows into day sections, each carrying the day's net in
  // display terms (positive = money in) for each currency its rows are in, so
  // the header adds up the rows shown under it. A row the person excluded is
  // left out of it, as of every total.
  const days = useMemo(() => {
    const groups: { date: string; nets: Map<string | null, number>; txns: Txn[] }[] = [];
    for (const t of visible) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== t.date) {
        g = { date: t.date, nets: new Map(), txns: [] };
        groups.push(g);
      }
      g.txns.push(t);
      if (isExcluded(t)) continue;
      const c = currencyOf(t) ?? currency;
      g.nets.set(c, (g.nets.get(c) ?? 0) - t.amount);
    }
    return groups;
  }, [visible, currency]);

  if (loading) {
    return (
      <div className="card">
        <div
          className="spinner"
          role="status"
          aria-label="Loading transactions"
        />
      </div>
    );
  }

  // Entering a transaction by hand or importing a file, on a manual account:
  // first on the tab, where a phone reaches it without scrolling.
  const addCard = onAddTransaction && (
    <div className="card">
      {onImport ? (
        <div className="button-pair" style={{ marginTop: 0 }}>
          <button onClick={onAddTransaction}>Add a transaction</button>
          <button className="secondary" onClick={onImport}>
            Import a file
          </button>
        </div>
      ) : (
        <button onClick={onAddTransaction}>Add a transaction</button>
      )}
      <p className="panel-note">
        On one of your manual accounts: cash, or a bank Plaid can&apos;t reach, typed in or imported from the
        bank&apos;s file. It doesn&apos;t change the account&apos;s balance unless you ask.
      </p>
    </div>
  );

  if (!txns || (txns.length === 0 && notes.length === 0)) {
    // Connections that can't bring any in are not an empty year.
    const none = txns ? noSpending(withoutTransactions, txns.length) : null;
    const missing = txns && !none ? missingEmptyNotes(withoutTransactions) : [];
    return (
      <>
        {addCard}
        <div className="card">
          <p className="empty-note">
            {none
              ? `${none.lead}, so there are no bank or card transactions to show. To see spending, ${none.remedy}${onAddTransaction ? (onImport ? ", or add a transaction by hand or import a file" : ", or add a transaction by hand") : ""}.`
              : "No transactions in the last 12 months."}
          </p>
          {missing.map((n) => (
            <div className="stale-note" key={n}>
              {n}
            </div>
          ))}
        </div>
      </>
    );
  }

  const net = moneyIn - moneyOut;
  const maxCat = categories.length > 0 ? categories[0][1] : 1;
  // A total that looks finished but may not be says so, under the total.
  const gapNotes = selected
    ? [...monthGapNotes(selected, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)), ...missingMonthNotes(withoutTransactions)]
    : [];
  // When only rows entered by hand are here, the connections that bring in
  // none are named beside the totals: where they come from, not a warning.
  const namedWithout = withoutNote(withoutTransactions, txns.length);

  return (
    <>
      {addCard}
      {trend.length > 1 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Net by month</div>
            <div className="inst-total">tap a month to select</div>
          </div>
          <div className="trend-row" ref={trendRef}>
            {(() => {
              const max = Math.max(...trend.map((t) => Math.abs(t.net)), 1);
              return trend.map(({ month: m, net }) => (
                <button
                  key={m}
                  className={`trend-col${m === selected ? " active" : ""}`}
                  onClick={() => setMonth(m)}
                  aria-pressed={m === selected}
                  aria-label={`${monthLabel(m)}: net ${formatMoney(net, currency)}`}
                >
                  <span className="trend-val">{fmtCompactSigned(net, currency)}</span>
                  <span
                    className={`trend-bar${net >= 0 ? " up" : " down"}`}
                    style={{
                      height: `${Math.max((Math.abs(net) / max) * 72, 2)}px`,
                    }}
                  />
                  <span className="trend-label">{monthLabel(m)}</span>
                </button>
              ));
            })()}
          </div>
        </div>
      )}

      {selected && monthTxns.length > 0 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Income vs spend</div>
            <div className="inst-total">{monthLabel(selected)}</div>
          </div>
          <MonthFlowChart txns={monthTxns} month={selected} currency={currency} />
        </div>
      )}

      <div className="card">
        <div className="summary-row">
          <div>
            <div className="total-label">In</div>
            <div className="summary-value inflow">
              {formatMoney(moneyIn, currency)}
            </div>
          </div>
          <div>
            <div className="total-label">Out</div>
            <div className="summary-value">{formatMoney(moneyOut, currency)}</div>
          </div>
          <div>
            <div className="total-label">Net</div>
            <div
              className={`summary-value${net < 0 ? " negative" : net > 0 ? " inflow" : ""}`}
            >
              {formatMoney(net, currency)}
            </div>
          </div>
        </div>
        <div className="chart-note">
          Transfers and loan payments excluded
          {excludedCount > 0 &&
            `, and ${excludedCount} transaction${excludedCount === 1 ? "" : "s"} you left out`}
          .
          {unknownCount > 0 &&
            ` Whether you excluded ${unknownCount} transaction${unknownCount === 1 ? "" : "s"} couldn't be read, so ${unknownCount === 1 ? "it counts" : "they count"} here.`}
          {leftOut && ` ${leftOut}`}
          {namedWithout && ` ${namedWithout}`}
        </div>
        {gapNotes.map((n) => (
          <div className="stale-note" key={n}>
            {n}
          </div>
        ))}
      </div>

      {categories.length > 0 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Top spending</div>
          </div>
          <div className="cat-list">
            {categories.map(([cat, sum]) => (
              <div className="cat-row" key={cat}>
                <span className="cat-name">{cat}</span>
                <div className="cat-track">
                  <div
                    className="cat-bar"
                    style={{ width: `${(sum / maxCat) * 100}%` }}
                  />
                </div>
                <span className="cat-val">{formatMoney(sum, currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(channelSplit.online > 0 || channelSplit.inStore > 0) && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Online vs in-store</div>
          </div>
          {(() => {
            const total = channelSplit.online + channelSplit.inStore;
            const rows: [string, number][] = [
              ["Online", channelSplit.online],
              ["In store", channelSplit.inStore],
            ];
            return (
              <div className="cat-list">
                {rows.map(([label, sum]) => (
                  <div className="cat-row" key={label}>
                    <span className="cat-name">{label}</span>
                    <div className="cat-track">
                      <div
                        className="cat-bar"
                        style={{ width: `${total > 0 ? (sum / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="cat-val">{formatMoney(sum, currency)}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {topCities.length > 0 && (
        <div className="card">
          <div className="inst-header">
            <div className="inst-name">Where you spent</div>
          </div>
          <div className="cat-list">
            {topCities.map(([place, sum]) => (
              <div className="cat-row" key={place}>
                <span className="cat-name">{place}</span>
                <div className="cat-track">
                  <div
                    className="cat-bar"
                    style={{ width: `${(sum / topCities[0][1]) * 100}%` }}
                  />
                </div>
                <span className="cat-val">{formatMoney(sum, currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Transactions</div>
          <div className="inst-total">
            {visible.length}
            {query ? ` of ${monthTxns.length}` : ""}
          </div>
        </div>

        <input
          className="text-input search-input"
          type="search"
          placeholder="Search transactions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {actionError && <div className="error">{actionError}</div>}

        {visible.length === 0 ? (
          <p className="empty-note">
            {query
              ? "No transactions match your search."
              : "No transactions this month."}
          </p>
        ) : (
          <table className="txn-table">
            <tbody>
              {days.map((g) => (
                <Fragment key={g.date}>
                  <tr className="txn-date-header">
                    <td>{fmtTxnDate(g.date)}</td>
                    <td className="num">{fmtDayNet(g.nets, currency)}</td>
                  </tr>
                  {g.txns.map((t, i) => (
                    <tr
                      key={t.transaction_id}
                      className={`acct-row${i === g.txns.length - 1 ? " last-in-day" : ""}`}
                      onClick={() => {
                        const opening = recatId !== t.transaction_id;
                        setRecatId(opening ? t.transaction_id : null);
                        if (opening) setRenameDraft(t.name);
                      }}
                    >
                      <td>
                        <div className="txn-main">
                          {t.logo_url || t.category_icon_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              className="txn-logo"
                              src={(t.logo_url || t.category_icon_url) ?? undefined}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span
                              className="txn-logo txn-logo-fallback"
                              aria-hidden="true"
                            >
                              {t.name.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <div className="txn-text">
                            <div>
                              {t.name}
                              {t.pending && (
                                <span className="pending-tag"> · pending</span>
                              )}
                              {isLowConfidence(t) && (
                                <span
                                  className="low-conf-tag"
                                  title="Plaid was unsure of this category — tap to fix it"
                                >
                                  {" "}
                                  · check category
                                </span>
                              )}
                            </div>
                            <div className="type-tag">
                              {t.institution_name} · {t.account_name}
                              {t.category ? ` · ${t.category}` : ""}
                              {t.subcategory ? ` › ${t.subcategory}` : ""}
                              {t.source ? ` · ${sourceLabel(t.source)}` : ""}
                            </div>
                            {t.excluded === true && (
                              <div className="excluded-tag">
                                Excluded from budgets and reports
                              </div>
                            )}
                            {t.excluded === null && (
                              <div className="excluded-tag">
                                Couldn&apos;t read whether you excluded this
                              </div>
                            )}
                          </div>
                        </div>
                        {recatId === t.transaction_id && (
                          <div
                            className="txn-edit"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <select
                              className="text-input recat-select"
                              value={t.category ?? "other"}
                              onChange={(e) => {
                                onRecategorize(t.transaction_id, e.target.value);
                                setRecatId(null);
                              }}
                              aria-label={`Category for ${t.name}`}
                            >
                              {pickable.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            {t.source && onEditTransaction && (
                              <div className="rename-row">
                                <button
                                  className="secondary"
                                  onClick={() => {
                                    onEditTransaction(t);
                                    setRecatId(null);
                                  }}
                                >
                                  Edit or delete
                                </button>
                              </div>
                            )}
                            {t.vendor_key && (
                              <>
                                <div className="rename-row">
                                  <input
                                    className="text-input"
                                    value={renameDraft}
                                    maxLength={100}
                                    onChange={(e) =>
                                      setRenameDraft(e.target.value)
                                    }
                                    placeholder="Rename vendor"
                                    aria-label={`Rename ${t.name}`}
                                  />
                                  <button
                                    className="secondary"
                                    disabled={renameDraft.trim() === t.name}
                                    onClick={() => {
                                      onRename(t.vendor_key, renameDraft.trim());
                                      setRecatId(null);
                                    }}
                                  >
                                    Rename
                                  </button>
                                </div>
                                <div className="rename-hint">
                                  Applies to this vendor&apos;s transactions;
                                  older ones may update later.
                                </div>
                              </>
                            )}
                            {/* A pending row gets a new id when it posts,
                                and an exclusion is kept by id: offered once
                                it has posted, so it can't quietly lapse. */}
                            {onToggleExcluded && t.pending && t.excluded !== true && (
                              <div className="rename-hint">
                                Once it posts, it can be excluded from budgets and reports.
                              </div>
                            )}
                            {onToggleExcluded && (!t.pending || t.excluded === true) && (
                              <>
                                <div className="rename-row">
                                  <button
                                    className="secondary"
                                    onClick={() => {
                                      onToggleExcluded(t, t.excluded !== true);
                                      setRecatId(null);
                                    }}
                                  >
                                    {t.excluded === true
                                      ? "Include in budgets and reports"
                                      : "Exclude from budgets and reports"}
                                  </button>
                                </div>
                                <div className="rename-hint">
                                  {t.excluded === true
                                    ? "Puts it back in totals, budgets, insights, bills and the Plan."
                                    : "For a one-off: it stays in this list, out of totals, budgets, insights, bills and the Plan."}
                                </div>
                              </>
                            )}
                            <TxnDetail t={t} />
                          </div>
                        )}
                      </td>
                      <td className={`num${t.amount < 0 ? " inflow" : ""}${t.excluded === true ? " excluded" : ""}`}>
                        {fmtTxnAmount(t.amount, currencyOf(t) ?? currency)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}

        {notes.map((n) => (
          <div className="error" key={n}>
            {n}
          </div>
        ))}
      </div>
    </>
  );
}
