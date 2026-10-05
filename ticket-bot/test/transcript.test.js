import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderTranscript } from '../src/transcript.js';

const names = { user: (id) => ({ '123456789012345678': 'Dj Support' })[id] ?? null, role: () => 'Support', channel: () => 'general' };

test('untrusted text is escaped, never executed', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> "quoted" &amp;');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('bold, italic, underline, strike, inline code and code blocks', () => {
  const html = renderMarkdown('**b** *i* _i2_ __u__ ~~s~~ `c<x>`\n```\nblock <b>\n```');
  assert.ok(html.includes('<strong>b</strong>'));
  assert.equal((html.match(/<em>/g) ?? []).length, 2);
  assert.ok(html.includes('<u>u</u>') && html.includes('<s>s</s>'));
  assert.ok(html.includes('<code class="inline">c&lt;x&gt;</code>'));
  assert.ok(html.includes('<pre><code>block &lt;b&gt;</code></pre>'));
});

test('mentions, channels, roles, links and timestamps resolve', () => {
  const html = renderMarkdown('<@123456789012345678> <@&1> <#2> https://example.com/a_b_c?x=1&y=2. <t:1791224000:t>', names);
  assert.ok(html.includes('@Dj Support'));
  assert.ok(html.includes('@Support') && html.includes('#general'));
  assert.ok(html.includes('href="https://example.com/a_b_c?x=1&amp;y=2"'), 'underscores in a URL must not become italics');
  assert.ok(html.includes('time-chip'));
});

test('headings, subtext, quotes and lists', () => {
  const html = renderMarkdown('# Big\n-# small\n> quote\n- item');
  for (const cls of ['h1', 'subtext', 'quote', 'li']) assert.ok(html.includes(`class="${cls}"`), cls);
});

const meta = { guildName: 'Selyn', channelName: 'ticket-0001-x', number: 1, subject: 'Hi <b>', openedBy: 'Axsl', handler: null, openedAt: 1e12, closedAt: null, closedBy: null };
const a = { id: '1', name: 'Axsl', avatar: null, bot: false, color: '#2ecc71' };
const bot = { id: '2', name: 'Selyn Goon', avatar: null, bot: true, color: null };

test('bot containers render with accent colour, text, separators and buttons', () => {
  const container = {
    type: 17,
    accent_color: 0x7c5cff,
    components: [
      { type: 10, content: '# 🎫 Ticket #0001' },
      { type: 14, divider: true },
      { type: 1, components: [{ type: 2, style: 4, label: 'Close', emoji: { name: '🔒' } }] },
    ],
  };
  const html = renderTranscript({ meta, messages: [{ id: 'm', at: 1e12, author: bot, content: '', attachments: [], embeds: [], components: [container] }] });
  assert.ok(html.includes('border-left-color:#7c5cff'));
  assert.ok(html.includes('class="h1"') && html.includes('class="sep"'));
  assert.ok(html.includes('btn danger') && html.includes('Close'));
  assert.ok(html.includes('APP'));
});

test('messages from the same author close together are grouped; a new day gets a separator', () => {
  const msg = (id, at, author) => ({ id, at, author, content: `m${id}`, attachments: [], embeds: [], components: [] });
  const day = 24 * 3600e3;
  const html = renderTranscript({ meta, messages: [msg('1', 1e12, a), msg('2', 1e12 + 60e3, a), msg('3', 1e12 + 2 * day, a)] });
  assert.equal((html.match(/class="avatar"/g) ?? []).length, 2, 'first message and the next-day message get a header');
  assert.equal((html.match(/class="msg grouped"/g) ?? []).length, 1);
  assert.equal((html.match(/class="day"/g) ?? []).length, 2);
});

test('header fields are escaped and an open ticket says so', () => {
  const html = renderTranscript({ meta, messages: [] });
  assert.ok(html.includes('Hi &lt;b&gt;') && !html.includes('Hi <b>'));
  assert.ok(html.includes('Still open'));
  assert.ok(renderTranscript({ meta: { ...meta, closedAt: 1e12 + 5, closedBy: 'Selyn AI' }, messages: [] }).includes('Selyn AI'));
});

test('attachments: images inline, files as links', () => {
  const html = renderTranscript({
    meta,
    messages: [{ id: '1', at: 1e12, author: a, content: '', embeds: [], components: [], attachments: [{ name: 'p.png', url: 'https://cdn/p.png', type: 'image/png', size: 10 }, { name: 'l.txt', url: 'https://cdn/l.txt', type: 'text/plain', size: 4096 }] }],
  });
  assert.ok(html.includes('<img class="attach-img"') && html.includes('l.txt') && html.includes('4 KB'));
});
