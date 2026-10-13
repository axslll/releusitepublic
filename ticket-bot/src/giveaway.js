import { randomInt } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { store } from './store.js';
import { giveawayMessage, notice, V2_EPHEMERAL } from './ui.js';

/**
 * /giveaway - hosts a giveaway in a channel.
 *
 * Only people with GIVEAWAY_ROLE_ID may start one; anyone can enter with the button. Entries live in the saved
 * data file, so giveaways survive a restart, and an overdue giveaway is ended the moment the bot is back.
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

/* ---------------------------------- command --------------------------------- */

export async function handleGiveawayCommand(interaction) {
  if (!interaction.member?.roles?.cache?.has(config.giveawayRoleId)) {
    const seen = [...(interaction.member?.roles?.cache?.keys() ?? [])].join(', ') || 'none';
    log(`Giveaway: /giveaway refused for ${interaction.user.tag} - it needs role ${config.giveawayRoleId}; the bot sees these roles on them: ${seen}`);
    return interaction.reply(ephemeral(`You need the <@&${config.giveawayRoleId}> role to host giveaways.`, config.accentWarn));
  }

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
    ephemeral(`✅ Giveaway **${title}** is live in <#${channel.id}>.\n🏆 ${winners} winner${winners === 1 ? '' : 's'} • ⏰ ends <t:${Math.floor(giveaway.endsAt / 1000)}:R> (${formatDuration(ms)})`, config.accentOk),
  );
}

/** Suggests common durations while the host types. */
export async function handleGiveawayAutocomplete(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').trim();
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
    return interaction.reply(ephemeral('👋 You left the giveaway. Press the button again to re-enter.'));
  }
  store.updateGiveaway(giveaway, { entries: [...giveaway.entries, userId] });
  scheduleRefresh(interaction.client, giveaway);
  return interaction.reply(ephemeral('🎉 You\'re in! Good luck. Press the button again if you want to leave.', config.accentOk));
}

/* ------------------------------------ ending ------------------------------------- */

/** Picks the winners, skipping anyone who has left the server (or is a bot), and replacing them from the rest. */
async function drawWinners(guild, giveaway) {
  const shuffled = pickWinners(giveaway.entries, giveaway.entries.length);
  const winners = [];
  for (const id of shuffled) {
    if (winners.length >= giveaway.winners) break;
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && !member.user.bot) winners.push(id);
  }
  return winners;
}

export async function endGiveaway(client, giveaway) {
  if (giveaway.ended) return;
  store.updateGiveaway(giveaway, { ended: true, endedAt: Date.now() }); // first, so it can never be ended twice
  clearTimeout(refreshTimers.get(giveaway.id));
  refreshTimers.delete(giveaway.id);

  const guild = client.guilds.cache.get(giveaway.guildId);
  const winnerIds = guild ? await drawWinners(guild, giveaway) : [];
  store.updateGiveaway(giveaway, { winnerIds });
  log(`Giveaway #${giveaway.id} "${giveaway.title}" ended: ${giveaway.entries.length} entries -> ${winnerIds.length ? `winners ${winnerIds.join(', ')}` : 'no winner'}`);

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (message) await message.edit(giveawayMessage(giveaway));
    const announcement = winnerIds.length
      ? notice(`🎉 Congratulations ${winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.title}**!`, { color: config.accentOk, mentions: { users: winnerIds } })
      : notice(`😕 The giveaway **${giveaway.title}** ended with no valid entries, so there is no winner.`, { mentions: { parse: [] } });
    if (message) announcement.reply = { messageReference: message.id, failIfNotExists: false };
    await channel.send(announcement);
  } catch (err) {
    log(`Giveaway #${giveaway.id}: could not announce the result (${err.message})`);
  }
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
