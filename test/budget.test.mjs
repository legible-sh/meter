// Pure domain logic: period windows, parsing, validation. No I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fits,
  newTopic,
  nextReset,
  parseAmount,
  parseConfig,
  parseRaise,
  periodKey,
  rollover,
  round6,
  status,
} from '../src/budget.mjs';
import { MAX_NOTE_LENGTH } from '../src/limits.mjs';

const T = Date.parse('2026-07-06T15:30:00Z');
const DAY = 24 * 3600 * 1000;

test('periodKey names the current window', () => {
  assert.equal(periodKey('day', T), '2026-07-06');
  assert.equal(periodKey('month', T), '2026-07');
  assert.equal(periodKey('total', T), 'total');
});

test('nextReset lands on UTC boundaries', () => {
  assert.equal(nextReset('day', T), '2026-07-07T00:00:00.000Z');
  assert.equal(nextReset('month', T), '2026-08-01T00:00:00.000Z');
  assert.equal(nextReset('total', T), null);
  assert.equal(nextReset('month', Date.parse('2026-12-31T23:59:59Z')), '2027-01-01T00:00:00.000Z');
  assert.equal(nextReset('day', Date.parse('2026-12-31T23:59:59Z')), '2027-01-01T00:00:00.000Z');
});

test('rollover resets the counter when the window changes, not before', () => {
  const t = newTopic('x', T);
  t.cap = 10;
  t.spent = 9;
  rollover(t, T + 1000);
  assert.equal(t.spent, 9, 'same day: counter untouched');
  rollover(t, T + DAY);
  assert.equal(t.spent, 0, 'next day: counter reset');
});

test('total period never resets', () => {
  const t = newTopic('x', T);
  t.period = 'total';
  t.periodKey = periodKey('total', T);
  t.spent = 5;
  rollover(t, T + 400 * DAY);
  assert.equal(t.spent, 5);
});

test('fits: cap boundary is inclusive and float-dust tolerant', () => {
  const t = newTopic('x', T);
  t.cap = 0.3;
  t.spent = 0.1;
  assert.equal(fits(t, 0.2, T), true, '0.1 + 0.2 fits a 0.3 cap despite float dust');
  assert.equal(fits(t, 0.21, T), false);
  t.cap = null;
  assert.equal(fits(t, 1e9, T), true, 'no cap: everything fits');
});

test('status shape', () => {
  const t = newTopic('ops', T);
  t.cap = 50;
  t.unit = 'usd';
  t.spent = 12.5;
  assert.deepEqual(status(t, T), {
    topic: 'ops',
    spent: 12.5,
    cap: 50,
    remaining: 37.5,
    unit: 'usd',
    period: 'day',
    resets: '2026-07-07T00:00:00.000Z',
  });
  t.cap = null;
  assert.equal(status(t, T).remaining, null);
});

test('parseAmount accepts a bare number, a JSON number, and {amount, note}', () => {
  assert.deepEqual(parseAmount('2.50'), { amount: 2.5, note: null });
  assert.deepEqual(parseAmount(' 3 '), { amount: 3, note: null });
  assert.deepEqual(parseAmount('0.000001'), { amount: 0.000001, note: null });
  assert.deepEqual(parseAmount('7'), { amount: 7, note: null });
  assert.deepEqual(parseAmount('{"amount": 1.25, "note": "embedding batch"}'), {
    amount: 1.25,
    note: 'embedding batch',
  });
  assert.deepEqual(parseAmount('{"amount": 4}'), { amount: 4, note: null });
});

test('parseAmount rejects garbage, zero, negatives, and the too-large', () => {
  for (const bad of ['', '   ', 'abc', '0', '-1', 'Infinity', 'NaN', '1e13', '[1]', '"5"', '{"amount": "5"}', '{"note":"x"}']) {
    assert.throws(() => parseAmount(bad), /amount|body/, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('parseAmount truncates long notes and rejects non-string notes', () => {
  const long = 'x'.repeat(MAX_NOTE_LENGTH + 100);
  assert.equal(parseAmount(JSON.stringify({ amount: 1, note: long })).note.length, MAX_NOTE_LENGTH);
  assert.throws(() => parseAmount('{"amount": 1, "note": 42}'), /note must be a string/);
});

test('parseConfig validates cap, period, unit; supports partial updates', () => {
  assert.deepEqual(parseConfig({ cap: '50', period: 'day', unit: 'usd' }), { cap: 50, period: 'day', unit: 'usd' });
  assert.deepEqual(parseConfig({ cap: 0 }), { cap: 0 }, 'cap 0 is a valid kill switch');
  assert.deepEqual(parseConfig({ cap: null }), { cap: null }, 'JSON null clears the cap');
  assert.deepEqual(parseConfig({ cap: 'none' }), { cap: null }, 'query-param "none" clears the cap');
  assert.deepEqual(parseConfig({ period: 'month' }), { period: 'month' });
  assert.throws(() => parseConfig({ period: 'week' }), /period must be one of/);
  assert.throws(() => parseConfig({ cap: -1 }), /cap must be/);
  assert.throws(() => parseConfig({ cap: 'abc' }), /cap must be/);
  assert.throws(() => parseConfig({ unit: 'has space' }), /unit must be/);
  assert.throws(() => parseConfig({ unit: 'x'.repeat(30) }), /unit must be/);
  assert.throws(() => parseConfig({}), /nothing to set/);
});

test('parseRaise: by adds, to sets, and the edges hold', () => {
  assert.equal(parseRaise({ by: 10 }, 50), 60);
  assert.equal(parseRaise({ by: '2.5' }, 10), 12.5);
  assert.equal(parseRaise({ to: 100 }, 50), 100);
  assert.equal(parseRaise({ to: 100 }, null), 100, 'to can set a first cap');
  assert.equal(parseRaise({ to: 20 }, 50), 20, 'to may also lower — it just sets the cap');
  assert.throws(() => parseRaise({ by: 10 }, null), /no cap set/);
  assert.throws(() => parseRaise({ by: -5 }, 50), /positive/);
  assert.throws(() => parseRaise({ by: 1, to: 2 }, 50), /not both/);
  assert.throws(() => parseRaise({}, 50), /provide/);
  assert.throws(() => parseRaise({ to: 'abc' }, 50), /"to" must be/);
});

test('round6 kills float dust', () => {
  assert.equal(round6(0.1 + 0.2), 0.3);
  assert.equal(round6(49.999999994), 50);
});
