// lib/sankey.ts
//
// A layered Sankey diagram's geometry, as a pure function (#41): nodes in
// columns by depth, each as tall as the amount through it, stacked down its
// column with a fixed gap and the column centred in the plot; links drawn as
// ribbons, two cubic Bezier curves (a top edge and a bottom edge) whose ends
// sit at the stacked offsets of the links already leaving their source and
// already reaching their target, so a ribbon is as wide at both ends as the
// amount it carries. No DOM and no chart library: components/CashFlowSankey.tsx
// draws what this answers as an inline SVG, and test/sankey.test.ts holds the
// geometry to these rules.
//
// ONE SCALE. Every node and every ribbon uses the same units per amount, so a
// node's height is its amount in proportion to every other's, in any column.
// The scale is the largest that lets every column fit the plot with its gaps;
// the plot is as tall as its busiest column needs for one label a node.
//
// FORWARD ONLY. A link goes from a column to a later one: one that doesn't is
// refused (an error), never drawn backwards. A month that spent more than came
// in is drawn with a node of its own for the difference beside the sources
// (lib/cash-flow.ts), not with a link running back.
//
// ORDER. No crossing minimization: the caller orders each column (most first,
// say), and a node's links leave and arrive in the order of the nodes at their
// other end, which at this size (a handful of payers, a dozen groups and their
// categories) never crosses two ribbons at a node.
//
// LABELS sit beside their node on the side the caller asks for (outside the
// node, which is too thin to hold text), centred on it, within the space to the
// next column. Labels too close to share a line are moved apart, down and then
// up within the plot, so two never overlap. A pure function can't measure text,
// so fitLabel cuts a name to the width it has by an estimate of each
// character's width, and a long name ends with an ellipsis rather than running
// into the next column.

export type LabelSide = 'left' | 'right' | 'none';

/** A node as asked for: its column (any numbers; only their order counts) and
 *  the side its label goes on. Its amount is what its links carry. */
export type SankeyNodeInput = { id: string; column: number; side?: LabelSide };

/** A link as asked for: a positive amount from one node to a node in a later
 *  column. */
export type SankeyLinkInput = { source: string; target: string; value: number };

export type SankeyOptions = {
  /** The width of the drawing (the SVG's viewBox). */
  width: number;
  nodeWidth: number;
  /** Between two nodes of a column. */
  gap: number;
  /** The plot's height for each node of its busiest column, and the least it
   *  may be: room for one label a node, whatever the amounts. */
  rowHeight: number;
  minPlotHeight: number;
  padTop: number;
  padBottom: number;
  /** A label's line: two labels' middles are never closer than this. */
  labelHeight: number;
  /** Between a node and its label, and between a label and the next column. */
  labelGap: number;
};

export const SANKEY_DEFAULTS: SankeyOptions = {
  width: 340,
  nodeWidth: 8,
  gap: 10,
  rowHeight: 24,
  minPlotHeight: 168,
  padTop: 6,
  padBottom: 6,
  labelHeight: 12,
  labelGap: 4,
};

/** Where a node's label goes: its anchor point (the end nearest the node), the
 *  text's anchor, and the width it may take. */
export type SankeyLabel = { side: 'left' | 'right'; x: number; y: number; anchor: 'start' | 'end'; maxWidth: number };

export type SankeyNodeBox = {
  id: string;
  /** Its column's place among the columns drawn, from 0. */
  column: number;
  /** Its place in its column, from the top. */
  index: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: SankeyLabel | null;
};

export type SankeyRibbon = {
  source: string;
  target: string;
  value: number;
  /** Its thickness, at both ends. */
  width: number;
  /** Where it leaves its source (x0, the top of its end y0) and reaches its
   *  target (x1, y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The filled ribbon, as an SVG path. */
  path: string;
};

export type SankeyLayout = {
  width: number;
  height: number;
  plotTop: number;
  plotHeight: number;
  /** Drawing units per unit of amount. */
  scale: number;
  nodes: SankeyNodeBox[];
  links: SankeyRibbon[];
};

/** Coordinates in a path, to a hundredth: enough for any screen. */
const at = (n: number) => String(Math.round(n * 100) / 100);

/** A ribbon from (x0, y0) to (x1, y1), `w` thick at both ends: a top edge and a
 *  bottom edge, each a cubic Bezier curve with its control points half way
 *  across, so it leaves and arrives level. */
export function ribbonPath(x0: number, y0: number, x1: number, y1: number, w: number): string {
  const xm = (x0 + x1) / 2;
  return (
    `M${at(x0)},${at(y0)}C${at(xm)},${at(y0)} ${at(xm)},${at(y1)} ${at(x1)},${at(y1)}` +
    `L${at(x1)},${at(y1 + w)}C${at(xm)},${at(y1 + w)} ${at(xm)},${at(y0 + w)} ${at(x0)},${at(y0 + w)}Z`
  );
}

