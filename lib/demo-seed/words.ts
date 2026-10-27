// lib/demo-seed/words.ts
//
// Wording the Demo data card (components/DemoDataCard.tsx) and the reset's
// refusals (lib/demo-seed/reset.ts) share. Apart from the rest so the page
// loads none of the seed.

/** A wait in whole minutes: "1 minute", "4 minutes". Never less than one. */
export function minutesText(seconds: number): string {
  const n = Math.max(1, Math.ceil(seconds / 60));
  return n === 1 ? '1 minute' : `${n} minutes`;
}
