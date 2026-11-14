import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetBand, cents, qualify, share } from './dist/domain.mjs';

const quotes = [{ total: 44001 }, { total: 56800 }, { total: 71600 }];

test('cents parses a dollar amount and rejects anything else', () => {
  assert.equal(cents('150'), 15000);
  assert.equal(cents('110.01'), 11001);
  assert.equal(cents('110.1'), 11010);
  assert.equal(cents('0'), 0);
  assert.equal(cents(''), null);
  assert.equal(cents('1.234'), null);
  assert.equal(cents('150.'), null);
});

test('the decision price is the per-person ceiling', () => {
  assert.deepEqual(share(44001, 4), { low: 11000, high: 11001 });
  assert.deepEqual(share(56800, 4), { low: 14200, high: 14200 });
  assert.deepEqual(qualify(quotes, 4, 11000), [false, false, false]);
  assert.deepEqual(qualify(quotes, 4, 11001), [true, false, false]);
  assert.deepEqual(qualify(quotes, 4, 14200), [true, true, false]);
});

test('a finished round reveals the tightest budget without the amounts', () => {
  assert.deepEqual(budgetBand(quotes, 4, [true, true, false]), { covered: 14200, blocked: 17900 });
  assert.deepEqual(budgetBand(quotes, 4, [false, false, false]), { covered: 0, blocked: 11001 });
  assert.deepEqual(budgetBand(quotes, 4, [true, true, true]), { covered: 17900, blocked: null });
  assert.equal(budgetBand(quotes, 4, null), null);
  assert.equal(budgetBand(quotes, 4, [true]), null);
});
