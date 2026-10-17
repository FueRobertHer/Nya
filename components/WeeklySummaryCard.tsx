'use client';

// The Weekly summary card, under Manage on the Accounts tab (mounted in
// components/Dashboard.tsx): whether the weekly summary email is on, and a
// sheet to turn it on or off, choose its day and time zone, see what this
// week's would say, and send one now (app/api/weekly-summary,
// lib/weekly-summary/).
//
// OFF UNTIL TURNED ON. The time zone is this device's when it is turned on and
// none was saved before, and can be changed: the week is the seven days before
// the day it comes, on that zone's calendar. When it comes there is worked out
// from the daily job's hour (lib/weekly-summary/when.ts), so the card and the
// sheet say the hour it really comes in that zone.
//
// THE PREVIEW is the server's: what the daily job would send this week if it
// went now, for the day and zone the sheet shows, saved or not, with the
// summary on. The one that goes is worked out when it goes, after a sync, so
// it can say more, and the link to turn it off is made for each email: the
// sheet says both.
//
// A setting that can't be read is said, and nothing is offered to save over
// it (the route refuses that too, lib/repo.ts).

import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { DEFAULT_WEEKDAY, SENDS_NOW_PER_DAY, WEEKDAY_NAMES, type Weekday, type WeeklySetting } from '@/lib/weekly-summary/settings';
import { RUN_TEXT, nextDelivery, sameClock, timeOfDay } from '@/lib/weekly-summary/when';

export type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; setting: WeeklySetting | null; canSend: boolean; whyNot: string | null; demo: boolean }
  | { kind: 'error'; message: string; unreadable: boolean };

export type Draft = { enabled: boolean; weekday: Weekday; time_zone: string };

export type PreviewState = { kind: 'loading' } | { kind: 'ready'; subject: string; text: string } | { kind: 'error'; message: string };

/** This device's time zone, or UTC when the browser won't say. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The zones to choose from: the browser's own list, with `keep` in it. */
export function zoneChoices(keep: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return zones.includes(keep) ? zones : [keep, ...zones];
}

/** What the card says of the setting beside its name: short, to fit a phone. */
export function statusLine(setting: WeeklySetting | null): string {
  if (!setting?.enabled) return 'Off';
  return `On, ${WEEKDAY_NAMES[setting.weekday]}s`;
}

/** A time zone's name as a person reads it: "America/New York". */
export const zoneName = (zone: string) => zone.replaceAll('_', ' ');

/** When it comes, in full, under the card's description: the day, and the
 *  hour the daily job's run falls at in its zone. */
export function whenLine(setting: WeeklySetting | null, now: number = Date.now()): string | null {
  if (!setting?.enabled) return null;
  const at = nextDelivery(setting.weekday, setting.time_zone, now);
  return `Every ${WEEKDAY_NAMES[setting.weekday]}${at ? ` ${timeOfDay(at, true)}` : ''}, ${zoneName(setting.time_zone)} time.`;
}

/** What the sheet says of when it comes: the job's hour, and what that is on
 *  the chosen day in the chosen zone. */
export function comesText(weekday: Weekday, zone: string, now: number = Date.now()): string {
  const at = nextDelivery(weekday, zone, now);
  const when = at ? `${WEEKDAY_NAMES[weekday]}s ${timeOfDay(at)}` : null;
  const here = when ? ` In ${zoneName(zone)}, that is ${when}${when.endsWith('.') ? '' : '.'}` : '';
  return `It comes with Nya’s daily update, which runs once a day for everyone, at ${RUN_TEXT}, a little later if the update is held up.${here}`;
}

/** The draft the sheet opens with: what is saved, or Monday in this device's zone. */
export function draftOf(setting: WeeklySetting | null, zone: string): Draft {
  return setting ? { enabled: setting.enabled, weekday: setting.weekday, time_zone: setting.time_zone } : { enabled: false, weekday: DEFAULT_WEEKDAY, time_zone: zone };
}

const errorOf = async (res: Response, fallback: string) => {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === 'string' ? data.error : fallback;
};

