import { randomInt } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { store } from './store.js';
import { giveawayMessage, notice, V2_EPHEMERAL } from './ui.js';

/**
 * Giveaways.
 *
 *   /giveaway start | end | cancel | reroll | list   - only people with GIVEAWAY_ROLE_ID
 *   /axslsdb                                         - host-selected winners, only GIVEAWAY_ADMIN_USER_IDS
 *
 * Anyone can enter with the button. Entries live in the saved data file, so giveaways survive a restart, and an
 * overdue giveaway is ended the moment the bot is back. Winners are random unless the host picked them with
 * /axslsdb - in that case the card and the announcement say "selected by the host", so nobody is misled.
 */

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const MIN_MS = 60_000; // 1 minute
const MAX_MS = 60 * 24 * 3600_000; // 60 days
const KEEP_ENDED_MS = 7 * 24 * 3600_000; // ended giveaways are forgotten after a week
const MAX_WINNERS = 20;
const REFRESH_DELAY_MS = 5000; // entry counts are updated at most this often (Discord rate limits message edits)

const UNITS = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const UNIT_NAMES = [
  [/^(weeks?|w)$/i, 'w'], [/^(days?|d)$/i, 'd'], [/^(hours?|hrs?|h)$/i, 'h'], [/^(minutes?|mins?|m)$/i, 'm'], [/^(seconds?|secs?|s)$/i, 's'],
];

/** "30m", "2h", "1d12h", "1 day 12 hours" -> milliseconds. Returns null if it isn't a valid duration. */
export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = '';
  for (const m of text.matchAll(re)) {
    const unit = UNIT_NAMES.find(([pattern]) => pattern.test(m[2]))?.[1];
    if (!unit) return null;
    total += Number(m[1]) * UNITS[unit];
    consumed += m[0];
  }
  // everything typed must have been understood (only spaces, commas and "and" may be left over)
  const leftover = text.replace(re, '').replace(/\b(and)\b|[\s,]/g, '');
  if (!consumed || leftover) return null;
  return Math.round(total);
}

/** 129_600_000 -> "1 day 12 hours". */
export function formatDuration(ms) {
  const parts = [];
  let rest = ms;
  for (const [unit, name] of [['d', 'day'], ['h', 'hour'], ['m', 'minute'], ['s', 'second']]) {
    const n = Math.floor(rest / UNITS[unit]);
    rest -= n * UNITS[unit];
    if (n) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
  }
  return parts.join(' ') || '0 seconds';
}

/** Random, unbiased pick of up to `count` different entries (cryptographic randomness). */
export function pickWinners(entries, count, rand = randomInt) {
  const pool = [...new Set(entries)];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, count));
}

const ephemeral = (message, color) => notice(message, { ephemeral: true, color, mentions: { parse: [] } });
const mentionList = (ids) => ids.map((id) => `<@${id}>`).join(', ');
const entriesText = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/* ------------------------------ finding giveaways ------------------------------ */

const isActive = (g) => !g.ended;
const isDrawn = (g) => g.ended && !g.cancelled;

/** Giveaways for the id pickers: running ones, and/or recently finished ones. */
function pickable(kind) {
  const all = store.allGiveaways();
  if (kind === 'active') return all.filter(isActive);
  if (kind === 'drawn') return all.filter(isDrawn);
  return all.filter((g) => !g.cancelled);
}

function giveawayChoices(typed, kind) {
  const q = String(typed ?? '').trim().toLowerCase();
  return pickable(kind)
    .filter((g) => !q || String(g.id).startsWith(q) || g.title.toLowerCase().includes(q))
    .sort((a, b) => b.id - a.id)
    .slice(0, 25)
    .map((g) => ({ name: `#${g.id} • ${g.title} (${entriesText(g.entries.length)}${g.ended ? ', ended' : ''})`.slice(0, 100), value: g.id }));
}

/* ------------------------------------ /giveaway ------------------------------------ */

const hasGiveawayRole = (interaction) => Boolean(interaction.member?.roles?.cache?.has(config.giveawayRoleId));

