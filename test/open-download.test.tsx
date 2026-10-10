import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import OpenDownloadPage from '@/app/open-download/page';
import { OpenProtectedDownloadView, openFile, openFailure, openedName, sizeOf, type OpenPhase } from '@/components/OpenProtectedDownload';
import { AgeError } from '@/lib/age/age';
import { protectFile } from '@/lib/protected-download';

// The page that opens a protected download in the browser (app/open-download,
// components/OpenProtectedDownload.tsx): public, reading nothing stored, and
// sending the file nowhere. The format itself is test/age.test.ts.

const ROOT = join(import.meta.dir, '..');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const PASSPHRASE = 'piano orbit lantern harvest';
const enc = (s: string) => new TextEncoder().encode(s);

/** A protected file as the download writes one, at a quick setting. */
async function protectedFile(contents: string, workFactor = 10) {
  const made = await protectFile({ filename: 'nya-data-2026-10-10.json', chunks: () => [enc(contents)] }, enc(contents).length, PASSPHRASE, { workFactor });
  return new Uint8Array(Buffer.concat([...made.chunks()]));
}

describe('the page', () => {
  const page = () => renderToStaticMarkup(<OpenDownloadPage />);

  test('says the file never leaves the device and no sign-in is needed, and how to open it without Nya', () => {
    const html = page();
    const words = text(html);
    expect(words).toContain('Open a protected download');
    expect(words).toContain('Your file is opened on your device, by this page: it is never uploaded, and nothing about it is sent anywhere.');
    expect(words).toContain('You don’t need to sign in, so a file still opens here after the account it came from is deleted.');
    expect(words).toContain('age -d -o nya-data-2026-10-10.json nya-data-2026-10-10.json.age');
    for (const install of ['brew install age', 'apt install age', 'winget install --id FiloSottile.age']) expect(words).toContain(install);
    expect(words).toContain('Nya never keeps it, so nobody can recover a lost one');
    // The frame of the public pages: back into the app, and the other pages.
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain('aria-current');
    expect(words).not.toMatch(/[\u2013\u2014]/);
  });

  test('asks for the file and its passphrase, and won’t open without both', () => {
    const view = (over: Partial<Parameters<typeof OpenProtectedDownloadView>[0]> = {}) =>
      renderToStaticMarkup(
        <OpenProtectedDownloadView fileName={null} onFile={() => {}} passphrase="" onPassphrase={() => {}} phase={{ kind: 'idle' }} onOpen={() => {}} onSaveAgain={() => {}} {...over} />
      );
    const button = (html: string) => /<button[^>]*>([^<]*)<\/button>/.exec(html)!;
    expect(view()).toContain('type="file"');
    expect(view()).toContain('accept=".age"');
    expect(view()).toContain('type="password"');
    expect(button(view())[0]).toMatch(/disabled/);
    expect(button(view({ fileName: 'f.json.age' }))[0]).toMatch(/disabled/);
    expect(button(view({ fileName: 'f.json.age', passphrase: 'x' }))[0]).not.toMatch(/disabled/);
    const phases: [OpenPhase, string][] = [
      [{ kind: 'working', step: 'key', done: 0.42 }, 'Unlocking it with your passphrase… 42%. This takes a few seconds on purpose: it is what makes guessing a passphrase slow.'],
      [{ kind: 'working', step: 'contents', done: 0.5 }, 'Opening… 50%'],
      [{ kind: 'done', name: 'f.json', blob: new Blob(['x'.repeat(3000)]) }, 'Opened and saved f.json (3 KB). It isn’t protected any more, so keep it somewhere safe.'],
      [{ kind: 'error', message: 'That passphrase doesn’t open this file.' }, 'That passphrase doesn’t open this file.'],
    ];
    for (const [phase, said] of phases) expect(text(view({ fileName: 'f.json.age', passphrase: 'x', phase }))).toContain(said);
    // While it works, nothing can be changed or started again.
    expect(button(view({ fileName: 'f.json.age', passphrase: 'x', phase: { kind: 'working', step: 'key', done: 0 } }))[0]).toMatch(/disabled/);
    expect(view({ phase: { kind: 'done', name: 'f.json', blob: new Blob(['x']) } })).toContain('Save it again');
  });

  test('the opened file is named as the protected one was, without .age', () => {
    expect(openedName('nya-data-2026-10-10.json.age')).toBe('nya-data-2026-10-10.json');
    expect(openedName('statement.OFX.AGE')).toBe('statement.OFX');
    expect(openedName('notes.txt')).toBe('notes.txt.opened');
    expect(openedName('.age')).toBe('.age.opened');
    expect([sizeOf(512), sizeOf(4096), sizeOf(3 * 1024 * 1024)]).toEqual(['512 bytes', '4 KB', '3.0 MB']);
  });
});

