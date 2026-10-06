import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { cleanText, decide, deLeet, handleModeration, _setClassifier } from '../src/moderation.js';

console.log = () => {};

// Real toxic-bert scores measured for these messages (identity_hate, insult, obscene).
const REAL = [
  // [message, hate, insult, obscene, should be deleted]
  ['fucking hell i forgot to do this', 0.00, 0.18, 0.98, false],
  ['what the fuck is this shit', 0.00, 0.34, 0.99, false],
  ['this is bullshit', 0.00, 0.12, 0.94, false],
  ['damn it still fails', 0.00, 0.04, 0.78, false],
  ['holy shit it works', 0.00, 0.08, 0.93, false],
  ['you are dumb', 0.02, 0.94, 0.52, false],
  ['you are an idiot', 0.01, 0.96, 0.76, false],
  ['what a stupid question, are you dumb', 0.01, 0.94, 0.76, false],
  ['stupid bot', 0.00, 0.88, 0.75, false],
  ['shut up nobody asked you', 0.00, 0.13, 0.05, false],
  ['i am a muslim and i need help', 0.00, 0.00, 0.00, false],
  ['fuck you', 0.02, 0.95, 0.99, true],
  ['fuck off', 0.01, 0.55, 0.99, true],
  ['shut the fuck up', 0.01, 0.58, 0.98, true],
  ['you piece of shit', 0.01, 0.95, 0.97, true],
  ['you are a fucking idiot', 0.02, 0.98, 0.98, true],
  ['slur + insult', 0.94, 0.97, 0.95, true],
  ['slur alone', 0.90, 0.69, 0.57, true],
  ['i hate black people', 0.78, 0.20, 0.15, true],
  ['all muslims are terrorists', 0.75, 0.27, 0.10, true],
  ['go back where you came from you filthy immigrants', 0.61, 0.68, 0.26, true],
];

test('decide(): matches the real model scores - vents and mild insults pass, racism and aimed abuse are deleted', () => {
  for (const [msg, hate, insult, obscene, expected] of REAL) {
    const v = decide({ identity_hate: hate, insult, obscene });
    assert.equal(v.delete, expected, `"${msg}"`);
  }
});

test('decide(): reasons, and missing scores never delete', () => {
  assert.equal(decide({ identity_hate: 0.9, insult: 0, obscene: 0 }).reason, 'hate');
  assert.equal(decide({ identity_hate: 0, insult: 0.9, obscene: 0.99 }).reason, 'abuse');
  assert.deepEqual(decide({}), { delete: false, reason: null });
});

test('decide(): thresholds are adjustable', () => {
  const s = { identity_hate: 0.6, insult: 0.3, obscene: 0.3 };
  assert.equal(decide(s, { hate: 0.5, insult: 0.5, obscene: 0.9 }).delete, true);
  assert.equal(decide(s, { hate: 0.7, insult: 0.5, obscene: 0.9 }).delete, false);
});

test('cleanText: drops links, mentions, emoji and code; ignores messages with no real words', () => {
  assert.equal(cleanText('hey <@123456789012345678> look https://x.com/a <:emoji:123> ok'), 'hey look ok');
  assert.equal(cleanText('```\nfuck you\n``` thanks'), 'thanks');
  assert.equal(cleanText('😂😂😂'), '');
  assert.equal(cleanText('ok'), '');
  assert.equal(cleanText('x'.repeat(1000)).length, 400);
});

// ---- the handler, with a fake classifier ----
const labels = (hate, insult, obscene) => [
  { label: 'identity_hate', score: hate }, { label: 'insult', score: insult }, { label: 'obscene', score: obscene }, { label: 'toxic', score: 1 },
];
function world(overrides = {}) {
  const dms = []; const logPosts = []; const deleted = [];
  const member = { id: '1', moderatable: true, displayName: 'Bob', roles: { cache: new Collection() }, timeout: async function (ms) { this.timedOutFor = ms; }, ...overrides };
  const message = (content) => ({
    content, guild: { name: 'Selyn', members: { fetch: async () => member }, channels: { fetch: async () => ({ isTextBased: () => true, send: async (m) => logPosts.push(m) }) } },
    channel: { id: '9', name: 'general' }, webhookId: null, member,
    author: { id: '1', tag: 'Bob#1', bot: false, send: async (m) => dms.push(m) },
    delete: async () => deleted.push(content),
  });
  return { member, message, dms, logPosts, deleted };
}
const text = (m) => JSON.stringify(m.components.map((c) => c.toJSON()));

test('a flagged message is deleted and the user is told why', async () => {
  const w = world();
  _setClassifier(async () => labels(0.01, 0.95, 0.99));
  assert.equal(await handleModeration(w.message('fuck you')), true);
  assert.deepEqual(w.deleted, ['fuck you']);
  assert.ok(text(w.dms[0]).includes('strong profanity aimed at another person'));
});

test('venting and mild insults are left alone', async () => {
  const w = world();
  _setClassifier(async () => labels(0, 0.18, 0.98));
  assert.equal(await handleModeration(w.message('fucking hell i forgot to do this')), false);
  _setClassifier(async () => labels(0.01, 0.94, 0.52));
  assert.equal(await handleModeration(w.message('you are dumb')), false);
  assert.equal(w.deleted.length, 0);
});

test('hate speech is deleted with the hate reason', async () => {
  const w = world();
  _setClassifier(async () => labels(0.8, 0.2, 0.1));
  assert.equal(await handleModeration(w.message('some hateful sentence')), true);
  assert.ok(text(w.dms[0]).includes('hateful or discriminatory'));
});

test('exempt members, bots and empty messages are never checked', async () => {
  const w = world({ id: '880060587697123370' }); // a protected user
  let calls = 0;
  _setClassifier(async () => { calls++; return labels(1, 1, 1); });
  assert.equal(await handleModeration(w.message('fuck you')), false);
  const w2 = world();
  const bot = w2.message('fuck you'); bot.author.bot = true;
  assert.equal(await handleModeration(bot), false);
  assert.equal(await handleModeration(w2.message('😂😂😂')), false);
  assert.equal(calls, 0);
});

test('if the model fails or is unavailable, messages are let through', async () => {
  const w = world();
  _setClassifier(async () => { throw new Error('boom'); });
  assert.equal(await handleModeration(w.message('fuck you')), false);
  _setClassifier(null);
  assert.equal(await handleModeration(w.message('fuck you')), false);
  assert.equal(w.deleted.length, 0);
});

test('deLeet: undoes disguised spellings, leaves normal text and numbers alone', () => {
  assert.equal(deLeet('sh1t f4ck n1gg3r'), 'shit fack nigger');
  assert.equal(deLeet('you $uck'), 'you suck');
  assert.equal(deLeet('version 1.3 costs 100'), 'version 1.3 costs 100');
  assert.equal(deLeet('hello world'), 'hello world');
});

test('a disguised message is scored in both forms and the higher score wins', async () => {
  const w = world();
  // fake model: only flags the plain spelling
  _setClassifier(async (t) => (t.includes('shit') ? labels(0, 0.95, 0.99) : labels(0, 0.05, 0.05)));
  assert.equal(await handleModeration(w.message('you piece of sh1t')), true);
  assert.equal(await handleModeration(w.message('version 1.3 works')), false);
});