export async function handleGiveawayCommand(interaction) {
  if (!hasGiveawayRole(interaction)) {
    const seen = [...(interaction.member?.roles?.cache?.keys() ?? [])].join(', ') || 'none';
    log(`Giveaway: /giveaway refused for ${interaction.user.tag} - it needs role ${config.giveawayRoleId}; the bot sees these roles on them: ${seen}`);
    return interaction.reply(ephemeral(`You need the <@&${config.giveawayRoleId}> role to manage giveaways.`, config.accentWarn));
  }
  switch (interaction.options.getSubcommand()) {
    case 'start': return startGiveaway(interaction);
    case 'end': return endNow(interaction);
    case 'cancel': return cancelNow(interaction);
    case 'reroll': return rerollNow(interaction);
    case 'list': return listGiveaways(interaction);
    default: return interaction.reply(ephemeral('Unknown giveaway command.', config.accentWarn));
  }
}

async function startGiveaway(interaction) {
  const title = interaction.options.getString('title', true).trim();
  const description = interaction.options.getString('description', true).trim();
  const durationText = interaction.options.getString('duration', true);
  const winners = interaction.options.getInteger('winners', true);
  const channel = interaction.options.getChannel('channel', true);

  const ms = parseDuration(durationText);
  if (ms === null) {
    return interaction.reply(ephemeral('I couldn\'t read that duration. Try something like `30m`, `2h`, `1d` or `1d 12h`.', config.accentWarn));
  }
  if (ms < MIN_MS || ms > MAX_MS) {
    return interaction.reply(ephemeral('A giveaway must last between **1 minute** and **60 days**.', config.accentWarn));
  }
  if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) {
    return interaction.reply(ephemeral(`The number of winners must be between 1 and ${MAX_WINNERS}.`, config.accentWarn));
  }
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return interaction.reply(ephemeral('Pick a normal text or announcement channel.', config.accentWarn));
  }
  const allowed = channel.permissionsFor?.(interaction.guild.members.me);
  if (!allowed?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return interaction.reply(ephemeral(`I can't post in <#${channel.id}> - give me **View Channel** and **Send Messages** there.`, config.accentWarn));
  }

  await interaction.deferReply({ flags: V2_EPHEMERAL });
  const giveaway = store.createGiveaway({
    guildId: interaction.guild.id,
    channelId: channel.id,
    hostId: interaction.user.id,
    title,
    description,
    winners,
    endsAt: Date.now() + ms,
  });
  try {
    const sent = await channel.send(giveawayMessage(giveaway));
    store.updateGiveaway(giveaway, { messageId: sent.id });
  } catch (err) {
    store.removeGiveaway(giveaway);
    log(`Giveaway: could not post in #${channel.name} (${err.message})`);
    return interaction.editReply(ephemeral(`I couldn't post the giveaway in <#${channel.id}> (${err.message}).`, config.accentWarn));
  }

  log(`Giveaway #${giveaway.id} "${title}" started by ${interaction.user.tag} in #${channel.name}: ${winners} winner(s), ends in ${formatDuration(ms)}`);
  return interaction.editReply(
    ephemeral(`✅ Giveaway **${title}** (#${giveaway.id}) is live in <#${channel.id}>.\n🏆 ${winners} winner${winners === 1 ? '' : 's'} • ⏰ ends <t:${Math.floor(giveaway.endsAt / 1000)}:R> (${formatDuration(ms)})`, config.accentOk),
  );
}

/** Looks up the giveaway the host picked; replies and returns null if it doesn't exist. */
async function chosenGiveaway(interaction) {
  const id = interaction.options.getInteger('giveaway', true);
  const giveaway = store.getGiveaway(id);
  if (!giveaway) {
    await interaction.reply(ephemeral(`There is no giveaway #${id} (ended ones are forgotten after a week). Use \`/giveaway list\`.`, config.accentWarn));
    return null;
  }
  return giveaway;
}

async function endNow(interaction) {
  const giveaway = await chosenGiveaway(interaction);
  if (!giveaway) return;
  if (giveaway.ended) return interaction.reply(ephemeral(`Giveaway #${giveaway.id} has already ended.`, config.accentWarn));
  await interaction.deferReply({ flags: V2_EPHEMERAL });
  log(`Giveaway #${giveaway.id}: ended early by ${interaction.user.tag}`);
  await endGiveaway(interaction.client, giveaway);
  return interaction.editReply(
    ephemeral(`✅ Ended **${giveaway.title}** with ${entriesText(giveaway.entries.length)}. ${giveaway.winnerIds.length ? `Winner${giveaway.winnerIds.length === 1 ? '' : 's'}: ${mentionList(giveaway.winnerIds)}` : 'No valid entries, so no winner.'}`, config.accentOk),
  );
}