describe('opening a file', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('opens a protected download whole, saying how far it has got, and sends nothing anywhere', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error('nothing may be sent');
    }) as unknown as typeof fetch;
    const contents = '{"format":"nya-export"}\n'.repeat(5000);
    const file = await protectedFile(contents);
    const phases: OpenPhase[] = [];
    const opened = await openFile(new Blob([file]), PASSPHRASE, (p) => phases.push(p));
    expect(await opened.text()).toBe(contents);
    expect(phases[0]).toEqual({ kind: 'working', step: 'key', done: 0 });
    expect(phases.some((p) => p.kind === 'working' && p.step === 'contents')).toBe(true);
    expect(phases.at(-1)).toEqual({ kind: 'working', step: 'contents', done: 1 });
    expect(requests).toBe(0);
  });

  test('a wrong passphrase, a damaged file, a changed one, the wrong kind of file: nothing opened, and why in words', async () => {
    const file = await protectedFile('secret contents');
    const failure = async (bytes: Uint8Array, passphrase = PASSPHRASE) => {
      try {
        await openFile(new Blob([bytes as Uint8Array<ArrayBuffer>]), passphrase, () => {});
        return 'opened';
      } catch (err) {
        return openFailure(err);
      }
    };
    expect(await failure(file, 'not the passphrase')).toBe('That passphrase doesn’t open this file. Type it exactly as you set it: capitals, spaces and punctuation count.');
    expect(await failure(file.subarray(0, file.length - 1))).toBe(
      'This file is damaged or incomplete (it may have been cut short while it was saved), so nothing was opened. Download it again.'
    );
    const changed = file.slice();
    changed[changed.length - 20] ^= 1;
    expect(await failure(changed)).toStartWith('This file is damaged or incomplete');
    expect(await failure(enc('{"format":"nya-export"}'))).toBe('This isn’t a protected download: those end in .age. A file ending in .json, .csv or .ofx is already open.');
    expect(openFailure(new AgeError('mac', 'x'))).toBe('This file was changed after it was made, so it can’t be trusted, and nothing was opened. Download it again.');
    expect(openFailure(new Error('boom'))).toBe('The file couldn’t be opened here. Try again, or open it with the age app.');
  });

  test('a slower setting than a browser can manage is sent to the age app, before any of the slow work', async () => {
    const file = await protectedFile('x');
    // The same file with its work factor raised past age's own: refused as it
    // is read, before the key is worked out.
    const header = new TextDecoder('latin1').decode(file.subarray(0, 80));
    const raised = enc(header.replace(/ 10\n/, ' 19\n'));
    const bytes = new Uint8Array(file.length);
    bytes.set(file);
    bytes.set(raised, 0);
    let worked = false;
    const message = await openFile(new Blob([bytes]), PASSPHRASE, (p) => {
      if (p.kind === 'working' && p.done > 0) worked = true;
    }).then(
      () => 'opened',
      (err) => openFailure(err)
    );
    expect(message).toBe('This file was protected with a slower setting than this page can manage. Open it with the age app instead.');
    expect(worked).toBe(false);
  });

  // Read from the source: the page's code makes no request of any kind, so
  // the file can't leave the device through it.
  test('nothing on the page’s path can send anything', () => {
    const files = ['components/OpenProtectedDownload.tsx', 'app/open-download/page.tsx', ...readdirSync(join(ROOT, 'lib', 'age')).map((f) => `lib/age/${f}`)];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8').replace(/\/\/[^\n]*/g, '');
      expect([file, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.share|<form/.test(source)]).toEqual([file, false]);
    }
  });
});
