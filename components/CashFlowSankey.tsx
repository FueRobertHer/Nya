'use client';

// The Activity tab's cash flow (#41): where money came from and where it went
// over a period, drawn as a Sankey diagram. Payers on the left flow into
// everything counted, which flows out to your category groups and on to their
// categories, with what was left over beside the groups, or, in a period that
// spent more than came in, what came from savings or debt beside the payers.
// The complement of the month's income vs spend line (MonthFlowChart): that
// one says when, this one says into what.
//
// THE TOTALS' OWN FIGURES. The flows are lib/cash-flow.ts's, from the rows the
// tab totals, by the rules the month's totals follow: the money in is the tab's
// money in for the same months, and spending by category the Budgets tab's,
// to the cent, in the one currency the tab's totals are in, and every count is
// of transactions, as theirs is (#39): a split one once, however its parts
// are spread, and a group as many as it holds. What it leaves out, and what
// may be missing from the period, is said beside it.
//
// HOUSE STYLE. Dependency-free inline SVG on a 340-wide viewBox, as the other
// charts, laid out by a pure function (lib/sankey.ts), its colors the app's
// own variables: money in and what is left over in the up hue, spending in
// the accent, what came from savings or debt in the down hue. Labels sit
// outside their nodes, which are too thin to hold them, cut to fit.
//
// TAPPING a payer, a group, a category or a fold lists its transactions in the
// Activity list below (components/MonthBreakdown.tsx), with the list's own
// search and tag filter on top, and tapping it again stops. The chart is an
// image to a screen reader: its text alternative is the table under it, every
// flow with its amount, each row's name a button that does what a tap does.

