import test from 'node:test';
import assert from 'node:assert/strict';
import { splitHandoff } from '../src/ai.js';

test('no marker means no hand-over', () => {
  assert.deepEqual(splitHandoff('Yes, Selyn will always be undetected.'), { text: 'Yes, Selyn will always be undetected.', handoff: false, close: false });
});

test('the marker is hidden and detected', () => {
  assert.deepEqual(splitHandoff("A staff member will take over.\n[CALL STAFF]"), { text: 'A staff member will take over.', handoff: true, close: false });
});

test('marker detection is tolerant of case and spacing', () => {
  assert.equal(splitHandoff('ok [ call  staff ]').handoff, true);
  assert.equal(splitHandoff('ok [Call Staff]').text, 'ok');
});

test('a bare marker leaves empty text', () => {
  assert.deepEqual(splitHandoff('[CALL STAFF]'), { text: '', handoff: true, close: false });
});

import { imageUrls } from '../src/ai.js';

test('imageUrls keeps images only, max 4, skips oversized', () => {
  const a = (name, contentType, size = 1000) => ({ url: `https://cdn/${name}`, name, contentType, size });
  const urls = imageUrls([
    a('a.png', 'image/png'),
    a('b.txt', 'text/plain'),
    a('c.jpg', 'image/jpeg'),
    a('huge.png', 'image/png', 30 * 1024 * 1024),
    a('d.webp', 'image/webp'),
    a('e.gif', 'image/gif'),
    a('f.png', 'image/png'),
    a('g.png', 'image/png'),
  ]);
  assert.deepEqual(urls, ['https://cdn/a.png', 'https://cdn/c.jpg', 'https://cdn/d.webp', 'https://cdn/e.gif']);
  assert.deepEqual(imageUrls([]), []);
  assert.deepEqual(imageUrls([{ url: 'x', contentType: null, size: 1 }]), []);
});

test('close markers are hidden and detected', () => {
  assert.deepEqual(splitHandoff('Glad it works! Bye.\n[ Close ticket ]'), { text: 'Glad it works! Bye.', handoff: false, close: 'plain' });
  assert.deepEqual(splitHandoff('Here is your copy.\n[ Close ticket with transcript ]'), { text: 'Here is your copy.', handoff: false, close: 'transcript' });
  assert.equal(splitHandoff('bye [close ticket]').close, 'plain');
  assert.equal(splitHandoff('bye [ CLOSE  TICKET  WITH  TRANSCRIPT ]').close, 'transcript');
});

test('"with transcript" is not mistaken for a plain close, and closing beats a hand-over', () => {
  assert.equal(splitHandoff('x [ Close ticket with transcript ]').close, 'transcript');
  assert.deepEqual(splitHandoff('x [CALL STAFF] [ Close ticket ]'), { text: 'x', handoff: false, close: 'plain' });
});
