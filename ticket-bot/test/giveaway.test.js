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
  const posts = []; const edits = []; const replies = []; const edited = []; const w_choices = [];
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
  const interaction = (over = {}, sub = 'start', who = {}) => {
    const o = { ...opts, ...over };
    return {
      user: { id: HOST, tag: 'Host#1', ...who }, guild, client,
      member: { roles: { cache: new Collection(roles.map((r) => [r, {}])) } },
      options: { getSubcommand: () => sub, getString: (n) => o[n], getInteger: (n) => o[n], getChannel: () => o.channel, getUser: (n) => o.users?.[n] ?? null, getFocused: () => o.focused ?? '' },
      respond: async (choices) => { w_choices.push(choices); },
      deferReply: async () => {}, editReply: async (m) => replies.push(text(m)), reply: async (m) => replies.push(text(m)),
    };
  };
  return { channel, guild, client, inGuild, interaction, posts, edits, replies, members, choices: w_choices };
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
  assert.ok(p.out[0].includes("You're in") && p.out[0].includes('1 entry so far'), p.out[0]);
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

/* ================= new: entry count, manage subcommands, host-selected winners ================= */

test('the card and the join message both say how many people have entered', async () => {
  const w = world(); const g = await newGiveaway(w);
  assert.ok(text(w.posts[0]).includes('Entries:** 0'), 'the card starts at 0');
  for (const u of ['a', 'b', 'c']) await G.handleGiveawayButton(press(w, g.id, u).i);
  const last = press(w, g.id, 'd'); await G.handleGiveawayButton(last.i);
  assert.ok(last.out[0].includes('4 entries so far'), last.out[0]);
  assert.ok(text(giveawayMessage(g)).includes('Entries:** 4'), 'the card shows the live count');
  const leave = press(w, g.id, 'a'); await G.handleGiveawayButton(leave.i);
  assert.ok(leave.out[0].includes('3 entries now'));
});

test('every manage subcommand needs the giveaway role', async () => {
  const w0 = world(); const g = await newGiveaway(w0);
  for (const sub of ['end', 'cancel', 'reroll', 'list']) {
    const w = world({ roles: [] });
    await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, sub));
    assert.ok(w.replies[0].includes('need the'), `${sub} must be refused`);
    assert.equal(g.ended, false, `${sub} must not touch the giveaway`);
  }
});

test('/giveaway end: ends it now and announces; ending twice or an unknown id is refused', async () => {
  const w = world(); w.inGuild('u1', 'u2'); const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['u1', 'u2'] });
  w.posts.length = 0;
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, 'end'));
  assert.equal(g.ended, true);
  assert.equal(g.winnerIds.length, 1);
  assert.ok(w.posts[0] && text(w.posts[0]).includes('You won'));
  assert.ok(w.replies.at(-1).includes('Ended') && w.replies.at(-1).includes('2 entries'));
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, 'end'));
  assert.ok(w.replies.at(-1).includes('already ended'));
  await G.handleGiveawayCommand(w.interaction({ giveaway: 99999 }, 'end'));
  assert.ok(w.replies.at(-1).includes('no giveaway #99999'));
});

test('/giveaway cancel: no winners, the card says cancelled, nobody can enter, and the sweep leaves it alone', async () => {
  const w = world(); const g = await newGiveaway(w);
  store.updateGiveaway(g, { entries: ['u1'], endsAt: Date.now() - 1 }); // even if it was overdue
  w.posts.length = 0;
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, 'cancel'));
  assert.equal(g.cancelled, true);
  assert.deepEqual(g.winnerIds, []);
  assert.ok(text(w.edits.at(-1)).includes('cancelled') && text(w.edits.at(-1)).includes('"disabled":true'));
  await G.sweepGiveaways(w.client);
  assert.equal(w.posts.length, 0, 'no winner announcement for a cancelled giveaway');
  const p = press(w, g.id, 'u2'); await G.handleGiveawayButton(p.i);
  assert.ok(p.out[0].includes('already ended'));
});