import { Fragment, useMemo, useState, type Ref } from 'react';
import { compactMoney, formatMoney } from '@/lib/format';
import { displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import {
  cashFlow,
  cashFlowNotes,
  drawnNodeOf,
  flowGraph,
  inPeriod,
  isPeriodKey,
  payerLabel,
  periodCaption,
  periodOf,
  MIN_SHARE,
  PERIODS,
  type CashFlow,
  type FlowNode,
  type FlowPick,
  type FlowRow,
  type PeriodKey,
} from '@/lib/cash-flow';
import { fitLabel, fitText, layoutSankey, textWidth, SANKEY_DEFAULTS, type SankeyNodeBox } from '@/lib/sankey';
import { instantDay, localDate } from '@/lib/local-date';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';

// Stable empty defaults, as in MonthBreakdown.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_NOTES: readonly string[] = [];

/** A label's text size in the viewBox, as the other charts' ticks. */
const LABEL_SIZE = 10;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An amount as a label shows it, short: cents under ten, whole units under a
 *  thousand, then "$1.2K"; the table and a node's tooltip have every cent. */
function labelMoney(n: number, currency: string | null): string {
  if (n < 10) return formatMoney(n, currency);
  return compactMoney(n < 1000 ? Math.round(n) : n, currency);
}

/** How a node is colored: money in, spending, what is left over, what came
 *  from savings or debt, or the middle. */
function toneOf(n: Pick<FlowNode, 'kind'>): string {
  switch (n.kind) {
    case 'payer':
    case 'other-income':
      return 'in';
    case 'deficit':
      return 'deficit';
    case 'left-over':
      return 'left';
    case 'total':
      return 'total';
    default:
      return 'out';
  }
}

/** A link takes its payer's color into the middle, and its target's out of it. */
function linkTone(source: FlowNode, target: FlowNode): string {
  if (source.kind === 'total') return toneOf(target);
  if (source.kind === 'group') return 'out sub';
  return toneOf(source);
}

/** What a node is, in a sentence, for its tooltip: "Food: $640.00, 41
 *  transactions", and what a fold holds. The middle says both sides, since
 *  its transactions are money in and money out alike. */
function nodeTitle(n: FlowNode, flow: CashFlow): string {
  const c = flow.currency;
  if (n.kind === 'total') return `${n.label}: ${formatMoney(flow.money_in, c)} in and ${formatMoney(flow.money_out, c)} out, ${plural(n.transactions, 'transaction')}`;
  const what = `${n.label}: ${formatMoney(n.value, c)}${n.transactions > 0 ? `, ${plural(n.transactions, 'transaction')}` : ''}`;
  return n.members ? `${what} (${n.members.map((m) => m.name).join(', ')})` : what;
}

/** The chart in a sentence, for a screen reader: its figures, and that the
 *  table has every flow. */
function summaryText(flow: CashFlow, caption: string): string {
  const c = flow.currency;
  const into = `${formatMoney(flow.money_in, c)} came in from ${plural(flow.payers.length, 'payer')}`;
  const deficit = flow.from_savings_or_debt > 0 ? ` and ${formatMoney(flow.from_savings_or_debt, c)} came from savings or debt` : '';
  const out = `${formatMoney(flow.money_out, c)} went out to ${plural(flow.groups.length, 'category group')}`;
  const left = flow.left_over > 0 ? `, and ${formatMoney(flow.left_over, c)} was left over` : '';
  return `Cash flow for ${caption}: ${into}${deficit}; ${out}${left}. The table under the chart lists every flow.`;
}

/** How tall a node must be for its label to take two lines. */
const TWO_LINES = SANKEY_DEFAULTS.labelHeight * 2 + 2;

type Label = { name: string; amount: string; lines: 1 | 2; width: number };

/** A node's label as it is drawn: its name and amount on one line, cut to
 *  fit; or, on a node tall enough whose label sits at its middle, the name on
 *  a line of its own above the amount, when one line would cut it. A node
 *  with a short name (a fold's "Other") takes it rather than be cut. */
function labelOf(b: SankeyNodeBox, name: string, amount: string, short?: string): Label | null {
  if (!b.label) return null;
  let one = fitLabel(name, amount, b.label.maxWidth, LABEL_SIZE);
  if (short && one?.name !== name) {
    const brief = fitLabel(short, amount, b.label.maxWidth, LABEL_SIZE);
    if (brief?.name === short) one = brief;
  }
  const centred = Math.abs(b.label.y - (b.y + b.height / 2)) < 0.5;
  if (centred && b.height >= TWO_LINES && one?.name !== name && one?.name !== short) {
    const top = fitText(name, b.label.maxWidth, LABEL_SIZE);
    if (top) return { name: top, amount, lines: 2, width: Math.max(textWidth(top, LABEL_SIZE), textWidth(amount, LABEL_SIZE)) };
  }
  if (!one) return null;
  return { ...one, lines: 1, width: textWidth(one.name ? `${one.name} ${one.amount}` : one.amount, LABEL_SIZE) };
}

/** Where a node can be tapped: its bar, widened to a finger, and its label. */
function hitBoxes(b: SankeyNodeBox, label: Label | null): { x: number; y: number; width: number; height: number }[] {
  const bar = { x: b.x - 6, y: Math.min(b.y, b.y + b.height / 2 - 11), width: b.width + 12, height: Math.max(b.height, 22) };
  if (!b.label || !label) return [bar];
  const x = b.label.anchor === 'start' ? b.label.x - 2 : b.label.x - label.width - 2;
  const height = label.lines === 2 ? 32 : 20;
  return [bar, { x, y: b.label.y - height / 2, width: label.width + 4, height }];
}

/** Says, above the Activity list, which node's transactions it is showing,
 *  and puts the month back. Focusable (`focusRef`), so a pick made from the
 *  table by keyboard can move focus here, where the list now is. A node with
 *  no rows now is one no longer in the cash flow (a fold that changed shape, a
 *  category whose transactions all moved): said so, never that a payer's or a
 *  category's transactions are gone. */
export function FlowShown({ pick, count, onClear, focusRef }: { pick: FlowPick; count: number; onClear: () => void; focusRef?: Ref<HTMLDivElement> }) {
  const today = localDate();
  const caption = periodCaption(periodOf(pick.period, today), today);
  return (
    <div className="flow-shown" role="status" ref={focusRef} tabIndex={-1}>
      <span>
        {count === 0
          ? `${pick.label}, ${caption}, is no longer in the cash flow, so nothing is listed.`
          : `${pick.label}, ${caption}, from the cash flow: ${plural(count, 'transaction')}.`}
      </span>
      <button className="secondary" onClick={onClear}>
        Back to the month
      </button>
    </div>
  );
}

export default function CashFlowSankey({
  txns,
  taxonomy,
  currency,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  notes = NO_NOTES,
  pick = null,
  onPick,
  period: shown,
  onPeriod,
  initialPeriod = 'this-month',
}: {
  /** Every row the Activity tab has loaded (lib/activity.ts). */
  txns: readonly FlowRow[];
  taxonomy: Taxonomy;
  /** The currency of the tab's totals (lib/spending.ts totalsCurrency). */
  currency: string | null;
  /** What may leave a month short, as the tab's months say it
   *  (lib/month-coverage.ts), and the connections without transactions. */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  withoutTransactions?: NoTransactionsView;
  /** What the load couldn't read, as the Activity list says it (a manual
   *  account's rows, SimpleFIN's accounts, the rules, the categories): said
   *  beside the chart first, since each can leave its figures short. */
  notes?: readonly string[];
  /** The node whose transactions the list shows, and how to show another's
   *  (null puts the list back). Without onPick, nothing can be tapped. */
  pick?: FlowPick | null;
  onPick?: (pick: FlowPick | null) => void;
  /** The period shown, when the caller keeps it, and how to change it: the
   *  Activity tab keeps it beside the pick, so a reload of the transactions,
   *  which shows a spinner in this card's place, brings it back with the
   *  pick. Without it, the card keeps its own, from `initialPeriod`. */
  period?: PeriodKey;
  onPeriod?: (period: PeriodKey) => void;
  initialPeriod?: PeriodKey;
}) {
  const [own, setOwn] = useState<PeriodKey>(initialPeriod);
  const periodKey = shown ?? own;
  const today = localDate();
  const period = useMemo(() => periodOf(periodKey, today), [periodKey, today]);
  const caption = periodCaption(period, today);
  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);
  const flow = useMemo(() => cashFlow(txns, inPeriod(period), currency, ix), [txns, period, currency, ix]);
  const graph = useMemo(() => flowGraph(flow), [flow]);
  const layout = useMemo(() => layoutSankey(graph.nodes, graph.links), [graph]);
  const said = useMemo(
    () => cashFlowNotes({ flow, period, rows: txns, read: notes, incomplete, stopped, view: withoutTransactions, today, day: (at) => instantDay(at) ?? at.slice(0, 10) }),
    [flow, period, txns, notes, incomplete, stopped, withoutTransactions, today]
  );
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const picked = pick && pick.period === periodKey ? pick.node : null;
  // What the chart marks for it: the node itself, or, for one from the table
  // the chart folds or leaves to its group, the node that holds it.
  const marked = picked ? drawnNodeOf(flow, graph, picked) : null;

  const choose = (node: string, label: string) => {
    if (!onPick) return;
    onPick(picked === node ? null : { period: periodKey, node, label });
  };
  const empty = graph.nodes.length === 0;
  const c = flow.currency;

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Cash flow</div>
        <div className="inst-total">{caption}</div>
      </div>
      <select
        className="text-input cash-flow-period"
        value={periodKey}
        onChange={(e) => {
          if (!isPeriodKey(e.target.value)) return;
          setOwn(e.target.value);
          onPeriod?.(e.target.value);
          // The list showed a node of the period left: it goes back too.
          if (pick) onPick?.(null);
        }}
        aria-label="Period"
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>

      {empty ? (
        <p className="empty-note">Nothing came in or went out in {caption}, of what the totals count.</p>
      ) : (
        <>
          <div className="summary-row cash-flow-summary">
            <div>
              <div className="total-label">In</div>
              <div className="summary-value inflow">{formatMoney(flow.money_in, c)}</div>
            </div>
            <div>
              <div className="total-label">Out</div>
              <div className="summary-value">{formatMoney(flow.money_out, c)}</div>
            </div>
            <div>
              <div className="total-label">Net</div>
              <div className={`summary-value${flow.net < 0 ? ' negative' : flow.net > 0 ? ' inflow' : ''}`}>{formatMoney(flow.net, c)}</div>
            </div>
          </div>

          <svg
            className={`sankey-svg${marked ? ' sankey-picking' : ''}`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={summaryText(flow, caption)}
          >
            {layout.links.map((l) => {
              const lit = marked !== null && (marked === 'total' || l.source === marked || l.target === marked);
              return <path key={`${l.source}>${l.target}`} className={`sankey-link ${linkTone(byId.get(l.source)!, byId.get(l.target)!)}${lit ? ' lit' : ''}`} d={l.path} />;
            })}
            {layout.nodes.map((b) => {
              const n = byId.get(b.id)!;
              const label = labelOf(b, n.label, labelMoney(n.value, c), n.short);
              const tappable = !!onPick && n.ids !== null;
              return (
                <g
                  key={b.id}
                  className={`sankey-node ${toneOf(n)}${tappable ? ' tappable' : ''}${marked === b.id ? ' picked' : ''}`}
                  onClick={tappable ? () => choose(n.id, n.label) : undefined}
                >
                  <title>{nodeTitle(n, flow)}</title>
                  {/* At least a pixel, so the thinnest node still shows. */}
                  <rect className="sankey-bar" x={b.x} y={b.y} width={b.width} height={Math.max(b.height, 1)} rx={1} />
                  {b.label && label && (
                    <text className="sankey-label" x={b.label.x} y={b.label.y} dy={label.lines === 1 ? '0.35em' : undefined} textAnchor={b.label.anchor}>
                      {label.lines === 2 ? (
                        <>
                          <tspan className="sankey-name" x={b.label.x} dy="-0.25em">
                            {label.name}
                          </tspan>
                          <tspan className="sankey-amount" x={b.label.x} dy="1.2em">
                            {label.amount}
                          </tspan>
                        </>
                      ) : (
                        <>
                          {label.name && <tspan className="sankey-name">{label.name} </tspan>}
                          <tspan className="sankey-amount">{label.amount}</tspan>
                        </>
                      )}
                    </text>
                  )}
                  {tappable && hitBoxes(b, label).map((h, i) => <rect key={i} className="sankey-hit" {...h} />)}
                </g>
              );
            })}
          </svg>

          <div className="chart-legend">
            <span className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: 'var(--up)' }} />
              In{flow.left_over > 0 ? ', left over' : ''}
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-dot" style={{ background: 'var(--accent)' }} />
              Spending
            </span>
            {flow.from_savings_or_debt > 0 && (
              <span className="chart-legend-item">
                <span className="chart-legend-dot" style={{ background: 'var(--down)' }} />
                From savings or debt
              </span>
            )}
          </div>
          {onPick && <p className="chart-note">Tap a payer, a group or a category to list its transactions below.</p>}
        </>
      )}

      {said.counted.length > 0 && <div className="chart-note">{said.counted.join(' ')}</div>}
      {said.gaps.map((n) => (
        <div className="stale-note" key={n}>
          {n}
        </div>
      ))}

      {!empty && <FlowTable flow={flow} caption={caption} onShow={onPick ? choose : undefined} />}
    </div>
  );
}

