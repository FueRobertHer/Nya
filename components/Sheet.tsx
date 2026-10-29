'use client';

// A drawer: a sheet up from the bottom on phones, a panel from the right on
// wider screens (styles in app/globals.css). Closes on the backdrop or the
// close button; Escape goes back a level if there is one, else closes. While
// open the page behind it doesn't scroll, focus moves into it, Tab and
// Shift+Tab stay inside it, and focus goes back to where it was when it
// closes (if that is still on the page; if not, to what the control's owner
// named instead, focusInsteadOf).

import { useEffect, useRef, useState, type ReactNode } from 'react';

// The slide-out transition: --dur-base in app/globals.css (the guard checks
// they match), so it comes off the page as it finishes sliding.
const CLOSE_MS = 220;

// Where focus goes when the control a sheet was opened from has left the
// page by the time the sheet closes (a save read the list again and drew
// its card anew, the control with it), as the control's owner names it
// (Menu's focusInstead). Held weakly, so a control gone for good takes its
// entry with it.
const insteadOf = new WeakMap<Element, () => HTMLElement | null>();

/** Whether Tab can land on the element: a link, an enabled control (none
 *  in a disabled fieldset), a summary, or anything given a tab stop of its
 *  own. */
function tabbable(el: Element, offFieldset: boolean): boolean {
  if (el.hasAttribute('tabindex')) return el.getAttribute('tabindex') !== '-1';
  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href');
    case 'INPUT':
      return !offFieldset && !el.hasAttribute('disabled') && el.getAttribute('type') !== 'hidden';
    case 'BUTTON':
    case 'SELECT':
    case 'TEXTAREA':
      return !offFieldset && !el.hasAttribute('disabled');
    case 'SUMMARY':
      return true;
    default:
      return false;
  }
}

const isRadio = (el: Element) => el.tagName === 'INPUT' && el.getAttribute('type') === 'radio';
const isChecked = (el: Element) => (el as HTMLInputElement).checked === true;

/** The panel's controls in the order Tab stops on them, leaving out any
 *  under a hidden or inert part (a closed level), a closed details' body
 *  (its summary stays), and all but one radio of a group: the checked one,
 *  or the first while none is (a radio with no name is a group of its own). */
function tabbables(panel: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const checkedGroups = new Set<string>();
  const seenGroups = new Set<string>();
  const walk = (n: Element, offFieldset: boolean, visit: (c: Element, off: boolean) => void) => {
    const closed = n.tagName === 'DETAILS' && !n.hasAttribute('open');
    for (const node of Array.from(n.childNodes)) {
      if (node.nodeType !== 1) continue;
      const c = node as Element;
      if (c.hasAttribute('hidden') || c.hasAttribute('inert')) continue;
      if (closed && c.tagName !== 'SUMMARY') continue;
      const off = offFieldset || (c.tagName === 'FIELDSET' && c.hasAttribute('disabled'));
      visit(c, off);
      walk(c, off, visit);
    }
  };
  walk(panel, false, (c) => {
    const group = c.getAttribute('name');
    if (group !== null && isRadio(c) && isChecked(c)) checkedGroups.add(group);
  });
  walk(panel, false, (c, off) => {
    if (!tabbable(c, off)) return;
    const group = c.getAttribute('name');
    if (group !== null && isRadio(c)) {
      if (seenGroups.has(group) || (checkedGroups.has(group) && !isChecked(c))) return;
      seenGroups.add(group);
    }
    out.push(c as HTMLElement);
  });
  return out;
}

/** Keeps Tab inside the panel: from its last control to its first, and
 *  Shift+Tab from its first (or the panel itself) to its last. Focus that has
 *  left for the page behind comes back in; focus in another dialog (a sheet
 *  this one opened) is that dialog's to keep. */
function trapTab(e: KeyboardEvent, panel: HTMLElement) {
  const at = document.activeElement as HTMLElement | null;
  const items = tabbables(panel);
  if (!at || !panel.contains(at)) {
    for (let n: Element | null = at; n; n = n.parentElement) if (n.getAttribute('role') === 'dialog') return;
    e.preventDefault();
    (items[0] ?? panel).focus();
    return;
  }
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (at === first || at === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Focus goes to what `to` gives, then, when a sheet opened from `opener`
 *  closes after `opener` has left the page, rather than to nothing. */
export function focusInsteadOf(opener: Element, to: () => HTMLElement | null) {
  insteadOf.set(opener, to);
}

export function Sheet({
  open,
  title,
  onClose,
  onBack,
  level: levelName,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Shows a back arrow before the title (a second level inside the drawer). */
  onBack?: () => void;
  /** Which level is shown, for a sheet with more than one inside it (a
   *  budget's: its rollover, then the reset under that), so a step from one
   *  inner level to another moves focus too. Left out, the levels are the
   *  first and any with a back arrow. */
  level?: string;
  /** Its buttons, kept in view at the foot while the body scrolls. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Stays mounted while it slides out, and slides in one frame after mounting.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Escape, read through a ref so the listener isn't re-added each render.
  const escape = useRef(onClose);
  escape.current = onBack ?? onClose;

  // Once it is on the page: lock the page behind, take focus, listen for
  // Escape and Tab.
  const active = open && mounted;
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escape.current();
      else if (e.key === 'Tab' && panel.current) trapTab(e, panel.current);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overflow = overflow;
      // Opened from a control that has since left the page: what its owner
      // named instead (a menu that has since closed names nothing, and
      // focus stays where it falls).
      const back = !before || before.isConnected ? before : (insteadOf.get(before)?.() ?? null);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [active]);

  // A new level (back or forward) starts with focus on the panel, not lost
  // with the button that went away.
  const level = levelName ?? (onBack ? 'inner' : 'top');
  useEffect(() => {
    if (active) panel.current?.focus({ preventScroll: true });
  }, [level, active]);

  if (!mounted) return null;
  return (
    <>
      <div className="sheet-backdrop" data-open={shown} onClick={onClose} aria-hidden="true" />
      <div className="sheet" data-open={shown} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          {onBack && (
            <button className="sheet-icon-btn" onClick={onBack} aria-label="Back">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          )}
          <h2>{title}</h2>
          <button className="sheet-icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </>
  );
}
