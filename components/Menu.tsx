'use client';

// An object's ⋯ menu (docs/design/design-system.md#menu): a 44px icon button
// that opens a small list of its rare actions, a destructive one last and in
// red. Follows the WAI-ARIA menu button pattern: opening moves focus to the
// first item, the arrow keys, Home and End move between items, Escape closes
// it and returns focus to the button, and so does choosing an item, so a
// sheet the item opens gives focus back to the button when it closes (or,
// the button gone by then, to what focusInstead names). An item
// can instead be a link to a file to save (Reports' Download as CSV): a real
// <a download>, so it saves with no script and keeps the browser's own
// "save link as"; as a link it is chosen with Enter, not Space.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { focusInsteadOf } from './Sheet';

export type MenuItem = {
  label: string;
  onSelect: () => void;
  /** Disconnect, Delete: drawn last, in red, and confirmed in a sheet. */
  danger?: boolean;
  disabled?: boolean;
};

/** A file to save (Reports' Download as CSV): drawn as a link with
 *  `download`, never disabled or destructive. */
export type MenuLink = { label: string; href: string; download: true; danger?: undefined };

/** The items in the order they are drawn: a destructive one always last. */
export function menuOrder<T extends MenuItem | MenuLink>(items: T[]): T[] {
  return [...items.filter((i) => !i.danger), ...items.filter((i) => i.danger)];
}

/** Which enabled item a key moves focus to, from the one focused now. */
export function nextIndex(key: string, at: number, enabled: boolean[]): number | null {
  const count = enabled.length;
  const step = (from: number, by: number) => {
    for (let n = 1; n <= count; n++) {
      const i = (from + by * n + count * n) % count;
      if (enabled[i]) return i;
    }
    return null;
  };
  if (key === 'ArrowDown') return step(at, 1);
  if (key === 'ArrowUp') return step(at < 0 ? 0 : at, -1);
  if (key === 'Home') return step(-1, 1);
  if (key === 'End') return step(0, -1);
  return null;
}

type Box = { top: number; bottom: number; left: number; right: number };

/** Where the menu goes: above its button when there is no room below it, and
 *  aligned to the button's right edge unless that would take it past the
 *  screen's edge, when it is moved in (`left`, from the button's left edge).
 *  `margin` is the gap kept to the screen's edges. */
export function menuPlacement(
  button: Box,
  menu: { width: number; height: number },
  screen: { width: number; height: number },
  margin = 8
): { up: boolean; left: number | null } {
  const up = button.bottom + menu.height > screen.height - margin && button.top > menu.height + margin;
  const aligned = button.right - menu.width;
  // Past the right edge it moves left; past the left edge (a screen narrower
  // than the menu too), it starts at the margin.
  const kept = Math.max(margin, Math.min(aligned, screen.width - margin - menu.width));
  return { up, left: kept === aligned ? null : kept - button.left };
}

export function Menu({
  label,
  items,
  focusInstead,
}: {
  label: string;
  items: (MenuItem | MenuLink)[];
  /** Where focus goes when a sheet an item opened closes after the ⋯ has
   *  left the page (its card drawn anew meanwhile, as the Transactions card
   *  is when an import reads the list again). Left out, nowhere. */
  focusInstead?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ up: boolean; left: number | null }>({ up: false, left: null });
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | HTMLAnchorElement | null)[]>([]);
  const shown = menuOrder(items);

  const itemEls = () => itemRefs.current.slice(0, shown.length).filter((el): el is HTMLButtonElement | HTMLAnchorElement => !!el);
  // A link is never disabled; a button may be.
  const enabled = (el: HTMLButtonElement | HTMLAnchorElement) => !(el as HTMLButtonElement).disabled;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) {
      setPlace({ up: false, left: null });
      return;
    }
    const menu = list.current?.getBoundingClientRect();
    const button = trigger.current?.getBoundingClientRect();
    if (menu && button && typeof window.innerHeight === 'number' && typeof window.innerWidth === 'number') {
      setPlace(menuPlacement(button, menu, { width: window.innerWidth, height: window.innerHeight }));
    }
    itemEls().find(enabled)?.focus();
  }, [open]);

  // Where focus goes instead of the button, for a sheet an item opens
  // (components/Sheet.tsx), read as the sheet closes. Not undone when the
  // menu goes: that is the case it is for, and the entry goes with the button.
  useEffect(() => {
    const button = trigger.current;
    if (button && focusInstead) focusInsteadOf(button, () => focusInstead.current);
  }, [focusInstead]);

  // A press anywhere else closes it, leaving focus where the press put it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Not the sheet's too: Escape closes this menu, not the sheet it is in.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const els = itemEls();
    const to = nextIndex(
      e.key,
      els.indexOf(document.activeElement as HTMLButtonElement),
      els.map(enabled)
    );
    if (to !== null) {
      e.preventDefault();
      els[to].focus();
    }
  };

  return (
    // While it is open the keys are read from the button too, so Escape
    // closes it there (where focus stays when every item is disabled).
    <div className="menu-anchor" ref={wrap} onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx={5} cy={12} r={1.8} />
          <circle cx={12} cy={12} r={1.8} />
          <circle cx={19} cy={12} r={1.8} />
        </svg>
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={`menu${place.up ? ' up' : ''}`}
          // Moved in from the screen's edge (menuPlacement): its position only.
          style={place.left === null ? undefined : { left: place.left, right: 'auto' }}
        >
          {shown.map((item, i) =>
            'href' in item ? (
              <a
                key={item.label}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                href={item.href}
                download
                // The browser saves the file, then the menu closes and gives
                // focus back: on the next tick, so the link is still in the
                // page when the browser follows it.
                onClick={() => {
                  setTimeout(() => close(true));
                }}
              >
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
