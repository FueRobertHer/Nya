'use client';

// API tokens (lib/api-tokens.ts, app/api/api-tokens), under Manage accounts:
// tokens for the programs a person chooses to let read their data, through
// the API (/api/v1) and the MCP server (/api/mcp) that an AI assistant can
// use. The developer page (/developers) says what each reads.
//
// WHAT IT CAN DO is chosen when a token is made, while this copy lets tokens
// write (`writes`, lib/api-writes-enabled.ts): read (the default), update
// balances, or read and make changes; never changed after. While it doesn't,
// the card reads as it did before tokens could write, and makes read tokens
// alone. The changes tokens made are listed under it (components/
// ApiChanges.tsx).
//
// MAKING ONE needs a fresh sign-in, as downloading everything does
// (lib/fresh-sign-in.ts): with Clerk, its useReverification asks the person to
// confirm it is them when the server says so, then sends the request again;
// with the shared password, the password is asked for here. The token is shown
// once, with a copy button, and with a configuration for an MCP client that
// already holds it; Nya keeps only a hash of it, so closing it loses it for
// good. Nothing here stores it: not the page's storage, not a log.
//
// REVOKING one asks first, and takes effect on its next request. A token whose
// record can't be read doesn't work; one with damaged bytes can be removed
// once the person confirms, and one saved by another version of Nya is only
// named (lib/repo.ts: never offered for removal).

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { Sheet } from './Sheet';
import ApiChanges from './ApiChanges';
import { CHANGES_KEEP_DAYS, LABEL_MAX, MAX_TOKENS, REQUESTS_PER_MINUTE, type Access } from '@/lib/api-limits';

export type TokenInfo = { id: string; label: string; hint: string; created_at: string; last_used_at: string | null; access?: Access };

export type TokenList =
  | { kind: 'loading' }
  | { kind: 'ready'; tokens: TokenInfo[]; unreadable: string[]; unrecognised: string[]; limit: number; writes?: boolean }
  | { kind: 'error'; message: string };

/** What a token can do, in words, as the list says it. */
export const ACCESS_WORDS: Record<Access, string> = { read: 'Reads', balances: 'Updates balances', write: 'Reads and makes changes' };

/** The choices when making a token, while this copy lets tokens write. */
export const ACCESS_CHOICES: readonly { value: Access; name: string; note: string }[] = [
  { value: 'read', name: 'Read your data', note: 'Your accounts, balances, transactions, budgets and the rest the developer page lists.' },
  {
    value: 'balances',
    name: 'Update balances',
    note: 'For a script that sends a manual account’s balance. It sees your accounts and their balances, and nothing else, and can change nothing but a manual account’s balance.',
  },
  {
    value: 'write',
    name: 'Read, and make changes',
    note: 'Add and change manual accounts and their transactions, categories and tags. It can never delete an account or change its past history, or change your bank’s transactions, sharing, tokens or settings.',
  },
];

/** Said under either choice beyond reading. */
export const CHANGES_NOTE = `Every change it makes is listed below under Changes made with your tokens, for ${CHANGES_KEEP_DAYS} days, and most can be undone there. An AI assistant with this token can make changes when you ask it, or when something it reads tricks it: use one that asks you before each change. A token’s access can’t be changed later, and a token never gains kinds of changes added to Nya after it was made: make a new token, and revoke the old one.`;

/** A token just made: the one time it is ever on screen. */
export type Made = { token: string; info: TokenInfo };

type Hint = { clerk_error: { type: string; reason: string } };
type Outcome = { ok: true; made: Made } | { ok: false; error: string } | Hint;

function isHint(v: unknown): v is Hint {
  const e = (v as Hint | null)?.clerk_error;
  return !!e && e.type === 'forbidden' && e.reason === 'reverification-error';
}

/** The day, in the viewer's own time. */
export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** What an MCP client is given: the server's address and the token as a
 *  bearer header. Many clients take this shape; where it goes differs. */
