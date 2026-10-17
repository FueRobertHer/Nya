'use client';

// Card Mode (YNAB's, Sep 2026): the transactions waiting for review, one card
// at a time, full screen, made for a phone. A card shows the merchant (as the
// list shows it), the amount, the day, the account, the category, the note
// and the tags, and what to know first (the bank changed its amount since it
// was approved, a merchant's default filed it, it is split or in a group).
//
//   Approve       swipe right, the Approve button, → or A, or Enter on the card
//   Recategorize  swipe left, the button, ← or C: the app's category picker,
//                 and the transaction is approved with the category chosen
//                 (which counts toward the merchant's default)
//   Skip          the button, ↓ or S: left for later, dealt again at the end
//   Split, Group  the Activity tab's own sheets, over the card
//   Undo          the button or U: the last action, whatever it was
//
// Every swipe has a button, the swipe is pointer events by hand
// (components/swipe.ts, no library), a drag that goes up or down first is the
// page's, the keys are single and never a browser's (components/review-keys.ts),
// a screen reader hears what each action did and how many are left, and with
// reduced motion the cards don't fly. It ends with "All caught up" and how
// many were approved, or, with some skipped, "Done for now" and the way back
// to them. Amounts go through lib/format.ts.

import { useEffect, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ApprovalTicket, CardUndo, ReviewControls } from './review-state';
import { categoryById, displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import type { Tag } from '@/lib/tags';
import { bankRows } from '@/lib/split-rows';
import { currencyOf } from '@/lib/spending';
import { signedMoney } from '@/lib/format';
import CategoryPicker from './CategoryPicker';
import TagChips from './TagChips';
import { cardKey, CARD_KEYS } from './review-keys';
import { swipeEnd, swipeMove, swipeOffset, swipeStart, type Point, type Swipe } from './swipe';
import { cardCounts, cardPosition, currentCard, dealSkipped, openCards, undoStep, withoutStep, withStep, type Cards } from './card-mode-state';
import { changedWords, defaultWords, doneWords, endWords } from './review-text';

/** What undoes a card's step: the approval's request, or the recategorize's. */
type StepUndo = Promise<ApprovalTicket | null> | Promise<CardUndo | null>;

/** The cards to deal from the list: each transaction that needs review, whole
 *  (a split one once, each of a group's on its own), newest first. */
export function cardsToDeal(txns: readonly Txn[]): string[] {
  return bankRows(txns, { groups: 'members' })
    .filter((t) => t.needs_review === true)
    .map((t) => t.transaction_id);
}

/** How long a card takes to fly off (none with reduced motion). */
const LEAVE_MS = 180;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (!q) return;
    setReduced(q.matches);
    const on = () => setReduced(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

const dayText = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const categoryText = (t: Pick<Txn, 'category' | 'category_name'>) => {
  const name = t.category_name !== undefined ? t.category_name : t.category;
  return name ? displayName(name) : 'No category';
};

export default function CardMode(props: {
  open: boolean;
  txns: Txn[] | null;
  taxonomy: Taxonomy | null;
  tags: readonly Tag[];
  /** The totals' currency, for a row that says none. */
  currency: string | null;
  review: ReviewControls;
  onClose: () => void;
  /** The Activity tab's split sheet, on the transaction whole. */
  onSplit: (t: Txn) => void;
  /** Its group sheet: on a new group from the transaction, or on its group's row. */
  onGroup: (t: Txn) => void;
}) {
  if (!props.open) return null;
  return <CardDeck {...props} />;
}

function CardDeck({ txns, taxonomy, tags, currency, review, onClose, onSplit, onGroup }: Parameters<typeof CardMode>[0]) {
  const rows = txns ?? [];
  const whole = bankRows(rows, { groups: 'members' });
  const byId = new Map(whole.map((t) => [t.transaction_id, t]));
  const [cards, setCards] = useState<Cards<StepUndo>>(() => openCards(cardsToDeal(rows)));
  const waits = (id: string) => byId.get(id)?.needs_review === true;
  const id = currentCard(cards, waits);
  const t = id ? (byId.get(id) ?? null) : null;
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState<'right' | 'left' | 'down' | null>(null);
  const [offset, setOffset] = useState(0);
  const [said, setSaid] = useState('');
  const [help, setHelp] = useState(false);
  const drag = useRef<Swipe | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  // On the page: lock the page behind and take focus; give it back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  // Each card, and the end, takes focus as it comes; the picker when it opens.
  useEffect(() => {
    if (picking) root.current?.querySelector<HTMLSelectElement>('.card-mode-picker select')?.focus();
    else if (id) cardRef.current?.focus({ preventScroll: true });
    else endRef.current?.focus({ preventScroll: true });
  }, [id, picking]);

  const left = (after: Cards<StepUndo>) => {
    const done = new Set(after.steps.map((s) => s.id));
    return after.queue.filter((q) => !done.has(q) && waits(q)).length;
  };

  /** Flies the card off its way, then resolves (at once with reduced motion). */
  const leave = (dir: 'right' | 'left' | 'down') =>
    new Promise<void>((resolve) => {
      if (reduced) return resolve();
      setLeaving(dir);
      setTimeout(() => {
        setLeaving(null);
        setOffset(0);
        resolve();
      }, LEAVE_MS);
    });

  // One action per card: a second press while the first is under way (a
  // double tap, a key held) does nothing.
  const acting = useRef<string | null>(null);
  useEffect(() => {
    acting.current = null;
  }, [id]);

  const act = async (kind: 'approve' | 'recategorize' | 'skip') => {
    if (!t || leaving || acting.current === t.transaction_id) return;
    if (kind === 'recategorize') {
      // A split transaction's parts have categories of their own.
      if (!t.split_parts) setPicking(true);
      return;
    }
    const row = t;
    acting.current = row.transaction_id;
    await leave(kind === 'approve' ? 'right' : 'down');
    if (kind === 'skip') {
      const step = { id: row.transaction_id, kind: 'skipped' as const };
      setCards((c) => withStep(c, step));
      setSaid(doneWords('skipped', row.name, left(withStep(cards, step))));
      return;
    }
    const approval = review.approve([row]);
    const step = { id: row.transaction_id, kind: 'approved' as const, undo: approval as StepUndo };
    setCards((c) => withStep(c, step));
    setSaid(doneWords('approved', row.name, left(withStep(cards, step))));
    // Not saved: dealt again, with the error showing.
    void approval.then((ticket) => {
      if (!ticket) setCards((c) => withoutStep(c, row.transaction_id));
    });
  };

  const choose = async (category_id: string) => {
    if (!t || !category_id || acting.current === t.transaction_id) return;
    const row = t;
    acting.current = row.transaction_id;
    setPicking(false);
    await leave('left');
    const undo = review.recategorizeAndApprove(row, category_id, taxonomy);
    const step = { id: row.transaction_id, kind: 'recategorized' as const, undo: undo as StepUndo };
    setCards((c) => withStep(c, step));
    setSaid(doneWords('recategorized', row.name, left(withStep(cards, step))));
    void undo.then((u) => {
      if (!u) setCards((c) => withoutStep(c, row.transaction_id));
    });
  };

  const undoLast = async () => {
    const { cards: next, step } = undoStep(cards);
    if (!step) return;
    setCards(next);
    setPicking(false);
    // An approved one counts again once it is back; a skipped one never left.
    setSaid(doneWords('undone', byId.get(step.id)?.name ?? 'it', left(next) + (step.kind === 'skipped' ? 0 : 1)));
    if (step.kind === 'approved') {
      const ticket = await (step.undo as Promise<ApprovalTicket | null>);
      if (ticket) await review.undo(ticket);
    } else if (step.kind === 'recategorized') {
      const u = await (step.undo as Promise<CardUndo | null>);
      if (u) await review.undoRecategorize(u);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = cardKey(e, e.target === cardRef.current);
    if (!k) return;
    e.preventDefault();
    if (k === 'close') {
      if (picking) setPicking(false);
      else onClose();
    } else if (k === 'help') setHelp((h) => !h);
    else if (k === 'undo') void undoLast();
    else void act(k === 'approve' ? 'approve' : k === 'recategorize' ? 'recategorize' : 'skip');
  };

  // The swipe, by hand: the card follows a sideways drag and decides on release.
  const at = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY, t: e.timeStamp });
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (picking || leaving || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = swipeStart(at(e));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = swipeMove(drag.current, at(e));
    // Up or down first: a scroll, the page's, not a swipe.
    if (drag.current.axis === 'y') {
      drag.current = null;
      setOffset(0);
      return;
    }
    setOffset(swipeOffset(drag.current));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const end = swipeEnd(swipeMove(d, at(e)), e.currentTarget.getBoundingClientRect().width || 320);
    if (end === 'right') void act('approve');
    else {
      setOffset(0);
      if (end === 'left') void act('recategorize');
    }
  };
  const onPointerCancel = () => {
    drag.current = null;
    setOffset(0);
  };

  const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
  const position = cardPosition(cards, id);
  const counts = cardCounts(cards);
  const groupRow = t?.group_id ? rows.find((r) => r.group_id === t.group_id && r.group_members) : undefined;
  // Where the card is drawn: following the drag, or flying off its way.
  const tilt = reduced ? 0 : leaving === 'right' ? 8 : leaving === 'left' ? -8 : offset / 24;
  const shift = leaving === 'right' ? '120%' : leaving === 'left' ? '-120%' : `${offset}px`;
  const style = leaving === 'down' ? { transform: 'translateY(40px)', opacity: 0 } : { transform: `translateX(${shift}) rotate(${tilt}deg)` };

  return (
    <div className="card-mode" role="dialog" aria-modal="true" aria-label="Review transactions" ref={root} onKeyDown={onKeyDown}>
      <div className="card-mode-header">
        <h2>Review</h2>
        <span className="card-mode-position">{t ? `${position.at} of ${position.of}` : ''}</span>
        <button className="sheet-icon-btn" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>

      {t ? (
        <div className="card-mode-body">
          <div
            className={`card-mode-card${offset > 40 ? ' leaning-right' : offset < -40 ? ' leaning-left' : ''}${leaving ? ' leaving' : ''}${drag.current ? ' dragging' : ''}`}
            ref={cardRef}
            tabIndex={0}
            role="group"
            aria-roledescription="card"
            aria-label={`Transaction ${position.at} of ${position.of}. Enter approves it.`}
            style={style}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          >
            <span className="card-mode-lean approve" aria-hidden="true">
              Approve
            </span>
            <span className="card-mode-lean recategorize" aria-hidden="true">
              Recategorize
            </span>
            <div className="card-mode-merchant">{t.name}</div>
            <div className={`card-mode-amount${t.amount < 0 ? ' inflow' : ''}`}>{signedMoney(-t.amount, currencyOf(t) ?? currency, { always: true })}</div>
            <div className="card-mode-meta">
              {dayText(t.date)} · {t.institution_name} · {t.account_name}
              {t.pending ? ' · pending' : ''}
            </div>
            {picking ? (
              <div className="card-mode-picker">
                {taxonomy ? (
                  <CategoryPicker taxonomy={taxonomy} value={t.category_id ?? taxonomy.uncategorized} onChange={(c) => void choose(c)} label={`Category for ${t.name}`} />
                ) : (
                  <p className="panel-note">Your categories haven&apos;t loaded, so there is nothing to choose from yet.</p>
                )}
                <button className="secondary" onClick={() => setPicking(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="card-mode-category">{categoryText(t)}</div>
            )}
            {t.filed_by_default && <div className="card-mode-hint">{defaultWords(t.name, t.filed_by_default.agree)}</div>}
            {t.review_changed && <div className="card-mode-hint">{changedWords(t.review_changed)}</div>}
            {t.split_parts && (
              <ul className="card-mode-parts" aria-label="Its parts">
                {t.split_parts.map((p) => (
                  <li key={p.transaction_id}>
                    <span>{p.category_id && ix ? displayName(categoryById(ix, p.category_id)?.name ?? categoryText(p)) : categoryText(p)}</span>
                    <span>{signedMoney(-p.amount, currencyOf(p) ?? currency, { always: true })}</span>
                  </li>
                ))}
              </ul>
            )}
            {groupRow && <div className="card-mode-hint">In the group “{groupRow.name}”</div>}
            {t.note && <div className="card-mode-note">{t.note}</div>}
            <TagChips ids={t.tags} tags={tags} />
          </div>

          <div className="card-mode-actions">
            <button className="secondary" onClick={() => void act('recategorize')} disabled={!!t.split_parts || picking} title={t.split_parts ? 'Its parts have categories of their own: edit the split' : undefined}>
              Recategorize
            </button>
            <button className="secondary" onClick={() => void act('skip')}>
              Skip
            </button>
            <button onClick={() => void act('approve')}>Approve</button>
          </div>
          <div className="card-mode-more">
            <button className="secondary" disabled={t.pending} onClick={() => onSplit(t)}>
              {t.split_parts ? 'Edit split' : 'Split'}
            </button>
            <button className="secondary" disabled={t.pending || (!!t.split_parts && !groupRow)} onClick={() => onGroup(groupRow ?? t)}>
              {groupRow ? 'Edit group' : 'Group'}
            </button>
            <button className="secondary" disabled={cards.steps.length === 0} onClick={() => void undoLast()}>
              Undo
            </button>
          </div>
          {t.pending && <p className="rename-hint">Once it posts, it can be split or grouped with others.</p>}
        </div>
      ) : (
        <div className="card-mode-end" ref={endRef} tabIndex={-1}>
          <h3>{endWords(counts).title}</h3>
          <p>{endWords(counts).detail}</p>
          <div className="button-stack">
            {counts.skipped > 0 && <button onClick={() => setCards(dealSkipped(cards))}>Review the skipped</button>}
            <button className={counts.skipped > 0 ? 'secondary' : undefined} onClick={onClose}>
              Close
            </button>
            {cards.steps.length > 0 && (
              <button className="secondary" onClick={() => void undoLast()}>
                Undo the last
              </button>
            )}
          </div>
        </div>
      )}

      {review.error && <div className="error card-mode-error">{review.error}</div>}
      <button className="review-keys-toggle" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        Keyboard shortcuts
      </button>
      {help && (
        <dl className="review-keys">
          {CARD_KEYS.map(([keys, does]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