async function cancelNow(interaction) {
  const giveaway = await chosenGiveaway(interaction);
  if (!giveaway) return;
  if (giveaway.ended) return interaction.reply(ephemeral(`Giveaway #${giveaway.id} has already ended.`, config.accentWarn));
  await interaction.deferReply({ flags: V2_EPHEMERAL });
  store.updateGiveaway(giveaway, { ended: true, cancelled: true, endedAt: Date.now() });
  clearRefresh(giveaway);
  await editCard(interaction.client, giveaway);
  log(`Giveaway #${giveaway.id} "${giveaway.title}" cancelled by ${interaction.user.tag}`);
  return interaction.editReply(ephemeral(`🚫 Cancelled **${giveaway.title}**. No winners were picked.`, config.accentOk));
}

async function rerollNow(interaction) {
  const giveaway = await chosenGiveaway(interaction);
  if (!giveaway) return;
  if (!isDrawn(giveaway)) {
    return interaction.reply(ephemeral(giveaway.cancelled ? 'That giveaway was cancelled.' : `Giveaway #${giveaway.id} is still running - use \`/giveaway end\` first.`, config.accentWarn));
  }
  const count = interaction.options.getInteger('winners') ?? 1;
  await interaction.deferReply({ flags: V2_EPHEMERAL });

  const guild = interaction.client.guilds.cache.get(giveaway.guildId);
  const candidates = giveaway.entries.filter((id) => !giveaway.winnerIds.includes(id));
  const fresh = guild ? await drawFrom(guild, candidates, Math.min(Math.max(count, 1), MAX_WINNERS)) : [];
  if (!fresh.length) {
    return interaction.editReply(ephemeral('There is nobody else left to pick - every other entrant already won or left the server.', config.accentWarn));
  }
  store.updateGiveaway(giveaway, { winnerIds: [...giveaway.winnerIds, ...fresh], rerolled: [...(giveaway.rerolled ?? []), ...fresh] });
  log(`Giveaway #${giveaway.id}: ${interaction.user.tag} rerolled -> ${fresh.join(', ')}`);
  await editCard(interaction.client, giveaway);
  await announce(interaction.client, giveaway, notice(`🎲 Reroll! New winner${fresh.length === 1 ? '' : 's'} for **${giveaway.title}**: ${mentionList(fresh)} - congratulations!`, { color: config.accentOk, mentions: { users: fresh } }));
  return interaction.editReply(ephemeral(`🎲 Rerolled **${giveaway.title}**: ${mentionList(fresh)}`, config.accentOk));
}

async function listGiveaways(interaction) {
  const active = store.allGiveaways().filter(isActive).sort((a, b) => a.endsAt - b.endsAt);
  if (!active.length) return interaction.reply(ephemeral('There are no running giveaways. Start one with `/giveaway start`.'));
  const lines = active.slice(0, 15).map(
    (g) => `**#${g.id}** ${g.title} - <#${g.channelId}> • 🏆 ${g.winners} • 🎟️ ${entriesText(g.entries.length)} • ends <t:${Math.floor(g.endsAt / 1000)}:R>`,
  );
  return interaction.reply(ephemeral(`### 🎉 Running giveaways\n${lines.join('\n')}${active.length > 15 ? `\n…and ${active.length - 15} more` : ''}`));
}

/** Suggestions while typing: common durations for `start`, matching giveaways for the id pickers. */
export async function handleGiveawayAutocomplete(interaction) {
  if (!hasGiveawayRole(interaction)) return interaction.respond([]).catch(() => {});
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'giveaway') {
    const kind = { end: 'active', cancel: 'active', reroll: 'drawn' }[interaction.options.getSubcommand()] ?? 'all';
    return interaction.respond(giveawayChoices(focused.value, kind)).catch(() => {});
  }
  const typed = String(focused.value ?? '').trim();
  const common = [
    ['10 minutes', '10m'], ['30 minutes', '30m'], ['1 hour', '1h'], ['6 hours', '6h'], ['12 hours', '12h'],
    ['1 day', '1d'], ['3 days', '3d'], ['1 week', '1w'], ['2 weeks', '2w'], ['30 days', '30d'],
  ].map(([name, value]) => ({ name, value }));
  const choices = [];
  const ms = parseDuration(typed);
  if (typed && ms !== null) choices.push({ name: `${formatDuration(ms)} (${typed})`.slice(0, 100), value: typed.slice(0, 100) });
  for (const c of common) if (!typed || c.value.startsWith(typed.toLowerCase()) || c.name.toLowerCase().startsWith(typed.toLowerCase())) choices.push(c);
  return interaction.respond(choices.slice(0, 25)).catch(() => {});
}

