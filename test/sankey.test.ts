import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitLabel, fitText, layoutSankey, ribbonPath, spreadLabels, textWidth, SANKEY_DEFAULTS, type SankeyLayout, type SankeyLinkInput, type SankeyNodeInput } from '@/lib/sankey';

// The cash flow chart's geometry (lib/sankey.ts, #41): a pure layered Sankey
// layout, held here to its rules: nodes as tall as their amounts on one scale,
// stacked with a fixed gap, each column centred; ribbons as wide as their
// amounts, leaving and reaching their nodes at the stacked offsets; links only
// ever forward; labels beside their nodes, never overlapping, cut to fit.

const EPS = 1e-6;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/** A small cash flow: two payers and a deficit into the middle, three groups
 *  and a left over out of it, and categories under two of the groups. */
const NODES: SankeyNodeInput[] = [
  { id: 'pay', column: 0, side: 'right' },
  { id: 'gift', column: 0, side: 'right' },
  { id: 'total', column: 1, side: 'none' },
  { id: 'food', column: 2, side: 'left' },
  { id: 'home', column: 2, side: 'left' },
  { id: 'fun', column: 2, side: 'left' },
  { id: 'left', column: 2, side: 'left' },
  { id: 'groceries', column: 3, side: 'left' },
  { id: 'cafes', column: 3, side: 'left' },
  { id: 'rent', column: 3, side: 'left' },
];
const LINKS: SankeyLinkInput[] = [
  { source: 'pay', target: 'total', value: 3000 },
  { source: 'gift', target: 'total', value: 200 },
  { source: 'total', target: 'food', value: 600 },
  { source: 'total', target: 'home', value: 1500 },
  { source: 'total', target: 'fun', value: 300 },
  { source: 'total', target: 'left', value: 800 },
  { source: 'food', target: 'groceries', value: 450 },
  { source: 'food', target: 'cafes', value: 150 },
  { source: 'home', target: 'rent', value: 1500 },
];

const node = (l: SankeyLayout, id: string) => l.nodes.find((n) => n.id === id)!;
const columnOf = (l: SankeyLayout, c: number) => l.nodes.filter((n) => n.column === c);

