import { describe, expect, test, mock } from 'bun:test';
mock.module('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: async () => {} }) }));
const { renderToStaticMarkup } = await import('react-dom/server');
const { DeleteAccountView } = await import('@/components/DeleteAccount');

const noop = () => {};
const view = (status: any, typed = '') =>
  renderToStaticMarkup(<DeleteAccountView status={status} typed={typed} busy={false} error="" onType={noop} onDelete={noop} />);

describe('deleting my account, on screen', () => {
  test('nothing with the shared password', () => {
    expect(view({ enabled: false })).toBe('');
  });

  test('never a blank page: loading, then the reason it could not check', () => {
    expect(view(null)).toContain('role="status"');
    expect(view('failed')).toContain('Could not check this account.');
  });

  test('the primary account is told why, with no button', () => {
    const html = view({ enabled: true, can_delete: false, reason: 'This is the primary account.' });
    expect(html).toContain('This is the primary account.');
    expect(html).not.toContain('<button');
  });

  test('the button stays off until DELETE is typed', () => {
    expect(view({ enabled: true, can_delete: true }, 'delete')).toMatch(/<button[^>]*disabled/);
    expect(view({ enabled: true, can_delete: true }, 'DELETE')).not.toMatch(/<button[^>]*disabled/);
  });
});
