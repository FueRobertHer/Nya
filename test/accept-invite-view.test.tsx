import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, testKey } from './fake-redis';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';

// An invite link's page (app/connect/[token]/page.tsx) and accepting it
// (components/AcceptInvite.tsx, app/api/connections/accept/route.ts). The page
// is rendered as the server renders it, over the real invite store in a fake
// Redis; Connect is used as a person would (react-dom/client over
// test/mini-dom.ts) against answers the route gives; and the route itself is
// asked, for the words the page shows. What the page must keep: a link that
// can't be used reads the same whatever the reason, and Nya's own failure
// reads the same whatever the token, so neither tells anything about the link
// or who sent it.

const savedEnv = { ...process.env };
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { renderToStaticMarkup } = await import('react-dom/server');
const dom = installDom();
const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Promise<Response> = () => new Promise(() => {});
globalThis.fetch = ((url: string, init?: RequestInit) => answer(url, init)) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
  process.env = { ...savedEnv };
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: ConnectPage } = await import('@/app/connect/[token]/page');
const { AcceptInvite } = await import('@/components/AcceptInvite');
const { createInvite, UNUSABLE, OWN_LINK } = await import('@/lib/sharing');
const { ownerContainer } = await import('@/lib/owners');

const UNCHECKED = 'Nya couldn’t check this invite link just now. Try again in a few minutes.';
const FAILED = 'Nya couldn’t connect you just now. Try again in a few minutes, and if the link no longer works, ask for a new one.';
const DONE = 'Connected. Nothing is shared yet: what they share with you will show at the bottom of Accounts, and you choose what you share with them in Settings, Sharing.';
const SHARING_HREF = '/?tab=accounts&amp;settings=sharing';

/** A well-formed token nobody made. */
const UNKNOWN = 'A'.repeat(32);

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_sender,user_follower';
  clerk.signedIn = 'user_follower';
});
afterEach(() => {
  clerk.signedIn = null;
});

/** The page for a token, as the server sends it. */
const page = async (token: string) => renderToStaticMarkup(await ConnectPage({ params: Promise.resolve({ token }) }));
/** An invite link's token from the sender, who'd like to be seen as Sam. */
const samsLink = async () => (await createInvite('user_sender', { fromName: 'Sam' })).token;

/** console.error's lines while `fn` runs, kept off the test's output. */
async function errorsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = real;
  }
}

describe('the invite page, before Connect', () => {
  test('a link that can’t be used reads the same whatever the reason: unknown, malformed, used up or expired', async () => {
    const unknown = await page(UNKNOWN);
    const malformed = await page('not a token!');
    // Used up and expired look alike: the invite's key is simply gone.
    const token = await samsLink();
    await fake.del(...[...(fake as any).strings.keys()].filter((k: string) => k.includes(':invites:')));
    const gone = await page(token);
    expect(malformed).toBe(unknown);
    expect(gone).toBe(unknown);
    // A caution (the person must ask for a new one), with its level said first.
    expect(unknown).toContain('<div class="notice caution">');
    expect(unknown).toContain(UNUSABLE);
    expect(unknown).not.toContain('<input');
    expect(unknown).not.toContain('Sam');
  });

  test('my own link says so as information, with no form', async () => {
    clerk.signedIn = 'user_sender';
    const html = await page(await samsLink());
    expect(html).toContain('<div class="notice info">');
    expect(html).toContain(OWN_LINK);
    expect(html).not.toContain('<input');
  });

  test('a link that works: who sent it, two fields and Connect, on the primitives with no inline style', async () => {
    const html = await page(await samsLink());
    expect(html).toContain('Sam invited you to connect.');
    // Not "which accounts": a share can hold more than accounts, and a new
    // connection holds nothing yet.
    expect(html).toContain('Connecting shares nothing by itself: each of you then chooses what to share with the other, read-only.');
    expect(html).toContain('<div class="card connect-card"><div class="card-header"><h2>Connect</h2></div><div class="stack">');
    expect(html.match(/<label class="field">/g)).toHaveLength(2);
    // What an empty name becomes is said under its field, which it describes.
    const [, noteId] = html.match(/<label class="field">What you call them<input maxLength="40" aria-describedby="([^"]+)" value="Sam"\/><\/label>/) ?? [];
    expect(noteId).toBeTruthy();
    expect(html).toContain(`<p class="helper" id="${noteId}">Left empty, you’ll see them as Sam.</p>`);
    expect(html).toContain('<button class="btn btn-block">Connect</button>');
    // The way out is a button-sized link, not a 21px line of text.
    expect(html).toContain('<div class="btn-row"><a class="btn ghost" href="/">Back to Nya</a></div>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('peer-row');
  });

  test('when Nya can’t read the link, it says so in the same words for every token, and nothing of the sender', async () => {
    const token = await samsLink();
    const { result: real, logged } = await errorsDuring(async () => {
      fake.failNext('get');
      return page(token);
    });
    fake.failNext('get');
    const { result: unknown } = await errorsDuring(() => page(UNKNOWN));
    expect(real).toBe(unknown);
    expect(real).toContain('<div class="notice caution">');
    expect(real).toContain(UNCHECKED);
    expect(real).not.toContain(UNUSABLE);
    expect(real).not.toContain('Sam');
    expect(real).not.toContain('<input');
    // The log names the failure's kind, never the token.
    expect(logged).toEqual([['Reading an invite link failed', 'Error']]);
    // A token that isn't one is never looked up, so it can't be used, outage
    // or not: the armed failure is still waiting for the next read.
    const unusable = await page('also not a token!');
    fake.failNext('get');
    expect(await page('not a token!')).toBe(unusable);
    expect((await errorsDuring(() => page(UNKNOWN))).result).toBe(unknown);
  });
});

