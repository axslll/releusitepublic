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