export function mcpConfig(origin: string, token: string): string {
  return JSON.stringify({ mcpServers: { nya: { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

/** Copies text, or selects it in `field` to copy by hand. True when copied. */
async function copy(text: string, field: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The clipboard refused: select it instead.
  }
  field?.select();
  return false;
}

async function requestToken(label: string, password: string | null, access: Access = 'read'): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch('/api/api-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A read token is asked for exactly as before tokens could write.
      body: JSON.stringify({ label, ...(password === null ? {} : { password }), ...(access === 'read' ? {} : { access }) }),
    });
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (isHint(data)) return data;
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'The token wasn’t made. Try again.' };
  }
  if (typeof data?.token !== 'string' || !data.info) return { ok: false, error: 'The token wasn’t made. Try again.' };
  return { ok: true, made: { token: data.token, info: data.info } };
}

/** The list, making and revoking, for both kinds of sign-in. */
function useTokens() {
  const [list, setList] = useState<TokenList>({ kind: 'loading' });
  const [label, setLabel] = useState('');
  const [access, setAccess] = useState<Access>('read');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/api-tokens', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.tokens)) {
        setList({ kind: 'error', message: typeof data?.error === 'string' ? data.error : 'Your API tokens couldn’t be loaded.' });
        return;
      }
      setList({ kind: 'ready', tokens: data.tokens, unreadable: data.unreadable ?? [], unrecognised: data.unrecognised ?? [], limit: data.limit ?? MAX_TOKENS, writes: data.writes === true });
    } catch {
      setList({ kind: 'error', message: 'Your API tokens couldn’t be loaded.' });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (request: () => Promise<Outcome>) => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await request();
      if (isHint(outcome)) setError('Nya couldn’t confirm it’s you. Sign out and in again, then try again.');
      else if (!outcome.ok) setError(outcome.error);
      else {
        setMade(outcome.made);
        setLabel('');
        setAccess('read');
        setPassword('');
        await load();
      }
    } catch (err) {
      if (!isReverificationCancelledError(err)) setError('The token wasn’t made. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string, unreadable: boolean): Promise<string | null> => {
    try {
      const res = await fetch('/api/api-tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unreadable ? { id, unreadable: true } : { id }),
      });
      // Gone already is what was asked for.
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        return typeof data?.error === 'string' ? data.error : 'It wasn’t revoked. Try again.';
      }
      await load();
      return null;
    } catch {
      return 'Nya could not be reached. Check your connection and try again.';
    }
  };

  return { list, label, setLabel, access, setAccess, password, setPassword, busy, error, made, setMade, create, revoke };
}

/** The tokens, and the changes they made below them. */
function WithChanges({ t, view }: { t: ReturnType<typeof useTokens>; view: ReactNode }) {
  return (
    <>
      {view}
      {t.list.kind === 'ready' && <ApiChanges tokens={t.list.tokens} writes={t.list.writes === true} />}
    </>
  );
}

function WithClerk() {
  const t = useTokens();
  const verified = useReverification((label: string, access: Access) => requestToken(label, null, access));
  return <WithChanges t={t} view={<ApiTokensView {...t} needsPassword={false} onCreate={() => t.create(() => verified(t.label, t.access))} />} />;
}

function WithPassword() {
  const t = useTokens();
  return <WithChanges t={t} view={<ApiTokensView {...t} needsPassword onCreate={() => t.create(() => requestToken(t.label, t.password, t.access))} />} />;
}

/** `clerk`: whether sign-in is Clerk's (lib/auth-mode.ts). Clerk's hook only
 *  works inside its provider, which exists only then. */
export default function ApiTokens({ clerk }: { clerk: boolean }) {
  return clerk ? <WithClerk /> : <WithPassword />;
}

/** The token being revoked, while the person is asked to confirm. */
export type Revoking = { id: string; label: string; unreadable: boolean } | null;