/** `clerk`: whether sign-in is Clerk's, which decides whom it goes to. */
export default function WeeklySummaryCard({ clerk }: { clerk: boolean }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null, 'UTC'));
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/weekly-summary', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoaded({ kind: 'error', message: typeof data?.error === 'string' ? data.error : 'The weekly summary’s setting couldn’t be loaded.', unreadable: data?.unreadable === true });
        return;
      }
      setLoaded({ kind: 'ready', setting: data.setting ?? null, canSend: data.can_send === true, whyNot: typeof data.why_not === 'string' ? data.why_not : null, demo: data.demo === true });
    } catch {
      setLoaded({ kind: 'error', message: 'The weekly summary’s setting couldn’t be loaded.', unreadable: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The preview follows the day and zone the sheet shows.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview({ kind: 'loading' });
    const q = new URLSearchParams({ weekday: String(draft.weekday), time_zone: draft.time_zone });
    fetch(`/api/weekly-summary/preview?${q}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!live) return;
        if (!res.ok) setPreview({ kind: 'error', message: await errorOf(res, 'This week’s summary couldn’t be worked out.') });
        else {
          const p = await res.json();
          setPreview({ kind: 'ready', subject: String(p.subject), text: String(p.text) });
        }
      })
      .catch(() => live && setPreview({ kind: 'error', message: 'Nya could not be reached. Check your connection and try again.' }));
    return () => {
      live = false;
    };
  }, [open, draft.weekday, draft.time_zone]);

  const openSheet = () => {
    const setting = loaded.kind === 'ready' ? loaded.setting : null;
    setDraft(draftOf(setting, deviceZone()));
    setSaveError(null);
    setSendNote(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/weekly-summary', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (!res.ok) setSaveError(await errorOf(res, 'It wasn’t saved. Try again.'));
      else {
        await load();
        setOpen(false);
      }
    } catch {
      setSaveError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const sendNow = async () => {
    setSending(true);
    setSendNote(null);
    try {
      const res = await fetch('/api/weekly-summary/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekday: draft.weekday, time_zone: draft.time_zone }),
      });
      setSendNote(res.ok ? { ok: true, text: 'Sent. It should arrive within a minute or two.' } : { ok: false, text: await errorOf(res, 'It wasn’t sent. Try again.') });
    } catch {
      setSendNote({ ok: false, text: 'Nya could not be reached. Check your connection and try again.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <WeeklySummaryView loaded={loaded} clerk={clerk} onOpen={openSheet} />
      <Sheet open={open} title="Weekly summary" onClose={() => !saving && setOpen(false)}>
        {loaded.kind === 'ready' && (
          <WeeklySummarySheetBody
            draft={draft}
            onDraft={setDraft}
            saved={loaded.setting}
            canSend={loaded.canSend}
            whyNot={loaded.whyNot}
            demo={loaded.demo}
            preview={preview}
            saving={saving}
            saveError={saveError}
            onSave={save}
            sending={sending}
            sendNote={sendNote}
            onSendNow={sendNow}
            zones={zoneChoices(draft.time_zone)}
            device={deviceZone()}
          />
        )}
      </Sheet>
    </>
  );
}

/** The card itself. */
export function WeeklySummaryView({ loaded, clerk, onOpen }: { loaded: Loaded; clerk: boolean; onOpen: () => void }) {
  return (
    <div className="card weekly-summary-card">
      <div className="inst-header">
        <div className="inst-name">Weekly summary</div>
        {loaded.kind === 'ready' && <div className="weekly-summary-status">{statusLine(loaded.setting)}</div>}
      </div>
      <p className="panel-note">
        An email once a week, on the day you choose: how your spending compared with a usual week, budgets over or close, bills due, goals, bank
        connections that need you and months that may be missing transactions. It never includes balances, amounts or account numbers: open Nya
        for those. It goes to {clerk ? 'the email address you sign in with, once it is verified' : 'the address this copy of Nya sends its notices to'}.
      </p>
      {loaded.kind === 'loading' && <p className="panel-note">Loading…</p>}
      {loaded.kind === 'error' && (
        <div className="error">
          {loaded.message}
          {loaded.unreadable ? ' Nothing was changed, and no summary is sent while it can’t be read.' : ''}
        </div>
      )}
      {loaded.kind === 'ready' && (
        <>
          {whenLine(loaded.setting) && <p className="as-of">{whenLine(loaded.setting)}</p>}
          {!loaded.canSend && loaded.whyNot && <p className="stale-note">{loaded.whyNot}</p>}
          <button className="secondary" onClick={onOpen}>
            {loaded.setting?.enabled ? 'Change or preview' : 'Set up and preview'}
          </button>
        </>
      )}
    </div>
  );
}

/** The sheet's contents: the choice, this week's summary, and send now. */
export function WeeklySummarySheetBody(props: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  saved: WeeklySetting | null;
  canSend: boolean;
  whyNot: string | null;
  demo: boolean;
  preview: PreviewState;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
  sending: boolean;
  sendNote: { ok: boolean; text: string } | null;
  onSendNow: () => void;
  zones: string[];
  device: string;
  /** For tests: the time the sheet reads when the summary comes. */
  now?: number;
}) {
  const { draft, onDraft, saved, preview } = props;
  const unchanged = saved ? saved.enabled === draft.enabled && saved.weekday === draft.weekday && saved.time_zone === draft.time_zone : !draft.enabled;
  const set = (d: Partial<Draft>) => onDraft({ ...draft, ...d });
  return (
    <div className="sheet-form weekly-summary-sheet">
      <label className="quick-add-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={props.saving || (props.demo && !draft.enabled)}
          // Turned on with none saved: this device's zone.
          onChange={(e) => set(e.target.checked && !saved ? { enabled: true, time_zone: props.device } : { enabled: e.target.checked })}
        />
        <span>Email me a summary every week</span>
      </label>
      <label className="field">
        Day
        <select value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) as Weekday })} disabled={props.saving}>
          {WEEKDAY_NAMES.map((name, i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Time zone
        <select value={draft.time_zone} onChange={(e) => set({ time_zone: e.target.value })} disabled={props.saving}>
          {props.zones.map((z) => (
            <option key={z} value={z}>
              {zoneName(z)}
            </option>
          ))}
        </select>
      </label>
      {!sameClock(draft.time_zone, props.device, props.now) && (
        <button className="link-btn" onClick={() => set({ time_zone: props.device })} disabled={props.saving}>
          Use this device’s time zone ({zoneName(props.device)})
        </button>
      )}
      <p className="panel-note">
        Each summary covers the seven days before its day, on this time zone’s calendar. {comesText(draft.weekday, draft.time_zone, props.now)}
      </p>
      {props.demo && <p className="stale-note">Demo accounts can’t get the weekly summary: everyone who tries the demo shares its data.</p>}
      <button onClick={props.onSave} disabled={props.saving || unchanged}>
        {props.saving ? 'Saving…' : 'Save'}
      </button>
      {props.saveError && <div className="error">{props.saveError}</div>}

      <h3 className="section-label weekly-preview-title">This week’s summary</h3>
      {preview.kind === 'loading' && <p className="panel-note">Working it out…</p>}
      {preview.kind === 'error' && <div className="error">{preview.message}</div>}
      {preview.kind === 'ready' && (
        <>
          <p className="weekly-preview-subject">{preview.subject}</p>
          <pre className="weekly-preview">{preview.text}</pre>
          <p className="panel-note">
            What the summary would say if it went now, for the day and time zone above, with the summary on. The one that goes is worked out when it
            goes, after your transactions are brought up to date, so it can say more, and its link to turn the summary off is made for each email. Your
            email provider can read it, as it can any email: it names your budgets, goals, bills, planned expenses and banks. A name of yours with a
            digit, a currency or percent sign, a number or a currency written as an English word, or a letter outside the Latin alphabet in it is
            counted instead of named; a bank’s, only for a digit or a currency or percent sign.
          </p>
        </>
      )}
      <button className="secondary" onClick={props.onSendNow} disabled={!props.canSend || props.sending}>
        {props.sending ? 'Sending…' : 'Send me one now'}
      </button>
      {!props.canSend && props.whyNot && <p className="panel-note">{props.whyNot}</p>}
      {props.sendNote && <p className={props.sendNote.ok ? 'status-note' : 'error'}>{props.sendNote.text}</p>}
      <p className="panel-note">Up to {SENDS_NOW_PER_DAY} a day.</p>
    </div>
  );
}
