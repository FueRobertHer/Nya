import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WeeklySummaryView, WeeklySummarySheetBody, draftOf, statusLine, whenLine, zoneChoices, type Loaded } from '@/components/WeeklySummaryCard';
import { UnsubscribeView, postUnsubscribe } from '@/components/UnsubscribeForm';
import { SENDS_NOW_PER_DAY, type WeeklySetting } from '@/lib/weekly-summary/settings';

// The weekly summary's card under Manage, its sheet, and the page its link
// opens: what each says for what is saved, what can't be read, and what this
// copy of Nya can't do; and that the preview shown is the server's text,
// whole.

const noop = () => {};
const ON: WeeklySetting = { v: 1, enabled: true, weekday: 1, time_zone: 'America/New_York', updated_at: '2026-10-01T00:00:00.000Z' };
const ready = (over: Partial<Extract<Loaded, { kind: 'ready' }>> = {}): Loaded => ({ kind: 'ready', setting: null, canSend: true, whyNot: null, demo: false, ...over });
const card = (loaded: Loaded, clerk = true) => renderToStaticMarkup(<WeeklySummaryView loaded={loaded} clerk={clerk} onOpen={noop} />);

type Body = Parameters<typeof WeeklySummarySheetBody>[0];
const sheet = (over: Partial<Body> = {}) =>
  renderToStaticMarkup(
    <WeeklySummarySheetBody
      draft={{ enabled: true, weekday: 1, time_zone: 'America/New_York' }}
      onDraft={noop}
      saved={ON}
      canSend
      whyNot={null}
      demo={false}
      preview={{ kind: 'ready', subject: 'Your week in Nya: a quiet week', text: 'Your week in Nya: Monday, October 5 to Sunday, October 11.\n\nNothing needs your attention this week.\n' }}
      saving={false}
      saveError={null}
      onSave={noop}
      sending={false}
      sendNote={null}
      onSendNow={noop}
      zones={['America/New_York', 'Europe/London']}
      device="America/New_York"
      {...over}
    />
  );

describe('the card', () => {
  test('says whether it is on, and on which day and zone', () => {
    expect(statusLine(null)).toBe('Off');
    expect(statusLine({ ...ON, enabled: false })).toBe('Off');
    expect(statusLine(ON)).toBe('On, Mondays');
    expect(whenLine(ON)).toBe('Every Monday, on America/New York time.');
    expect(whenLine(null)).toBeNull();
    expect(card(ready())).toContain('Off');
    expect(card(ready())).toContain('Set up and preview');
    expect(card(ready())).not.toContain('Every Monday');
    const on = card(ready({ setting: ON }));
    expect(on).toContain('On, Mondays');
    expect(on).toContain('Every Monday, on America/New York time.');
    expect(on).toContain('Change or preview');
  });

  test('says what it holds, never amounts, and whom it goes to', () => {
    const html = card(ready());
    expect(html).toContain('It never includes balances, amounts or account numbers');
    expect(html).toContain('the email address you sign in with, once it is verified');
    expect(card(ready(), false)).toContain('the address this copy of Nya sends its notices to');
  });

  test('says why this copy of Nya can’t send one', () => {
    expect(card(ready({ canSend: false, whyNot: 'This copy of Nya has no APP_URL set.' }))).toContain('This copy of Nya has no APP_URL set.');
  });

  test('a setting that can’t be read is said, and nothing is offered over it', () => {
    const html = card({ kind: 'error', message: 'Your saved weekly summary settings could not be read, so they were left untouched.', unreadable: true });
    expect(html).toContain('could not be read');
    expect(html).toContain('no summary is sent while it can’t be read');
    expect(html).not.toContain('Set up and preview');
  });
});