describe('nodes', () => {
  const l = layoutSankey(NODES, LINKS);

  test('each is as tall as the amount through it, on one scale, in every column', () => {
    for (const n of l.nodes) expect([n.id, near(n.height, n.value * l.scale)]).toEqual([n.id, true]);
    expect(node(l, 'total').value).toBe(3200);
    expect(node(l, 'food').value).toBe(600);
    // A node's amount is what flows through it: in for a sink, out for a source.
    expect(node(l, 'rent').value).toBe(1500);
    expect(node(l, 'pay').value).toBe(3000);
    // Heights compare across columns: rent's is home's, and pay is 15 times gift.
    expect(near(node(l, 'rent').height, node(l, 'home').height)).toBe(true);
    expect(near(node(l, 'pay').height / node(l, 'gift').height, 15)).toBe(true);
  });

  test('stack down their column in the order given, a fixed gap apart, each column centred in the plot', () => {
    for (const c of [0, 1, 2, 3]) {
      const stack = columnOf(l, c);
      stack.forEach((n, i) => {
        expect(n.index).toBe(i);
        if (i > 0) expect(near(n.y - (stack[i - 1].y + stack[i - 1].height), SANKEY_DEFAULTS.gap)).toBe(true);
      });
      const top = stack[0].y - l.plotTop;
      const bottom = l.plotTop + l.plotHeight - (stack[stack.length - 1].y + stack[stack.length - 1].height);
      expect([c, near(top, bottom)]).toEqual([c, true]);
    }
    expect(columnOf(l, 2).map((n) => n.id)).toEqual(['food', 'home', 'fun', 'left']);
  });

  test('the column with the most to fit fills the plot exactly; the scale fits every column', () => {
    const fill = (c: number) => {
      const stack = columnOf(l, c);
      return stack.reduce((a, n) => a + n.height, 0) + (stack.length - 1) * SANKEY_DEFAULTS.gap;
    };
    const fills = [0, 1, 2, 3].map(fill);
    for (const f of fills) expect(f).toBeLessThanOrEqual(l.plotHeight + EPS);
    expect(fills.some((f) => near(f, l.plotHeight))).toBe(true);
    // Four in the busiest column: the plot is its least, with room for a label each.
    expect(l.plotHeight).toBe(Math.max(SANKEY_DEFAULTS.minPlotHeight, 4 * SANKEY_DEFAULTS.rowHeight));
    expect(l.height).toBe(SANKEY_DEFAULTS.padTop + l.plotHeight + SANKEY_DEFAULTS.padBottom);
  });

  test('the plot grows with the busiest column, a row a node', () => {
    const many: SankeyNodeInput[] = [{ id: 'in', column: 0 }, ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, column: 1 }))];
    const big = layoutSankey(many, many.slice(1).map((n) => ({ source: 'in', target: n.id, value: 10 + n.id.length })));
    expect(big.plotHeight).toBe(20 * SANKEY_DEFAULTS.rowHeight);
  });

  test('columns spread across the width, the first at the left edge and the last at the right', () => {
    expect(columnOf(l, 0)[0].x).toBe(0);
    expect(columnOf(l, 3)[0].x).toBe(SANKEY_DEFAULTS.width - SANKEY_DEFAULTS.nodeWidth);
    const xs = [0, 1, 2, 3].map((c) => columnOf(l, c)[0].x);
    expect(near(xs[1] - xs[0], xs[2] - xs[1]) && near(xs[2] - xs[1], xs[3] - xs[2])).toBe(true);
  });

  test('a node with nothing through it, and so an empty column, is left out, and the columns drawn close up', () => {
    const out = layoutSankey([...NODES, { id: 'idle', column: 5 }, { id: 'nothing', column: 0 }], [...LINKS, { source: 'pay', target: 'idle', value: 0 }]);
    expect(out.nodes.map((n) => n.id)).not.toContain('idle');
    expect(out.nodes.map((n) => n.id)).not.toContain('nothing');
    // Three columns of nodes when the categories go: the groups reach the right edge.
    const three = layoutSankey(
      NODES.filter((n) => n.column < 3),
      LINKS.filter((k) => !['groceries', 'cafes', 'rent'].includes(k.target))
    );
    expect(columnOf(three, 2)[0].x).toBe(SANKEY_DEFAULTS.width - SANKEY_DEFAULTS.nodeWidth);
    expect(Math.max(...three.nodes.map((n) => n.column))).toBe(2);
  });

  test('nothing to draw is an empty layout, never an error', () => {
    for (const links of [[], [{ source: 'pay', target: 'total', value: 0 }], [{ source: 'pay', target: 'total', value: Number.NaN }], [{ source: 'pay', target: 'total', value: -5 }]]) {
      const e = layoutSankey(NODES, links);
      expect([e.nodes, e.links, e.scale, e.plotHeight]).toEqual([[], [], 0, 0]);
    }
  });
});

