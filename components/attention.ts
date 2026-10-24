// components/attention.ts
//
// Home's Needs attention (rollout phase 4b, information-architecture.md
// "Needs attention"): what asks the person to act, one row each, saying what
// and where it is fixed. Each row's color is the one its object already has:
// a connection's is its card's (lib/accounts-status.ts), a restore as the
// total's caveat says it; an overdue payment is red, and a payment due soon
// or a budget over or close amber (rollout.md "Decided in 4b"). Each row's
// words are the ones already said for it, as a title and, where the sentence
// went on after a colon, a line under it. A balance that couldn't refresh but
// needs nothing from the person is not listed: its card and the total say it.
// Pure, client-safe.

import { cardlessSeverity, type Severity } from '@/lib/accounts-status';
import { connectorBadge } from '@/lib/connectors/health';
import type { ConnectorsList } from './Connectors';
import { fmtStaleDay, type Institution } from './accounts-format';
import { accountName, questionText } from './AccountLifecycle';
import { statusBadge } from './ConnectionStatus';
import type { Offer } from './CurrencyNotes';
import { reconnectAlerts, type budgetAlerts, type paymentAlerts } from './Insights';
import type { RestoreHoldNote } from './total-notes';

export type AttentionSeverity = Severity | 'info';

/** Where a row goes: its card on Accounts, Settings > Connections (focused
 *  on the connection's card there, when it has one, or the card `focus`
 *  names), an account's sheet over Home, the
 *  Budgets tab, Activity's review count, Settings > Your data, or the offer
 *  of a home currency. */
export type Go =
  | { to: 'card'; item_id: string }
  | { to: 'accounts'; focus: string }
  | { to: 'connections'; item_id?: string; focus?: string }
  | { to: 'account'; item_id: string; account_id: string }
  | { to: 'budgets' }
  | { to: 'review' }
  | { to: 'restore' }
  | { to: 'currency' };

export type AttentionItem = {
  key: string;
  severity: AttentionSeverity;
  title: string;
  sub?: string;
  go: Go;
  /** Read from this month's spending: what the month may be missing is said
   *  right after it. */
  spending?: true;
};

/** A card on the Accounts tab, or in Settings > Connections, with its color. */
export type Placed = { inst: Institution; severity: Severity | null };

export type AttentionInput = {
  /** The Accounts tab's cards, with their colors (connectionSeverity). */
  cards: readonly Placed[];
  /** Linked connections whose accounts are all hidden or ended: their cards
   *  are in Settings > Connections. */
  hiddenOnly: readonly Placed[];
  /** Every institution as loaded, hidden rows too, for the questions. */
  institutions: readonly Institution[];
  /** SimpleFIN and Lunch Flow connections with no card, by id, and what
   *  /api/connectors says of them. */
  cardless: ReadonlySet<string>;
  connectors: ConnectorsList | null;
  /** How many transactions wait for review, with review on. */
  review: number;
  payments: ReturnType<typeof paymentAlerts>;
  budgets: ReturnType<typeof budgetAlerts>;
  /** The offer of a home currency, while it stands (not chosen, not set aside). */
  currency: Offer | null;
  restore: RestoreHoldNote | null;
  /** What this load couldn't read about the connections: without it, a
   *  connection that needs the person could be missing from the list. */
  unread?: { health: boolean; connectors: boolean };
  /** The reconnected accounts Settings > Connections suggests linking, by
   *  name (lib/links.ts linkOfferForDisplay). */
  linkOffer?: readonly string[];
  now?: Date;
};

/** The Reconnected accounts card's title in Settings > Connections, where
 *  the row about them lands (components/AccountLinks.tsx). */
export const ACCOUNT_LINKS_TITLE = 'account-links-title';

const RANK: Record<AttentionSeverity, number> = { critical: 0, caution: 1, info: 2 };

/** The line under a title, which starts a sentence of its own. */
const sentence = (sub?: string) => (sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : undefined);

/** What fixes a connection, as the row's title, when the person must do it
 *  at Nya (the redesign's "Reconnect Chase"); null when the badge says it. */