/* ----------------------------------- entering ------------------------------------ */

const refreshTimers = new Map(); // giveaway id -> timer

function clearRefresh(giveaway) {
  clearTimeout(refreshTimers.get(giveaway.id));
  refreshTimers.delete(giveaway.id);
}

/** Updates the entry count on the card, at most once per few seconds. */
function scheduleRefresh(client, giveaway) {
  if (refreshTimers.has(giveaway.id)) return;
  const timer = setTimeout(async () => {
    refreshTimers.delete(giveaway.id);
    await editCard(client, giveaway);
  }, REFRESH_DELAY_MS);
  timer.unref?.(); // never keep the process alive just for this
  refreshTimers.set(giveaway.id, timer);
}

async function editCard(client, giveaway) {
  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(giveaway.messageId);
    await message.edit(giveawayMessage(giveaway));
  } catch {
    /* the message or channel is gone - nothing to update */
  }
}

/** Posts in the giveaway's channel as a reply to the card. */
async function announce(client, giveaway, payload) {
  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    payload.reply = { messageReference: giveaway.messageId, failIfNotExists: false };
    await channel.send(payload);
  } catch (err) {
    log(`Giveaway #${giveaway.id}: could not post in the channel (${err.message})`);
  }
}

/** The Enter button. Pressing it again leaves the giveaway. */
export async function handleGiveawayButton(interaction) {
  const id = interaction.customId.split(':')[2];
  const giveaway = store.getGiveaway(id);
  if (!giveaway || giveaway.ended) {
    return interaction.reply(ephemeral('This giveaway has already ended.', config.accentWarn));
  }
  if (interaction.user.bot) return interaction.reply(ephemeral('Bots can\'t enter giveaways.', config.accentWarn));

  const userId = interaction.user.id;
  if (giveaway.entries.includes(userId)) {
    store.updateGiveaway(giveaway, { entries: giveaway.entries.filter((e) => e !== userId) });
    scheduleRefresh(interaction.client, giveaway);
    return interaction.reply(ephemeral(`👋 You left the giveaway (${entriesText(giveaway.entries.length)} now). Press the button again to re-enter.`));
  }
  store.updateGiveaway(giveaway, { entries: [...giveaway.entries, userId] });
  scheduleRefresh(interaction.client, giveaway);
  return interaction.reply(ephemeral(`🎉 You're in! Good luck - ${entriesText(giveaway.entries.length)} so far. Press the button again if you want to leave.`, config.accentOk));
}

/* ------------------------------------ ending ------------------------------------- */

/** Picks up to `count` random entrants, skipping anyone who left the server (or is a bot) and replacing them. */
async function drawFrom(guild, candidates, count) {
  const winners = [];
  for (const id of pickWinners(candidates, candidates.length)) {
    if (winners.length >= count) break;
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && !member.user.bot) winners.push(id);
  }
  return winners;
}

/** Winners the host picked with /axslsdb that are still in the server. */
async function stillHere(guild, ids) {
  const here = [];
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && !member.user.bot) here.push(id);
  }
  return here;
}

export async function endGiveaway(client, giveaway) {
  if (giveaway.ended) return;
  store.updateGiveaway(giveaway, { ended: true, endedAt: Date.now() }); // first, so it can never be ended twice
  clearRefresh(giveaway);

  const guild = client.guilds.cache.get(giveaway.guildId);
  let winnerIds = [];
  let hostChosen = false;
  if (guild) {
    // Winners the host selected win; otherwise it is a fair random draw.
    if (giveaway.chosenWinnerIds?.length) {
      winnerIds = await stillHere(guild, giveaway.chosenWinnerIds);
      hostChosen = winnerIds.length > 0;
    }
    if (!winnerIds.length) winnerIds = await drawFrom(guild, giveaway.entries, giveaway.winners);
  }
  store.updateGiveaway(giveaway, { winnerIds, hostChosen });
  log(`Giveaway #${giveaway.id} "${giveaway.title}" ended: ${giveaway.entries.length} entries -> ${winnerIds.length ? `${hostChosen ? 'host-selected ' : ''}winners ${winnerIds.join(', ')}` : 'no winner'}`);

  await editCard(client, giveaway);
  const announcement = winnerIds.length
    ? notice(
        hostChosen
          ? `🎯 The host selected the winner${winnerIds.length === 1 ? '' : 's'} of **${giveaway.title}**: ${mentionList(winnerIds)} - congratulations!`
          : `🎉 Congratulations ${mentionList(winnerIds)}! You won **${giveaway.title}**!`,
        { color: config.accentOk, mentions: { users: winnerIds } },
      )
    : notice(`😕 The giveaway **${giveaway.title}** ended with no valid entries, so there is no winner.`, { mentions: { parse: [] } });
  await announce(client, giveaway, announcement);
}

