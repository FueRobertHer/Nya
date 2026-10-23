'use client';

// The receipt "Delete my account" ends with (lib/deletion-receipt.ts): what
// was deleted, what expires later and when, and what stays and why, with Copy
// and Download as text.
//
// It is shown on the sign-in page, where the deletion ends: the account's
// session is gone with it, and Clerk closes the account window it started in
// as soon as it notices. The page that deleted keeps the receipt in this
// tab's sessionStorage on the way (counts and dates, nothing stored about the
// person), and this shows it until Done or the tab closes. Where that storage
// is off, components/DeleteAccount.tsx shows it in place instead.

import { useEffect, useState } from 'react';
import {
  asDeletionReceipt,
  mergeCounts,
  receiptSections,
  receiptText,
  receiptFilename,
  PLAID_PORTAL,
  type DeletionCounts,
  type DeletionReceipt,
  type ReceiptFormat,
} from '@/lib/deletion-receipt';

const RECEIPT_KEY = 'nya:deletion-receipt';
/** What an unfinished attempt deleted (DeleteAccount), until one finishes. */
const PARTIAL_KEY = 'nya:deletion-partial';

function readJson(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function forget(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage off: nothing was kept.
  }
}

/** Keeps the receipt for the sign-in page. False when it can't be kept. */
export function keepReceipt(receipt: DeletionReceipt): boolean {
  try {
    sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
    return sessionStorage.getItem(RECEIPT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Adds what an unfinished attempt deleted to what it reports, so a retry's
 *  receipt counts both. */
export function keepPartial(counts: DeletionCounts): void {
  const earlier = readJson(PARTIAL_KEY) as DeletionCounts | null;
  try {
    sessionStorage.setItem(PARTIAL_KEY, JSON.stringify(earlier ? mergeCounts(earlier, counts) : counts));
  } catch {
    // Storage off: the receipt says the counts are what this attempt found.
  }
}

/** The receipt with any unfinished attempt's counts added, which are then let go. */
export function withEarlierAttempts(receipt: DeletionReceipt): DeletionReceipt {
  const earlier = readJson(PARTIAL_KEY) as DeletionCounts | null;
  forget(PARTIAL_KEY);
  if (!earlier || typeof earlier.banks_disconnected !== 'number') return receipt;
  return { ...receipt, deleted: mergeCounts(earlier, receipt.deleted), includes_earlier_attempt: true };
}

/** On the sign-in page: the receipt of a deletion this tab just made. */
export default function DeletionReceiptNotice() {
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  useEffect(() => setReceipt(asDeletionReceipt(readJson(RECEIPT_KEY))), []);
  if (!receipt) return null;
  return (
    <DeletionReceiptView
      receipt={receipt}
      doneLabel="Done"
      onDone={() => {
        forget(RECEIPT_KEY);
        setReceipt(null);
      }}
    />
  );
}

/** A line with the Plaid Portal's address as a link. */
function withLink(line: string) {
  const at = line.indexOf(PLAID_PORTAL);
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <a href={PLAID_PORTAL} target="_blank" rel="noreferrer">
        {PLAID_PORTAL}
      </a>
      {line.slice(at + PLAID_PORTAL.length)}
    </>
  );
}

export function DeletionReceiptView({
  receipt,
  onDone,
  doneLabel,
  format,
}: {
  receipt: DeletionReceipt;
  onDone: () => void;
  doneLabel: string;
  /** Tests fix the locale and time zone; people get their own. */
  format?: ReceiptFormat;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = () => receiptText(receipt, format);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  const onDownload = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = receiptFilename(receipt, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="card receipt-card">
      <h2>Your account was deleted</h2>
      <p className="panel-note">
        What was deleted, what expires later, and what stays. Save a copy: it goes away when you press {doneLabel} or
        close this tab.
      </p>
      {receiptSections(receipt, format).map((s) => (
        <section key={s.title} className="receipt-section">
          <h3 className="section-label">{s.title}</h3>
          <ul>
            {s.lines.map((line) => (
              <li key={line}>{withLink(line)}</li>
            ))}
          </ul>
        </section>
      ))}
      <div className="button-pair">
        <button className="secondary" onClick={onCopy}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button className="secondary" onClick={onDownload}>
          Download as text
        </button>
      </div>
      {copy === 'failed' && <div className="error">Couldn’t copy it. Use Download as text instead.</div>}
      <button className="receipt-done" onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}
