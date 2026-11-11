// lib/import/pdf-text.ts
//
// A PDF's text, with where each piece sits on its page, for readers that go
// by position (lib/import/vanguard-performance.ts). It runs pdf.js, which the
// caller passes in: the browser loads pdfjs-dist when an import sheet asks
// for it (with its worker), and tests load its legacy build under Bun, so no
// page that never reads a PDF pays for it. Safe to import from client code.
//
// Only text is read. pdf.js never evaluates code from a file (version 6 has
// no eval at all), and fonts aren't loaded as web fonts, since nothing is
// drawn. A file larger than MAX_PDF_BYTES or longer than MAX_PDF_PAGES is
// refused before its pages are read: Vanguard's Performance page for thirty
// years is about a dozen pages and a few hundred kilobytes.

import type { PdfPage, PdfTextItem } from './vanguard-performance';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 60;

/** The parts of pdf.js used here, so either of its builds can be passed. */
export type PdfJs = {
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; disableFontFace?: boolean; verbosity?: number }): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
};
type PdfDocument = { numPages: number; getPage(n: number): Promise<PdfDocPage> };
type PdfDocPage = {
  getViewport(o: { scale: number }): { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
};

export type PdfTextError = 'too-large' | 'too-many-pages' | 'password' | 'unreadable';

/** Each page's text items, from the page's top left, in points. */
export async function pdfTextPages(
  data: Uint8Array,
  pdfjs: PdfJs,
  limits: { bytes: number; pages: number } = { bytes: MAX_PDF_BYTES, pages: MAX_PDF_PAGES }
): Promise<PdfPage[] | { error: PdfTextError }> {
  if (data.byteLength > limits.bytes) return { error: 'too-large' };
  // pdf.js may hand the buffer to its worker, so it gets a copy.
  const task = pdfjs.getDocument({ data: data.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    return { error: (e as { name?: string })?.name === 'PasswordException' ? 'password' : 'unreadable' };
  }
  try {
    if (doc.numPages > limits.pages) return { error: 'too-many-pages' };
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        const it = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
        if (typeof it.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform)) continue;
        const [x, y] = view.convertToViewportPoint(Number(it.transform[4]), Number(it.transform[5]));
        const width = Number(it.width);
        const height = Number(it.height);
        if (![x, y, width, height].every(Number.isFinite)) continue;
        items.push({ text: it.str, x, y, width, height });
      }
      pages.push({ width: view.width, height: view.height, items });
    }
    return pages;
  } catch {
    return { error: 'unreadable' };
  } finally {
    // The loading task owns the document (and the worker's copy of it).
    await task.destroy().catch(() => {});
  }
}
