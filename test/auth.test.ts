import { afterEach, describe, expect, test } from 'bun:test';
import { previewLoginAllowed } from '@/lib/auth';

// The login page shows a button that mints a session with no password, and
// /api/login honours it, so the one thing that must never drift is which
// deployments answer yes here. Production has to refuse even though the code
// ships with the rest of the app.

const original = process.env.VERCEL_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = original;
});

describe('previewLoginAllowed', () => {
  test('refuses on production', () => {
    process.env.VERCEL_ENV = 'production';
    expect(previewLoginAllowed()).toBe(false);
  });

  test('allows on preview deployments', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(previewLoginAllowed()).toBe(true);
  });

  test('allows on Vercel development deployments', () => {
    process.env.VERCEL_ENV = 'development';
    expect(previewLoginAllowed()).toBe(true);
  });

  test('allows off-Vercel, where VERCEL_ENV is unset (local dev)', () => {
    delete process.env.VERCEL_ENV;
    expect(previewLoginAllowed()).toBe(true);
  });
});
