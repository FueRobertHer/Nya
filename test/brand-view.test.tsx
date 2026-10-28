import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Brand, BrandLogo } from '@/components/Brand';

// The header logo as a two-ink mark (look and feel, step 4): one inline SVG,
// its one ink the theme's --brand-mark (through .brand-mark's color), cut by
// a mask so the page is its disc. No image to swap by theme.

describe('the logo mark', () => {
  test('one inline SVG in the current color, hidden from screen readers, no image', () => {
    const html = renderToStaticMarkup(<Brand />);
    expect(html).not.toContain('<img');
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<rect [^>]*fill="currentColor"/);
    expect(html).toContain('<h1>Nya</h1>');
  });

  test('the mask keeps the ring and the face, and cuts the disc and the features', () => {
    const html = renderToStaticMarkup(<BrandLogo />);
    const fills = [...html.matchAll(/<path fill="(white|black)"/g)].map((m) => m[1]);
    // The ring, the disc inside it, the face, then its eleven features.
    expect(fills).toEqual(['white', 'black', 'white', ...Array(11).fill('black')]);
  });

  test('two marks on one page each use their own mask', () => {
    const html = renderToStaticMarkup(
      <>
        <BrandLogo />
        <BrandLogo />
      </>,
    );
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`mask="url(#${id})"`);
  });
});
