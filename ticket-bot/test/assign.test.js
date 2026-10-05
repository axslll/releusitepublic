import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStaff } from '../src/assign.js';

test('returns null with no staff', () => assert.equal(pickStaff([], []), null));

test('distributes evenly over many tickets', () => {
  const staff = ['a', 'b', 'c'];
  const totals = {};
  const last = {};
  const open = [];
  const got = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 30; i++) {
    const id = pickStaff(staff, open, totals, last);
    got[id]++;
    totals[id] = (totals[id] || 0) + 1;
    last[id] = i;
    open.push({ staffId: id });
  }
  assert.deepEqual(got, { a: 10, b: 10, c: 10 });
});

test('new staff start at the current minimum instead of being flooded', () => {
  const totals = { a: 50, b: 52 };
  const picks = [];
  for (let i = 0; i < 6; i++) {
    const id = pickStaff(['a', 'b', 'new'], [], totals, {});
    totals[id] = (totals[id] ?? 50) + 1;
    picks.push(id);
  }
  const count = (x) => picks.filter((p) => p === x).length;
  assert.ok(count('new') <= 3 && count('a') >= 2);
});

test('ties go to whoever has fewer open tickets', () => {
  const id = pickStaff(['a', 'b'], [{ staffId: 'a' }], { a: 1, b: 1 }, {});
  assert.equal(id, 'b');
});
