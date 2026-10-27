'use client';

// The Theme card, first in Settings > Preferences (mounted in
// components/Dashboard.tsx): System, Dark or Light for this device
// (components/theme.ts). A radio group drawn as a segmented control, as the
// design system has a setting. `onChanged` runs after a choice is applied.

import { useRef, type KeyboardEvent } from 'react';
import { segmentKey } from './ActivityBar';
import { setTheme, useTheme } from './theme';
import type { ThemeChoice } from '@/lib/theme';

const CHOICES: { value: ThemeChoice | null; label: string }[] = [
  { value: null, label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function ThemeCard({ onChanged }: { onChanged?: () => void }) {
  const theme = useTheme();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const at = CHOICES.findIndex((c) => c.value === theme);
  const choose = (choice: ThemeChoice | null) => {
    setTheme(choice);
    onChanged?.();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // A radio group's arrows go either way, up and left back, down and right on.
    const to = segmentKey(e.key === 'ArrowUp' ? 'ArrowLeft' : e.key === 'ArrowDown' ? 'ArrowRight' : e.key, at, CHOICES.length);
    if (to === null) return;
    e.preventDefault();
    choose(CHOICES[to].value);
    buttons.current[to]?.focus();
  };

  return (
    <section className="card stack" aria-labelledby="theme-title">
      <div className="card-header">
        <h3 id="theme-title">Theme</h3>
      </div>
      <div className="segmented" role="radiogroup" aria-labelledby="theme-title" aria-describedby="theme-help" onKeyDown={onKey}>
        {CHOICES.map((c, i) => (
          <button
            key={c.label}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            tabIndex={i === at ? 0 : -1}
            onClick={() => choose(c.value)}
            aria-checked={i === at}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="helper" id="theme-help">
        System follows this device’s light or dark setting. The choice is kept on this device.
      </p>
    </section>
  );
}
