'use client';

// Vanguard's transactions download (a CSV) inside an investment account's ⋯,
// Import history from a file (components/HistoryImportSheet.tsx), on an
// account at Vanguard only. The file's rows take the place of what Vanguard
// gave Nya for the days it covers (lib/investment-imports.ts), worked out on
// every read, so each import is its own record and its Undo hands its days
// back exactly.
//
//   - The review (TransactionsReview), from the server (app/api/investment-
//     imports, action 'review'): each of the file's accounts, checked when it
//     can be taken, with its rows, how many it replaces and its deposits &
//     withdrawals against what counts now; off and saying why when it can't
//     (none of the person's Vanguard accounts ends in its digits, or two do,
//     a line Nya can't read, nothing in the file's days, as many imports as
//     it keeps, days that don't reach Nya's activity); each month where
//     deposits & withdrawals change; the rows just outside its days left out
//     as the same event as one of its own. One import takes every account
//     checked, with one Undo (Fue, 2026-11-12).
//   - Once imported: which days come from a download (TransactionsNow), and
//     every import of the account listed (TransactionImports), each saying
//     whether it counts, with Undo, confirmed in place with what comes back
//     and every account it is undone from.

import { useCallback, useEffect, useRef, useState } from 'react';
import CheckRows, { type CheckRow } from './CheckRows';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { formatDay, formatInstantDay, formatMoney, plainNumber, signedMoney } from '@/lib/format';
import { withMask } from '@/lib/account-names';
import { displayName } from '@/lib/categories';
import { monthText } from '@/lib/investment-months';
import { afterUndo, daysApart, MAX_IMPORTS_PER_ACCOUNT, type DecidedBy } from '@/lib/investment-imports';
import type { ImportsReview, ReviewedAccount } from '@/lib/investment-imports-review';
import type { ListedImport } from '@/lib/investment-imports-store';
import type { Unreadable } from '@/lib/import/vanguard-transactions';
import type { InvestmentActivityPayload } from './InvestmentActivity';

export const TXN_SOURCE = 'Vanguard’s transactions download';
const CURRENCY = 'USD';