/**
 * Label middles `ys` (in order, top first) moved apart until each is at least
 * `min` below the one before, and all of them within [lo, hi]: each moves as
 * little as it can, down first, then back up from the bottom. When they can't
 * all fit, they keep their order and spacing and run past `hi` (the layout's
 * plot is always tall enough that they fit).
 */
export function spreadLabels(ys: readonly number[], min: number, lo: number, hi: number): number[] {
  const out = [...ys];
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], i === 0 ? lo : out[i - 1] + min);
  for (let i = out.length - 1; i >= 0; i--) out[i] = Math.min(out[i], i === out.length - 1 ? hi : out[i + 1] - min);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], i === 0 ? lo : out[i - 1] + min);
  return out;
}

/**
 * The layout of these nodes and links (see the header). Nodes are listed in
 * the order they stack, top first, within each column; a node with nothing
 * through it, and an empty column, are left out. A link that isn't positive is
 * left out; one that names a node not listed, or doesn't go to a later
 * column, is refused.
 */
export function layoutSankey(nodes: readonly SankeyNodeInput[], links: readonly SankeyLinkInput[], options: Partial<SankeyOptions> = {}): SankeyLayout {
  const o = { ...SANKEY_DEFAULTS, ...options };
  const given = new Map(nodes.map((n) => [n.id, n]));
  if (given.size !== nodes.length) throw new Error('A Sankey node id is listed twice');
  const flowing = links.filter((l) => Number.isFinite(l.value) && l.value > 0);
  for (const l of flowing) {
    const s = given.get(l.source);
    const t = given.get(l.target);
    if (!s || !t) throw new Error(`A Sankey link names a node that isn't listed: ${!s ? l.source : l.target}`);
    if (t.column <= s.column) throw new Error(`A Sankey link must go to a later column: ${l.source} to ${l.target}`);
  }

  // A node's amount: what its links carry in or out, whichever is more (the
  // same, for a node with both).
  const inOf = new Map<string, number>();
  const outOf = new Map<string, number>();
  for (const l of flowing) {
    outOf.set(l.source, (outOf.get(l.source) ?? 0) + l.value);
    inOf.set(l.target, (inOf.get(l.target) ?? 0) + l.value);
  }
  const valueOf = (id: string) => Math.max(inOf.get(id) ?? 0, outOf.get(id) ?? 0);
  const live = nodes.filter((n) => valueOf(n.id) > 0);
  const columns = [...new Set(live.map((n) => n.column))].sort((a, b) => a - b);
  const empty: SankeyLayout = { width: o.width, height: o.padTop + o.padBottom, plotTop: o.padTop, plotHeight: 0, scale: 0, nodes: [], links: [] };
  if (columns.length === 0) return empty;

  const stacks = columns.map((c) => live.filter((n) => n.column === c));
  const busiest = Math.max(...stacks.map((s) => s.length));
  const plotHeight = Math.max(o.minPlotHeight, busiest * o.rowHeight);
  // The one scale: the largest at which every column, with its gaps, fits.
  const scale = Math.min(...stacks.map((s) => (plotHeight - (s.length - 1) * o.gap) / s.reduce((a, n) => a + valueOf(n.id), 0)));
  const xOf = (c: number) => (columns.length === 1 ? (o.width - o.nodeWidth) / 2 : (c * (o.width - o.nodeWidth)) / (columns.length - 1));

  const boxes = new Map<string, SankeyNodeBox>();
  const ordered: SankeyNodeBox[] = [];
  stacks.forEach((stack, c) => {
    const total = stack.reduce((a, n) => a + valueOf(n.id) * scale, 0) + (stack.length - 1) * o.gap;
    let y = o.padTop + (plotHeight - total) / 2;
    stack.forEach((n, index) => {
      const value = valueOf(n.id);
      const box: SankeyNodeBox = { id: n.id, column: c, index, value, x: xOf(c), y, width: o.nodeWidth, height: value * scale, label: null };
      boxes.set(n.id, box);
      ordered.push(box);
      y += box.height + o.gap;
    });
  });

  // Links leave a node in the order of their targets, and reach one in the
  // order of their sources, each below the ones before it.
  const place = (b: SankeyNodeBox) => b.column * 1e6 + b.index;
  const leaving = new Map<string, number>();
  const reaching = new Map<string, number>();
  const sorted = flowing.map((l) => ({ l, s: boxes.get(l.source)!, t: boxes.get(l.target)! }));
  const outOffset = new Map<SankeyLinkInput, number>();
  const inOffset = new Map<SankeyLinkInput, number>();
  for (const { l, s } of [...sorted].sort((a, b) => place(a.s) - place(b.s) || place(a.t) - place(b.t))) {
    const off = leaving.get(s.id) ?? 0;
    outOffset.set(l, off);
    leaving.set(s.id, off + l.value * scale);
  }
  for (const { l, t } of [...sorted].sort((a, b) => place(a.t) - place(b.t) || place(a.s) - place(b.s))) {
    const off = reaching.get(t.id) ?? 0;
    inOffset.set(l, off);
    reaching.set(t.id, off + l.value * scale);
  }
  const ribbons: SankeyRibbon[] = sorted.map(({ l, s, t }) => {
    const width = l.value * scale;
    const x0 = s.x + s.width;
    const y0 = s.y + outOffset.get(l)!;
    const x1 = t.x;
    const y1 = t.y + inOffset.get(l)!;
    return { source: l.source, target: l.target, value: l.value, width, x0, y0, x1, y1, path: ribbonPath(x0, y0, x1, y1, width) };
  });

  // Labels, column by column, beside their node, spread so none overlap.
  const lo = o.padTop + o.labelHeight / 2;
  const hi = o.padTop + plotHeight - o.labelHeight / 2;
  stacks.forEach((stack, c) => {
    const labelled = stack.map((n) => ({ n, box: boxes.get(n.id)! })).filter(({ n }) => n.side === 'left' || n.side === 'right');
    const ys = spreadLabels(
      labelled.map(({ box }) => box.y + box.height / 2),
      o.labelHeight,
      lo,
      hi
    );
    labelled.forEach(({ n, box }, i) => {
      const right = n.side === 'right';
      const x = right ? box.x + box.width + o.labelGap : box.x - o.labelGap;
      // Up to the next column (or the edge) on its side, keeping a gap there.
      const reach = right ? (c < columns.length - 1 ? xOf(c + 1) : o.width) - x : x - (c > 0 ? xOf(c - 1) + o.nodeWidth : 0);
      const maxWidth = Math.max(0, reach - (right ? (c < columns.length - 1 ? o.labelGap : 0) : c > 0 ? o.labelGap : 0));
      box.label = { side: right ? 'right' : 'left', x, y: ys[i], anchor: right ? 'start' : 'end', maxWidth };
    });
  });

  return { width: o.width, height: o.padTop + plotHeight + o.padBottom, plotTop: o.padTop, plotHeight, scale, nodes: ordered, links: ribbons };
}

