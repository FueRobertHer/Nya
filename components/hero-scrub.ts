// components/hero-scrub.ts
//
// Home's hero (look and feel, step 5): dragging across the net worth chart
// moves the figure above it to the day under the finger. The chart reports
// the day it is scrubbed to, and the hero (components/NetWorthCard.tsx) holds
// it, so a pointer move re-renders the hero, never the whole dashboard. Only
// a chart drawn as the hero reports, and only a pointer's scrub or the
// keys' (arrows on the focused plot): a note chosen from its list, a
// measurement between two days, or a chart elsewhere never moves the figure.

import { createContext } from 'react';

/** The day a finger is on: its value, its date as the chart writes it, and
 *  what the chart says of it, so an estimate never reads as recorded. */
export type HeroReading = { value: number; day: string; estimated: boolean; note: string | null };

/** The hero's setter, for the chart under it; null anywhere else. */
export const HeroScrub = createContext<((reading: HeroReading | null) => void) | null>(null);
