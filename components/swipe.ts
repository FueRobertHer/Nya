// Card Mode's swipe (components/CardMode.tsx), worked out by hand from
// pointer events, with no gesture library: a drag that goes sideways before
// it goes up or down is the card's, one that goes up or down first is the
// page's (a scroll), and on release the card is swiped when it went far
// enough, or was flicked fast enough, else it springs back. Pure, so the tests
// drive it with the points a finger or a mouse would give.
//
// Right is approve and left is recategorize; every swipe has a button that
// does the same, so nothing needs a gesture.

/** One pointer position, with its time in milliseconds. */
export type Point = { x: number; y: number; t: number };

/** A drag under way: where it started, the last two points (for the speed at
 *  release) and the axis it took, once it took one. */
export type Swipe = { start: Point; prev: Point; last: Point; axis: 'x' | 'y' | null };

/** How far a pointer moves before the drag picks its axis: a tap or a
 *  trembling finger moves nothing. */
export const SLOP = 10;
/** A release decides when the card went this share of its width... */
export const DISTANCE = 0.3;
/** ...or at least this far, on a narrow card. */
export const MIN_DISTANCE = 64;
/** A flick this fast (px per ms) decides on its own... */
export const FLING = 0.5;
/** ...when it went at least this far, the way it was flicked. */
export const FLING_MIN = 24;

export function swipeStart(p: Point): Swipe {
  return { start: p, prev: p, last: p, axis: null };
}

/** The drag after the pointer moved to `p`: its axis is the one it first
 *  went past SLOP along, and once taken it stays. */
export function swipeMove(s: Swipe, p: Point): Swipe {
  let axis = s.axis;
  if (axis === null) {
    const dx = Math.abs(p.x - s.start.x);
    const dy = Math.abs(p.y - s.start.y);
    if (dx > SLOP || dy > SLOP) axis = dx > dy ? 'x' : 'y';
  }
  return { start: s.start, prev: s.last, last: p, axis };
}

/** How far to draw the card sideways now: the drag's own, only once it is a
 *  sideways one. */
export function swipeOffset(s: Swipe | null): number {
  return s && s.axis === 'x' ? s.last.x - s.start.x : 0;
}

/** What a release decides, for a card `width` wide: 'right', 'left', or
 *  null (it springs back). */
export function swipeEnd(s: Swipe, width: number): 'right' | 'left' | null {
  if (s.axis !== 'x') return null;
  const dx = s.last.x - s.start.x;
  const dt = Math.max(1, s.last.t - s.prev.t);
  const v = (s.last.x - s.prev.x) / dt;
  const far = Math.abs(dx) >= Math.max(MIN_DISTANCE, width * DISTANCE);
  const flung = Math.abs(v) >= FLING && Math.abs(dx) >= FLING_MIN && Math.sign(v) === Math.sign(dx);
  if (!far && !flung) return null;
  return dx > 0 ? 'right' : 'left';
}
