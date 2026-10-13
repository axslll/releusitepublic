import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';

// Giveaways are saved to disk, so run in a throw-away folder.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'giveawaytest-')));
const G = await import('../src/giveaway.js');
const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const { giveawayMessage } = await import('../src/ui.js');
console.log = () => {};

const HOST = '111111111111111111';
const text = (m) => JSON.stringify(m.components.map((c) => c.toJSON()));

/* ---------------- duration + winners ---------------- */

test('parseDuration understands the usual ways of writing a duration', () => {
  const MIN = 60_000, H = 3_600_000, D = 86_400_000;
  assert.equal(G.parseDuration('30m'), 30 * MIN);
  assert.equal(G.parseDuration('2h'), 2 * H);
  assert.equal(G.parseDuration('1d'), D);
  assert.equal(G.parseDuration('1w'), 7 * D);
  assert.equal(G.parseDuration('1d12h'), D + 12 * H);
  assert.equal(G.parseDuration('1d 12h'), D + 12 * H);
  assert.equal(G.parseDuration('1 day, 12 hours'), D + 12 * H);
  assert.equal(G.parseDuration('90 minutes'), 90 * MIN);
  assert.equal(G.parseDuration('1 hour and 30 minutes'), 90 * MIN);
  assert.equal(G.parseDuration('2H'), 2 * H, 'case does not matter');
  assert.equal(G.parseDuration('1.5h'), 90 * MIN);
});

test('parseDuration rejects anything it cannot fully understand', () => {
  for (const bad of ['', '   ', 'soon', '30', 'h', '2 parsecs', '1d banana', '-5m', 'tomorrow']) assert.equal(G.parseDuration(bad), null, JSON.stringify(bad));
});

test('formatDuration', () => {
  assert.equal(G.formatDuration(129_600_000), '1 day 12 hours');
  assert.equal(G.formatDuration(60_000), '1 minute');
  assert.equal(G.formatDuration(3_660_000), '1 hour 1 minute');
});

test('pickWinners: distinct, never more than asked, only real entrants', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'a', 'a'];
  for (let i = 0; i < 100; i++) {
    const w = G.pickWinners(entries, 3);
    assert.equal(w.length, 3);
    assert.equal(new Set(w).size, 3, 'no duplicates (a entered several times still only counts once)');
    for (const x of w) assert.ok(['a', 'b', 'c', 'd', 'e'].includes(x));
  }
  assert.deepEqual(G.pickWinners(['a', 'b'], 5).sort(), ['a', 'b'], 'fewer entries than winners: everyone wins');
  assert.deepEqual(G.pickWinners([], 3), []);
});

test('pickWinners is fair: every entrant wins about equally often', () => {
  const wins = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < 4000; i++) wins[G.pickWinners(['a', 'b', 'c', 'd'], 1)[0]]++;
  for (const [who, n] of Object.entries(wins)) assert.ok(n > 800 && n < 1200, `${who} won ${n} of 4000`);
});

/* ---------------- fakes ---------------- */

function world({ roles = [config.giveawayRoleId] } = {}) {
  const posts = []; const edits = []; const replies = []; const edited = [];
  const channel = {
    id: '900', name: 'giveaways', type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async (m) => { posts.push(m); return { id: 'msg' + posts.length }; },
    messages: { fetch: async () => ({ id: 'msg1', edit: async (m) => edits.push(m) }) },
  };
  const members = new Map(); // id -> { user: { bot } } ; anyone missing has "left the server"
  const guild = { id: 'g', members: { me: {}, fetch: async (id) => { if (!members.has(id)) throw new Error('Unknown Member'); return members.get(id); } } };
  const client = { guilds: { cache: new Map([['g', guild]]) }, channels: { fetch: async () => channel } };
  const inGuild = (...ids) => ids.forEach((id) => members.set(id, { user: { bot: false } }));
  const opts = { title: 'Nitro', description: 'A month of Nitro', duration: '1h', winners: 2, channel };
  const interaction = (over = {}) => {
    const o = { ...opts, ...over };
    return {
      user: { id: HOST, tag: 'Host#1' }, guild, client,
      member: { roles: { cache: new Collection(roles.map((r) => [r, {}])) } },
      options: { getString: (n) => o[n], getInteger: (n) => o[n], getChannel: () => o.channel },
      deferReply: async () => {}, editReply: async (m) => replies.push(text(m)), reply: async (m) => replies.push(text(m)),
    };
  };
  return { channel, guild, client, inGuild, interaction, posts, edits, replies, members };
}
const press = (w, id, userId, bot = false) => {
  const out = [];
  return { out, i: { customId: `giveaway:enter:${id}`, user: { id: userId, bot }, client: w.client, reply: async (m) => out.push(text(m)) } };
};

