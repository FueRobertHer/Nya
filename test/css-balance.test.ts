// The stylesheet is one file every feature appends to, and a merge that drops a
// brace nests everything after it inside the previous rule, where it matches
// nothing. The suite cannot see CSS otherwise, so this checks the structure.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stylesheet without comments and strings, which may hold braces. */
function structure(css: string): string {
  // Comments keep their line breaks, so reported line numbers stay exact.
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

describe('app/globals.css', () => {
  const css = structure(readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8'));

  test('every brace closes, and none closes early', () => {
    let depth = 0;
    let line = 1;
    for (const ch of css) {
      if (ch === '\n') line++;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth < 0) throw new Error(`An extra closing brace near line ${line}`);
    }
    expect(depth).toBe(0);
  });

  test('rules nest only inside at-rules (no rule left open above another)', () => {
    // A selector block opened inside another selector block means a brace is
    // missing; at-rules (@media, @supports, @keyframes) are the only nesting
    // this stylesheet uses.
    const stack: string[] = [];
    let head = '';
    let line = 1;
    for (const ch of css) {
      if (ch === '\n') line++;
      if (ch === '{') {
        const selector = head.trim();
        const parent = stack[stack.length - 1];
        if (parent !== undefined && !parent.startsWith('@') && !/^(from|to|\d+%)/.test(selector)) {
          throw new Error(`"${selector}" opens inside "${parent}" near line ${line}: a closing brace is missing`);
        }
        stack.push(selector);
        head = '';
      } else if (ch === '}') {
        stack.pop();
        head = '';
      } else if (ch === ';') {
        head = '';
      } else {
        head += ch;
      }
    }
    expect(stack).toEqual([]);
  });
});