/** Ends giveaways that ran out of time (also catches ones that ended while the bot was off) and tidies up old ones. */
export async function sweepGiveaways(client) {
  const now = Date.now();
  for (const giveaway of store.allGiveaways()) {
    try {
      if (!giveaway.ended && giveaway.messageId && giveaway.endsAt <= now) await endGiveaway(client, giveaway);
      else if (giveaway.ended && giveaway.endedAt && now - giveaway.endedAt > KEEP_ENDED_MS) store.removeGiveaway(giveaway);
    } catch (err) {
      console.error(`Giveaway #${giveaway.id} sweep failed:`, err);
    }
  }
}

/* -------------------------------------- /axslsdb ---------------------------------------
 * The host's own control over who wins. It is not secret to the entrants on purpose: a winner chosen here is
 * shown as "selected by the host" on the card and in the announcement, never as a random draw. */

const isGiveawayAdmin = (interaction) => config.giveawayAdminUserIds.includes(interaction.user.id);

export async function handleAxslsdbCommand(interaction) {
  if (!isGiveawayAdmin(interaction)) {
    log(`Giveaway: /axslsdb refused for ${interaction.user.tag} (${interaction.user.id})`);
    return interaction.reply(ephemeral("You can't use this command.", config.accentWarn));
  }
  const id = interaction.options.getInteger('giveaway', true);
  const giveaway = store.getGiveaway(id);
  if (!giveaway || giveaway.cancelled) return interaction.reply(ephemeral(`There is no usable giveaway #${id}. Use \`/giveaway list\`.`, config.accentWarn));

  const users = ['user1', 'user2', 'user3', 'user4', 'user5'].map((n) => interaction.options.getUser(n)).filter(Boolean);
  const ids = [...new Set(users.map((u) => u.id))];
  if (users.some((u) => u.bot)) return interaction.reply(ephemeral("Bots can't win giveaways.", config.accentWarn));
  if (ids.length > giveaway.winners) {
    return interaction.reply(ephemeral(`Giveaway #${id} has ${giveaway.winners} winner${giveaway.winners === 1 ? '' : 's'} - you picked ${ids.length}.`, config.accentWarn));
  }
  const guild = interaction.client.guilds.cache.get(giveaway.guildId);
  const here = guild ? await stillHere(guild, ids) : [];
  const missing = ids.filter((x) => !here.includes(x));
  if (missing.length) return interaction.reply(ephemeral(`${mentionList(missing)} ${missing.length === 1 ? "isn't" : "aren't"} in the server.`, config.accentWarn));

  await interaction.deferReply({ flags: V2_EPHEMERAL });
  if (!giveaway.ended) {
    store.updateGiveaway(giveaway, { chosenWinnerIds: ids });
    log(`Giveaway #${id}: ${interaction.user.tag} selected the winners in advance: ${ids.join(', ')}`);
    return interaction.editReply(
      ephemeral(`✅ Saved. When **${giveaway.title}** ends, ${mentionList(ids)} will be announced as the winner${ids.length === 1 ? '' : 's'} **selected by the host** (the card and announcement say so).`, config.accentOk),
    );
  }

  store.updateGiveaway(giveaway, { chosenWinnerIds: ids, winnerIds: ids, hostChosen: true });
  log(`Giveaway #${id}: ${interaction.user.tag} replaced the winners with ${ids.join(', ')}`);
  await editCard(interaction.client, giveaway);
  await announce(interaction.client, giveaway, notice(`🎯 The host selected new winner${ids.length === 1 ? '' : 's'} for **${giveaway.title}**: ${mentionList(ids)} - congratulations!`, { color: config.accentOk, mentions: { users: ids } }));
  return interaction.editReply(ephemeral(`✅ Winners of **${giveaway.title}** are now ${mentionList(ids)} (shown as selected by the host).`, config.accentOk));
}

export async function handleAxslsdbAutocomplete(interaction) {
  if (!isGiveawayAdmin(interaction)) return interaction.respond([]).catch(() => {});
  return interaction.respond(giveawayChoices(interaction.options.getFocused(), 'all')).catch(() => {});
}