describe('ribbons', () => {
  const l = layoutSankey(NODES, LINKS);
  const link = (s: string, t: string) => l.links.find((k) => k.source === s && k.target === t)!;

  test('as wide as their amount, at both ends, on the nodes’ scale', () => {
    for (const k of l.links) expect(near(k.width, k.value * l.scale)).toBe(true);
  });

  test('leave a node at the stacked offsets of the links before them, in the order of their targets, filling it', () => {
    for (const n of l.nodes) {
      const leaving = l.links.filter((k) => k.source === n.id).sort((a, b) => a.y0 - b.y0);
      if (leaving.length === 0) continue;
      let y = n.y;
      for (const k of leaving) {
        expect([n.id, k.target, near(k.y0, y), near(k.x0, n.x + n.width)]).toEqual([n.id, k.target, true, true]);
        y += k.width;
      }
      // Everything through it leaves it: the stack ends at its foot.
      expect([n.id, near(y, n.y + n.height)]).toEqual([n.id, true]);
      // In the order of the targets down their column.
      const targets = leaving.map((k) => node(l, k.target));
      expect(targets.map((t) => t.column * 100 + t.index)).toEqual([...targets.map((t) => t.column * 100 + t.index)].sort((a, b) => a - b));
    }
    expect(l.links.filter((k) => k.source === 'total').sort((a, b) => a.y0 - b.y0).map((k) => k.target)).toEqual(['food', 'home', 'fun', 'left']);
  });

  test('reach a node at the stacked offsets of the links before them, in the order of their sources, filling it', () => {
    for (const n of l.nodes) {
      const reaching = l.links.filter((k) => k.target === n.id).sort((a, b) => a.y1 - b.y1);
      if (reaching.length === 0) continue;
      let y = n.y;
      for (const k of reaching) {
        expect([n.id, k.source, near(k.y1, y), near(k.x1, n.x)]).toEqual([n.id, k.source, true, true]);
        y += k.width;
      }
      expect([n.id, near(y, n.y + n.height)]).toEqual([n.id, true]);
    }
    expect(link('pay', 'total').y1).toBe(node(l, 'total').y);
    expect(near(link('gift', 'total').y1, node(l, 'total').y + link('pay', 'total').width)).toBe(true);
  });

  test('two cubic curves from end to end, level where they leave and arrive, closed', () => {
    expect(ribbonPath(0, 10, 100, 50, 20)).toBe('M0,10C50,10 50,50 100,50L100,70C50,70 50,30 0,30Z');
    const k = link('food', 'groceries');
    const numbers = k.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // Starts at its source end's top, and comes back to its foot there.
    expect(near(numbers[0], k.x0) || Math.abs(numbers[0] - k.x0) < 0.01).toBe(true);
    expect(Math.abs(numbers[1] - k.y0)).toBeLessThan(0.01);
    expect(Math.abs(numbers[numbers.length - 1] - (k.y0 + k.width))).toBeLessThan(0.01);
    expect(k.path.endsWith('Z')).toBe(true);
    expect(k.path.match(/C/g)).toHaveLength(2);
  });

  test('never runs backwards: a link to the same or an earlier column is refused', () => {
    expect(() => layoutSankey(NODES, [...LINKS, { source: 'food', target: 'total', value: 10 }])).toThrow('later column');
    expect(() => layoutSankey(NODES, [...LINKS, { source: 'food', target: 'home', value: 10 }])).toThrow('later column');
    // Nor names a node not listed, nor lists one twice.
    expect(() => layoutSankey(NODES, [...LINKS, { source: 'total', target: 'ghost', value: 10 }])).toThrow('ghost');
    expect(() => layoutSankey([...NODES, { id: 'pay', column: 0 }], LINKS)).toThrow('twice');
  });
});

describe('labels', () => {
  const l = layoutSankey(NODES, LINKS);

  test('beside their node on the side asked for, outside it; none for a node that asks none', () => {
    const pay = node(l, 'pay');
    expect(pay.label).toMatchObject({ side: 'right', anchor: 'start', x: pay.x + pay.width + SANKEY_DEFAULTS.labelGap });
    const food = node(l, 'food');
    expect(food.label).toMatchObject({ side: 'left', anchor: 'end', x: food.x - SANKEY_DEFAULTS.labelGap });
    expect(node(l, 'total').label).toBeNull();
  });

  test('within the space to the next column, so no label runs into the one beyond', () => {
    const pay = node(l, 'pay');
    const total = node(l, 'total');
    expect(pay.label!.x + pay.label!.maxWidth).toBeLessThanOrEqual(total.x - SANKEY_DEFAULTS.labelGap + EPS);
    const rent = node(l, 'rent');
    const home = node(l, 'home');
    expect(rent.label!.x - rent.label!.maxWidth).toBeGreaterThanOrEqual(home.x + home.width + SANKEY_DEFAULTS.labelGap - EPS);
    expect(pay.label!.maxWidth).toBeGreaterThan(90);
  });

  test('centred on their node where there is room', () => {
    const home = node(l, 'home');
    expect(near(home.label!.y, home.y + home.height / 2)).toBe(true);
  });

  test('never overlap, however thin the nodes, and stay in the plot', () => {
    // Twelve slivers and one giant in a column: their middles nearly coincide.
    const slivers: SankeyNodeInput[] = [{ id: 'in', column: 0, side: 'right' }, ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, column: 1, side: 'left' as const }))];
    const links = slivers.slice(1).map((n, i) => ({ source: 'in', target: n.id, value: i === 0 ? 10_000 : 1 }));
    const out = layoutSankey(slivers, links);
    const ys = out.nodes.filter((n) => n.column === 1).map((n) => n.label!.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(SANKEY_DEFAULTS.labelHeight - EPS);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(out.plotTop + SANKEY_DEFAULTS.labelHeight / 2 - EPS);
    expect(Math.max(...ys)).toBeLessThanOrEqual(out.plotTop + out.plotHeight - SANKEY_DEFAULTS.labelHeight / 2 + EPS);
  });

  test('spreading moves each as little as it can: down, then back up from the foot of the plot', () => {
    expect(spreadLabels([10, 50, 90], 12, 6, 200)).toEqual([10, 50, 90]);
    expect(spreadLabels([10, 12, 14], 12, 6, 200)).toEqual([10, 22, 34]);
    expect(spreadLabels([190, 195, 199], 12, 6, 200)).toEqual([176, 188, 200]);
    expect(spreadLabels([0, 1], 12, 6, 200)).toEqual([6, 18]);
    expect(spreadLabels([], 12, 6, 200)).toEqual([]);
  });
});

