import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, FakeEvent, type FakeElement } from './mini-dom';
import { CLERK_APPEARANCE, colorScheme, statusBarStyle, themeChoice, themeColors } from '@/lib/theme';

// The theme (rollout phase 7): System, Dark or Light for this device, kept in
// a cookie the root layout reads (lib/theme.ts, app/layout.tsx), chosen on
// Settings > Preferences' Theme card (components/ThemeCard.tsx,
// components/theme.ts), used as a person would (react-dom/client over
// test/mini-dom.ts).

describe('what the layout sends for a choice (lib/theme.ts)', () => {
  test('a cookie holds light, dark or nothing; anything else is the system', () => {
    expect(themeChoice('light')).toBe('light');
    expect(themeChoice('dark')).toBe('dark');
    for (const v of [undefined, null, '', 'Light', 'system', 'blue']) expect(themeChoice(v)).toBeNull();
  });

  test("the chrome color: each theme's canvas by the system's setting, or the choice's for both", () => {
    expect(themeColors(null)).toEqual([
      { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
      { media: '(prefers-color-scheme: dark)', color: '#0d0f14' },
    ]);
    expect(themeColors('light').map((t) => t.color)).toEqual(['#f6f7f9', '#f6f7f9']);
    expect(themeColors('dark').map((t) => t.color)).toEqual(['#0d0f14', '#0d0f14']);
  });

  test("color-scheme and iOS's status bar follow a choice; with none, both themes and dark's bar", () => {
    expect(colorScheme(null)).toBe('dark light');
    expect(colorScheme('light')).toBe('light');
    expect(statusBarStyle(null)).toBe('black-translucent');
    expect(statusBarStyle('dark')).toBe('black-translucent');
    expect(statusBarStyle('light')).toBe('default');
  });

  test("Clerk's colors are the tokens, so it follows whichever theme is on", () => {
    for (const [k, v] of Object.entries(CLERK_APPEARANCE.variables)) {
      if (k.startsWith('color')) expect(v).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });
});

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { ThemeCard } = await import('@/components/ThemeCard');

// What the browser holds: the cookies written, and the metas the layout sent.
const written: string[] = [];
Object.defineProperty(dom.document, 'cookie', {
  configurable: true,
  get: () => '',
  set: (v: string) => written.push(v),
});
const meta = (attrs: Record<string, string>) => {
  const m = dom.document.createElement('meta');
  for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
  dom.document.head.appendChild(m);
  return m;
};
const lightColor = meta({ name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#f6f7f9' });
const darkColor = meta({ name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#0d0f14' });
const scheme = meta({ name: 'color-scheme', content: 'dark light' });

function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(<ThemeCard />));
  const radios = () => host.querySelectorAll('button') as FakeElement[];
  const checked = () => radios().find((b) => b.getAttribute('aria-checked') === 'true')?.textContent;
  return { host, radios, checked, unmount: () => act(() => root.unmount()) };
}

const key = (el: FakeElement, k: string) => {
  const e = new FakeEvent('keydown');
  e.key = k;
  act(() => {
    el.dispatchEvent(e);
  });
};

describe('the Theme card', () => {
  test('three choices in a named radio group, on System while no theme is chosen', () => {
    const v = mount();
    const group = v.host.querySelectorAll('div[role="radiogroup"]')[0];
    expect(group.getAttribute('aria-labelledby')).toBe('theme-title');
    expect(v.radios().map((b) => b.textContent)).toEqual(['System', 'Dark', 'Light']);
    expect(v.radios().map((b) => b.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(v.checked()).toBe('System');
    // One stop for Tab, on the checked one.
    expect(v.radios().map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(v.host.textContent).toContain('kept on this device');
    v.unmount();
  });

  test('Light: kept in the cookie for a year, drawn at once, and the chrome told', () => {
    const v = mount();
    written.length = 0;
    act(() => click(v.radios()[2]));
    expect(written).toEqual([`nya-theme=light; Path=/; Max-Age=${365 * 24 * 60 * 60}; SameSite=Lax`]);
    expect(dom.document.documentElement.dataset.theme).toBe('light');
    expect(v.checked()).toBe('Light');
    expect(lightColor.getAttribute('content')).toBe('#f6f7f9');
    expect(darkColor.getAttribute('content')).toBe('#f6f7f9');
    expect(scheme.getAttribute('content')).toBe('light');
    v.unmount();
  });

  test('System again: the cookie goes, the root follows the system, the chrome too', () => {
    const v = mount();
    expect(v.checked()).toBe('Light');
    written.length = 0;
    act(() => click(v.radios()[0]));
    expect(written).toEqual(['nya-theme=; Path=/; Max-Age=0; SameSite=Lax']);
    expect(dom.document.documentElement.dataset.theme).toBeUndefined();
    expect(v.checked()).toBe('System');
    expect(lightColor.getAttribute('content')).toBe('#f6f7f9');
    expect(darkColor.getAttribute('content')).toBe('#0d0f14');
    expect(scheme.getAttribute('content')).toBe('dark light');
    v.unmount();
  });

  test('the arrows choose, either way round, and Home and End', () => {
    const v = mount();
    const group = v.host.querySelectorAll('div[role="radiogroup"]')[0];
    key(group, 'ArrowRight');
    expect(v.checked()).toBe('Dark');
    expect(dom.document.documentElement.dataset.theme).toBe('dark');
    expect(darkColor.getAttribute('content')).toBe('#0d0f14');
    expect(lightColor.getAttribute('content')).toBe('#0d0f14');
    key(group, 'ArrowDown');
    expect(v.checked()).toBe('Light');
    key(group, 'ArrowRight');
    expect(v.checked()).toBe('System');
    key(group, 'ArrowLeft');
    expect(v.checked()).toBe('Light');
    key(group, 'Home');
    expect(v.checked()).toBe('System');
    key(group, 'End');
    expect(v.checked()).toBe('Light');
    v.unmount();
  });

  test('a page the layout drew in a theme opens the card on it', () => {
    dom.document.documentElement.dataset.theme = 'dark';
    const v = mount();
    expect(v.checked()).toBe('Dark');
    v.unmount();
  });
});