/* ---------------- permissions ---------------- */

test('/giveaway: only the giveaway role may host one', async () => {
  for (const roles of [[], [config.supportRoleId], [config.moderationCommandRoleId]]) {
    const w = world({ roles });
    await G.handleGiveawayCommand(w.interaction());
    assert.equal(w.posts.length, 0, 'nothing is posted');
    assert.ok(w.replies[0].includes('need the') && w.replies[0].includes(config.giveawayRoleId));
  }
  const before = store.allGiveaways().length;
  const ok = world();
  await G.handleGiveawayCommand(ok.interaction());
  assert.equal(ok.posts.length, 1);
  assert.equal(store.allGiveaways().length, before + 1);
});

/* ---------------- creating ---------------- */

test('a valid /giveaway posts the card and saves the giveaway', async () => {
  const w = world();
  const t0 = Date.now();
  await G.handleGiveawayCommand(w.interaction({ title: 'Big Prize', description: 'Details here', duration: '1d 12h', winners: 3 }));
  const g = store.allGiveaways().at(-1);
  assert.equal(g.title, 'Big Prize');
  assert.equal(g.description, 'Details here');
  assert.equal(g.winners, 3);
  assert.equal(g.channelId, '900');
  assert.equal(g.hostId, HOST);
  assert.ok(Math.abs(g.endsAt - (t0 + 129_600_000)) < 5000, 'ends in 1 day 12 hours');
  assert.equal(g.messageId, 'msg1');
  const card = text(w.posts[0]);
  assert.ok(card.includes('Big Prize') && card.includes('Details here') && card.includes('Enter Giveaway') && card.includes(`giveaway:enter:${g.id}`));
  assert.ok(w.replies.at(-1).includes('is live'));
});

test('bad input is refused and nothing is created', async () => {
  const cases = [
    [{ duration: 'whenever' }, "couldn't read that duration"],
    [{ duration: '30s' }, 'between **1 minute** and **60 days**'],
    [{ duration: '61d' }, 'between **1 minute** and **60 days**'],
    [{ winners: 0 }, 'between 1 and 20'],
    [{ winners: 21 }, 'between 1 and 20'],
  ];
  for (const [over, expected] of cases) {
    const w = world(); const before = store.allGiveaways().length;
    await G.handleGiveawayCommand(w.interaction(over));
    assert.ok(w.replies[0].includes(expected), `${JSON.stringify(over)} -> ${w.replies[0]}`);
    assert.equal(w.posts.length, 0);
    assert.equal(store.allGiveaways().length, before);
  }
  const w = world(); const before = store.allGiveaways().length;
  w.channel.type = ChannelType.GuildVoice;
  await G.handleGiveawayCommand(w.interaction());
  assert.ok(w.replies[0].includes('text or announcement'));
  w.channel.type = ChannelType.GuildText; w.channel.permissionsFor = () => ({ has: () => false });
  await G.handleGiveawayCommand(w.interaction());
  assert.ok(w.replies[1].includes("can't post"));
  assert.equal(store.allGiveaways().length, before);
});

test('if the bot cannot post, no giveaway is left behind', async () => {
  const w = world(); const before = store.allGiveaways().length;
  w.channel.send = async () => { throw new Error('Missing Access'); };
  await G.handleGiveawayCommand(w.interaction());
  assert.ok(w.replies.at(-1).includes("couldn't post"));
  assert.equal(store.allGiveaways().length, before);
});

/* ---------------- entering ---------------- */

async function newGiveaway(w, over = {}) {
  await G.handleGiveawayCommand(w.interaction(over));
  return store.allGiveaways().at(-1);
}

test('entering: join, press again to leave, and every entry is saved', async () => {
  const w = world(); const g = await newGiveaway(w);
  let p = press(w, g.id, 'u1'); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes("You're in"));
  p = press(w, g.id, 'u2'); await G.handleGiveawayButton(p.i);
  assert.deepEqual(g.entries, ['u1', 'u2']);
  p = press(w, g.id, 'u1'); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes('You left'));
  assert.deepEqual(g.entries, ['u2']);
  assert.deepEqual(store.getGiveaway(g.id).entries, ['u2'], 'persisted');
});

test('entering: bots cannot, and an ended giveaway cannot be entered', async () => {
  const w = world(); const g = await newGiveaway(w);
  let p = press(w, g.id, 'bot1', true); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes("Bots can't enter"));
  assert.deepEqual(g.entries, []);
  store.updateGiveaway(g, { ended: true });
  p = press(w, g.id, 'u1'); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes('already ended'));
  assert.deepEqual(g.entries, []);
  p = press(w, 99999, 'u1'); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes('already ended'), 'a deleted/unknown giveaway is handled too');
});

