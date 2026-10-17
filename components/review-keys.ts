// The review queue's keyboard shortcuts, for a desktop (docs/features.md lists
// them): in Card Mode (components/CardMode.tsx), and on the Activity tab while
// the queue is on (components/ReviewBar.tsx). Single keys, never with Ctrl,
// Alt or the Command key, so none takes a browser's or the system's shortcut,
// and none while the person types in a field or a list has focus (the
// category picker reads its own arrow keys). Pure, so the tests read the
// same map the views do.

/** What a key event says of itself. */
export type KeyLike = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
};

/** Whether the key goes to a field the person is typing in, or a list that
 *  reads its own keys. */
export function isTyping(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as { tagName?: unknown; isContentEditable?: unknown };
  return t.isContentEditable === true || (typeof t.tagName === 'string' && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName.toUpperCase()));
}

const withModifier = (e: KeyLike) => !!(e.altKey || e.ctrlKey || e.metaKey);

export type CardKey = 'approve' | 'recategorize' | 'skip' | 'undo' | 'close' | 'help';

/**
 * What a key does in Card Mode. `onCard`: focus is on the card itself, where
 * Enter approves (on a button, Enter presses that button, as always).
 * Escape closes (the picker first, when it is open: the view decides); every
 * other key is ignored while the person is choosing or typing.
 */
export function cardKey(e: KeyLike, onCard: boolean): CardKey | null {
  if (withModifier(e)) return null;
  if (e.key === 'Escape') return 'close';
  if (isTyping(e.target) || e.repeat) return null;
  if (e.key === 'Enter') return onCard ? 'approve' : null;
  if (e.key === '?') return 'help';
  if (e.shiftKey) return null;
  switch (e.key) {
    case 'ArrowRight':
    case 'a':
      return 'approve';
    case 'ArrowLeft':
    case 'c':
      return 'recategorize';
    case 'ArrowDown':
    case 's':
      return 'skip';
    case 'u':
      return 'undo';
    default:
      return null;
  }
}

/**
 * What a key does in Card Mode's category picker, a list whose arrows only
 * move through the categories (nothing is chosen on input alone, WCAG
 * 3.2.2): Enter on the list uses the category it shows. Escape is cardKey's
 * (it closes the picker first).
 */
export function pickerKey(e: KeyLike): 'choose' | null {
  if (withModifier(e) || e.repeat || e.key !== 'Enter') return null;
  const t = e.target as { tagName?: unknown } | null | undefined;
  return t && typeof t === 'object' && typeof t.tagName === 'string' && t.tagName.toUpperCase() === 'SELECT' ? 'choose' : null;
}

export type ActivityKey = 'review' | 'filter' | 'approve-listed' | 'undo' | 'help';

/** What a key does on the Activity tab while the queue is on and its keys
 *  are (components/activity-keys.ts: they can be turned off, WCAG 2.1.4).
 *  Approving what is listed takes Shift, as it may approve many at once, and
 *  asks first (components/ReviewBar.tsx). */
export function activityKey(e: KeyLike): ActivityKey | null {
  if (withModifier(e) || e.repeat || isTyping(e.target)) return null;
  if (e.key === '?') return 'help';
  if (e.key === 'A' && e.shiftKey) return 'approve-listed';
  if (e.shiftKey) return null;
  switch (e.key) {
    case 'r':
      return 'review';
    case 'n':
      return 'filter';
    case 'u':
      return 'undo';
    default:
      return null;
  }
}

/** The shortcuts, in words, for the help each view shows. */
export const CARD_KEYS: readonly (readonly [string, string])[] = [
  ['→ or A', 'Approve'],
  ['Enter', 'Approve (on the card)'],
  ['← or C', 'Recategorize'],
  ['Enter (in the category list)', 'Use the category shown'],
  ['↓ or S', 'Skip'],
  ['U', 'Undo the last action'],
  ['Esc', 'Close'],
];

export const ACTIVITY_KEYS: readonly (readonly [string, string])[] = [
  ['R', 'Review one at a time (Card Mode)'],
  ['N', 'Show only what needs review, or everything'],
  ['Shift+A', 'Approve what is listed (it asks first)'],
  ['U', 'Undo the last approval'],
  ['?', 'Show or hide these shortcuts'],
];
