// Preloaded by test/hide-amounts.test.tsx into a run of the view suites
// (`bun test --preload`), for its backstop: each render a suite makes is
// given back as the suite asked for it, then made again with amounts hidden,
// and what that one shows a person or a screen reader (each piece of its
// text, each label read alone, each option of a select) is written to the
// file NYA_HIDDEN_RENDERS names, one line each, after the test file that
// made it: the lines holding a digit, once each. A figure the scan of the
// source can't see (a number drawn as it is) shows there.
import { mock } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { amountsHidden, setAmountsHidden } from '../lib/format';

const OUT = process.env.NYA_HIDDEN_RENDERS;
const real = require('react-dom/server');
const seen = new Set<string>();

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** The test file a render was made from. */
function suite(): string {
  const frame = (new Error().stack ?? '').split('\n').find((l) => /[\\/]test[\\/][\w-]+\.test\.tsx?:\d+/.test(l));
  return /test[\\/][\w-]+\.test\.tsx?:\d+/.exec(frame ?? '')?.[0].replace('\\', '/') ?? '?';
}

function record(html: string) {
  if (!OUT) return;
  const where = suite();
  const shown = [
    ...html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, '\n').split('\n'),
    ...[...html.matchAll(/\s(aria-label|aria-valuetext|aria-description|title|alt)="([^"]*)"/g)].map((m) => `[${m[1]}] ${m[2]}`),
  ];
  for (const piece of shown) {
    const line = decode(piece).trim();
    if (!/\d/.test(line) || seen.has(`${where}\t${line}`)) continue;
    seen.add(`${where}\t${line}`);
    appendFileSync(OUT, `${where}\t${line}\n`);
  }
}

/** `render`, as the suite asked, and again with amounts hidden for the record. */
const twice =
  (render: (...args: unknown[]) => string) =>
  (...args: unknown[]): string => {
    const html = render(...args);
    if (amountsHidden()) {
      record(html);
      return html;
    }
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    setAmountsHidden(true);
    if (none) delete g.window;
    try {
      record(render(...args));
    } finally {
      setAmountsHidden(false);
    }
    return html;
  };

mock.module('react-dom/server', () => ({ ...real, renderToStaticMarkup: twice(real.renderToStaticMarkup), renderToString: twice(real.renderToString) }));