/* ---------------- ending ---------------- */

test('the sweep ends only giveaways that are overdue, picks the right number of winners, and announces them', async () => {
  const w = world(); w.inGuild('u1', 'u2', 'u3', 'u4', 'u5');
  const due = await newGiveaway(w, { winners: 2 });
  const later = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(due, { entries: ['u1', 'u2', 'u3', 'u4', 'u5'], endsAt: Date.now() - 1000 });
  w.posts.length = 0;
  await G.sweepGiveaways(w.client);

  assert.equal(due.ended, true);
  assert.equal(later.ended, false, 'not due yet');
  assert.equal(due.winnerIds.length, 2);
  assert.equal(new Set(due.winnerIds).size, 2);
  for (const id of due.winnerIds) assert.ok(due.entries.includes(id));
  const ann = w.posts[0];
  for (const id of due.winnerIds) assert.ok(text(ann).includes(`<@${id}>`) && ann.allowedMentions.users.includes(id), 'winners are mentioned and pinged');
  assert.equal(ann.allowedMentions.users.length, 2, 'nobody else is pinged');
  assert.ok(text(ann).includes('You won'));
  assert.ok(text(w.edits.at(-1)).includes('Giveaway ended'), 'the card turns into the results');
  assert.ok(text(w.edits.at(-1)).includes('"disabled":true'), 'the Enter button is disabled');
});

test('winners who left the server (or are bots) are skipped and replaced from the other entrants', async () => {
  const w = world(); w.inGuild('stay1', 'stay2');
  w.members.set('robot', { user: { bot: true } });
  const g = await newGiveaway(w, { winners: 2 });
  store.updateGiveaway(g, { entries: ['gone1', 'robot', 'stay1', 'gone2', 'stay2'], endsAt: Date.now() - 1 });
  await G.endGiveaway(w.client, g);
  assert.deepEqual([...g.winnerIds].sort(), ['stay1', 'stay2']);
});

test('no entries (or nobody left): the giveaway ends with no winner', async () => {
  const w = world();
  const g = await newGiveaway(w);
  w.posts.length = 0;
  await G.endGiveaway(w.client, g);
  assert.deepEqual(g.winnerIds, []);
  assert.ok(text(w.posts[0]).includes('no valid entries'));
  assert.ok(text(w.edits.at(-1)).includes('nobody'));
});

test('fewer entrants than winners: everyone who entered wins', async () => {
  const w = world(); w.inGuild('only1');
  const g = await newGiveaway(w, { winners: 5 });
  store.updateGiveaway(g, { entries: ['only1'] });
  await G.endGiveaway(w.client, g);
  assert.deepEqual(g.winnerIds, ['only1']);
});

test('a giveaway can never be ended (and announced) twice', async () => {
  const w = world(); w.inGuild('u1');
  const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['u1'] });
  w.posts.length = 0;
  await Promise.all([G.endGiveaway(w.client, g), G.endGiveaway(w.client, g), G.sweepGiveaways(w.client)]);
  await G.endGiveaway(w.client, g);
  assert.equal(w.posts.length, 1, 'one announcement');
});

test('ended giveaways are forgotten after a week; recent ones are kept', async () => {
  const w = world();
  const old = await newGiveaway(w); const fresh = await newGiveaway(w);
  store.updateGiveaway(old, { ended: true, endedAt: Date.now() - 8 * 86_400_000 });
  store.updateGiveaway(fresh, { ended: true, endedAt: Date.now() - 86_400_000 });
  await G.sweepGiveaways(w.client);
  assert.equal(store.getGiveaway(old.id), undefined);
  assert.ok(store.getGiveaway(fresh.id));
});

test('the giveaway card renders for running and ended giveaways', () => {
  const g = { id: 1, title: 'T'.repeat(300), description: 'D'.repeat(3000), hostId: HOST, winners: 2, endsAt: Date.now() + 1e6, entries: ['a'], ended: false, winnerIds: [] };
  const running = giveawayMessage(g);
  JSON.stringify(running.components.map((c) => c.toJSON()));
  assert.ok(text(running).includes('Enter Giveaway'));
  const ended = giveawayMessage({ ...g, ended: true, winnerIds: ['a', 'b'] });
  assert.ok(text(ended).includes('<@a>, <@b>') && text(ended).includes('"disabled":true'));
});

test('the giveaway role defaults to the one you gave me', () => {
  assert.equal(config.giveawayRoleId, '1543156919831887953');
});