describe('a label that fits', () => {
  test('whole when it fits; the name cut with an ellipsis when not; the amount alone, then nothing', () => {
    expect(fitLabel('Food', '$640', 100)).toEqual({ name: 'Food', amount: '$640' });
    const cut = fitLabel('Travel and entertainment', '$1.2K', 100)!;
    expect(cut.name.endsWith('…')).toBe(true);
    expect(cut.name.length).toBeLessThan('Travel and entertainment'.length);
    expect(textWidth(`${cut.name} ${cut.amount}`)).toBeLessThanOrEqual(100);
    expect(fitLabel('Travel and entertainment', '$1.2K', 34)).toEqual({ name: '', amount: '$1.2K' });
    expect(fitLabel('Travel', '$1.2K', 10)).toBeNull();
  });

  test('never splits a character written as two, nor ends on a space before the ellipsis', () => {
    const fit = fitLabel('Coffee 😀😀😀😀😀😀😀😀', '$5', 80)!;
    expect(fit.name.endsWith('…')).toBe(true);
    expect([...fit.name.slice(0, -1)].every((ch) => ch.length === 1 || /\p{Extended_Pictographic}/u.test(ch))).toBe(true);
    expect(fitLabel('Big Shop', '$5', textWidth('Big …') + textWidth(' $5') + 1)!.name).toBe('Big…');
  });

  test('text alone cut to a width: whole, with an ellipsis, or nothing', () => {
    expect(fitText('Food', 100)).toBe('Food');
    const cut = fitText('Travel and entertainment', 60);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut)).toBeLessThanOrEqual(60);
    expect(fitText('Travel', 5)).toBe('');
  });

  test('wide letters and full-width characters are counted wider than narrow ones', () => {
    expect(textWidth('MMMM')).toBeGreaterThan(textWidth('iiii'));
    expect(textWidth('食費')).toBeGreaterThan(textWidth('ab'));
    expect(textWidth('')).toBe(0);
  });
});

describe('no chart library', () => {
  test('the layout imports nothing, and the chart only React and Nya’s own modules', () => {
    const layout = readFileSync(join(import.meta.dir, '..', 'lib', 'sankey.ts'), 'utf8');
    expect(layout).not.toMatch(/^import /m);
    const chart = readFileSync(join(import.meta.dir, '..', 'components', 'CashFlowSankey.tsx'), 'utf8');
    const from = [...chart.matchAll(/^import [^;]* from '([^']+)';/gm)].map((m) => m[1]);
    expect(from.length).toBeGreaterThan(3);
    expect(from.filter((f) => f !== 'react' && !f.startsWith('@/lib/'))).toEqual([]);
  });
});
