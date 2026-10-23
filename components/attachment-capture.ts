// components/attachment-capture.ts
//
// Getting a receipt or a document ready to attach (#47, lib/attachments.ts),
// in the browser, before anything is sent: a photo is shrunk to what a
// receipt needs and re-encoded as JPEG, which also drops what the camera
// saved with it (where it was taken, when, with what): a canvas writes none
// of it, and the server refuses a photo that still carries a location
// (lib/attachment-crypto.ts jpegProblem). A thumbnail is made at the same
// time, for the transaction's sheet. A PDF goes as it is, with what it
// carries.
//
// THE SIZE. At most LONG_SIDE pixels on the long side, or TALL_LONG_SIDE for a
// till receipt (more than TALL_RATIO times taller than wide), so its short
// side keeps about a thousand pixels of small print; JPEG at QUALITY, again
// at RETRY_QUALITY when that is still over MAX_PHOTO_BYTES. A 12-megapixel
// phone photo of a receipt comes to about 300 KB.
//
// WHAT CAN BE OPENED. Any image this browser can decode (createImageBitmap,
// else an <img>): JPEG, PNG, WebP, GIF (its first frame), and HEIC and TIFF
// where the browser opens them (Safari does). An iPhone's picker usually
// hands over a JPEG already. A HEIC this browser can't open (Chrome or
// Firefox on a computer or an Android phone) is refused with what to do,
// never sent to be converted. Anything else is refused, as is a picture past
// MAX_INPUT_BYTES, which a phone can't decode whole.
//
// The pure parts (the sizes, what a file is) are exported for tests.

/** The largest picture taken in, before shrinking. */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const LONG_SIDE = 2048;
export const TALL_LONG_SIDE = 3072;
export const TALL_RATIO = 2.5;
export const QUALITY = 0.75;
export const RETRY_QUALITY = 0.6;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const THUMB_SIDE = 320;
export const THUMB_QUALITY = 0.7;
/** The largest file attached (as lib/attachment-crypto.ts MAX_FILE_BYTES). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What the page has made ready: the bytes to send, and a thumbnail. */
export type Prepared = { kind: 'image' | 'pdf'; bytes: Uint8Array; thumb: Uint8Array | null; name: string | null };
export type Refused = { refused: string };

/** The size a picture is drawn at: no larger than it is, its long side at
 *  most LONG_SIDE (TALL_LONG_SIDE for a tall receipt), its shape kept. */
export function targetSize(width: number, height: number, limit?: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const cap = limit ?? (long / short > TALL_RATIO ? TALL_LONG_SIDE : LONG_SIDE);
  const scale = Math.min(1, cap / long);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Whether bytes are a HEIC or HEIF picture (its "ftyp" box's brand). */
export function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const text = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  return text(4, 4) === 'ftyp' && HEIC_BRANDS.has(text(8, 4));
}

/** Whether bytes are a PDF: "%PDF-" in their first kilobyte, as readers allow. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
  return head.includes('%PDF-');
}

/** What a chosen file looks like it is, from its type and name, before any
 *  byte is read. */
export function looksLike(file: { type: string; name: string }): 'pdf' | 'image' | 'heic' | 'other' {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'image/heic' || type === 'image/heif' || /\.hei[cf]$/.test(name)) return 'heic';
  if (type.startsWith('image/') || /\.(jpe?g|png|webp|gif|tiff?|bmp|avif)$/.test(name)) return 'image';
  return 'other';
}

export const HEIC_REFUSAL = 'This browser can’t open HEIC photos. Choose it again from your phone’s own browser, or save it as JPEG first.';
export const OTHER_REFUSAL = 'Only photos and PDFs can be attached. Save the document as a PDF first.';
export const TOO_LARGE_PDF = 'A PDF can be at most 10 MB.';
export const TOO_LARGE_PICTURE = 'This picture is too large to open here. Take a smaller one, or save it smaller first.';

/** The name a file keeps: its own, unless the camera made it up. */
function keptName(file: { name: string }): string | null {
  const n = file.name.trim();
  if (!n || /^(image|photo|img)[_ -]?\d*\.(jpe?g|png|heic|heif)$/i.test(n)) return null;
  return n.replace(/\.(heic|heif|png|webp|gif|tiff?|bmp|avif)$/i, '.jpg');
}

/** A picture decoded, oriented as the camera held it, ready to draw. */
type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Not decodable this way: an <img> may still open it.
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws a picture at a size and encodes it as JPEG. */
async function encode(d: Decoded, size: { width: number; height: number }, quality: number): Promise<Uint8Array | null> {
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff'; // a transparent PNG becomes white, not black
    g.fillRect(0, 0, size.width, size.height);
    g.drawImage(d.source, 0, 0, size.width, size.height);
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size.width, size.height);
    g.drawImage(d.source, 0, 0, size.width, size.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** A chosen file, ready to send, or why it can't be (see the header). */
export async function prepareFile(file: File): Promise<Prepared | Refused> {
  const looks = looksLike(file);
  if (looks === 'other') return { refused: OTHER_REFUSAL };
  if (looks === 'pdf') {
    if (file.size > MAX_FILE_BYTES) return { refused: TOO_LARGE_PDF };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPdfBytes(bytes)) return { refused: 'This file isn’t a PDF this app can read.' };
    return { kind: 'pdf', bytes, thumb: null, name: file.name.trim() || null };
  }
  if (file.size > MAX_INPUT_BYTES) return { refused: TOO_LARGE_PICTURE };
  const decoded = await decode(file);
  if (!decoded) {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    return { refused: looks === 'heic' || isHeicBytes(head) ? HEIC_REFUSAL : 'This picture can’t be opened here.' };
  }
  try {
    let bytes = await encode(decoded, targetSize(decoded.width, decoded.height), QUALITY);
    if (bytes && bytes.length > MAX_PHOTO_BYTES) bytes = await encode(decoded, targetSize(decoded.width, decoded.height), RETRY_QUALITY);
    if (bytes && bytes.length > MAX_PHOTO_BYTES) bytes = await encode(decoded, targetSize(decoded.width, decoded.height, LONG_SIDE * 0.75), RETRY_QUALITY);
    if (!bytes || bytes.length > MAX_FILE_BYTES) return { refused: 'This picture couldn’t be made small enough to attach.' };
    const thumb = await encode(decoded, targetSize(decoded.width, decoded.height, THUMB_SIDE), THUMB_QUALITY);
    return { kind: 'image', bytes, thumb, name: keptName(file) };
  } finally {
    decoded.close();
  }
}

/** The SHA-256 of each part of the bytes, as hex: what the server checks each
 *  part against (lib/attachments.ts receivePart). */
export async function partDigests(bytes: Uint8Array, partBytes: number): Promise<string[]> {
  const out: string[] = [];
  for (let at = 0; at < bytes.length; at += partBytes) out.push(await digest(bytes.subarray(at, at + partBytes)));
  return out;
}

export async function digest(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
