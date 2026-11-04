import { describe, expect, test } from 'bun:test';
import { nameTaken } from '@/lib/fire/plan-list';

describe('a plan’s name', () => {
  test('two plans can’t share one, in any case', () => {
    const list = [{ id: 'a', name: 'Retire at 50' }];
    expect(nameTaken(list, ' retire AT 50 ')).toBe(true);
    expect(nameTaken(list, 'Retire at 50', 'a')).toBe(false);
    expect(nameTaken(list, 'Retire at 52')).toBe(false);
  });
});
