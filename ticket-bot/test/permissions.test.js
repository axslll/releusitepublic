import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

// Tickets are saved to disk, so run in a throw-away folder.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'permtest-')));
const T = await import('../src/tickets.js');
const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const { logTeams } = await import('../src/startup.js');
console.log = () => {};

const ADMIN = 'Administrator';
const OPENER = '111111111111111111';
const STRANGER = '222222222222222222';
const STAFF = '333333333333333333';
const OTHER_STAFF = '444444444444444444';

const memberWith = (roleIds = [], admin = false) => ({ roles: { cache: new Collection(roleIds.map((id) => [id, {}])) }, permissions: { has: (p) => admin && p === 8n }, });
const people = {
  stranger: { id: STRANGER, tag: 'Stranger#1', member: memberWith([]) },
  opener: { id: OPENER, tag: 'Opener#1', member: memberWith([]) },
  staff: { id: STAFF, tag: 'Staff#1', member: memberWith([config.supportRoleId]) },
  admin: { id: '555555555555555555', tag: 'Admin#1', member: memberWith([], true) },
  modOnly: { id: '666666666666666666', tag: 'Mod#1', member: memberWith([config.moderationCommandRoleId]) },
};

function setup() {
  const t = store.create({ guildId: 'g', userId: OPENER, subject: 's', description: 'd' });
  const sent = [];
  const channel = { id: 'c' + t.number, name: 'ticket', send: async (m) => sent.push(m), delete: async () => {}, messages: { fetch: async () => null }, permissionOverwrites: { edit: async () => {} } };
  store.update(t, { channelId: channel.id, messageId: 'm', staffCalled: true, ai: true });
  return { t, channel, sent };
}
// a fake button / select / command interaction made by one of the people above
function click(who, customId, { channel, extra = {} } = {}) {
  const out = { replies: [], updates: [], deferred: 0 };
  const text = (m) => JSON.stringify(m.components.map((c) => c.toJSON()));
  return {
    out,
    i: {
      customId, user: { id: who.id, tag: who.tag }, member: who.member, memberPermissions: { has: (p) => who.member.permissions.has(p) },
      channelId: channel?.id, channel, guild: { id: 'g', name: 'G', members: { fetch: async () => null, cache: new Map() }, roles: { fetch: async () => null, cache: new Map() } },
      client: { users: { fetch: async () => ({ send: async () => {} }), cache: new Map() }, guilds: { cache: new Map() } },
      options: { getChannel: () => null }, values: [],
      reply: async (m) => out.replies.push(text(m)), update: async (m) => out.updates.push(text(m)),
      deferUpdate: async () => { out.deferred++; }, deferReply: async () => { out.deferred++; }, editReply: async () => {},
      ...extra,
    },
  };
}
const refused = (out) => out.replies.concat(out.updates).some((r) => /Only|only|no longer available|need/.test(r));

test('/ticketpanel: administrators only', async () => {
  for (const who of [people.stranger, people.staff, people.modOnly]) {
    const { sent, channel } = setup();
    const { i, out } = click(who, null, { channel, extra: { options: { getChannel: () => channel } } });
    await T.handleTicketPanelCommand(i);
    assert.equal(sent.length, 0, `${who.tag} must not be able to post the panel`);
    assert.ok(refused(out), `${who.tag} gets a refusal`);
  }
  const { sent, channel } = setup();
  const { i } = click(people.admin, null, { channel, extra: { options: { getChannel: () => channel } } });
  await T.handleTicketPanelCommand(i);
  assert.equal(sent.length, 1, 'an administrator can');
});

test('/staffpanel and /ticketstats: support staff (or admins) only', async () => {
  for (const handler of [T.handleStaffPanel, T.handleStats]) {
    for (const who of [people.stranger, people.opener, people.modOnly]) {
      const { channel } = setup();
      const { i, out } = click(who, null, { channel });
      await handler(i);
      assert.ok(refused(out), `${who.tag} must be refused by ${handler.name}`);
    }
  }
  const { channel } = setup();
  const { i, out } = click(people.staff, null, { channel });
  await T.handleStaffPanel(i);
  assert.ok(out.replies.join('').includes('Staff controls'), 'staff can open the panel');
});