function actionFor(inst: Institution): string | null {
  const h = inst.health;
  const name = inst.institution_name;
  // A SimpleFIN or Lunch Flow connection is connected again as a whole.
  if (h?.cause === 'connector') return h.detail && (h.detail.issue === 'refused' || h.detail.issue === 'credentials') ? `Connect ${h.detail.label} again` : null;
  if (h) return h.state === 'needs_reauth' ? `Reconnect ${name}` : h.state === 'relink' ? `Connect ${name} again` : null;
  return inst.needs_reauth && inst.error ? `Reconnect ${name}` : null;
}

const joinNames = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** The rows, critical first, then caution, then information, each level in
 *  the order built. */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const now = input.now ?? new Date();
  const items: AttentionItem[] = [];
  const onCard = new Set(input.cards.map((c) => c.inst.item_id));
  const where = (item_id: string): Go => (onCard.has(item_id) ? { to: 'card', item_id } : { to: 'connections', item_id });

  // Each connection once: what its card is red for, else the end Plaid warned
  // of, else accounts its connector stopped sending, else accounts not added.
  // A SimpleFIN or Lunch Flow connection that fails as a whole says the same
  // on every bank's card, word for word: one row, on its first. What it says
  // of one bank (a card to sign, a bank it can't reach) is that bank's row.
  const shown = new Set<string>();
  const soon = reconnectAlerts(
    [...input.cards, ...input.hiddenOnly].flatMap(({ inst }) =>
      inst.health?.state === 'reconnect_soon' && inst.health.ends_at
        ? [{ item_id: inst.item_id, institution_name: inst.institution_name, ends_at: inst.health.ends_at, ends_estimated: inst.health.ends_estimated }]
        : []
    ),
    now
  );
  for (const { inst, severity } of [...input.cards, ...input.hiddenOnly]) {
    const go = where(inst.item_id);
    const badge = statusBadge(inst, now.getTime());
    if (severity === 'critical') {
      // What to do, then how old its balances are; else its name and its
      // card's badge.
      const act = actionFor(inst);
      const said = badge ?? inst.error ?? "An account isn't counted in your net worth";
      const sub = act ? (inst.stale_as_of ? `Balances as of ${fmtStaleDay(inst.stale_as_of, inst.stale_as_of_at)}` : undefined) : said;
      const who = inst.health?.cause === 'connector' && inst.connection_id ? `${inst.connection_id}:${(inst.health.detail?.messages ?? []).join('|')}` : inst.item_id;
      const key = `connection:${who}:${act ?? said}`;
      if (shown.has(key)) continue;
      shown.add(key);
      items.push({ key, severity, title: act ?? inst.institution_name, sub, go });
      continue;
    }
    const ending = soon.find((a) => a.key === `reconnect-${inst.item_id}`);
    if (ending) {
      items.push({ key: ending.key, severity: 'caution', title: ending.title, sub: sentence(ending.sub), go });
      continue;
    }
    if (inst.health?.cause === 'connector' && inst.health.detail?.issue === 'missing') {
      items.push({ key: `missing:${inst.item_id}`, severity: 'caution', title: inst.institution_name, sub: connectorBadge(inst.health), go });
      continue;
    }
    if (inst.new_accounts_available && !inst.manual) {
      items.push({ key: `new-accounts:${inst.item_id}`, severity: 'info', title: `${inst.institution_name} has accounts you haven't added yet`, go });
    }
  }

  // SimpleFIN and Lunch Flow connections with no card: refused, or accounts
  // left from one that is gone (red), and accounts offered with none chosen
  // (amber, as in Settings > Connections).
  for (const id of input.cardless) {
    const conn = input.connectors?.connections.find((c) => c.connection_id === id);
    if (!conn) {
      const left = input.connectors?.orphaned.find((o) => o.connection_id === id);
      if (!left) continue;
      const one = left.accounts.length === 1;
      items.push({
        key: `orphaned:${id}`,
        severity: 'critical',
        title: `${joinNames(left.accounts.map((a) => a.name))} ${one ? 'is' : 'are'} left from a connection that is gone`,
        go: { to: 'connections' },
      });
      continue;
    }
    const severity = cardlessSeverity(conn);
    if (severity === 'critical') items.push({ key: `cardless:${id}`, severity, title: conn.label, sub: 'Needs connecting again', go: { to: 'connections' } });
    else if (severity && conn.accounts.length === 0 && conn.available.length > 0)
      items.push({ key: `cardless:${id}`, severity, title: `${conn.label} has accounts you haven't added yet`, go: { to: 'connections' } });
  }

  // Each account question, as its card asks it, hidden accounts' too.
  for (const inst of input.institutions) {
    for (const a of [...inst.accounts, ...(inst.ended_reported ?? [])]) {
      if (!a.question) continue;
      const { ask } = questionText(a.question, accountName(a.name, a.mask), inst.institution_name, a);
      items.push({ key: `question:${a.account_id}`, severity: 'caution', title: ask, go: where(inst.item_id) });
    }
  }

  if (input.review > 0) items.push({ key: 'review', severity: 'info', title: `${input.review} transaction${input.review === 1 ? '' : 's'} to review`, go: { to: 'review' } });

  // Reconnected accounts Settings > Connections suggests linking to the
  // earlier ones they replace, named as it names them, in the IA's words ("A
  // reconnected account may continue an earlier one: link its history"). It
  // stays until the person links it or says it is not the same there.
  const offer = input.linkOffer ?? [];
  if (offer.length > 0) {
    const one = offer.length === 1;
    const names = offer.length <= 2 ? [...offer] : [...offer.slice(0, 2), `${offer.length - 2} more`];
    items.push({
      key: 'link-offer',
      severity: 'info',
      title: one ? `${offer[0]} may continue an earlier account` : `${offer.length} reconnected accounts may continue earlier ones`,
      sub: one ? 'Link its history' : `Link the history of ${joinNames(names)}`,
      go: { to: 'connections', focus: ACCOUNT_LINKS_TITLE },
    });
  }

  for (const p of input.payments) {
    items.push({ key: p.key, severity: p.severity, title: p.title, sub: sentence(p.sub), go: { to: 'account', item_id: p.item_id, account_id: p.account_id } });
  }

  for (const b of input.budgets.alerts) {
    items.push({ key: b.key, severity: 'caution', title: b.title, sub: sentence(b.sub), go: { to: 'budgets' }, spending: true });
  }
  if (input.budgets.more > 0) {
    const n = input.budgets.more;
    items.push({ key: 'budgets-more', severity: 'caution', title: `${n} more budget${n === 1 ? '' : 's'} over or nearly over`, go: { to: 'budgets' }, spending: true });
  }

  // Amber while the total adds currencies as they are (as its caveat is),
  // neutral when only spending is in several.
  if (input.currency) {
    const accounts = input.currency.why !== 'transactions';
    items.push({
      key: 'currency',
      severity: accounts ? 'caution' : 'info',
      title: 'Show your totals in one currency',
      sub: accounts ? 'Your accounts are in more than one currency' : 'Your transactions are in more than one currency',
      go: { to: 'currency' },
    });
  }

  // What couldn't be read leaves the list short: said, so an empty card
  // never claims nothing needs the person. In the Accounts tab's words and
  // colors (amber for Plaid's warnings, red for the connections, as there).
  if (input.unread?.health)
    items.push({ key: 'health-unread', severity: 'caution', title: "Plaid's warnings couldn't be read just now", sub: 'A connection that is about to end may not be listed', go: { to: 'accounts', focus: 'health-unread' } });
  if (input.unread?.connectors)
    items.push({ key: 'connectors-unread', severity: 'critical', title: 'Your own sync’s connections couldn’t be loaded', sub: 'One that needs you may not be listed', go: { to: 'accounts', focus: 'connectors-unread' } });

  // An unfinished restore has its banner, on every tab. A bank it brought
  // back that isn't connected is missing from the total: red.
  const hold = input.restore;
  if (hold && hold.waiting.length > 0) {
    const one = hold.waiting.length === 1;
    items.push({
      key: 'restore-waiting',
      severity: 'critical',
      title: `${joinNames(hold.waiting.map((w) => w.institution_name))} ${one ? "isn't" : "aren't"} connected after a restore`,
      sub: `${one ? "It isn't" : "They aren't"} counted in your net worth`,
      go: { to: 'restore' },
    });
  }
  if (hold?.unreadable) items.push({ key: 'restore-unreadable', severity: 'caution', title: "A restore can't be read", sub: 'No total is recorded until it can be', go: { to: 'restore' } });

  // Array sort is stable: each level keeps the order above.
  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