test('/giveaway reroll: new random winners, never a previous winner, announced and shown on the card', async () => {
  const w = world(); w.inGuild('a', 'b', 'c', 'd'); const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['a', 'b', 'c', 'd'] });
  await G.endGiveaway(w.client, g);
  const first = g.winnerIds[0];
  w.posts.length = 0;
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id, winners: 2 }, 'reroll'));
  assert.equal(g.winnerIds.length, 3);
  assert.equal(new Set(g.winnerIds).size, 3, 'nobody wins twice');
  assert.equal(g.winnerIds[0], first);
  const ann = text(w.posts[0]);
  assert.ok(ann.includes('Reroll') && g.rerolled.every((id) => ann.includes(`<@${id}>`)));
  assert.ok(!ann.includes(`<@${first}>`), 'the original winner is not re-announced');
  assert.ok(text(w.edits.at(-1)).includes('Reroll'));
  // a running giveaway cannot be rerolled
  const running = await newGiveaway(w);
  await G.handleGiveawayCommand(w.interaction({ giveaway: running.id }, 'reroll'));
  assert.ok(w.replies.at(-1).includes('still running'));
  // nobody left to pick
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id, winners: 5 }, 'reroll'));
  assert.equal(g.winnerIds.length, 4);
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, 'reroll'));
  assert.ok(w.replies.at(-1).includes('nobody else left'));
});

test('/giveaway list shows the running giveaways with their entry counts', async () => {
  const w = world();
  for (const g of store.allGiveaways()) store.updateGiveaway(g, { ended: true, endedAt: Date.now() });
  await G.handleGiveawayCommand(w.interaction({}, 'list'));
  assert.ok(w.replies.at(-1).includes('no running giveaways'));
  const g = await newGiveaway(w, { title: 'Listed prize' });
  store.updateGiveaway(g, { entries: ['a', 'b'] });
  await G.handleGiveawayCommand(w.interaction({}, 'list'));
  const out = w.replies.at(-1);
  assert.ok(out.includes('Listed prize') && out.includes('2 entries') && out.includes(`#${g.id}`));
});

test('autocomplete: durations for start, giveaway pickers for the others, nothing for people without the role', async () => {
  const w = world(); const g = await newGiveaway(w, { title: 'Picker prize' });
  const ask = (over, sub, ww = w) => ww.interaction({ ...over }, sub);
  const inter = (focus, sub, ww = w) => { const i = ask({}, sub, ww); i.options.getFocused = (full) => (full ? focus : focus.value); return i; };
  await G.handleGiveawayAutocomplete(inter({ name: 'duration', value: '1d' }, 'start'));
  const dur = w.choices.at(-1);
  assert.ok(dur.some((c) => c.value === '1d') && dur.length <= 25);
  await G.handleGiveawayAutocomplete(inter({ name: 'giveaway', value: '' }, 'end'));
  assert.ok(w.choices.at(-1).some((c) => c.value === g.id && c.name.includes('Picker prize')));
  const nobody = world({ roles: [] });
  await G.handleGiveawayAutocomplete(inter({ name: 'giveaway', value: '' }, 'end', nobody));
  assert.deepEqual(nobody.choices.at(-1), []);
});

/* ---- /axslsdb: host-selected winners, openly labelled ---- */

const OWNER = '880060587697123370';
const axs = (w, giveawayId, userIds, who = { id: OWNER }) =>
  w.interaction({ giveaway: giveawayId, users: Object.fromEntries(userIds.map((id, i) => [`user${i + 1}`, { id, bot: false }])) }, 'x', who);

test('/axslsdb can only be used by the configured owner - not even people with the giveaway role or admins', async () => {
  const w = world(); w.inGuild('u1'); const g = await newGiveaway(w, { winners: 1 });
  for (const who of [{ id: '123456789012345678' }, { id: HOST }]) {
    const i = axs(w, g.id, ['u1'], who);
    await G.handleAxslsdbCommand(i);
    assert.ok(w.replies.at(-1).includes("can't use this command"));
    assert.equal(g.chosenWinnerIds, undefined);
  }
  assert.deepEqual(config.giveawayAdminUserIds, [OWNER], 'defaults to the owner');
});

