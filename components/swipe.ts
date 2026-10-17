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

/** A drag under way: where it started, its points of the last SPEED_WINDOW
 *  ms (for the speed at release), the last of them, and the axis it took,
 *  once it took one. */
export type Swipe = { start: Point; recent: Point[]; last: Point; axis: 'x' | 'y' | null };

/** The time a release's speed is measured over, in ms: the last moves before
 *  it, never only the last step, which a browser's pointerup makes one of
 *  nothing (it repeats the last move's position). */
export const SPEED_WINDOW = 100;
/** A release this long after the last move is of a pointer that stopped
 *  first: no flick, however fast it went before. */
export const STOPPED = 100;

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
  return { start: p, recent: [p], last: p, axis: null };
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
  const recent = [...s.recent, p].filter((q) => p.t - q.t <= SPEED_WINDOW);
  return { start: s.start, recent, last: p, axis };
}

/** How fast the drag went sideways at its end, px per ms: from the earliest
 *  of its points within SPEED_WINDOW of the last, to the last. Zero for a
 *  drag that stood still that long. */
export function swipeSpeed(s: Swipe): number {
  const from = s.recent[0] ?? s.last;
  const dt = s.last.t - from.t;
  return dt > 0 ? (s.last.x - from.x) / dt : 0;
}

/** How far to draw the card sideways now: the drag's own, only once it is a
 *  sideways one. */
export function swipeOffset(s: Swipe | null): number {
  return s && s.axis === 'x' ? s.last.x - s.start.x : 0;
}

/** What releasing the pointer at `p` decides, for a card `width` wide:
 *  'right', 'left', or null (it springs back). A release where the pointer
 *  moved on is one more point; one that repeats the last move's position (a
 *  browser's pointerup does, a few ms later, or later still when events are
 *  slow) adds only its time, which says just whether the pointer stopped
 *  first (STOPPED): the speed is the moves' own (swipeSpeed). */
export function swipeRelease(s: Swipe, p: Point, width: number): 'right' | 'left' | null {
  if (p.x !== s.last.x || p.y !== s.last.y) return swipeEnd(swipeMove(s, p), width);
  return swipeEnd(s, width, p.t - s.last.t > STOPPED ? 0 : swipeSpeed(s));
}

/** What a drag that ends where it is now decides (swipeRelease), at the
 *  speed it ends at. */
export function swipeEnd(s: Swipe, width: number, speed: number = swipeSpeed(s)): 'right' | 'left' | null {
  if (s.axis !== 'x') return null;
  const dx = s.last.x - s.start.x;
  const v = speed;
  const far = Math.abs(dx) >= Math.max(MIN_DISTANCE, width * DISTANCE);
  const flung = Math.abs(v) >= FLING && Math.abs(dx) >= FLING_MIN && Math.sign(v) === Math.sign(dx);
  if (!far && !flung) return null;
  return dx > 0 ? 'right' : 'left';
}