describe('the sheet', () => {
  test('opens with what is saved, or off on Mondays in this device’s zone', () => {
    expect(draftOf(ON, 'Europe/London')).toEqual({ enabled: true, weekday: 1, time_zone: 'America/New_York' });
    expect(draftOf(null, 'Europe/London')).toEqual({ enabled: false, weekday: 1, time_zone: 'Europe/London' });
    // A zone the browser doesn't list is kept, at the top.
    expect(zoneChoices('Mars/Olympus_Mons')[0]).toBe('Mars/Olympus_Mons');
  });

  test('shows the server’s preview whole, with what it leaves out said', () => {
    const html = sheet();
    expect(html).toContain('Your week in Nya: a quiet week');
    expect(html).toContain('<pre class="weekly-preview">Your week in Nya: Monday, October 5 to Sunday, October 11.\n\nNothing needs your attention this week.\n</pre>');
    expect(html).toContain('but for its link to turn the summary off');
    expect(html).toContain('a name with a number in it is left out');
    expect(html).toContain(`Up to ${SENDS_NOW_PER_DAY} a day.`);
    expect(sheet({ preview: { kind: 'loading' } })).toContain('Working it out');
    expect(sheet({ preview: { kind: 'error', message: 'This week’s summary couldn’t be worked out.' } })).toContain('couldn’t be worked out');
  });

  test('saves only a change, and sends only where this copy of Nya can', () => {
    expect(sheet()).toMatch(/<button disabled="">Save<\/button>/);
    expect(sheet({ draft: { enabled: true, weekday: 3, time_zone: 'America/New_York' } })).toMatch(/<button>Save<\/button>/);
    const cannot = sheet({ canSend: false, whyNot: 'This copy of Nya isn’t set up to send email.' });
    expect(cannot).toMatch(/<button class="secondary" disabled="">Send me one now<\/button>/);
    expect(cannot).toContain('isn’t set up to send email');
    expect(sheet({ sendNote: { ok: true, text: 'Sent. It should arrive within a minute or two.' } })).toContain('class="status-note">Sent.');
    expect(sheet({ sendNote: { ok: false, text: 'You can send yourself 3 a day.' } })).toContain('class="error">You can send yourself 3 a day.');
  });

  test('offers this device’s zone when another is chosen, and says a demo account can’t have one', () => {
    expect(sheet({ device: 'Europe/London' })).toContain('Use this device’s time zone (Europe/London)');
    expect(sheet({ device: 'America/Los_Angeles' })).toContain('Use this device’s time zone (America/Los Angeles)');
    expect(sheet()).not.toContain('Use this device’s time zone');
    const demo = sheet({ demo: true, draft: { enabled: false, weekday: 1, time_zone: 'UTC' }, saved: null });
    expect(demo).toContain('Demo accounts can’t get the weekly summary');
    expect(demo).toMatch(/<input type="checkbox" disabled=""/);
  });
});

describe('the page its link opens', () => {
  test('asks before it turns anything off, and needs the link', () => {
    expect(renderToStaticMarkup(<UnsubscribeView token={undefined} phase={{ kind: 'idle' }} onTurnOff={noop} />)).toContain('Loading');
    const none = renderToStaticMarkup(<UnsubscribeView token={null} phase={{ kind: 'idle' }} onTurnOff={noop} />);
    expect(none).toContain('This page needs the link from a weekly summary email');
    expect(none).not.toContain('<button');
    const asks = renderToStaticMarkup(<UnsubscribeView token="abc" phase={{ kind: 'idle' }} onTurnOff={noop} />);
    expect(asks).toContain('Turn off the weekly summary that comes with this link?');
    expect(asks).toContain('<button>Turn off the weekly summary</button>');
    expect(renderToStaticMarkup(<UnsubscribeView token="abc" phase={{ kind: 'busy' }} onTurnOff={noop} />)).toContain('<button disabled="">Turning it off…</button>');
    expect(renderToStaticMarkup(<UnsubscribeView token="abc" phase={{ kind: 'done', message: 'Your weekly summary from Nya is off.' }} onTurnOff={noop} />)).toContain('Your weekly summary from Nya is off.');
  });

  test('posts the link’s token as a mail app’s one-click unsubscribe does, and says what came of it', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (res: Response) => (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res;
    }) as unknown as typeof fetch;
    expect(await postUnsubscribe('a.b.c', answer(Response.json({ ok: true, message: 'Off.' })))).toEqual({ kind: 'done', message: 'Off.' });
    expect(calls[0].url).toBe('/api/weekly-summary/unsubscribe?t=a.b.c');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: 'List-Unsubscribe=One-Click' });
    expect(await postUnsubscribe('x', answer(Response.json({ error: 'This link doesn’t work.' }, { status: 400 })))).toEqual({ kind: 'error', message: 'This link doesn’t work.' });
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await postUnsubscribe('x', offline)).toMatchObject({ kind: 'error', message: expect.stringContaining('could not be reached') });
  });
});
