import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

// Test mode is saved to disk, so run in a throw-away folder.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'pingtest-')));
const { extractMentions, findProtectedPings, handleProtectedPing, resetPingCooldowns } = await import('../src/antiping.js');
const { setTestMode } = await import('../src/testmode.js');
const { store } = await import('../src/store.js');

const OWNER = '880060587697123370'; // protected user
const ROLE_A = '1556917397280260167'; // protected roles
const ROLE_B = '1556917485733941280';
const PINGER = '111111111111111111';
const HOLDER = '222222222222222222'; // holds a protected role
const PLAIN = '333333333333333333';

console.log = () => {};

const role = (id, name) => ({ id, name });
const mkMember = (id, name, roles = [], extra = {}) => ({
  id, displayName: name, moderatable: true, user: { id, tag: `${name}#1`, bot: false },
  roles: { cache: new Collection(roles.map((r) => [r.id, r])) },
  timeout: async function (ms) { this.timedOutFor = ms; }, ...extra,
});

function world() {
  resetPingCooldowns();
  const roleA = role(ROLE_A, 'Owner');
  const roleB = role(ROLE_B, 'Developer');
  const owner = mkMember(OWNER, 'Axsl', [roleA]);
  const holder = mkMember(HOLDER, 'Samir', [roleB]);
  const plain = mkMember(PLAIN, 'Bob');
  const pinger = mkMember(PINGER, 'Annoying');
  const botMember = mkMember('444444444444444444', 'SomeBot', [roleB]); botMember.user.bot = true;
  roleA.members = new Collection([[OWNER, owner]]);
  roleB.members = new Collection([[HOLDER, holder], [botMember.id, botMember], [PINGER, pinger]]);
  const members = new Collection([owner, holder, plain, pinger, botMember].map((m) => [m.id, m]));
  const guild = { members: { cache: members, fetch: async (id) => members.get(id) }, roles: { cache: new Collection([[ROLE_A, roleA], [ROLE_B, roleB]]) } };
  const dms = []; const posts = []; const deleted = [];
  const mkUser = (m) => ({ id: m.id, tag: m.user.tag, send: async (msg) => dms.push({ to: m.displayName, msg }) });
  const client = { users: { cache: new Map(), fetch: async (id) => mkUser(members.get(id)) } };
  const channel = { id: '555', name: 'general', send: async (msg) => posts.push(msg) };
  const send = (content, authorMember = pinger) => {
    const message = { guild, client, channel, content, webhookId: null, member: authorMember,
      author: { id: authorMember.id, tag: authorMember.user.tag, bot: false, username: authorMember.displayName, send: async (msg) => dms.push({ to: authorMember.displayName + ' (pinger)', msg }) },
      delete: async () => deleted.push(content) };
    return message;
  };
  const text = (m) => JSON.stringify((m.components ?? m.msg?.components).map((c) => c.toJSON()));
  return { guild, members, pinger, owner, holder, plain, dms, posts, deleted, send, text };
}

test('extractMentions: dedupes, handles nicknames, ignores code and reply-only pings', () => {
  assert.deepEqual(extractMentions(`<@${OWNER}> <@!${OWNER}> <@&${ROLE_A}>`), { userIds: [OWNER], roleIds: [ROLE_A] });
  assert.deepEqual(extractMentions(`\`<@${OWNER}>\` and \`\`\`<@&${ROLE_A}>\`\`\``), { userIds: [], roleIds: [] });
  assert.deepEqual(extractMentions('no mentions here'), { userIds: [], roleIds: [] });
});

test('findProtectedPings: protected user, holder of a protected role, protected role; not plain members or self', async () => {
  const w = world();
  const r = await findProtectedPings(w.guild, `<@${OWNER}> <@${HOLDER}> <@${PLAIN}> <@&${ROLE_B}> <@&999>`, PINGER);
  assert.deepEqual([...r.users.keys()].sort(), [OWNER, HOLDER].sort());
  assert.deepEqual(r.users.get(HOLDER).roles, ['Developer']);
  assert.deepEqual(r.roles, [ROLE_B]);
  assert.equal((await findProtectedPings(w.guild, `<@${OWNER}>`, OWNER)).users.size, 0, 'pinging yourself is fine');
});

