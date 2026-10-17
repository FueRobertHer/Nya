// The dashboard's header on a phone. Beside the brand, password mode's three
// buttons (Refresh, Log out, Sign out everywhere) don't fit at 390 px, nor
// its two at 320 px; a row of buttons that can neither shrink nor wrap then
// pushes the page wider than the screen, and it scrolls sideways. The suite
// cannot lay a page out, so this holds the rules that let the header fit (seen
// in Chromium at 320 and 390 px, in both sign-in modes, when they were written)
// and the markup they rely on.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const css = readFileSync(join(ROOT, 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const dashboard = readFileSync(join(ROOT, 'components', 'Dashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** The declarations of every rule outside an at-rule whose selector is
 *  exactly `selector`, in order, so a later one wins as in the browser. */
function declared(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let head = '';
  let body = '';
  for (const ch of css) {
    if (ch === '{') {
      depth++;
      if (depth === 1) body = '';
      else body += ch;
    } else if (ch === '}') {
      depth--;
      if (depth > 0) body += ch;
      else {
        if (head.trim() === selector) {
          for (const d of body.split(';')) {
            const at = d.indexOf(':');
            if (at > 0) out.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
          }
        }
        head = '';
      }
    } else if (depth === 0) head += ch;
    else body += ch;
  }
  return out;
}

describe("the dashboard's header", () => {
  test('its buttons wrap onto another line rather than push the page wider than the screen', () => {
    const actions = declared('.top-actions');
    expect(actions.get('display')).toBe('flex');
    expect(actions.get('flex-wrap')).toBe('wrap');
    expect(actions.get('justify-content')).toBe('flex-end');
    // A row that may not shrink can't wrap either.
    expect(actions.get('flex-shrink') ?? '1').not.toBe('0');
  });

  test('the brand takes what the buttons leave, so they keep one line wherever they fit', () => {
    expect(declared('.top-row > :first-child').get('flex')).toBe('1 1 0');
  });

  test('the markup is the one the rules are written for: the brand first, then the buttons', () => {
    const row = dashboard.slice(dashboard.indexOf('<div className="top-row">'));
    expect(row).toMatch(/^<div className="top-row">\s*<div>\s*<div className="brand">/);
    expect(row.indexOf('<div className="top-actions">')).toBeGreaterThan(row.indexOf('<p className="sub">'));
  });
});
