import { describe, expect, test, mock } from 'bun:test';
import type { TokenInfo } from '@/components/ApiTokens';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { ApiTokensView, RevokeSheet, mcpConfig, shortDay } = await import('@/components/ApiTokens');
const { MAX_TOKENS, REQUESTS_PER_MINUTE } = await import('@/lib/api-limits');

type Props = Parameters<typeof ApiTokensView>[0];

const noop = () => {};
const TOKEN = `nya_0123456789abcdef_${'A'.repeat(43)}_8a1c2f4e-5b6d-4c7e-9f80-1a2b3c4d5e6f`;
const info = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  id: '0123456789abcdef',
  label: 'Claude',
  hint: 'nya_0123',
  created_at: '2026-10-01T12:00:00.000Z',
  last_used_at: null,
  ...over,
});
const ready = (tokens: TokenInfo[], more: { unreadable?: string[]; unrecognised?: string[] } = {}): Props['list'] => ({
  kind: 'ready',
  tokens,
  unreadable: more.unreadable ?? [],
  unrecognised: more.unrecognised ?? [],
  limit: MAX_TOKENS,
});
const view = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <ApiTokensView
      list={ready([])}
      label=""
      setLabel={noop}
      password=""
      setPassword={noop}
      needsPassword={false}
      busy={false}
      error={null}
      made={null}
      setMade={noop}
      onCreate={noop}
      revoke={async () => null}
      origin="https://nya.example"
      {...over}
    />
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const makeButton = (html: string) => /<button[^>]*>(Make a token|Making…)<\/button>/.exec(html)!;

