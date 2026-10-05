import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStaff } from '../src/assign.js';

test('returns null with no staff', () => assert.equal(pickStaff([], []), null));

test('distributes evenly over many tickets', () => {
  const staff = ['a', 'b', 'c'];
  const totals = {};
  const open = [];
  const got = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 30; i++) {
    const id = pickStaff(staff, open, totals);
    got[id]++;
    totals[id] = (totals[id] || 0) + 1;
    open.push({ staffId: id });
  }
  assert.deepEqual(got, { a: 10, b: 10, c: 10 });
});

test('the first offer is random, not always the same person', () => {
  const staff = ['a', 'b', 'c', 'd', 'e'];
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickStaff(staff, [], {}));
  assert.equal(seen.size, staff.length);
});

test('random only breaks ties: someone with fewer tickets always wins', () => {
  for (let i = 0; i < 50; i++) assert.equal(pickStaff(['a', 'b', 'c'], [], { a: 3, b: 1, c: 3 }), 'b');
});

test('new staff start at the current minimum instead of being flooded', () => {
  const totals = { a: 50, b: 52 };
  const picks = [];
  for (let i = 0; i < 6; i++) {
    const id = pickStaff(['a', 'b', 'new'], [], totals);
    totals[id] = (totals[id] ?? 50) + 1;
    picks.push(id);
  }
  const count = (x) => picks.filter((p) => p === x).length;
  assert.ok(count('new') <= 3 && count('a') >= 2);
});

test('ties go to whoever has fewer open tickets', () => {
  for (let i = 0; i < 50; i++) assert.equal(pickStaff(['a', 'b'], [{ staffId: 'a' }], { a: 1, b: 1 }), 'b');
});

test('skips staff who already declined this ticket', () => {
  assert.equal(pickStaff(['a', 'b'], [], { a: 0, b: 5 }, ['a']), 'b');
});

test('returns null once everyone has been offered the ticket', () => {
  assert.equal(pickStaff(['a', 'b'], [], {}, ['a', 'b']), null);
});

test('pending offers count so simultaneous tickets go to different people', () => {
  const tickets = [{ staffId: null, offer: { staffId: 'a' } }];
  for (let i = 0; i < 50; i++) assert.equal(pickStaff(['a', 'b'], tickets, { a: 0, b: 0 }), 'b');
});
