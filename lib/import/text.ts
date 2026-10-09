// lib/import/text.ts
//
// A file's bytes as text, and which format it is in. Pure, safe to import from
// client code: the import sheet reads a file the same way the server does.
//
// ENCODING. Banks write files in UTF-8, in UTF-16 (Excel's "Unicode text"), or
// in Windows-1252, the old Western code page OFX 1.x declares as CHARSET:1252
// and many European banks still use for CSV. A file that starts with a byte
// order mark is read as it says. An OFX 1.x header that names its character
// set is believed. Anything else is read as UTF-8 if it is valid UTF-8, and
// as Windows-1252 otherwise: text in Windows-1252 with accents is almost never
// valid UTF-8 by accident, and reading it as UTF-8 would turn every "é" into
// a replacement character. (ISO-8859-1 is read as Windows-1252, its superset,
// as browsers do.)
//
// FORMAT. Decided by what the file holds, not its name: an OFX or QFX file
// has an OFX header or an <OFX> element, a QIF file starts with "!Type:" (or
// Quicken's "!Account" or "!Option" lines), and anything else is read as CSV.
// A name that says otherwise is reported, so a bank's mislabelled download
// can be told from the wrong file.

import type { FileFormat } from './record';

export type DecodedText = { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' };

const decode = (bytes: Uint8Array, encoding: DecodedText['encoding'], fatal = false) => new TextDecoder(encoding, { fatal }).decode(bytes);

/** The character set an OFX 1.x header declares, if it is one of these. */
function ofxHeaderCharset(head: string): DecodedText['encoding'] | null {
  if (!/^\s*OFXHEADER\s*:/i.test(head)) return null;
  const encoding = /^\s*ENCODING\s*:\s*([^\r\n]*)/im.exec(head)?.[1]?.trim().toUpperCase();
  if (encoding === 'UTF-8' || encoding === 'UTF8') return 'utf-8';
  const charset = /^\s*CHARSET\s*:\s*([^\r\n]*)/im.exec(head)?.[1]?.trim().toUpperCase();
  if (charset === '1252' || charset === 'WINDOWS-1252' || charset === '8859-1' || charset === 'ISO-8859-1' || charset === 'LATIN1') return 'windows-1252';
  return null;
}

/**
 * The file's text, without a byte order mark, and the encoding it was read
 * in (see the header).
 */
export function decodeFile(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: decode(bytes.subarray(3), 'utf-8'), encoding: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode(bytes.subarray(2), 'utf-16le'), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode(bytes.subarray(2), 'utf-16be'), encoding: 'utf-16be' };
  // The header is ASCII, so the first bytes read the same in any of these.
  const declared = ofxHeaderCharset(decode(bytes.subarray(0, 1024), 'windows-1252'));
  if (declared) return { text: decode(bytes, declared), encoding: declared };
  try {
    return { text: decode(bytes, 'utf-8', true), encoding: 'utf-8' };
  } catch {
    return { text: decode(bytes, 'windows-1252'), encoding: 'windows-1252' };
  }
}

/** The format the file's own content says it is in (see the header). */
export function detectFormat(text: string): FileFormat {
  const head = text.slice(0, 4096);
  if (/^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX\b/i.test(head) || /<OFX>/i.test(head)) return 'ofx';
  const first = head.split(/\r\n|\n|\r/).find((l) => l.trim() !== '') ?? '';
  if (/^\s*!(?:Type|Account|Option|Clear)\s*:?/i.test(first)) return 'qif';
  return 'csv';
}

/** The format a file's name suggests, or null for a name that suggests none. */
export function formatFromName(name: string | null | undefined): FileFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'qif') return 'qif';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  return null;
}

/** Names for the formats, in the person's words. */
export const FORMAT_NAMES: Record<FileFormat, string> = { ofx: 'OFX', csv: 'CSV', qif: 'QIF' };