describe('API tokens, on screen', () => {
  test('says what a token can do, that it must be kept secret, and the limits the server applies', () => {
    const t = text(view());
    expect(t).toContain('A token lets a program you choose read your data');
    expect(t).toContain('It can’t change anything');
    expect(t).toContain('keep it secret, and revoke any you no longer use');
    expect(t).toContain('Signing out everywhere doesn’t revoke tokens.');
    // With the shared password, the natural move after a leak is a new password: that doesn't end them either.
    expect(text(view({ needsPassword: true }))).toContain('Signing out everywhere, or changing the app password, doesn’t revoke tokens.');
    // Moving to sign-in accounts does: nobody vouches for a token the password made.
    expect(text(view({ needsPassword: true }))).toContain('Turning on sign-in accounts does: make new ones once you sign in.');
    expect(text(view())).not.toContain('Turning on sign-in accounts');
    expect(view()).toContain('href="/developers"');
    expect(t).toContain(`Up to ${MAX_TOKENS} tokens, and ${REQUESTS_PER_MINUTE} requests a minute each.`);
    expect(t).toContain('No tokens yet.');
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  test('loading, and a list that couldn’t be loaded: nothing can be made yet', () => {
    expect(text(view({ list: { kind: 'loading' } }))).toContain('Loading your tokens…');
    const failed = view({ list: { kind: 'error', message: 'Your API tokens couldn’t be loaded.' } });
    expect(failed).toContain('Your API tokens couldn’t be loaded.');
    expect(failed).not.toContain('Make a token');
  });

  test('each token: its name, the first characters, when it was made and last used, and a way to revoke it', () => {
    const html = view({
      list: ready([info(), info({ id: 'fedcba9876543210', label: 'My dashboard', hint: 'nya_fedc', last_used_at: '2026-10-08T09:30:00.000Z' })]),
    });
    const t = text(html);
    expect(t).toContain('Claude');
    expect(t).toContain('nya_0123…');
    expect(t).toContain(`made ${shortDay('2026-10-01T12:00:00.000Z')} · never used`);
    expect(t).toContain('My dashboard');
    expect(t).toContain(`last used ${shortDay('2026-10-08T09:30:00.000Z')}`);
    expect(html.match(/>Revoke<\/button>/g)).toHaveLength(2);
    // Never the token itself: the list has only what the server keeps to show.
    expect(html).not.toContain('AAAAAAAA');
  });

  test('making one needs a name, and with the shared password, the password', () => {
    expect(makeButton(view())[0]).toMatch(/disabled/);
    expect(makeButton(view({ label: '   ' }))[0]).toMatch(/disabled/);
    const clerk = view({ label: 'Claude' });
    expect(makeButton(clerk)[0]).not.toMatch(/disabled/);
    expect(clerk).not.toContain('type="password"');
    expect(text(clerk)).toContain('you’ll be asked to confirm it’s you first');

    const shared = view({ label: 'Claude', needsPassword: true });
    expect(shared).toContain('type="password"');
    expect(makeButton(shared)[0]).toMatch(/disabled/);
    expect(makeButton(view({ label: 'Claude', needsPassword: true, password: 'hunter2' }))[0]).not.toMatch(/disabled/);
  });

  test('while one is being made, nothing can be changed, and an error is shown as the server said it', () => {
    const busy = view({ label: 'Claude', busy: true });
    expect(makeButton(busy)[1]).toBe('Making…');
    expect(makeButton(busy)[0]).toMatch(/disabled/);
    expect(busy).toMatch(/<input[^>]*disabled/);
    expect(view({ error: 'You have the most API tokens you can.' })).toContain('You have the most API tokens you can.');
  });

  test('at the limit, no form: revoke one first (records that can’t be read count, as the server counts them)', () => {
    const full = Array.from({ length: MAX_TOKENS }, (_, i) => info({ id: `0123456789abcd${String(i).padStart(2, '0')}` }));
    const html = view({ list: ready(full), label: 'Claude' });
    expect(text(html)).toContain(`You have the most tokens you can (${MAX_TOKENS}). Revoke one you no longer use to make another.`);
    expect(html).not.toContain('Make a token');
    const withDamaged = view({ list: ready(full.slice(1), { unreadable: ['00000000000000aa'] }), label: 'Claude' });
    expect(withDamaged).not.toContain('Make a token');
    expect(view({ list: ready(full.slice(1)), label: 'Claude' })).toContain('Make a token');
  });

  test('a record that can’t be read: it doesn’t work, and it can be removed; one from another version is only named', () => {
    const html = view({ list: ready([], { unreadable: ['00000000000000aa'], unrecognised: ['00000000000000bb'] }) });
    const t = text(html);
    expect(t).toContain('A token’s record couldn’t be read, so that token doesn’t work.');
    expect(html).toContain('Remove it');
    expect(t).toContain('A token was saved by another version of Nya, which this one can’t read, so it doesn’t work here. Nothing was changed.');
    expect(t).not.toContain('No tokens yet.');
    expect(text(view({ list: ready([], { unrecognised: ['a', 'b'] }) }))).toContain('2 tokens were saved by another version of Nya');
  });

  test('a token just made: shown once, with copy buttons, a warning, and an MCP client configuration that holds it', () => {
    const made = { token: TOKEN, info: info() };
    const html = view({ made, label: 'Claude' });
    const t = text(html);
    expect(t).toContain('Made “Claude”. Copy it now: Nya keeps only a hash of it, so it can’t show it again.');
    expect(html).toContain(`value="${TOKEN}"`);
    expect(html).toMatch(/<input[^>]*readOnly|<input[^>]*readonly/);
    expect(html).toContain('>Copy</button>');
    expect(html).toContain('>Copy configuration</button>');
    expect(html).toContain('>Done</button>');
    expect(t).toContain('https://nya.example/api/v1/…');
    expect(t).toContain('"url": "https://nya.example/api/mcp"');
    expect(t).toContain(`"Authorization": "Bearer ${TOKEN}"`);
    // While it is on screen, no second one is started.
    expect(html).not.toContain('Make a token');
  });

  test('the MCP configuration is the address and the token as a bearer header', () => {
    expect(JSON.parse(mcpConfig('https://nya.example', TOKEN))).toEqual({
      mcpServers: { nya: { url: 'https://nya.example/api/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });
});

describe('revoking, asked first', () => {
  const sheet = (over: Partial<Parameters<typeof RevokeSheet>[0]> = {}) =>
    renderToStaticMarkup(<RevokeSheet revoking={{ id: '0123456789abcdef', label: 'Claude', unreadable: false }} busy={false} error={null} onCancel={noop} onConfirm={noop} {...over} />);

  test('nothing until a token is chosen', () => {
    expect(sheet({ revoking: null })).toBe('');
  });

  test('says what it does and that it can’t be undone', () => {
    const t = text(sheet());
    expect(t).toContain('Revoke Claude?');
    expect(t).toContain('Anything using it loses access on its next request. This can’t be undone');
    expect(sheet()).toContain('>Cancel</button>');
    expect(sheet()).toMatch(/<button class="danger"[^>]*>Revoke<\/button>/);
  });

  test('a record that can’t be read is removed, not revoked', () => {
    const t = text(sheet({ revoking: { id: '00000000000000aa', label: 'the token that can’t be read', unreadable: true } }));
    expect(t).toContain('Remove the token?');
    expect(t).toContain('Its record can’t be read, so it doesn’t work now.');
    expect(t).toContain('Remove');
  });

  test('while it works, both buttons wait; a failure is shown', () => {
    const busy = sheet({ busy: true });
    expect(busy).toContain('Revoking…');
    expect(busy.match(/<button class="(secondary|danger)" disabled/g)).toHaveLength(2);
    expect(sheet({ error: 'It wasn’t revoked. Try again.' })).toContain('It wasn’t revoked. Try again.');
  });
});