test('staff-only buttons refuse strangers AND the ticket opener, and change nothing', async () => {
  const staffOnly = ['ticket:claim', 'ticket:ai', 'ticket:add', 'ticket:transcript'];
  for (const who of [people.stranger, people.opener, people.modOnly]) {
    for (const id of staffOnly) {
      const { t, channel } = setup();
      const { i, out } = click(who, id, { channel });
      await T.handleTicketButton(i);
      assert.ok(refused(out), `${who.tag} pressing ${id} must be refused`);
      assert.equal(t.staffId, null, `${id} must not assign the ticket`);
      assert.equal(t.ai, true, `${id} must not change the AI`);
      assert.ok(store.byChannel(channel.id), `${id} must not close the ticket`);
    }
  }
});

test('closing: only the opener or staff - a stranger cannot, even with the confirm buttons', async () => {
  for (const id of ['ticket:close', 'ticket:close:yes', 'ticket:close:transcript']) {
    const { channel } = setup();
    const { i, out } = click(people.stranger, id, { channel });
    await T.handleTicketButton(i);
    assert.ok(refused(out), `a stranger pressing ${id} must be refused`);
    assert.ok(store.byChannel(channel.id), 'the ticket is still open');
  }
  const { channel } = setup();
  const { i, out } = click(people.opener, 'ticket:close', { channel });
  await T.handleTicketButton(i);
  assert.ok(out.replies.join('').includes('Close this ticket'), 'the opener may start closing');
});

test('"Talk to a human" is for the opener / staff only', async () => {
  const { t, channel } = setup();
  store.update(t, { staffCalled: false });
  const { i, out } = click(people.stranger, 'ticket:human', { channel });
  await T.handleTicketButton(i);
  assert.ok(refused(out));
  assert.equal(t.staffCalled, false, 'staff must not be called by a stranger');
});

test('calling extra staff via the select menu is staff-only', async () => {
  const { t, channel } = setup();
  const { i, out } = click(people.stranger, 'ticket:addselect', { channel, extra: { values: [OTHER_STAFF] } });
  await T.handleStaffSelect(i);
  assert.ok(refused(out));
  assert.deepEqual(t.helpers, []);
});

test('a ticket offer can only be accepted or skipped by the person it was sent to', async () => {
  const { t } = setup();
  store.update(t, { offer: { staffId: STAFF, expiresAt: Date.now() + 60_000, dmChannelId: null, dmMessageId: null } });
  for (const action of ['accept', 'skip']) {
    const { i, out } = click(people.stranger, `offer:${action}:${t.number}`, {});
    await T.handleOffer(i);
    assert.ok(refused(out), `a stranger cannot ${action}`);
    assert.equal(t.staffId, null);
    assert.equal(t.offer?.staffId, STAFF, 'the offer is untouched');
  }
});

test('startup log lists the support team and the /moderation role', async () => {
  const lines = [];
  const original = console.log;
  console.log = (l) => lines.push(l);
  const member = (id, name, bot = false) => ({ id, user: { tag: `${name}#1`, bot } });
  const roles = new Map([
    [config.supportRoleId, { name: 'Support', members: new Collection([['1', member('1', 'Ann')], ['2', member('2', 'Bob')], ['3', member('3', 'Robot', true)]]) }],
    [config.moderationCommandRoleId, { name: 'Mods', members: new Collection() }],
  ]);
  const guild = { id: 'g', name: 'Selyn', roles: { fetch: async (id) => roles.get(id) ?? null } };
  try { await logTeams({ guilds: { cache: new Map([['g', guild]]) } }); } finally { console.log = original; }
  const log = lines.join('\n');
  assert.ok(log.includes('Ticket support team') && log.includes('2 members') && log.includes('Ann#1 (1)') && log.includes('Bob#1 (2)'));
  assert.ok(!log.includes('Robot#1'), 'bots are not listed');
  assert.ok(log.includes('NO members'), 'an empty role is called out');
});

test('anyone can still open a ticket from the panel button - one at a time', async () => {
  const fresh = { id: '777777777777777777', tag: 'Newcomer#1', member: memberWith([]) }; // has no ticket yet
  for (const who of [people.stranger, fresh, people.modOnly]) {
    let shown = null;
    const { i } = click(who, 'ticket:open', { extra: { showModal: async (m) => { shown = m; } } });
    await T.handleOpenButton(i);
    assert.ok(shown, `${who.tag} (no staff role, no admin) gets the ticket form`);
  }
  // someone who already has an open ticket is pointed to it instead of getting a second one
  const { t } = setup();
  store.update(t, { userId: people.stranger.id });
  let shown = null;
  const { i, out } = click(people.stranger, 'ticket:open', { extra: { showModal: async (m) => { shown = m; } } });
  await T.handleOpenButton(i);
  assert.equal(shown, null, 'no second form while they have an open ticket');
  assert.ok(out.replies.join('').includes('already have an open ticket'));
});