test('/axslsdb before the end: those people win, and the card + announcement say "selected by the host"', async () => {
  const w = world(); w.inGuild('u1', 'u2', 'u3', 'u4'); const g = await newGiveaway(w, { winners: 2 });
  store.updateGiveaway(g, { entries: ['u1', 'u2', 'u3', 'u4'] });
  await G.handleAxslsdbCommand(axs(w, g.id, ['u3', 'u4']));
  assert.deepEqual(g.chosenWinnerIds, ['u3', 'u4']);
  assert.ok(w.replies.at(-1).includes('selected by the host'), 'the host is told it will be labelled');
  w.posts.length = 0;
  await G.endGiveaway(w.client, g);
  assert.deepEqual([...g.winnerIds].sort(), ['u3', 'u4']);
  assert.equal(g.hostChosen, true);
  assert.ok(text(w.posts[0]).includes('The host selected the winner'), 'the announcement is not worded as a random draw');
  assert.ok(text(w.edits.at(-1)).includes('selected by the host'));
});

test('/axslsdb can pick people who did not enter (a judged contest) but only people who are in the server', async () => {
  const w = world(); w.inGuild('judged'); const g = await newGiveaway(w, { winners: 1 });
  await G.handleAxslsdbCommand(axs(w, g.id, ['judged']));
  assert.deepEqual(g.chosenWinnerIds, ['judged']);
  await G.handleAxslsdbCommand(axs(w, g.id, ['stranger-not-in-server']));
  assert.ok(w.replies.at(-1).includes("isn't in the server"));
  assert.deepEqual(g.chosenWinnerIds, ['judged'], 'unchanged');
});

test('/axslsdb refuses too many winners, bots, and cancelled giveaways', async () => {
  const w = world(); w.inGuild('a', 'b'); const g = await newGiveaway(w, { winners: 1 });
  await G.handleAxslsdbCommand(axs(w, g.id, ['a', 'b']));
  assert.ok(w.replies.at(-1).includes('has 1 winner'));
  const bot = axs(w, g.id, ['a']); bot.options.getUser = () => ({ id: 'bot9', bot: true });
  await G.handleAxslsdbCommand(bot);
  assert.ok(w.replies.at(-1).includes("Bots can't win"));
  await G.handleGiveawayCommand(w.interaction({ giveaway: g.id }, 'cancel'));
  await G.handleAxslsdbCommand(axs(w, g.id, ['a']));
  assert.ok(w.replies.at(-1).includes('no usable giveaway'));
  assert.equal(g.chosenWinnerIds, undefined);
});

test('/axslsdb after the end replaces the winners openly (announced as chosen by the host)', async () => {
  const w = world(); w.inGuild('a', 'b', 'c'); const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['a', 'b'] });
  await G.endGiveaway(w.client, g);
  assert.equal(g.hostChosen, false, 'a normal draw is not labelled as host-selected');
  w.posts.length = 0;
  await G.handleAxslsdbCommand(axs(w, g.id, ['c']));
  assert.deepEqual(g.winnerIds, ['c']);
  assert.equal(g.hostChosen, true);
  assert.ok(text(w.posts[0]).includes('The host selected new winner') && text(w.posts[0]).includes('<@c>'));
  assert.ok(text(w.edits.at(-1)).includes('selected by the host'));
});

test('if a host-selected winner left before the end, the giveaway falls back to a normal random draw', async () => {
  const w = world(); w.inGuild('e1', 'e2'); w.inGuild('picked');
  const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['e1', 'e2'] });
  await G.handleAxslsdbCommand(axs(w, g.id, ['picked']));
  w.members.delete('picked'); // they left
  await G.endGiveaway(w.client, g);
  assert.ok(['e1', 'e2'].includes(g.winnerIds[0]));
  assert.equal(g.hostChosen, false, 'and it is labelled as the random draw it is');
});

test('a normal giveaway is never labelled as host-selected', async () => {
  const w = world(); w.inGuild('x1'); const g = await newGiveaway(w, { winners: 1 });
  store.updateGiveaway(g, { entries: ['x1'] });
  w.posts.length = 0;
  await G.endGiveaway(w.client, g);
  assert.ok(text(w.posts[0]).includes('You won') && !text(w.posts[0]).includes('selected'));
  assert.ok(!text(w.edits.at(-1)).includes('selected by the host'));
});