/** AcceptInvite on a page of its own, for a person to use. */
function mount(fromName = 'Sam') {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(<AcceptInvite token={UNKNOWN} fromName={fromName} />));
  const find = (pred: (e: FakeElement) => boolean) => host.findAll(pred)[0];
  return {
    host,
    connect: () => find((e) => e.tagName === 'BUTTON'),
    inputs: () => host.findAll((e) => e.tagName === 'INPUT'),
    notice: () => find((e) => (e.getAttribute('class') ?? '').startsWith('notice ')),
    sharingLink: () => find((e) => e.tagName === 'A'),
    focused: () => dom.document.activeElement as unknown as FakeElement,
  };
}

/** Lets a request's answer, its body and the render after it land. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Connect, used as a person would', () => {
  test('once connected, the form gives way to a done notice that takes focus, says nothing is shared yet, and links to Sharing', async () => {
    const sent: unknown[] = [];
    answer = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return reply(200, { id: 'c1' })();
    };
    const view = mount();
    act(() => type(view.inputs()[1], 'Rob'));
    act(() => click(view.connect()));
    await settle();
    expect(sent).toEqual([{ token: UNKNOWN, label: 'Sam', my_name: 'Rob' }]);
    const notice = view.notice();
    expect(notice.getAttribute('class')).toBe('notice done');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toBe(`Done: ${DONE}`);
    // Connect went with the form, so focus is on what replaced it, not the
    // page; a browser focuses a div only with a tabindex.
    expect(view.focused()).toBe(notice);
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(view.inputs()).toHaveLength(0);
    expect(view.connect()).toBeUndefined();
    expect(view.sharingLink().getAttribute('class')).toBe('btn btn-block');
    expect(view.sharingLink().getAttribute('href')).toBe('/?tab=accounts&settings=sharing');
    expect(view.sharingLink().textContent).toBe('Choose what you share');
  });

  test('a link refused on Connect is final: a caution in focus in place of the form, in the same words as the page', async () => {
    answer = reply(409, { error: UNUSABLE });
    const view = mount();
    act(() => click(view.connect()));
    await settle();
    const notice = view.notice();
    expect(notice.getAttribute('class')).toBe('notice caution');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain(UNUSABLE);
    expect(view.focused()).toBe(notice);
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(view.inputs()).toHaveLength(0);
    expect(view.sharingLink()).toBeUndefined();
  });

  test('already connected isn’t a failure: information, with the way to Sharing', async () => {
    answer = reply(409, { error: 'You’re already connected.', connected: true });
    const view = mount();
    act(() => click(view.connect()));
    await settle();
    const notice = view.notice();
    expect(notice.getAttribute('class')).toBe('notice info');
    expect(notice.textContent).toContain('You’re already connected.');
    expect(view.focused()).toBe(notice);
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(view.sharingLink().getAttribute('href')).toBe('/?tab=accounts&settings=sharing');
  });

  test('a failure keeps the form to try again, with the route’s words as a critical alert under Connect', async () => {
    answer = reply(500, { error: FAILED });
    const view = mount();
    act(() => click(view.connect()));
    await settle();
    const notice = view.notice();
    expect(notice.getAttribute('class')).toBe('notice critical');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain(FAILED);
    expect(view.inputs()).toHaveLength(2);
    expect(view.connect().textContent).toBe('Connect');
    expect(view.connect().disabled).toBe(false);
  });

  test('no answer at all (offline) says so, and keeps the form', async () => {
    answer = async () => {
      throw new TypeError('Failed to fetch');
    };
    const view = mount();
    act(() => click(view.connect()));
    await settle();
    expect(view.notice().getAttribute('class')).toBe('notice critical');
    expect(view.notice().textContent).toContain('Could not connect. Try again.');
    expect(view.inputs()).toHaveLength(2);
  });
});

describe('the accept route’s words', () => {
  const accept = async (token: string) => {
    const { POST } = await import('@/app/api/connections/accept/route');
    const res = await POST(new Request('http://x/api/connections/accept', { method: 'POST', body: JSON.stringify({ token, label: '' }) }));
    return { status: res.status, body: await res.json() };
  };
  beforeEach(async () => {
    await ownerContainer('user_sender');
    await ownerContainer('user_follower');
  });

  test('an empty name is saved as the page says it will be: the sender’s name, or Someone when they gave none', async () => {
    const { GET, DELETE } = await import('@/app/api/connections/route');
    const myLabel = async () => (await (await GET()).json()).connections[0].label;
    for (const [fromName, shown] of [
      ['Sam', 'Sam'],
      ['', 'Someone'],
    ]) {
      const token = (await createInvite('user_sender', { fromName })).token;
      expect(await page(token)).toContain(`Left empty, you’ll see them as ${shown}.</p>`);
      const made = await accept(token);
      expect(made.status).toBe(200);
      expect(await myLabel()).toBe(shown);
      await DELETE(new Request('http://x/api/connections', { method: 'DELETE', body: JSON.stringify({ id: made.body.id }) }));
    }
  });

  test('already connected is a refusal marked connected; a blocked pair is answered as a dead link is, word for word', async () => {
    const first = await accept(await samsLink());
    expect(first.status).toBe(200);
    expect(await accept(await samsLink())).toEqual({ status: 409, body: { error: 'You’re already connected.', connected: true } });
    const { DELETE } = await import('@/app/api/connections/route');
    const blocked = await DELETE(new Request('http://x/api/connections', { method: 'DELETE', body: JSON.stringify({ id: first.body.id, block: true }) }));
    expect(blocked.status).toBe(200);
    const dead = await accept(UNKNOWN);
    expect(dead).toEqual({ status: 409, body: { error: UNUSABLE } });
    expect(await accept(await samsLink())).toEqual(dead);
  });

  test('Nya’s own failure has a full stop and says what to do', async () => {
    const token = await samsLink();
    fake.failNext('getdel');
    const { result, logged } = await errorsDuring(() => accept(token));
    expect(result).toEqual({ status: 500, body: { error: FAILED } });
    expect(logged).toEqual([['Accepting an invite failed', 'Error']]);
  });

  test('a failure on the sender’s side reads as Nya’s own, naming nothing of theirs', async () => {
    const token = await samsLink();
    // The sender's registry entry can't be read: a container error, whose own
    // words name their container.
    const theirs = await ownerContainer('user_sender');
    const entry = await fake.hget<string>(testKey('containers'), theirs);
    await fake.hset(testKey('containers'), { [theirs]: '{' });
    const { result } = await errorsDuring(() => accept(token));
    expect(result).toEqual({ status: 500, body: { error: FAILED } });
    expect(JSON.stringify(result)).not.toContain(theirs);
    // That failure came before the link was used up: trying again says the
    // same while it lasts, and connects once it's over.
    expect((await errorsDuring(() => accept(token))).result).toEqual(result);
    await fake.hset(testKey('containers'), { [theirs]: typeof entry === 'string' ? entry : JSON.stringify(entry) });
    expect((await accept(token)).status).toBe(200);
  });
});