test('pinging the protected user: deletes, times out 5 min, replies, DMs the pinged person and the pinger', async () => {
  const w = world();
  assert.equal(await handleProtectedPing(w.send(`hey <@${OWNER}> help me`)), true);
  assert.deepEqual(w.deleted, [`hey <@${OWNER}> help me`]);
  assert.equal(w.pinger.timedOutFor, 5 * 60 * 1000);
  const reply = w.posts[0];
  assert.deepEqual(reply.allowedMentions.users, [PINGER], 'the reply may only ping the pinger, never re-ping the protected user');
  assert.ok(w.text(reply).includes("please don't ping") && w.text(reply).includes('open a ticket') && w.text(reply).includes('timed out for 5 minutes'));
  const toOwner = w.dms.find((d) => d.to === 'Axsl');
  assert.ok(w.text(toOwner).includes('Sorry about that') && w.text(toOwner).includes('Annoying') && w.text(toOwner).includes('deleted their message and timed them out for 5 minutes'));
  assert.ok(w.dms.some((d) => d.to === 'Annoying (pinger)'));
});

test('pinging someone who HOLDS a protected role counts', async () => {
  const w = world();
  assert.equal(await handleProtectedPing(w.send(`<@${HOLDER}> yo`)), true);
  assert.equal(w.deleted.length, 1);
  assert.equal(w.pinger.timedOutFor, 300000);
  const toHolder = w.dms.find((d) => d.to === 'Samir');
  assert.ok(toHolder && w.text(toHolder).includes('@Developer'));
});

test('pinging a protected role DMs its members (not bots, not the pinger)', async () => {
  const w = world();
  assert.equal(await handleProtectedPing(w.send(`<@&${ROLE_B}> hello`)), true);
  const recipients = w.dms.map((d) => d.to).filter((n) => !n.includes('(pinger)'));
  assert.deepEqual(recipients, ['Samir']);
});

test('normal pings, pings in code blocks and members of protected roles pinging are ignored', async () => {
  let w = world();
  assert.equal(await handleProtectedPing(w.send(`<@${PLAIN}> hi`)), false);
  assert.equal(await handleProtectedPing(w.send('`<@' + OWNER + '>` in code')), false);
  assert.equal(await handleProtectedPing(w.send(`<@${OWNER}> from a dev`, w.holder)), false, 'members of a protected role may ping');
  assert.equal(await handleProtectedPing(w.send(`<@${OWNER}> from the owner`, w.owner)), false);
  assert.equal(w.deleted.length, 0);
});

test('if the timeout is not possible the message says nothing about one', async () => {
  const w = world();
  w.pinger.moderatable = false;
  assert.equal(await handleProtectedPing(w.send(`<@${OWNER}> hi`)), true);
  assert.equal(w.deleted.length, 1);
  assert.equal(w.pinger.timedOutFor, undefined);
  assert.ok(!w.text(w.posts[0]).includes('timed out'));
  assert.ok(!w.text(w.dms.find((d) => d.to === 'Axsl')).includes('timed them out'));
});

test('the same person is not DMed again for the same pinger within 5 minutes', async () => {
  const w = world();
  await handleProtectedPing(w.send(`<@${OWNER}> one`));
  await handleProtectedPing(w.send(`<@${OWNER}> two`));
  assert.equal(w.dms.filter((d) => d.to === 'Axsl').length, 1);
  assert.equal(w.deleted.length, 2, 'but every message is still deleted');
});

test('test mode: protected users and role holders are checked too, and it expires by itself', async () => {
  const w = world();
  const owner = w.owner; // a protected person pinging another protected person
  assert.equal(await handleProtectedPing(w.send(`<@${HOLDER}> hi`, owner)), false, 'normally exempt');
  setTestMode(true);
  assert.equal(await handleProtectedPing(w.send(`<@${HOLDER}> hi`, owner)), true, 'test mode checks them');
  store.setSetting('testModeUntil', Date.now() - 1000); // 30 minutes are up
  assert.equal(await handleProtectedPing(w.send(`<@${HOLDER}> hi again`, owner)), false, 'back to normal');
  setTestMode(false);
});
