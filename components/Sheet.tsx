'use client';

// A drawer: a sheet up from the bottom on phones, a panel from the right on
// wider screens (styles in app/globals.css). Closes on the backdrop, the
// close button or Escape. While open the page behind it doesn't scroll, and
// focus moves into it and back to where it was when it closes.

import { useEffect, useRef, useState, type ReactNode } from 'react';

const CLOSE_MS = 320; // the slide-out transition

export function Sheet({
  open,
  title,
  onClose,
  onBack,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Shows a back arrow before the title (a second level inside the drawer). */
  onBack?: () => void;
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

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overflow = overflow;
      before?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

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
      </div>
    </>
  );
}
