import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

// Notes on the net-worth timeline (#50): the store, its shape and its limits.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const ctx = TEST_CTX;
const OTHER = { container: '1c7e6b63-4d2e-4f3a-9bac-2d3e4f5a6b7c' } as { container: any };

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const {
  timelineNotesStore,
  isTimelineNote,
  cleanNoteText,
  addUserNote,
  editUserNote,
  removeUserNote,
  writeAutoNote,
  removeAutoNote,
  readNotes,
  autoNoteId,
  NoteRefusedError,
  MAX_NOTES,
  NOTE_TEXT_MAX,
} = await import('@/lib/timeline-notes');

const NOW = Date.parse('2026-06-15T12:00:00.000Z');

beforeEach(() => fake.reset());

describe('the shape', () => {
  const good = { date: '2026-03-12', text: 'Bought the house', kind: 'user', created_at: '2026-03-12T10:00:00.000Z' };

  test('a note is a day, one line of text and its kind', () => {
    expect(isTimelineNote(good)).toBe(true);
    expect(isTimelineNote({ ...good, account_id: 'acct_1', updated_at: '2026-03-13T00:00:00Z' })).toBe(true);
    expect(isTimelineNote({ ...good, date: '2026-02-30' })).toBe(false);
    expect(isTimelineNote({ ...good, date: '1969-12-31' })).toBe(false);
    expect(isTimelineNote({ ...good, text: '' })).toBe(false);
    expect(isTimelineNote({ ...good, text: ' padded ' })).toBe(false);
    expect(isTimelineNote({ ...good, text: 'two\nlines' })).toBe(false);
    expect(isTimelineNote({ ...good, text: 'x'.repeat(NOTE_TEXT_MAX + 1) })).toBe(false);
    expect(isTimelineNote({ ...good, kind: 'system' })).toBe(false);
    expect(isTimelineNote({ ...good, account_id: 'has space' })).toBe(false);
    // An auto note is always about an account.
    expect(isTimelineNote({ ...good, kind: 'auto' })).toBe(false);
    expect(isTimelineNote({ ...good, kind: 'auto', account_id: 'acct_1' })).toBe(true);
    // Closed: a later release's field makes it unrecognised.
    expect(isTimelineNote({ ...good, color: 'red' })).toBe(false);
  });

  test('text is cleaned to one line, and refused when empty or too long', () => {
    expect(cleanNoteText('  401(k)\n rolled   into the IRA ')).toBe('401(k) rolled into the IRA');
    expect(cleanNoteText('   ')).toBeNull();
    expect(cleanNoteText(42)).toBeNull();
    expect(cleanNoteText('x'.repeat(NOTE_TEXT_MAX + 1))).toBeNull();
  });
});

describe("the person's own notes", () => {
  test('add, edit and remove, under a random id', async () => {
    const { id, note } = await addUserNote(ctx, { date: '2026-03-12', text: 'Bought the house' }, NOW);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(note).toEqual({ date: '2026-03-12', text: 'Bought the house', kind: 'user', created_at: new Date(NOW).toISOString() });
    expect(await editUserNote(ctx, id, { text: 'Closed on the house' }, NOW + 1000)).toMatchObject({ text: 'Closed on the house', date: '2026-03-12', updated_at: new Date(NOW + 1000).toISOString() });
    expect(await removeUserNote(ctx, id)).toBe(true);
    expect(await removeUserNote(ctx, id)).toBe(false);
    expect(await editUserNote(ctx, id, { text: 'gone' }, NOW)).toBeNull();
  });

  test('is stored encrypted: the words are not in the stored bytes', async () => {
    await addUserNote(ctx, { date: '2026-03-12', text: 'Inheritance from Aunt May' }, NOW);
    expect(JSON.stringify(await fake.hgetall(ctxKey('timeline-notes')))).not.toContain('Aunt May');
  });

  test('an auto note can’t be edited or removed as if it were one', async () => {
    await writeAutoNote(ctx, 'acct_1', '2026-03-12', 'Ally Savings closed', NOW);
    await expect(editUserNote(ctx, autoNoteId('acct_1'), { text: 'mine now' }, NOW)).rejects.toBeInstanceOf(NoteRefusedError);
    await expect(removeUserNote(ctx, autoNoteId('acct_1'))).rejects.toBeInstanceOf(NoteRefusedError);
    expect((await timelineNotesStore.get(ctx, autoNoteId('acct_1')))?.text).toBe('Ally Savings closed');
  });

  test('at most MAX_NOTES, counting every entry, unreadable ones too', async () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < MAX_NOTES - 1; i++) fields[`n${i}`] = 'damaged-or-not-it-counts';
    await fake.hset(ctxKey('timeline-notes'), fields);
    await addUserNote(ctx, { date: '2026-03-12', text: 'The last one' }, NOW);
    await expect(addUserNote(ctx, { date: '2026-03-13', text: 'One too many' }, NOW)).rejects.toBeInstanceOf(NoteRefusedError);
  });
});

