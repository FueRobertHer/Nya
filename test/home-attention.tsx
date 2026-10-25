import NeedsAttention from '@/components/NeedsAttention';
import { attentionItems, type AttentionInput } from '@/components/attention';
import { budgetAlerts, paymentAlerts, spendingNotes, type BudgetAlertInput, type PaymentAccount, type SpendingNoteInput } from '@/components/Insights';

// Home's Needs attention as the Dashboard builds it (components/Dashboard.tsx
// `attention`), from the budgets and payments alone: the spending notes
// follow a budget row, read from the same month.

export const NOTHING: AttentionInput = {
  cards: [],
  hiddenOnly: [],
  institutions: [],
  cardless: new Set(),
  connectors: null,
  review: 0,
  payments: [],
  budgets: { alerts: [], more: 0 },
  currency: null,
  restore: null,
};

export function HomeAttention(props: BudgetAlertInput & SpendingNoteInput & { payments?: PaymentAccount[]; over?: Partial<AttentionInput> }) {
  const budgets = budgetAlerts(props);
  const items = attentionItems({ ...NOTHING, budgets, payments: paymentAlerts(props.payments ?? []), ...props.over });
  const notes = budgets.alerts.length > 0 ? spendingNotes(props) : { leftOut: null, missing: [] };
  return <NeedsAttention items={items} notes={notes} onGo={() => {}} />;
}

/** The budget alerts' sentences, whole. */
export const budgetTexts = (input: BudgetAlertInput) =>
  budgetAlerts(input)
    .alerts.map((a) => a.text)
    .join(' ');
