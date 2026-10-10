'use client';

// The two choices the download card (components/DownloadMyData.tsx) adds to
// a format: which account an OFX statement is of, and a passphrase that
// protects the file. Views only, with the rules they show taken from
// lib/download-options.ts, which the route (app/api/my-data) checks again.
//
// A LOST PASSPHRASE IS A LOST FILE. Nya never keeps it, so the card says so
// beside the fields, asks for it twice, and says how to open the file
// afterwards: on Nya's own page, which needs no sign-in and never uploads the
// file (app/open-download), or with the age app.

import { OPEN_DOWNLOAD_PATH, PASSPHRASE_MIN, ofxKindOf, passphraseLength } from '@/lib/download-options';

/** An account as the card offers it, from what the dashboard shows. */
export type DownloadAccount = { account_id: string; name: string; institution_name: string; type: string; mask: string | null };

/** The accounts an OFX statement can be made of (bank accounts and cards),
 *  by institution, then name. */
export function ofxAccounts(accounts: readonly DownloadAccount[]): DownloadAccount[] {
  return accounts
    .filter((a) => ofxKindOf(a.type) !== null)
    .sort((a, b) => a.institution_name.localeCompare(b.institution_name) || a.name.localeCompare(b.name) || (a.account_id < b.account_id ? -1 : 1));
}

/** "Chase · Checking ••1111". */
export const accountLabel = (a: DownloadAccount) => `${a.institution_name} · ${a.name}${a.mask ? ` ••${a.mask}` : ''}`;

/**
 * For a passphrase field: nothing offers to save it as this site's password,
 * or fills that password in, since it is the file's and not the app's.
 * "new-password" would invite a browser to make one up and save it, and
 * beside the shared password's field the card looks like a form that changes
 * the app's own. "off" for browsers; the rest are the marks password managers
 * look for (1Password, LastPass, Bitwarden, Dashlane).
 */
export const NOT_A_SIGN_IN = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

/** Why the passphrase can't be used yet, in words, or null when it can. */
export function passphraseHint(passphrase: string, confirm: string): string | null {
  if (passphraseLength(passphrase) < PASSPHRASE_MIN) return `Use at least ${PASSPHRASE_MIN} characters.`;
  if (passphrase.trim() === '') return 'Use words, not only spaces.';
  if (confirm !== passphrase) return confirm ? 'The two don’t match.' : 'Type it again below.';
  return null;
}

/** The account a statement is of: the one chosen, while it is still offered,
 *  else the first. */
export function chosenAccount(accounts: readonly DownloadAccount[], chosen: string | null): DownloadAccount | null {
  const offered = ofxAccounts(accounts);
  return offered.find((a) => a.account_id === chosen) ?? offered[0] ?? null;
}

export function OfxAccountPicker({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: readonly DownloadAccount[];
  value: string | null;
  onChange: (account_id: string) => void;
  disabled: boolean;
}) {
  const offered = ofxAccounts(accounts);
  const current = chosenAccount(accounts, value);
  return (
    <div className="download-ofx">
      {current ? (
        <label className="field">
          Account
          <select value={current.account_id} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            {offered.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="empty-note">There’s no bank account or card to make a statement of.</p>
      )}
      <p className="panel-note">
        Bank accounts and cards only. A loan has no statement in the OFX money apps read, and an investment account’s
        needs its holdings and trades, which Nya doesn’t write, so neither is offered: their history is in the JSON file.
      </p>
    </div>
  );
}

export function PassphraseFields({
  on,
  onToggle,
  passphrase,
  onPassphrase,
  confirm,
  onConfirm,
  disabled,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  passphrase: string;
  onPassphrase: (s: string) => void;
  confirm: string;
  onConfirm: (s: string) => void;
  disabled: boolean;
}) {
  const hint = on ? passphraseHint(passphrase, confirm) : null;
  return (
    <div className="download-protect">
      <label className="quick-add-check">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>Protect the file with a passphrase</span>
      </label>
      {on && (
        <>
          <label className="field">
            Passphrase
            <input type="password" {...NOT_A_SIGN_IN} value={passphrase} onChange={(e) => onPassphrase(e.target.value)} disabled={disabled} />
          </label>
          <label className="field">
            Type it again
            <input type="password" {...NOT_A_SIGN_IN} value={confirm} onChange={(e) => onConfirm(e.target.value)} disabled={disabled} />
          </label>
          {hint && <p className="panel-note">{hint}</p>}
          <p className="panel-note">
            At least {PASSPHRASE_MIN} characters. Four or more words you’ll remember that don’t belong together, with
            spaces between them, make one that is strong and easy to type.
          </p>
          <p className="stale-note">
            Nya never keeps your passphrase. If you lose it, the file can’t be opened, by you or by anyone running Nya.
          </p>
          <p className="panel-note">
            The file is saved with .age at the end. Open it on <a href={OPEN_DOWNLOAD_PATH}>Open a protected download</a>,
            which needs no sign-in and never uploads the file, or with the age app (<code>age -d</code>).
          </p>
        </>
      )}
    </div>
  );
}
