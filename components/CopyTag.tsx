// "Copy: Stop at 52", at the top of every card and editing sheet of the
// Plan tab while a copy is open (components/PlansSheet.tsx), so a card
// scrolled to, or in a screenshot, can't be taken for your plan.

export function CopyTag({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return <div className="plan-copy-tag">Copy: {name}</div>;
}