const plural = (n: number, one: string, many = `${one}s`) => `${plainNumber(n)} ${n === 1 ? one : many}`;
const day = (d: string) => formatDay(d, { sentence: true });
const spanText = (from: string, to: string) => (from === to ? day(from) : `${day(from)} to ${day(to)}`);
const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const importedDay = (i: { imported_at: string }) => formatInstantDay(i.imported_at, { sentence: true }) ?? i.imported_at.slice(0, 10);
const listed = (words: readonly string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
const money = (n: number) => <Masked>{signedMoney(n, CURRENCY, { always: true })}</Masked>;

// ---- The account's imports --------------------------------------------------

/** The account's imports, as the route lists them: newest first, each with
 *  every account it took, the fingerprint they were listed under, and those
 *  accounts' names. */
export type TxnImports = {
  imports: ListedImport[];
  fingerprint: string;
  names: Record<string, { name: string; mask: string | null; item_id: string }>;
};

export function txnImportsFrom(data: unknown): TxnImports | null {
  const d = data as Partial<TxnImports> | null;
  return d && Array.isArray(d.imports) && typeof d.fingerprint === 'string' ? { imports: d.imports, fingerprint: d.fingerprint, names: d.names ?? {} } : null;
}

/** The account's imports of the download, loaded when the sheet opens on it;
 *  an answer for an account the sheet has left is dropped. */
export function useTransactionImports(account_id: string | null) {
  const [list, setList] = useState<TxnImports | null>(null);
  const [error, setError] = useState('');
  const current = useRef<string | null>(null);
  const reload = useCallback(async (id: string) => {
    setError('');
    try {
      const res = await fetch(`/api/investment-imports?account_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => null);
      if (current.current !== id) return;
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'The imported transactions couldn’t be loaded.');
        return;
      }
      setList(txnImportsFrom(data));
    } catch {
      if (current.current === id) setError('The imported transactions couldn’t be loaded: the server couldn’t be reached.');
    }
  }, []);
  useEffect(() => {
    current.current = account_id;
    setList(null);
    setError('');
    if (account_id) void reload(account_id);
  }, [account_id, reload]);
  const set = useCallback((data: unknown) => setList(txnImportsFrom(data)), []);
  return { list, set, error, reload };
}

// ---- The review -------------------------------------------------------------

/** Whether an account can be taken: it is one of the person's, nothing stops
 *  it, and the review says what it would do. */
export const takeable = (a: ReviewedAccount): boolean => !!a.account && !a.problem && !!a.effect;

/** Every account that can be taken, checked to begin with (keys: their
 *  digits, which the review keeps one account each). */
export const checkedFirst = (r: ImportsReview): string[] => r.accounts.filter(takeable).map((a) => a.mask);

/** What the Import sends for the accounts checked. */
export const takeOf = (r: ImportsReview, checked: readonly string[]) =>
  r.accounts.filter((a) => takeable(a) && checked.includes(a.mask)).map((a) => ({ account_id: a.account!.account_id, mask: a.mask }));

/** The rows the accounts checked would bring. */
export const rowsTaken = (r: ImportsReview, checked: readonly string[]) => r.accounts.filter((a) => takeable(a) && checked.includes(a.mask)).reduce((n, a) => n + a.rows, 0);

/** None of the file's accounts is one of the person's Vanguard accounts in
 *  Nya: said where the file is chosen, as nothing in it can be imported. */
export function noneOfYours(r: ImportsReview, name: string): string | null {
  if (r.accounts.length === 0 || !r.accounts.every((a) => a.problem?.why === 'not-in-nya')) return null;
  return `None of this file’s accounts (${listed(r.accounts.map((a) => `••${a.mask}`))}) is one of your Vanguard accounts in Nya, so nothing can be imported. Download it from the Vanguard login ${name} is in.`;
}

/** What makes a line unreadable, mid sentence. */
export function unreadableText(u: Unreadable, lines: number): string {
  if (u.reason === 'unknown-type') return `one of its ${plural(lines, 'transaction')} is “${u.type}”, a kind Nya doesn’t know yet`;
  if (u.reason === 'bad-row') return `the ${u.field} on line ${plainNumber(u.line)} can’t be read`;
  if (u.reason === 'no-value') return `line ${plainNumber(u.line)} moves shares (“${u.type}”) with no value in the file`;
  const what = { fees: 'a fee', 'accrued-interest': 'accrued interest', principal: 'a principal amount unlike its net amount' }[u.field];
  return `line ${plainNumber(u.line)} has ${what}, which Nya doesn’t read yet`;
}

/** Why an account can't be taken, under its name. */
function problemSub(a: ReviewedAccount): string {
  const p = a.problem!;
  if (p.why === 'unreadable') return `Can’t be imported: ${unreadableText(p.detail, a.lines)}.`;
  if (p.why === 'no-rows')
    return p.now > 0 ? `None in the file, and ${plural(p.now, 'transaction')} from Vanguard in these days, which it keeps.` : 'None in the file’s days.';
  if (p.why === 'full') return `It has ${MAX_IMPORTS_PER_ACCOUNT} imports of ${TXN_SOURCE}, the most Nya keeps. Undo an old one to import this file into it.`;
  if (p.why === 'unreached') {
    if (!p.activity) return 'Nya has no activity for it yet, so the file has nothing to join.';
    if (p.covers.to < p.activity.from)
      return `The file ends ${day(p.covers.to)}, and Nya’s activity for it starts ${day(p.activity.from)}. Nothing covers the days between, so it can’t be used. Download the last 18 months from Vanguard instead.`;
    return `The file starts ${day(p.covers.from)}, after Nya’s activity for it ends ${day(p.activity.through)}, so it can’t be used.`;
  }
  return '';
}

/** What taking an account would do, under its name. */
function takesSub(e: NonNullable<ReviewedAccount['effect']>) {
  return (
    <>
      {`${plural(e.rows, 'transaction')}, in place of ${e.now_rows === 0 ? 'none' : `the ${plainNumber(e.now_rows)} there now`}. Deposits & withdrawals `}
      {money(e.flows.file)}
      {e.flows.now === null ? ', none counted for these days now.' : <>, now {money(e.flows.now)}.</>}
    </>
  );
}

const nameIn = (a: ReviewedAccount) => withMask(a.account?.name ?? 'Account', a.mask);

export function TransactionsReview({
  fileName,
  review,
  sheet,
  checked,
  onChecked,
  disabled,
}: {
  fileName: string;
  review: ImportsReview;
  /** The account whose sheet it is. */
  sheet: { account_id: string; name: string };
  checked: string[];
  onChecked: (masks: string[]) => void;
  disabled: boolean;
}) {
  const accounts = review.accounts;
  const mine = accounts.filter((a) => a.account);
  const rows: CheckRow[] = mine.map((a) => ({
    key: a.mask,
    title: nameIn(a),
    sub: a.problem ? problemSub(a) : a.effect ? takesSub(a.effect) : undefined,
    disabled: !takeable(a),
  }));
  const lines = accounts.reduce((n, a) => n + a.lines, 0);
  const on = accounts.filter((a) => takeable(a) && checked.includes(a.mask));

  // What stops an account, said above the list when it isn't plain from its
  // row: a kind Nya doesn't know, days Nya has rows for that the file has
  // none in, two accounts that end alike.
  const cautions: string[] = [];
  for (const a of mine) {
    if (a.problem?.why === 'unreadable')
      cautions.push(
        `${capital(nameIn(a))}’s transactions can’t be imported: ${unreadableText(a.problem.detail, a.lines)}, and Nya never guesses what one means. ${mine.some((o) => o !== a && takeable(o)) ? 'The other accounts can be, and ' : ''}${nameIn(a)} keeps what Vanguard gave Nya.`
      );
    if (a.problem?.why === 'no-rows' && a.problem.now > 0)
      cautions.push(`${capital(nameIn(a))} is in the file with no transactions, though Vanguard gave Nya ${plural(a.problem.now, 'of its transactions', 'of its transactions')} in these days. The download may have left them out, so it isn’t imported: it keeps Vanguard’s.`);
  }
  const twoInNya = [...new Set(accounts.filter((a) => a.problem?.why === 'two-in-nya').map((a) => a.mask))];
  for (const mask of twoInNya) {
    const n = accounts.filter((a) => a.mask === mask).reduce((s, a) => s + a.lines, 0);
    cautions.push(`Two of your Vanguard accounts end in ${mask}, so Nya can’t tell which one is the file’s ••${mask}: its ${plural(n, 'transaction')} ${n === 1 ? 'is' : 'are'} left out.`);
  }
  for (const mask of [...new Set(accounts.filter((a) => a.problem?.why === 'repeated').map((a) => a.mask))])
    cautions.push(`The file has more than one account ending in ${mask}, so Nya can’t tell them apart: their transactions are left out.`);
  const strangers = accounts.filter((a) => a.problem?.why === 'not-in-nya');

  const changes = on.flatMap((a) => (a.effect?.months ?? []).map((m) => ({ a, m })));
  const twins = on.flatMap((a) => (a.effect?.twins ?? []).map((t) => ({ a, t })));
  const several = on.length > 1;

  return (
    <div className="stack">
      <p className="helper">{`${fileName} · ${TXN_SOURCE}`}</p>
      <div className="stack tight">
        <h3 className="section-label">{`${plural(lines, 'transaction')} in ${plural(accounts.length, 'account')}, ${spanText(review.covers.from, review.covers.to)}`}</h3>
        <p className="helper">For each account you import it into, the file’s transactions take the place of the ones Vanguard gave Nya for these days. Before and after them, nothing changes.</p>
      </div>
      {cautions.map((c) => (
        <Notice key={c} level="caution" role="status">
          {c}
        </Notice>
      ))}
      <CheckRows legend="Import into" rows={rows} checked={checked.filter((k) => rows.some((r) => r.key === k && !r.disabled))} onChange={onChecked} disabled={disabled} />
      {strangers.length > 0 && (
        <p className="helper">
          {strangers.length === 1
            ? `The file’s ${plural(strangers[0].lines, 'transaction')} for ••${strangers[0].mask} ${strangers[0].lines === 1 ? 'is' : 'are'} left out: it isn’t one of your Vanguard accounts in Nya.`
            : `The file’s transactions for ${listed(strangers.map((a) => `••${a.mask}`))} are left out: they aren’t among your Vanguard accounts in Nya.`}
        </p>
      )}
      {!review.sheet_in && <p className="helper">{`${capital(sheet.name)} isn’t in this file. Its other accounts can still be imported.`}</p>}
      {review.after_today > 0 && (
        <p className="helper">{`The file’s ${plural(review.after_today, 'transaction')} from today ${review.after_today === 1 ? 'is' : 'are'} left out: today may not be complete yet.`}</p>
      )}
      {changes.length > 0 && (
        <div className="stack tight">
          <h3 className="section-label">Where deposits & withdrawals change</h3>
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">
                  Now
                </th>
                <th scope="col" className="num">
                  From the file
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map(({ a, m }) => (
                <tr key={`${a.mask}:${m.month}`}>
                  <td>{several ? `${a.account!.name}, ${monthText(m.month)}` : monthText(m.month)}</td>
                  <td className="num">{m.now === null ? 'None counted' : money(m.now)}</td>
                  <td className="num">{money(m.file)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="helper">
            Vanguard’s file says what each one was: it values the shares a conversion moves, and a sweep inside an account is no money in or out. A conversion counts
            as money moving between your accounts, never as new savings, so your Plan’s savings stay as they are.
          </p>
        </div>
      )}
      {twins.slice(0, 3).map(({ a, t }) => {
        const kind = (displayName(t.subtype) || t.type).toLowerCase();
        return (
          <p key={`${a.mask}:${t.date}:${t.file_date}:${t.amount}`} className="helper">
            {`${several ? `${capital(nameIn(a))}: ` : ''}Vanguard gave Nya ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} of `}
            <Masked>{formatMoney(Math.abs(t.amount), CURRENCY)}</Masked>
            {` on ${day(t.date)} that the file lists on ${day(t.file_date)}, so it counts once, as the file’s.`}
          </p>
        );
      })}
      {twins.length > 3 && <p className="helper">{`And ${plural(twins.length - 3, 'more like it', 'more like them')}.`}</p>}
    </div>
  );
}

// ---- Once imported ----------------------------------------------------------

/** Which days come from a download now (the sheet's top). */
export function TransactionsNow({ name, activity }: { name: string; activity: InvestmentActivityPayload | null }) {
  const days = activity?.imported_days ?? [];
  if (days.length === 0) return null;
  const files = new Set(days.map((d) => d.import_id)).size;
  // Stretches that meet are one run; days between runs are Vanguard's.
  const runs: { from: string; to: string }[] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && daysApart(last.to, d.from) <= 1) last.to = d.to > last.to ? d.to : last.to;
    else runs.push({ from: d.from, to: d.to });
  }
  return (
    <div className="stack tight">
      <h3 className="section-label">{`${capital(listed(runs.map((r) => spanText(r.from, r.to))))}, from ${files === 1 ? TXN_SOURCE : 'Vanguard’s transactions downloads'}`}</h3>
      <p className="helper">{`For those days ${name}’s activity is the ${files === 1 ? 'file’s' : 'files’'}, in place of what Vanguard gave Nya.`}</p>
    </div>
  );
}

/** Whether an import counts now, by what the activity says each one
 *  decides: null until it has loaded. */
function standing(i: ListedImport, activity: InvestmentActivityPayload | null): { badge: string; sub: string; days: { from: string; to: string }[] } | null {
  if (!activity?.imported_days) return null;
  const days = activity.imported_days.filter((d) => d.import_id === i.import_id).map(({ from, to }) => ({ from, to }));
  const has = days.reduce((n, d) => n + daysApart(d.from, d.to) + 1, 0);
  const all = daysApart(i.covers.from, i.covers.to) + 1;
  if (has >= all) return { badge: 'Counts', sub: '', days };
  if (has > 0) return { badge: 'Counts in part', sub: ` · counts ${listed(days.map((d) => spanText(d.from, d.to)))}`, days };
  const why = activity.imports_unused?.includes(i.import_id) ? 'its days don’t reach Nya’s activity' : 'newer imports decide its days';
  return { badge: 'Doesn’t count', sub: ` · ${why}`, days };
}

const NUMBER_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** What undoing it would do, for its confirm. What comes back is worked out
 *  for the sheet's account (`name`), from its activity and imports; for the
 *  others it took, said by the rule alone, since their imports aren't here. */
export function undoText(i: ListedImport, list: TxnImports, activity: InvestmentActivityPayload | null, name: string): string {
  const n = i.accounts.length;
  const names = i.accounts.map((id) => (list.names[id] ? withMask(list.names[id].name, list.names[id].mask) : 'an account Nya no longer lists'));
  const went = n > 1 ? `It went into ${listed(names)}, and is undone from ${n === 2 ? 'both' : `all ${NUMBER_WORDS[n] ?? plainNumber(n)}`}` : '';
  const rule = 'its days will come from an import before it, or from what Vanguard gave Nya, again';
  const now = standing(i, activity);
  if (!now) return `Undo the import from ${importedDay(i)}? ${went ? `${went}: in each, ${rule}` : capital(rule)}. Nothing else changes, and you can import the file again later.`;
  let back: string;
  if (now.days.length === 0) back = 'nothing you see changes, as it doesn’t count now';
  else {
    const others = list.imports.filter((o) => o.import_id !== i.import_id);
    const parts: DecidedBy[] = afterUndo(now.days, others);
    back = parts
      .map((p, k) => {
        const by = p.by ? others.find((o) => o.import_id === p.by) : null;
        const from = by ? `the import from ${importedDay(by)}` : 'what Vanguard gave Nya';
        return `${spanText(p.from, p.to)} ${k === 0 ? 'will come ' : ''}from ${from}${k === 0 ? ' again' : ''}`;
      })
      .join(', and ');
  }
  const rest = n - 1;
  const theirs = went ? `. In ${name}, ${back}; in the other${rest > 1 ? ` ${NUMBER_WORDS[rest] ?? plainNumber(rest)}` : ''}, ${rule}` : '';
  return `Undo the import from ${importedDay(i)}? ${went ? `${went}${theirs}` : capital(back)}. Nothing else changes, and you can import the file again later.`;
}

export function TransactionImports({
  name,
  list,
  activity,
  busy,
  onUndo,
}: {
  /** The sheet's account, with its mask. */
  name: string;
  list: TxnImports;
  /** Its activity, or null while it is loading or out of date. */
  activity: InvestmentActivityPayload | null;
  busy: boolean;
  onUndo: (i: ListedImport) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  if (list.imports.length === 0) return null;
  return (
    <ul className="list-rows">
      {list.imports.map((i) => {
        const now = standing(i, activity);
        const others = i.accounts.length - 1;
        return (
          <li key={i.import_id}>
            <div className="list-row">
              <span className="list-row-text">
                <span className="list-row-title">{i.file_name ?? TXN_SOURCE}</span>
                <span className="list-row-sub">
                  {`Imported ${importedDay(i)} · ${plural(i.rows, 'transaction')}${others > 0 ? `, and into ${plural(others, 'other account')}` : ''} · ${capital(spanText(i.covers.from, i.covers.to))}${now?.sub ?? ''}`}{' '}
                  {now && <span className={`badge${now.badge === 'Doesn’t count' ? '' : ' accent'}`}>{now.badge}</span>}
                </span>
              </span>
              {asking !== i.import_id && (
                <button type="button" className="btn ghost" aria-label={`Undo the import from ${importedDay(i)}`} disabled={busy} onClick={() => setAsking(i.import_id)}>
                  Undo
                </button>
              )}
            </div>
            {asking === i.import_id && (
              <div className="import-confirm stack tight">
                <p className="helper" role="status">
                  {undoText(i, list, activity, name)}
                </p>
                <div className="btn-row">
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => setAsking(null)}>
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={async () => {
                      if (await onUndo(i)) setAsking(null);
                    }}
                  >
                    {busy ? 'Undoing…' : 'Undo import'}
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