export function ApiTokensView({
  list,
  label,
  setLabel,
  access = 'read',
  setAccess = () => {},
  password,
  setPassword,
  needsPassword,
  busy,
  error,
  made,
  setMade,
  onCreate,
  revoke,
  origin,
}: {
  list: TokenList;
  label: string;
  setLabel: (s: string) => void;
  access?: Access;
  setAccess?: (a: Access) => void;
  password: string;
  setPassword: (s: string) => void;
  needsPassword: boolean;
  busy: boolean;
  error: string | null;
  made: Made | null;
  setMade: (m: Made | null) => void;
  onCreate: () => void;
  revoke: (id: string, unreadable: boolean) => Promise<string | null>;
  /** This site's address, for the MCP configuration; the page's own by default. */
  origin?: string;
}) {
  const [revoking, setRevoking] = useState<Revoking>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'token' | 'config' | null>(null);
  const site = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  const atLimit = list.kind === 'ready' && list.tokens.length + list.unreadable.length + list.unrecognised.length >= list.limit;
  const writes = list.kind === 'ready' && list.writes === true;
  const canCreate = list.kind === 'ready' && !atLimit && !busy && label.trim().length > 0 && (!needsPassword || password.length > 0);

  const copied2s = (which: 'token' | 'config') => {
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    const failed = await revoke(revoking.id, revoking.unreadable);
    setRevokeBusy(false);
    if (failed) setRevokeError(failed);
    else setRevoking(null);
  };

  return (
    <div className="card api-tokens-card">
      <div className="inst-header">
        <div className="inst-name">API tokens</div>
      </div>
      {writes ? (
        <p className="panel-note">
          A token lets a program you choose read your data: a script, a dashboard, or an AI assistant through Nya’s MCP
          server. It reads only what the <a href="/developers">developer page</a> lists, and changes nothing unless you
          choose, when you make it, that it may update balances or make changes. Anyone holding it can do all it can, so
          keep it secret, and revoke any you no longer use.{' '}
          {needsPassword
            ? 'Signing out everywhere, or changing the app password, doesn’t revoke tokens. Turning on sign-in accounts does: make new ones once you sign in.'
            : 'Signing out everywhere doesn’t revoke tokens.'}
        </p>
      ) : (
      <p className="panel-note">
        A token lets a program you choose read your data: a script, a dashboard, or an AI assistant through Nya’s MCP
        server. It can’t change anything, and reads only what the <a href="/developers">developer page</a> lists. Anyone
        holding it can read all of that, so keep it secret, and revoke any you no longer use.{' '}
        {needsPassword
          ? 'Signing out everywhere, or changing the app password, doesn’t revoke tokens. Turning on sign-in accounts does: make new ones once you sign in.'
          : 'Signing out everywhere doesn’t revoke tokens.'}
      </p>
      )}

      {list.kind === 'loading' && <p className="panel-note">Loading your tokens…</p>}
      {list.kind === 'error' && <div className="error">{list.message}</div>}
      {list.kind === 'ready' && (
        <>
          {list.tokens.length === 0 && list.unreadable.length === 0 && list.unrecognised.length === 0 && (
            <p className="empty-note">No tokens yet.</p>
          )}
          {list.tokens.length > 0 && (
            <ul className="api-token-list">
              {list.tokens.map((t) => (
                <li key={t.id} className="api-token">
                  <div className="api-token-text">
                    <div className="api-token-label">{t.label}</div>
                    <div className="as-of">
                      <code>{t.hint}…</code> · {writes ? `${ACCESS_WORDS[t.access ?? 'read']} · ` : ''}made {shortDay(t.created_at)} ·{' '}
                      {t.last_used_at ? `last used ${shortDay(t.last_used_at)}` : 'never used'}
                    </div>
                  </div>
                  <button className="secondary" onClick={() => setRevoking({ id: t.id, label: t.label, unreadable: false })}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.unreadable.map((id) => (
            <div key={id} className="stale-note api-token-problem">
              A token’s record couldn’t be read, so that token doesn’t work.{' '}
              <button className="link-btn danger-link" onClick={() => setRevoking({ id, label: 'the token that can’t be read', unreadable: true })}>
                Remove it
              </button>
            </div>
          ))}
          {list.unrecognised.length > 0 && (
            <p className="stale-note">
              {list.unrecognised.length === 1 ? 'A token was' : `${list.unrecognised.length} tokens were`} saved by another version of Nya, which
              this one can’t read, so {list.unrecognised.length === 1 ? 'it doesn’t' : 'they don’t'} work here. Nothing was changed.
            </p>
          )}
        </>
      )}

      {made ? (
        <div className="api-token-made" aria-live="polite">
          <p className="status-note">
            Made “{made.info.label}”{writes && made.info.access && made.info.access !== 'read' ? `, which ${made.info.access === 'write' ? 'reads and makes changes' : 'updates balances'}` : ''}. Copy it now: Nya
            keeps only a hash of it, so it can’t show it again.
          </p>
          <div className="invite-link">
            <input readOnly value={made.token} aria-label="API token" onFocus={(e) => e.target.select()} />
            <button
              className="secondary"
              onClick={async (e) => {
                if (await copy(made.token, e.currentTarget.previousElementSibling as HTMLInputElement | null)) copied2s('token');
              }}
            >
              {copied === 'token' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="panel-note">
            Send it as <code>Authorization: Bearer</code> and the token, to <code>{site}/api/v1/…</code>. For an MCP client
            that takes a server’s address and headers:
          </p>
          <textarea className="api-token-config" readOnly rows={9} value={mcpConfig(site, made.token)} aria-label="MCP client configuration" onFocus={(e) => e.target.select()} />
          <div className="button-pair">
            <button
              className="secondary"
              onClick={async (e) => {
                const field = e.currentTarget.parentElement?.previousElementSibling as HTMLTextAreaElement | null;
                if (await copy(mcpConfig(site, made.token), field)) copied2s('config');
              }}
            >
              {copied === 'config' ? 'Copied' : 'Copy configuration'}
            </button>
            <button onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      ) : (
        list.kind === 'ready' && (
          <div className="api-token-new">
            {atLimit ? (
              <p className="panel-note">You have the most tokens you can ({list.limit}). Revoke one you no longer use to make another.</p>
            ) : (
              <>
                <label className="field">
                  A name for it, such as the program that will use it
                  <input value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} placeholder="Claude, Raycast, my dashboard" disabled={busy} />
                </label>
                {writes && (
                  <fieldset className="lifecycle-choices api-access-choices" disabled={busy}>
                    <legend className="section-label">What it can do</legend>
                    {ACCESS_CHOICES.map((c) => (
                      <label key={c.value} className="lifecycle-choice api-access-choice">
                        <input
                          type="radio"
                          name="api-token-access"
                          value={c.value}
                          checked={access === c.value}
                          onChange={() => setAccess(c.value)}
                          aria-describedby={`api-access-${c.value}`}
                        />
                        <span>
                          <span className="lifecycle-choice-name">{c.name}</span>
                          <span className="lifecycle-choice-note" id={`api-access-${c.value}`}>
                            {c.note}
                          </span>
                        </span>
                      </label>
                    ))}
                    {access !== 'read' && <p className="panel-note api-access-warning">{CHANGES_NOTE}</p>}
                  </fieldset>
                )}
                {needsPassword ? (
                  <label className="field">
                    Your app password, to confirm it’s you
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && canCreate) onCreate();
                      }}
                      disabled={busy}
                    />
                  </label>
                ) : (
                  <p className="panel-note">If you haven’t signed in within the last few minutes, you’ll be asked to confirm it’s you first.</p>
                )}
                <button onClick={onCreate} disabled={!canCreate}>
                  {busy ? 'Making…' : 'Make a token'}
                </button>
              </>
            )}
            {error && <div className="error">{error}</div>}
          </div>
        )
      )}

      <p className="panel-note">
        Up to {MAX_TOKENS} tokens, and {REQUESTS_PER_MINUTE} requests a minute each.
      </p>

      <RevokeSheet
        revoking={revoking}
        busy={revokeBusy}
        error={revokeError}
        onCancel={() => !revokeBusy && setRevoking(null)}
        onConfirm={confirmRevoke}
      />
    </div>
  );
}

/** Asks before revoking: what it does, and that it can't be undone. */
export function RevokeSheet({
  revoking,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  revoking: Revoking;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={!!revoking} title={revoking?.unreadable ? 'Remove the token?' : `Revoke ${revoking?.label ?? 'token'}?`} onClose={onCancel}>
      {revoking && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {revoking.unreadable
              ? 'Its record can’t be read, so it doesn’t work now. Removing it deletes what is left of it.'
              : 'Anything using it loses access on its next request. This can’t be undone: make a new token if you need one again.'}
          </p>
          {error && <div className="error">{error}</div>}
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="danger" onClick={onConfirm} disabled={busy}>
              {busy ? 'Revoking…' : revoking.unreadable ? 'Remove' : 'Revoke'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