// ---- Labels that fit ----

/** Characters about a third of an em wide in a sans serif face. */
const NARROW = /[ .,:;'!|()[\]{}"ijlrtfI’]/;
/** About an em: the widest. */
const WIDEST = /[MW@%]/;
/** Nine tenths of an em. */
const WIDE = /[mw]/;

/** The width text takes at `size`, by an estimate at or a little over what a
 *  system sans serif face draws (measured against Inter, about as wide as
 *  iOS's San Francisco and wider than Android's Roboto): narrow, wide and
 *  full-width characters (CJK, an emoji) apart from the rest. */
export function textWidth(text: string, size = 10): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80) em += 1;
    else if (NARROW.test(ch)) em += 0.32;
    else if (WIDEST.test(ch)) em += 1;
    else if (WIDE.test(ch)) em += 0.9;
    else if (/[A-Z$&#]/.test(ch)) em += 0.68;
    else em += 0.6;
  }
  return em * size;
}

/** Text as it fits in `maxWidth`: whole, or cut with an ellipsis (never
 *  inside a character written as two, an emoji, nor just after a space), or
 *  '' when not even a letter does. */
export function fitText(text: string, maxWidth: number, size = 10): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = [...text];
  for (let n = chars.length - 1; n >= 1; n--) {
    const cut = `${chars.slice(0, n).join('').trimEnd()}…`;
    if (textWidth(cut, size) <= maxWidth) return cut;
  }
  return '';
}

/**
 * A label as it fits in `maxWidth` on one line: the name and its amount, with
 * a space between; the name cut with an ellipsis when both don't fit; the
 * amount alone when not even a letter of the name does; null when the amount
 * alone doesn't fit either.
 */
export function fitLabel(name: string, amount: string, maxWidth: number, size = 10): { name: string; amount: string } | null {
  const fitted = fitBeside(name, textWidth(amount, size), maxWidth, size);
  return fitted === null ? null : { name: fitted, amount };
}

/**
 * A name as it fits in `maxWidth` on one line beside `room` kept for what
 * follows it (an amount, or the room the widest amount could take, so the
 * label doesn't move with the amount): whole, or cut with an ellipsis; ''
 * when not even a letter fits; null when the room alone doesn't fit either.
 */
export function fitBeside(name: string, room: number, maxWidth: number, size = 10): string | null {
  const fitted = fitText(name, maxWidth - room - textWidth(' ', size), size);
  if (fitted) return fitted;
  return room <= maxWidth ? '' : null;
}
