import test from 'node:test';
import assert from 'node:assert/strict';
import { splitHandoff } from '../src/ai.js';

test('no marker means no hand-over', () => {
  assert.deepEqual(splitHandoff('Yes, Selyn will always be undetected.'), { text: 'Yes, Selyn will always be undetected.', handoff: false });
});

test('the marker is hidden and detected', () => {
  assert.deepEqual(splitHandoff("A staff member will take over.\n[CALL STAFF]"), { text: 'A staff member will take over.', handoff: true });
});

test('marker detection is tolerant of case and spacing', () => {
  assert.equal(splitHandoff('ok [ call  staff ]').handoff, true);
  assert.equal(splitHandoff('ok [Call Staff]').text, 'ok');
});

test('a bare marker leaves empty text', () => {
  assert.deepEqual(splitHandoff('[CALL STAFF]'), { text: '', handoff: true });
});