describe('auto notes', () => {
  test('one per account: written, moved, removed', async () => {
    await writeAutoNote(ctx, 'acct_1', '2026-03-12', 'Ally Savings closed', NOW);
    await writeAutoNote(ctx, 'acct_1', '2026-03-10', 'Ally Savings closed', NOW + 1);
    expect(await timelineNotesStore.count(ctx)).toBe(1);
    expect(await timelineNotesStore.get(ctx, autoNoteId('acct_1'))).toMatchObject({ date: '2026-03-10', kind: 'auto', account_id: 'acct_1', created_at: new Date(NOW).toISOString() });
    await removeAutoNote(ctx, 'acct_1');
    expect(await timelineNotesStore.count(ctx)).toBe(0);
  });

  test('a long account name is cut to fit, never refused', async () => {
    await writeAutoNote(ctx, 'acct_1', '2026-03-12', `${'Very long name '.repeat(20)}closed`, NOW);
    const text = (await timelineNotesStore.get(ctx, autoNoteId('acct_1')))!.text;
    expect(text.length).toBeLessThanOrEqual(NOTE_TEXT_MAX);
    expect(text.endsWith('…')).toBe(true);
  });

  test('a note this release can’t read is never written over', async () => {
    await fake.hset(ctxKey('timeline-notes'), { [autoNoteId('acct_1')]: 'damaged-bytes-damaged-bytes-damaged' });
    await expect(writeAutoNote(ctx, 'acct_1', '2026-03-12', 'Ally Savings closed', NOW)).rejects.toThrow();
    expect(await fake.hget<string>(ctxKey('timeline-notes'), autoNoteId('acct_1'))).toBe('damaged-bytes-damaged-bytes-damaged');
  });
});

describe('reading', () => {
  test('oldest day first, and what can’t be read is named, never dropped silently', async () => {
    await addUserNote(ctx, { date: '2026-05-01', text: 'Later' }, NOW);
    await addUserNote(ctx, { date: '2026-01-01', text: 'Earlier' }, NOW);
    await fake.hset(ctxKey('timeline-notes'), {
      broken: 'damaged-bytes-damaged-bytes-damaged',
      future: await encrypt(JSON.stringify({ date: '2026-03-01', text: 'x', kind: 'user', created_at: '2026-03-01T00:00:00Z', mood: 'happy' })),
    });
    const { notes, unreadable, unrecognised } = await readNotes(ctx);
    expect(notes.map((n) => n.text)).toEqual(['Earlier', 'Later']);
    expect(unreadable).toEqual(['broken']);
    expect(unrecognised).toEqual(['future']);
  });

  test('a Redis failure throws, never "no notes"', async () => {
    fake.failNext('hgetall');
    await expect(readNotes(ctx)).rejects.toThrow(/armed failure/);
  });

  test('one container never sees another’s notes', async () => {
    await addUserNote(OTHER, { date: '2026-03-12', text: 'Theirs' }, NOW);
    expect((await readNotes(ctx)).notes).toEqual([]);
  });
});
