'use client';

// A transaction's sheet, opened by its row on Activity's Transactions
// (docs/design/information-architecture.md#activity): what it is, then its
// category, tags and note, split or group, sharing, whether it counts, the
// rules it matches and its receipts, and the bank's details last. Rename
// vendor and, for a row entered by hand, Edit or delete are in its ⋯.
// Replaces the editor that opened inside the row.
//
// A split transaction's parts and a group's transactions are rows of their
// own, and open this sheet on themselves: a part's category and whether it
// counts, a group's transaction taken out of it.
//
// Changes shown at once (a category, an exclusion, tags and a note, a review)
// leave it open on the row as it now is; after a category, the offer to make
// a rule of it shows under the field. Looks right, Exclude or Include, a note
// and tags say what they saved in a done line once the server has it
// (docs/design/guidelines.md#after-save), which a refusal never does. Changes
// the list shows only once it is read again (a part's, a group's) close it,
// as the editor closed: a part's or a group transaction's waits for its write
// first, and says in the sheet why one wasn't made. A rename waits for its
// write too: it closes once saved, the rows behind it renamed, or says beside
// Rename why it wasn't.
// Each action that has a sheet of its own closes this one first, so no sheet
// opens on top of another.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Menu, type MenuItem } from './Menu';
import { Masked } from './HideAmounts';
import { ALERT, LevelWord } from './ConnectionStatus';
import { Notice } from './TotalCaveats';
import CategoryPicker from './CategoryPicker';
import TxnTagsNote, { type TagChange } from './TxnTagsNote';
import ReviewNote from './ReviewNote';
import AttachmentSection from './AttachmentSection';
import { sharedActions, SharedRowLine, type SharedRowHooks } from './SharedRows';
import { bankKept, entryNotice, heldInGroupAs, sendChange, splitActions, splitKeptUnder } from './SplitRows';
import ActionRows, { type SheetAction } from './ActionRows';
import type { ReviewControls } from './review-state';
import type { CategoryChoice, ExclusionSaved } from './transaction-edits';
import type { Txn } from './MonthBreakdown';
import { exclusionOffer, isLowConfidence, nameForRules, pairedWords } from './txn-words';
import { formatDay, formatMoney, signedMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { displayName, type Taxonomy } from '@/lib/categories';
import { MIN_MEMBERS, PART_PREFIX } from '@/lib/split-rows';
import { isConnectorKind } from '@/lib/connectors/types';
import { IMPORTED_TXN_PREFIX, importedChangedNote } from '@/lib/history-import/view';
import { sourceLabel } from '@/lib/manual-txn-input';
import { shownName } from '@/lib/merchant-name';
import type { Tag } from '@/lib/tags';

/** What an exclusion saved says; the row's own line says how it stands. */
const EXCLUDED_SAID = 'Excluded: it stays in this list, out of totals, budgets, insights, bills and the Plan.';
const INCLUDED_SAID = 'Included again: it counts in totals, budgets, insights, bills and the Plan.';
/** What its Undo says, by how it stood before. */
const UNDONE_COUNTS = 'Undone: it counts in totals, budgets, insights, bills and the Plan, as before.';
const UNDONE_EXCLUDED = 'Undone: it’s excluded again, as before.';
const UNDONE_BY_RULE = 'Undone: a rule hides it again, as before.';

/** What a change of tags saved says, by the tags' names. */
export function tagsSaid(change: TagChange, tags: readonly Tag[]): string {
  const names = (ids: readonly string[] | undefined) => (ids ?? []).flatMap((id) => tags.find((g) => g.id === id)?.name ?? []);
  const added = [...names(change.add), ...(change.newTag ? [change.newTag] : [])];
  const removed = names(change.remove);
  if (added.length > 0) return `${added.length === 1 ? 'Tag' : 'Tags'} added: ${added.join(', ')}.`;
  if (removed.length > 0) return `${removed.length === 1 ? 'Tag' : 'Tags'} removed: ${removed.join(', ')}.`;
  return 'Tags saved.';
}

/** What the done line says, about which row, while the row holds it; for
 *  Exclude and Include, what its Undo sends and says once done. */
type Done = {
  id: string;
  text: string;
  holds: (x: Txn) => boolean;
  undo?: { saved: ExclusionSaved; text: string; holds: (x: Txn) => boolean };
};
/** Where focus goes to the done line from: nowhere (false); from wherever it
 *  has gone, off the page or onto nothing (true); or from that and from the
 *  control that was pressed. */
type FocusFrom = boolean | Element | null;

/** A toggle's answer carrying what its Undo needs. */
function isExclusionSaved(v: unknown): v is ExclusionSaved {
  return typeof v === 'object' && v !== null && 'undo' in v && 'shown' in v;
}

/** What a row opens: a transaction, by its id in the list; a part of a split
 *  one, by its own id and its transaction's; a group's transaction, by its
 *  id and the group's row's. */
export type SheetTarget = { kind: 'txn'; id: string } | { kind: 'part'; parent: string; id: string } | { kind: 'member'; group: string; id: string };

/** The rows a target names, found in the list as it is now. */
export type SheetRows =
  | { kind: 'txn'; t: Txn }
  | { kind: 'part'; parent: Txn; part: Txn }
  | { kind: 'member'; group: Txn; member: Txn };

/** Finds what a target names among the rows put back whole (lib/split-rows.ts
 *  bankRows), by id: null once it is gone (posted under a new id, deleted,
 *  split or grouped away). */
export function findTarget(target: SheetTarget | null, byId: ReadonlyMap<string, Txn>): SheetRows | null {
  if (!target) return null;
  if (target.kind === 'txn') {
    const t = byId.get(target.id);
    return t ? { kind: 'txn', t } : null;
  }
  if (target.kind === 'part') {
    const parent = byId.get(target.parent);
    const part = parent?.split_parts?.find((p) => p.transaction_id === target.id);
    return parent && part ? { kind: 'part', parent, part } : null;
  }
  const group = byId.get(target.group);
  const member = group?.group_members?.find((m) => m.transaction_id === target.id);
  return group && member ? { kind: 'member', group, member } : null;
}

/** Whether a row was entered by hand or imported into a manual account:
 *  not one SimpleFIN brought nor one imported into a linked account, which
 *  are the bank's or the file's record, whose category alone is the
 *  person's. Its sheet's ⋯ offers Edit or delete. */
export function editableByHand(t: Pick<Txn, 'source' | 'transaction_id' | 'group_members'>): boolean {
  return !!t.source && !isConnectorKind(t.source) && !t.transaction_id.startsWith(IMPORTED_TXN_PREFIX) && !t.group_members;
}

/**
 * What a row says under its name beside its category, and its sheet under its
 * amount: the notes about it that bear on what it counts as (an exclusion that
 * couldn't be read, a pair worked out, its split or group, how it is shared,
 * a file's amount the bank changed). In their words, on the row too: never
 * only in a sheet. `whole` is the transaction with every part of its split.
 */
export function TxnNotes({ t, whole, shared, as = 'span' }: { t: Txn; whole: Txn; shared?: SharedRowHooks; as?: 'span' | 'p' }) {
  const Note = as;
  const notice = entryNotice(whole);
  const paired = pairedWords(t);
  return (
    <>
      {t.excluded === null && <Note className="txn-row-note">Couldn&apos;t read whether you excluded this</Note>}
      {/* A pair Nya worked out between two SimpleFIN accounts
          (lib/manual-txns.ts): said, so a wrong one is seen and given a category. */}
      {paired && <Note className="txn-row-note">{paired}</Note>}
      {notice && <Note className="txn-row-note">{notice}</Note>}
      {shared && <SharedRowLine t={t} hooks={shared} as={as} />}
      {/* A bank row standing for a row imported from its file, which the bank changed since (#52). */}
      {t.imported_amount !== undefined && (
        <Note className="txn-row-note">
          <Masked>{importedChangedNote(t, (n) => formatMoney(n, currencyOf(t)))}</Masked>
        </Note>
      )}
    </>
  );
}

// A short "HH:MM" from Plaid's ISO datetime, in the viewer's locale. Null when
// the row carries only a posting date.
function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// What a row files under, for the status line: its category's id and its
// category's words. Saved without the taxonomy, a row keeps only the words.
type Filed = { id: string | null; words: string | null };
const filedUnder = (t: Pick<Txn, 'category_id' | 'category'>): Filed => ({ id: t.category_id ?? null, words: t.category ?? null });
// Still filed under what was kept: the same id, or no id now and the same words.
const stillFiled = (kept: Filed, t: Pick<Txn, 'category_id' | 'category'>) => {
  const now = filedUnder(t);
  return now.id !== null ? now.id === kept.id : now.words !== null && now.words === kept.words;
};

/** "Today", "Yesterday", "Thu, Oct 22", "Thu, Oct 22, 2025" (lib/format.ts formatDay). */
function longDay(iso: string): string {
  return formatDay(iso, { weekday: 'short' });
}

/** Plaid's payment_channel in words: "online", "in store", "other". */
const CHANNEL_WORDS: Readonly<Record<string, string>> = { online: 'Online', 'in store': 'In store', other: 'Other' };

// "What is this charge?": the Plaid fields that answer it (the real merchant
// behind a processor, channel, place, time, website, reference and check
// numbers, and, for joint accounts, the owner), skipping any the row doesn't
// carry, under a heading; nothing when it carries none.
function TxnDetail({ t, noteEditor = false }: { t: Txn; noteEditor?: boolean }) {
  const rows: { label: string; value: ReactNode }[] = [];
  const time = fmtTime(t.datetime);

  // Plaid's finer category, which the row leaves out to keep to two lines.
  // Only on a row from Plaid: a pair Nya worked out between SimpleFIN
  // accounts carries one Nya set (lib/manual-txns.ts), not the bank's.
  if (t.subcategory && !t.paired && !t.source) rows.push({ label: 'Bank’s category', value: displayName(t.subcategory) });
  if (t.counterparty) rows.push({ label: 'Merchant', value: t.counterparty });
  if (t.payment_processor) rows.push({ label: 'Processed by', value: t.payment_processor });
  if (t.payment_channel) rows.push({ label: 'Channel', value: CHANNEL_WORDS[t.payment_channel] ?? displayName(t.payment_channel) });
  if (t.city) rows.push({ label: 'Where', value: t.region ? `${t.city}, ${t.region}` : t.city });
  if (time) rows.push({ label: 'Time', value: time });
  if (t.website)
    rows.push({
      label: 'Website',
      value: (
        <a href={`https://${t.website.replace(/^https?:\/\//, '')}`} target="_blank" rel="noopener noreferrer">
          {t.website.replace(/^https?:\/\//, '')}
        </a>
      ),
    });
  if (t.payment_reference) rows.push({ label: 'Reference', value: t.payment_reference });
  if (t.check_number) rows.push({ label: 'Check #', value: t.check_number });
  if (t.account_owner) rows.push({ label: 'Owner', value: t.account_owner });
  if (t.note && !noteEditor) rows.push({ label: 'Note', value: t.note });

  if (rows.length === 0) return null;

  return (
    <section className="stack tight" aria-labelledby={`bank-${t.transaction_id}`}>
      <h3 className="txn-sheet-heading" id={`bank-${t.transaction_id}`}>
        Bank details
      </h3>
      <dl className="txn-detail">
        {rows.map((r) => (
          <div className="txn-detail-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export type TransactionSheetProps = {
  open: boolean;
  /** What is open, as the list has it now; null draws nothing. */
  rows: SheetRows | null;
  onClose: () => void;
  /** The tab's currency, for a row with none of its own. */
  currency: string | null;
  /** What went wrong with the last change, said at the top while it is open. */
  errors: string[];
  taxonomy: Taxonomy | null;
  /** The categories to choose from without your own (categoryOptions). */
  pickable: string[];
  tags: Tag[];
  /** Every row loaded, for a receipt's "move to another transaction". */
  list: Txn[] | null;
  review?: ReviewControls;
  shared?: SharedRowHooks;
  ruleSentenceOf?: (id: string) => string | null;
  /** May return a promise that resolves true once the change is saved: the
   *  status line says so only then (components/transaction-edits.ts). */
  onRecategorize: (transaction_id: string, choice: CategoryChoice) => unknown;
  /** As onRecategorize, a promise: of null once saved, or of what went
   *  wrong, which the sheet says beside Rename, staying open. */
  onRename: (vendor_key: string, name: string) => unknown;
  onEditTransaction?: (t: Txn) => void;
  /** As onRecategorize: a promise, once saved, of what its Undo needs
   *  (components/transaction-edits.ts ExclusionSaved), or of true. */
  onToggleExcluded?: (t: Txn, excluded: boolean) => unknown;
  /** Undoes an exclusion or an include exactly: a promise of null once
   *  undone, or of what went wrong, said beside Undo. */
  onUndoExcluded?: (saved: ExclusionSaved) => Promise<string | null>;
  /** As onRecategorize: a promise of true once saved. */
  onChangeTags?: (t: Txn, change: TagChange) => unknown;
  /** As onRecategorize: a promise of true once saved (empty clears it). */
  onSaveNote?: (t: Txn, note: string) => unknown;
  onCreateRule?: (t: Txn, category_id?: string) => void;
  /** Splits and groups (#39): the list read again after one changes;
   *  without it, nothing is offered to split or group. */
  onSplitsChanged?: () => void;
  onSplit: (t: Txn) => void;
  onGroup: (start: Txn | null, group: Txn | null) => void;
  /** What went wrong with a split or group change, or null once one is made. */
  onSplitError: (message: string | null) => void;
  onAttachmentsChanged?: () => void;
};

export default function TransactionSheet(props: TransactionSheetProps) {
  const { open, rows, onClose, errors } = props;
  if (!rows) return null;
  const said = errors.length > 0 && (
    <>
      {errors.map((e) => (
        <div className="notice critical" key={e}>
          {ALERT}
          <p>
            <LevelWord level="critical" />
            {e}
          </p>
        </div>
      ))}
    </>
  );
  if (rows.kind === 'part') return <PartSheet {...props} parent={rows.parent} part={rows.part} said={said} />;
  if (rows.kind === 'member') return <MemberSheet {...props} group={rows.group} member={rows.member} said={said} />;
  // The rules' sentences hold amounts: passed by name, so the hide-amounts
  // scan (test/amount-sources.ts) traces them to the dashboard, which a
  // spread hides from it.
  return <TxnSheet {...props} t={rows.t} said={said} open={open} onClose={onClose} ruleSentenceOf={props.ruleSentenceOf} />;
}

type Inner = TransactionSheetProps & { said: ReactNode };

function TxnSheet({
  open,
  t,
  said,
  onClose,
  currency,
  taxonomy,
  pickable,
  tags,
  list,
  review,
  shared,
  ruleSentenceOf,
  onRecategorize,
  onRename,
  onEditTransaction,
  onToggleExcluded,
  onUndoExcluded,
  onChangeTags,
  onSaveNote,
  onCreateRule,
  onSplitsChanged,
  onSplit,
  onGroup,
  onSplitError,
  onAttachmentsChanged,
}: Inner & { t: Txn }) {
  // The category just chosen, while the offer to make a rule of it stands.
  const [offer, setOffer] = useState<string | null>(null);
  // What the done line says: the last change saved (Looks right, Exclude or
  // Include, a note, tags), on which row, while the row still holds it. A kept
  // is said only while the row still files under what it kept (its
  // category's id, not its name, which can change on saving). Every change
  // starts by taking the line away, and an answer says something only if no
  // change has started since, so a choice made while a save is out, or after,
  // never reads as the earlier one saved. Exclude and Include carry an Undo
  // (docs/design/guidelines.md#after-save): what it sends, and what the line
  // says once it is done, while the row holds that. Tags and a note have
  // none: a chip's x, or the note field, takes them back where they were made.
  const [done, setDone] = useState<Done | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoRefused, setUndoRefused] = useState<string | null>(null);
  const undoErrorId = useId();
  const changes = useRef(0);
  const begin = () => {
    setDone(null);
    setUndoRefused(null);
    return ++changes.current;
  };
  /** Said once the server has it (a refusal is said above, and puts the row back). */
  const sayOnce = (n: number, saved: boolean, id: string, text: string, holds: (x: Txn) => boolean, focus: FocusFrom = false, undo?: Done['undo']) => {
    if (saved && n === changes.current) {
      focusDone.current = focus;
      setDone({ id, text, holds, undo });
    }
  };
  // Focus goes to the line once it says something, unless it has moved on to
  // something else meanwhile. A note or tags saved: what was pressed has gone
  // (the editor starts again on the saved note, a chip goes) or can't be
  // pressed (Add, its field emptied). Exclude or Include saved: from its row,
  // which stays, to the line with its Undo under it. Undone: Undo has gone.
  // Looks right keeps its own.
  const doneRef = useRef<HTMLDivElement>(null);
  const focusDone = useRef<FocusFrom>(false);
  useEffect(() => {
    const from = focusDone.current;
    if (!done || from === false) return;
    focusDone.current = false;
    const at = document.activeElement;
    const gone = !at || at === document.body || !at.isConnected || at.getAttribute('disabled') !== null;
    if (gone || at === from || at === waitRef.current) {
      // Said before its row went: the line said in its place doesn't take it.
      focusWait.current = false;
      doneRef.current?.focus();
    }
  }, [done]);
  // Include on a pending row takes its row away (exclusionOffer: it can't be
  // excluded again until it posts): focus goes to the line said in its place
  // while it saves, then to the done line.
  const waitRef = useRef<HTMLParagraphElement>(null);
  const focusWait = useRef(false);
  // Refused, Undo is pressable again: focus back on it if it went while it
  // waited (a disabled control can lose it).
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const at = document.activeElement;
    if (undoRefused && (!at || at === document.body || at === undoRef.current)) undoRef.current?.focus();
  }, [undoRefused]);
  /** Exclude's or Include's Undo: the line says so once it is done, focus on
   *  it; refused, why is said under Undo, which stays. */
  const undoExclusion = async () => {
    const was = done;
    if (!was?.undo || undoing || !onUndoExcluded) return;
    const n = ++changes.current;
    setUndoing(true);
    setUndoRefused(null);
    const refused = await onUndoExcluded(was.undo.saved);
    setUndoing(false);
    if (n !== changes.current) return;
    if (refused) setUndoRefused(refused);
    else {
      focusDone.current = true;
      setDone({ id: was.id, text: was.undo.text, holds: was.undo.holds });
    }
  };
  // Rename vendor, a second level of the sheet, what is typed there, and
  // its write: out, or what went wrong with it.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(t.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameErrorId = useId();
  const categoryRef = useRef<HTMLSelectElement>(null);
  const act = (go: () => void) => () => {
    onClose();
    go();
  };
  const c = currencyOf(t) ?? currency;
  const exclusion = exclusionOffer(t);
  useEffect(() => {
    if (!focusWait.current || exclusion === 'toggle') return;
    focusWait.current = false;
    waitRef.current?.focus();
  }, [exclusion]);
  // "Check category" answered: the category it has, chosen as the person's
  // through the same path as picking one (app/api/recategorize), which takes
  // Plaid's doubt off it. Only where the category field below is the row's
  // own (not a split's parts or a group's), and once it has posted: a choice
  // is kept by the row's id, and a pending row gets a new one when it posts.
  const confirm: CategoryChoice | null =
    !isLowConfidence(t) || t.pending || t.split_parts || t.group_outside || t.group_members
      ? null
      : taxonomy && t.category_id
        ? { category_id: t.category_id }
        : !taxonomy && t.category
          ? { category: t.category }
          : null;
  const countable = !!onToggleExcluded && !t.group_members && !t.group_outside;
  // The done line, when it is shown: about this row, while the row holds what
  // it says, or while its Undo is out or was refused.
  const shown = done && done.id === t.transaction_id && (undoing || undoRefused !== null || done.holds(t)) ? done : null;

  if (renaming && t.vendor_key) {
    const vendor = t.vendor_key;
    const rename = async () => {
      setRenameBusy(true);
      setRenameError(null);
      let failed: unknown;
      try {
        failed = await Promise.resolve(onRename(vendor, draft.trim()));
      } finally {
        setRenameBusy(false);
      }
      if (typeof failed === 'string') setRenameError(failed);
      else onClose();
    };
    return (
      <Sheet
        open={open}
        title="Rename vendor"
        onClose={() => !renameBusy && onClose()}
        // Kept while it waits, so the level (and focus) stays put: it just
        // doesn't go back until the answer is in.
        onBack={() => !renameBusy && setRenaming(false)}
        footer={
          <>
            {renameError && (
              <div className="sheet-footer-note" id={renameErrorId}>
                <Notice level="critical" role="alert">
                  {renameError}
                </Notice>
              </div>
            )}
            <button
              type="button"
              className="btn"
              disabled={renameBusy || draft.trim() === t.name}
              aria-describedby={renameError ? renameErrorId : undefined}
              onClick={() => void rename()}
            >
              {renameBusy ? 'Renaming…' : 'Rename'}
            </button>
          </>
        }
      >
        <div className="stack">
          <label className="field">
            Name
            <input className="text-input" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} disabled={renameBusy} />
          </label>
          <p className="helper">Applies to this vendor&apos;s transactions; older ones may update later.</p>
        </div>
      </Sheet>
    );
  }

  const more: MenuItem[] = [
    ...(t.vendor_key
      ? [
          {
            label: 'Rename vendor',
            onSelect: () => {
              setDraft(t.name);
              setRenameError(null);
              setRenaming(true);
            },
          },
        ]
      : []),
    ...(onEditTransaction && editableByHand(t) ? [{ label: 'Edit or delete', onSelect: act(() => onEditTransaction(t)) }] : []),
  ];

  // Its category: filed as its parts are, or as its group is, when split or
  // counted in a group dated before what is shown (#39). A group's row
  // files the group's net; the list shows that once it is read again.
  const category =
    t.split_parts || t.group_outside ? null : taxonomy ? (
      <label className="field">
        Category
        <CategoryPicker
          ref={categoryRef}
          taxonomy={taxonomy}
          value={t.category_id ?? taxonomy.uncategorized}
          onChange={(id) => {
            if (!id || id === t.category_id) return;
            begin();
            if (t.group_members) {
              onClose();
              void sendChange('/api/transaction-groups', 'PATCH', { id: t.group_id, category_id: id }).then((failed) => {
                onSplitError(failed);
                onSplitsChanged?.();
              });
              return;
            }
            onRecategorize(t.transaction_id, { category_id: id });
            setOffer(id);
          }}
        />
      </label>
    ) : t.group_members ? null : (
      <label className="field">
        Category
        <select
          ref={categoryRef}
          className="text-input"
          value={t.category ?? 'other'}
          onChange={(e) => {
            begin();
            onRecategorize(t.transaction_id, { category: e.target.value });
          }}
        >
          {pickable.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
    );

  // Its actions, one list (components/ActionRows.tsx), and "Create a rule
  // from this" in a list of its own after the rules that match it. Each that
  // opens another sheet closes this one first; Exclude acts in place: its
  // row stays (its key holds while its title flips), and once it is saved
  // the done line says what it did, focus on it, with an Undo under it.
  const split = onSplitsChanged
    ? splitActions(t, {
        onSplit: act(() => onSplit(t)),
        onGroup: act(() => (t.group_members ? onGroup(null, t) : onGroup(t, null))),
        onUngroup: (id) => {
          onClose();
          void sendChange('/api/transaction-groups', 'DELETE', { id }).then((failed) => {
            onSplitError(failed);
            onSplitsChanged();
          });
        },
      })
    : null;
  const actions: SheetAction[] = [
    ...(split?.rows ?? []),
    ...(shared ? sharedActions(t, shared, onClose) : []),
    ...(countable && exclusion === 'toggle'
      ? [
          {
            key: 'exclude',
            title: t.excluded === true ? 'Include in budgets and reports' : 'Exclude from budgets and reports',
            sub:
              t.excluded === true
                ? 'Puts it back in totals, budgets, insights, bills and the Plan.'
                : 'For a one-off: it stays in this list, out of totals, budgets, insights, bills and the Plan.',
            onSelect: () => {
              const excluded = t.excluded !== true;
              const id = t.transaction_id;
              // How it stood, for what its Undo says once done.
              const wasExcluded = t.excluded === true;
              const undone = !wasExcluded ? UNDONE_COUNTS : t.excluded_by_rule ? UNDONE_BY_RULE : UNDONE_EXCLUDED;
              const from = document.activeElement;
              focusWait.current = exclusionOffer({ ...t, excluded: excluded ? true : undefined, excluded_by_rule: undefined }) !== 'toggle';
              const n = begin();
              void Promise.resolve(onToggleExcluded!(t, excluded)).then((saved) => {
                const undo = isExclusionSaved(saved) && onUndoExcluded ? { saved, text: undone, holds: (x: Txn) => (x.excluded === true) === wasExcluded } : undefined;
                sayOnce(n, saved === true || isExclusionSaved(saved), id, excluded ? EXCLUDED_SAID : INCLUDED_SAID, (x) => (x.excluded === true) === excluded, from, undo);
              });
            },
          },
        ]
      : []),
  ];
  // A rule from it, after the rules that already match it.
  const ruleRow: SheetAction[] = onCreateRule && !t.group_members ? [{ key: 'rule', title: 'Create a rule from this', opens: true, onSelect: act(() => onCreateRule(t)) }] : [];

  return (
    <Sheet open={open} title={shownName(t)} onClose={onClose} footer={more.length > 0 ? <Menu label={`More for ${shownName(t)}`} items={more} /> : undefined}>
      <div className="stack">
        {said}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${t.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-t.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {longDay(t.date)} · {t.institution_name} · {t.account_name}
            {t.source ? ` · ${sourceLabel(t.source)}` : ''}
          </p>
          {/* Its row's chips, the exclusion in full. */}
          {(t.pending || isLowConfidence(t)) && (
            <p>
              {t.pending && <span className="badge">Pending</span>}{' '}
              {isLowConfidence(t) && <span className="badge warn">Check category</span>}
              {confirm && (
                <>
                  {' '}
                  <button
                    className="btn ghost"
                    onClick={() => {
                      const id = t.transaction_id;
                      const kept = filedUnder(t);
                      const n = begin();
                      void Promise.resolve(onRecategorize(id, confirm)).then((saved) =>
                        sayOnce(n, saved === true, id, `Category kept: ${t.category_name ?? t.category ?? 'uncategorized'}.`, (x) => stillFiled(kept, x))
                      );
                      // The button goes with the mark: focus to the field it was about.
                      categoryRef.current?.focus();
                    }}
                  >
                    Looks right
                  </button>
                </>
              )}
            </p>
          )}
          {/* What the last change saved, said where focus is: a live region
              kept on the page, out of the flow while it says nothing. Shown
              while the row holds it, and while its Undo is out or refused. */}
          <div className="txn-sheet-said" role="status">
            {shown && (
              <Notice level="done" ref={doneRef} tabIndex={-1}>
                {shown.text}
              </Notice>
            )}
          </div>
          {/* Its Undo, outside the live region; in a row of its own, so the
              hero's column doesn't stretch it. */}
          {shown?.undo && (
            <div>
              <button type="button" className="btn ghost" ref={undoRef} onClick={() => void undoExclusion()} disabled={undoing} aria-describedby={undoRefused ? undoErrorId : undefined}>
                {undoing ? 'Undoing…' : 'Undo'}
              </button>
            </div>
          )}
          {shown && undoRefused && (
            <div id={undoErrorId}>
              <Notice level="critical" role="alert">
                {undoRefused}
              </Notice>
            </div>
          )}
          {t.excluded === true && <p className="helper">{t.excluded_by_rule ? 'Hidden by a rule: out of budgets and reports' : 'Excluded from budgets and reports'}</p>}
          <TxnNotes t={t} whole={t} shared={shared} as="p" />
        </div>

        {/* Its review and its merchant's default (components/ReviewNote.tsx). */}
        {review && <ReviewNote t={t} taxonomy={taxonomy} review={review} onChanged={() => onSplitsChanged?.()} />}

        {category}
        {/* The offer to do the same for every transaction with its name (#36). */}
        {offer && onCreateRule && (
          <div className="rule-offer stack tight">
            <p className="helper">
              Do the same for every transaction named “{nameForRules(t)}”
              {t.name_before_rules !== undefined && ` (shown as “${t.name}”)`}, past and future? A rule does it, and you can change or turn it off later.
            </p>
            <div className="btn-row">
              <button className="btn secondary" onClick={act(() => onCreateRule(t, offer))}>
                Make a rule
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setOffer(null);
                  // The button goes with the offer: focus back to the field it was about.
                  categoryRef.current?.focus();
                }}
              >
                No thanks
              </button>
            </div>
          </div>
        )}

        {onChangeTags && onSaveNote && !t.group_members && (
          <TxnTagsNote
            key={`${t.transaction_id}:${t.note ?? ''}`}
            t={t}
            tags={tags}
            onChangeTags={(change) => {
              const n = begin();
              const id = t.transaction_id;
              // On, or off, while the row still has it so.
              const holds = (x: Txn) => (change.add ?? []).every((g) => x.tags?.includes(g)) && !(change.remove ?? []).some((g) => x.tags?.includes(g));
              void Promise.resolve(onChangeTags(t, change)).then((saved) => sayOnce(n, saved === true, id, tagsSaid(change, tags), holds, true));
            }}
            onSaveNote={(note) => {
              const n = begin();
              const id = t.transaction_id;
              void Promise.resolve(onSaveNote(t, note)).then((saved) => sayOnce(n, saved === true, id, note ? 'Note saved.' : 'Note cleared.', (x) => (x.note ?? '') === note, true));
            }}
          />
        )}

        {/* What can be done with it, one action to a row: splitting it or
            grouping it with others (#39), sharing it or what it paid back
            (#49), and leaving it out of budgets. */}
        <ActionRows rows={actions} />
        {split?.said && <p className="helper">{split.said}</p>}
        {/* Offered once a pending row has posted (exclusionOffer), one a rule hides too. */}
        {countable && exclusion !== 'toggle' && (
          <p className="helper" ref={waitRef} tabIndex={-1}>
            {exclusion === 'wait-rule'
              ? 'A rule hides it. Once it posts, it can be put back in budgets and reports.'
              : 'Once it posts, it can be excluded from budgets and reports.'}
          </p>
        )}

        {ruleSentenceOf && (t.rule_ids?.length ?? 0) > 0 && (
          <div className="helper">
            {t.rule_ids!.length === 1 ? 'A rule matches it' : 'Rules match it'}, in the order they run (what you set here wins):
            <ul className="rule-matched">
              {t.rule_ids!.map((id) => {
                const sentence = ruleSentenceOf(id);
                return sentence ? (
                  <li key={id}>
                    <Masked>{sentence}</Masked>
                  </li>
                ) : null;
              })}
            </ul>
          </div>
        )}
        <ActionRows rows={ruleRow} />

        {/* Its receipts and documents (#47), read as it opens. */}
        {onAttachmentsChanged && <AttachmentSection t={t} rows={list} onChanged={onAttachmentsChanged} />}
        {!t.group_members && <TxnDetail t={t} noteEditor={!!(onChangeTags && onSaveNote) && !t.pending} />}
      </div>
    </Sheet>
  );
}

/** A part of a split transaction: its category, whether it counts on its
 *  own, and the whole split. Each change waits for its write, then closes
 *  it: the list shows it once it is read again. A refusal is said here, the
 *  sheet still open. */
function PartSheet({ open, onClose, said, parent, part: p, taxonomy, onSplitsChanged, onSplit, onSplitError }: Inner & { parent: Txn; part: Txn }) {
  const c = currencyOf(parent);
  const label = p.category_name !== undefined ? p.category_name : p.category;
  const { busy, refused, send } = useWrite(open, onClose, onSplitsChanged, onSplitError);
  const patch = (change: Record<string, unknown>) =>
    send(() => sendChange('/api/transaction-splits', 'PATCH', { transaction_id: splitKeptUnder(parent), part_id: p.transaction_id.slice(PART_PREFIX.length), ...change }));
  return (
    <Sheet
      open={open}
      title={`Part of ${shownName(parent)}`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          {busy && (
            <p className="helper sheet-footer-note" role="status">
              Saving…
            </p>
          )}
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => {
              onClose();
              onSplit(parent);
            }}
          >
            Edit split
          </button>
        </>
      }
    >
      <div className="stack">
        {said}
        {refused && (
          <Notice level="critical" role="alert">
            {refused}
          </Notice>
        )}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${p.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-p.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {label ? displayName(label) : 'No category'} · {longDay(parent.date)} · {parent.institution_name} · {parent.account_name}
          </p>
          {p.note && <p className="helper">{p.note}</p>}
          {p.split_remainder && (
            <p className="txn-row-note">
              {bankKept(parent) ? 'What the bank changed the amount by' : 'What the amount changed by'} since you split it: edit the split to place it.
            </p>
          )}
          {p.split_excluded && <p className="txn-row-note">Left out of budgets and reports on its own</p>}
        </div>
        {taxonomy && !p.split_remainder && (
          <label className="field">
            Category
            <CategoryPicker
              taxonomy={taxonomy}
              value={p.category_id ?? taxonomy.uncategorized}
              onChange={(id) => {
                if (id && id !== p.category_id) patch({ category_id: id });
              }}
              disabled={busy}
            />
          </label>
        )}
        {/* Its one action, a row as the transaction's are (components/ActionRows.tsx). */}
        {!p.split_remainder && parent.excluded !== true && (
          <ActionRows
            rows={[{ key: 'exclude', title: p.split_excluded ? 'Count this part again' : 'Leave this part out of budgets and reports', onSelect: () => patch({ excluded: !p.split_excluded }) }]}
          />
        )}
      </div>
    </Sheet>
  );
}

/** One of a group's transactions: as it is, and taken out of the group.
 *  Taking it out waits for its write, then closes it: the list shows that
 *  once it is read again. A refusal is said beside the button. */
function MemberSheet({ open, onClose, said, group, member: m, onSplitsChanged, onSplitError }: Inner & { group: Txn; member: Txn }) {
  const members = group.group_members ?? [];
  const c = currencyOf(group);
  const { busy, refused, send } = useWrite(open, onClose, onSplitsChanged, onSplitError);
  const failedId = useId();
  return (
    <Sheet
      open={open}
      title={shownName(m)}
      onClose={() => !busy && onClose()}
      footer={
        members.length > MIN_MEMBERS ? (
          <>
            {refused && (
              <div className="sheet-footer-note" id={failedId}>
                <Notice level="critical" role="alert">
                  {refused}
                </Notice>
              </div>
            )}
            <button
              className="btn secondary"
              disabled={busy}
              aria-describedby={refused ? failedId : undefined}
              onClick={() => send(() => sendChange('/api/transaction-groups', 'PATCH', { id: group.group_id, remove: [heldInGroupAs(m)] }))}
            >
              {busy ? 'Taking it out…' : 'Take it out of the group'}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="stack">
        {said}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${m.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-m.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {longDay(m.date)} · {m.institution_name} · {m.account_name}
          </p>
          {/* What was said of it on its own doesn't change the group's net. */}
          {m.excluded === true && (
            <p className="txn-row-note">{m.excluded_by_rule ? 'A rule hides it' : 'You excluded it'}: in the group, it counts through the group.</p>
          )}
        </div>
        <p className="helper">In a group, it counts through the group’s total, under the group’s category.</p>
        {members.length <= MIN_MEMBERS && (
          <p className="helper">A group holds at least {MIN_MEMBERS} transactions: to take this one out, ungroup it from the group’s row.</p>
        )}
      </div>
    </Sheet>
  );
}

/** A part's or a group transaction's change: sent while the sheet stays
 *  open, then closed and the list read again; refused, the words for the
 *  sheet to say, and the list read again too (as it always was). */
function useWrite(open: boolean, onClose: () => void, onSplitsChanged: (() => void) | undefined, onSplitError: (message: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // Gone from the page while open and saying a refusal (its part or
  // transaction no longer there once the list is read again): the list says
  // it instead, under its heading, where focus goes, rather than nowhere. An
  // answer that comes once it has gone goes to the list too, and closes
  // nothing. Kept as the write and the props say, not as a render last
  // drew, so a refusal and its sheet going in one render still reach it.
  const live = useRef({ mounted: true, open, refused: null as string | null, onSplitError });
  useEffect(() => {
    live.current.open = open;
    live.current.onSplitError = onSplitError;
  });
  useEffect(() => {
    const now = live.current;
    now.mounted = true;
    return () => {
      now.mounted = false;
      if (now.open && now.refused) now.onSplitError(now.refused);
    };
  }, []);
  const send = async (write: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    live.current.refused = null;
    const failed = await write();
    live.current.refused = failed;
    if (!live.current.mounted) {
      onSplitError(failed);
      onSplitsChanged?.();
      return;
    }
    setBusy(false);
    if (failed) setRefused(failed);
    else {
      // Made: what the list said of an earlier one goes.
      onSplitError(null);
      onClose();
    }
    onSplitsChanged?.();
  };
  return { busy, refused, send };
}
