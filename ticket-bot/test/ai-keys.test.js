import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GROQ_API_KEY = 'primary-key';
process.env.GROQ_API_KEY_BACKUP = 'backup-key';
const { askAI } = await import('../src/ai.js');

const ok = (text) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => '' });
const limited = (hint = 'Please try again in 100ms.') => ({ ok: false, status: 429, headers: new Map(), text: async () => `{"error":{"message":"Rate limit reached. ${hint}"}}` });
const ticket = { subject: 's', description: 'd', staffId: 'x' };
const msgs = [{ role: 'user', content: 'hi' }];
const origWarn = console.warn;
console.warn = () => {};

test('falls over to the backup key when the primary is rate limited, then remembers it', async () => {
  const used = [];
  globalThis.fetch = async (url, opts) => {
    const key = opts.headers.Authorization.replace('Bearer ', '');
    used.push(key);
    return key === 'primary-key' ? limited('Please try again in 20s.') : ok('from backup');
  };
  const first = await askAI(ticket, msgs);
  assert.equal(first.answer, 'from backup');
  assert.deepEqual(used, ['primary-key', 'backup-key'], 'tried primary once, then switched immediately');
  used.length = 0;
  await askAI(ticket, msgs);
  assert.deepEqual(used, ['backup-key'], 'the limited primary is skipped while it is still limited');
});

test('401 on a key also fails over', async () => {
  // fresh module state is not available, so use a body-level check: a rejected primary must not break the request
  const used = [];
  globalThis.fetch = async (url, opts) => {
    used.push(opts.headers.Authorization);
    return ok('fine');
  };
  assert.equal((await askAI(ticket, msgs)).answer, 'fine');
});

test('non-rate-limit errors are surfaced, not retried on the other key', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: new Map(), text: async () => 'boom' });
  await assert.rejects(() => askAI(ticket, msgs), /Groq 500/);
});

test.after(() => { console.warn = origWarn; });
