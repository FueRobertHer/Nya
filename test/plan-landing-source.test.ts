import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Home's FI line opens the Plan tab on Your path and lands on its heading
// (rollout phase 6b). The dashboard needs Clerk and Plaid Link to render, so
// its side is read from the source, as test/budgets-segments-view.test.tsx
// reads Budgets'; the Plan's side, the heading taking focus, is rendered in
// test/plan-bar-view.test.tsx. Dashboard.tsx is stored with CRLF endings:
// they are read as LF.

const src = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** The text from `start` to the first `end` after it. */
const from = (start: string, end: string) => {
  const at = src.indexOf(start);
  expect([start, at >= 0]).toEqual([start, true]);
  return src.slice(at, src.indexOf(end, at));
};

describe('Home’s FI line and the Plan tab', () => {
  test('the FI line opens the Plan at its top, on Your path, with a landing for its heading', () => {
    const open = from('onOpenPlan={() => {', '}}');
    expect(open).toContain('window.scrollTo(0, 0);');
    expect(open).toContain("setPlanSegment('path');");
    expect(open).toContain('setPlanLanding(Date.now());');
    expect(open).toContain("setTab('plan');");
  });

  test('the Plan keeps its segment with the dashboard, and is handed the landing, which it clears once landed', () => {
    expect(src).toContain("const [planSegment, setPlanSegment] = useState<PlanSegment>('path');");
    expect(src).toContain('const [planLanding, setPlanLanding] = useState<number | null>(null);');
    const tag = from('<PlanTabLoader', '/>');
    expect(tag).toContain('segment={planSegment}');
    expect(tag).toContain('onSegment={setPlanSegment}');
    expect(tag).toContain('landing={planLanding}');
    expect(tag).toContain('onLanded={() => setPlanLanding(null)}');
  });

  test('otherwise the landing is cleared only while another tab is shown, never in the commit that opens the Plan', () => {
    // A first visit is still loading the Plan's code then: a landing cleared
    // as the tab opens would be gone before its heading is drawn.
    const writes = [...src.matchAll(/setPlanLanding\(/g)].length;
    expect(writes).toBe(3);
    expect(src).toContain("if (tab !== 'plan' && planLanding !== null) setPlanLanding(null);");
    // The FI line's write is its only other one.
    expect(src.split('setPlanLanding(Date.now())').length - 1).toBe(1);
  });

  test('the dashboard imports only a type from the Plan’s bar, and nothing from the Plan tab, so the Plan’s code stays lazy', () => {
    // Every import statement, a side effect's alone (`import './x';`) too.
    const imports = [...src.matchAll(/^import\s+(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"];/gm)];
    // By either path the dashboard could name it by.
    const of = (name: string) => imports.filter((m) => m[1] === `./${name}` || m[1] === `@/components/${name}`).map((m) => m[0]);
    expect(of('PlanBar')).toEqual(["import type { PlanSegment } from './PlanBar';"]);
    expect(of('PlanTab')).toEqual([]);
    expect(of('PlanTabLoader')).toEqual(["import PlanTabLoader from './PlanTabLoader';"]);
    // Nor loaded any other way.
    expect(src).not.toMatch(/(?:import|require)\(\s*['"](?:\.\/|@\/components\/)Plan(?:Tab|Bar)['"]/);
  });
});