/** The chart's text alternative: every flow, with its amount and how many
 *  transactions it sums, folds and all spelled out. */
function FlowTable({ flow, caption, onShow }: { flow: CashFlow; caption: string; onShow?: (node: string, label: string) => void }) {
  const c = flow.currency;
  /** A flow's name: a button that lists its transactions, where it can. */
  const name = (node: string, label: string) =>
    onShow ? (
      <button type="button" className="cash-flow-show" onClick={() => onShow(node, label)}>
        {label}
        <span className="visually-hidden">: list its transactions</span>
      </button>
    ) : (
      label
    );
  return (
    <details className="cash-flow-table">
      <summary>Show as a table</summary>
      <table>
        <caption className="visually-hidden">Cash flow for {caption}</caption>
        <thead>
          <tr>
            <th scope="col">Flow</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col" className="num">
              Transactions
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="cash-flow-section">
            <th scope="rowgroup" colSpan={3}>
              Money in, by who paid it
            </th>
          </tr>
          {flow.payers.map((p) => (
            <tr key={p.key}>
              <td>
                {name(`payer:${p.key}`, payerLabel(p))}
                {p.refund && <span className="cash-flow-tag"> refund</span>}
              </td>
              <td className="num">{formatMoney(p.amount, c)}</td>
              <td className="num">{p.transactions}</td>
            </tr>
          ))}
          <tr className="cash-flow-total">
            <td>Money in</td>
            <td className="num">{formatMoney(flow.money_in, c)}</td>
            <td className="num">{flow.money_in_transactions}</td>
          </tr>
          {flow.from_savings_or_debt > 0 && (
            <tr>
              <td>From savings or debt, beyond what came in</td>
              <td className="num">{formatMoney(flow.from_savings_or_debt, c)}</td>
              <td className="num" />
            </tr>
          )}
        </tbody>
        <tbody>
          <tr className="cash-flow-section">
            <th scope="rowgroup" colSpan={3}>
              Money out, by group and category
            </th>
          </tr>
          {flow.groups.map((g) => (
            <Fragment key={g.id}>
              <tr>
                <td>{name(`group:${g.id}`, g.name)}</td>
                <td className="num">{formatMoney(g.amount, c)}</td>
                <td className="num">{g.transactions}</td>
              </tr>
              {g.categories.map((cat) => {
                const label = displayName(cat.name);
                return (
                  <tr key={cat.id} className="cash-flow-child">
                    <td>{name(`category:${cat.id}`, label)}</td>
                    <td className="num">{formatMoney(cat.amount, c)}</td>
                    <td className="num">{cat.transactions}</td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
          <tr className="cash-flow-total">
            <td>Money out</td>
            <td className="num">{formatMoney(flow.money_out, c)}</td>
            <td className="num">{flow.money_out_transactions}</td>
          </tr>
          {flow.left_over > 0 && (
            <tr>
              <td>Left over, of what came in</td>
              <td className="num">{formatMoney(flow.left_over, c)}</td>
              <td className="num" />
            </tr>
          )}
        </tbody>
      </table>
      <p className="chart-note">
        The chart draws payers and categories under {Math.round(MIN_SHARE * 100)}% of the flow together, as Other income and Other in their group, and
        a group under it without its categories; this table lists each one.
      </p>
    </details>
  );
}
