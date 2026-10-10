import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import OpenProtectedDownload from '@/components/OpenProtectedDownload';

export const metadata: Metadata = {
  title: 'Open a protected download · Nya',
  description: 'Open a download of your Nya data that you protected with a passphrase, in your browser.',
};

// Opens a download of my data protected with a passphrase
// (lib/protected-download.ts), in the browser, where the file never leaves
// the device (components/OpenProtectedDownload.tsx). Public (proxy.ts): it
// reads no stored data and needs no sign-in, so a file still opens after the
// account it came from is deleted. It also says how to open the file without
// Nya at all, with the age app, since a protected download is an age file
// (docs/data-export.md).

export default function OpenDownloadPage() {
  return (
    <InfoPage page="open-download" title="Open a protected download" intro="A download of your data that you protected with a passphrase, opened in your browser.">
      <section className="card info-section info-notice">
        <p>
          Your file is opened on your device, by this page: it is never uploaded, and nothing about it is sent anywhere. You
          don’t need to sign in, so a file still opens here after the account it came from is deleted.
        </p>
      </section>

      <OpenProtectedDownload />

      <InfoSection title="With the age app">
        <p>
          A protected download is an age file (age-encryption.org), so the age app opens it too, without Nya. It runs on
          macOS, Linux and Windows. In a terminal:
        </p>
        <pre>
          <code>age -d -o nya-data-2026-10-10.json nya-data-2026-10-10.json.age</code>
        </pre>
        <p>
          It asks for the passphrase, then writes the opened file. To install it: <code>brew install age</code> on a Mac
          with Homebrew, <code>apt install age</code> on Debian or Ubuntu, or <code>winget install --id FiloSottile.age</code>{' '}
          on Windows.
        </p>
      </InfoSection>

      <InfoSection title="If it doesn’t open">
        <ul>
          <li>
            Type the passphrase exactly as you set it: capitals, spaces and punctuation count. Nya never keeps it, so
            nobody can recover a lost one, and nobody can open the file without it.
          </li>
          <li>
            A file that was cut short while it was saved, or changed since, doesn’t open at all rather than opening in
            part. Download it again.
          </li>
          <li>
            Unlocking the file takes about 256 MB of memory for a few seconds, then room for what it opens. An older
            phone may stop the page, or say it can’t spare the memory: open the file on a computer instead.
          </li>
          <li>Once opened, the file isn’t protected any more, so keep it somewhere safe.</li>
        </ul>
      </InfoSection>
    </InfoPage>
  );
}
