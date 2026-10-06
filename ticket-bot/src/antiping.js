import { config } from './config.js';
import { notice } from './ui.js';

/**
 * Anti-ping protection.
 *
 * Nobody may ping the protected users, the protected roles, or anyone who holds one of those roles.
 * When someone does, the bot deletes the message, times the pinger out, replies in the channel, and
 * DMs the people who were pinged (and the pinger) so everyone knows what happened.
 */

const MAX_DM_RECIPIENTS = 10; // a role ping must never turn into a mass DM
const DM_COOLDOWN_MS = 5 * 60 * 1000;
const recentDms = new Map(); // `${pingerId}:${targetId}` -> timestamp

/** Forgets who was DMed recently (used by the tests). */
export const resetPingCooldowns = () => recentDms.clear();

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

/**
 * User and role IDs typed as mentions in a message. Mentions inside code blocks / inline code are
 * ignored (Discord doesn't ping for those), and so are reply pings: only a mention written in the
 * text counts.
 */
export function extractMentions(content) {
  const text = String(content ?? '').replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  const ids = (re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
  return { userIds: ids(/<@!?(\d+)>/g), roleIds: ids(/<@&(\d+)>/g) };
}

const isProtectedRole = (id) => config.protectedRoleIds.includes(id);

async function memberOf(guild, id) {
  return guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
}

/**
 * Works out which of the mentions are protected.
 * Returns { users: Map(userId -> { direct, roles: [names] }), roles: [roleId] } - empty when nothing is protected.
 */
export async function findProtectedPings(guild, content, authorId) {
  const { userIds, roleIds } = extractMentions(content);
  const users = new Map();
  const roles = roleIds.filter(isProtectedRole);

  for (const id of userIds) {
    if (id === authorId) continue; // pinging yourself is fine
    if (config.protectedUserIds.includes(id)) {
      users.set(id, { direct: true, roles: [] });
      continue;
    }
    // Someone who holds a protected role is protected too.
    const member = await memberOf(guild, id);
    const held = member ? [...member.roles.cache.values()].filter((r) => isProtectedRole(r.id)) : [];
    if (held.length) users.set(id, { direct: false, roles: held.map((r) => r.name) });
  }
  return { users, roles };
}

export function isExempt(member) {
  if (config.protectedUserIds.includes(member.id)) return true;
  return member.roles.cache.some((r) => isProtectedRole(r.id) || config.pingExemptRoleIds.includes(r.id));
}

const minutes = () => Math.round(config.pingTimeoutMs / 60000);

/** Returns true if the message was a protected ping and has been handled (it is deleted). */
export async function handleProtectedPing(message) {
  if (!message.guild || message.author?.bot || message.webhookId || !message.content) return false;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member)) return false;

  const { guild, channel, client } = message;
  const hit = await findProtectedPings(guild, message.content, message.author.id);
  if (!hit.users.size && !hit.roles.length) return false;

  // 1) Delete the message and 2) time the pinger out.
  const deleted = await message.delete().then(() => true, (err) => (log(`Anti-ping: could not delete the message (${err.message})`), false));
  let timedOut = false;
  if (member.moderatable) {
    timedOut = await member.timeout(config.pingTimeoutMs, 'Pinged a protected user or role').then(() => true, (err) => (log(`Anti-ping: could not time out ${member.user.tag} (${err.message})`), false));
  } else {
    log(`Anti-ping: cannot time out ${member.user.tag} (higher role, administrator or server owner)`);
  }

  // Who was pinged, as plain text (never re-ping them).
  const roleNames = hit.roles.map((id) => `@${guild.roles.cache.get(id)?.name ?? 'role'}`);
  const userNames = [...hit.users.keys()].map((id) => guild.members.cache.get(id)?.displayName ?? 'them');
  const targets = [...userNames, ...roleNames].map((n) => `**${n}**`).join(', ');
  const timeoutNote = timedOut ? ` You have been timed out for ${minutes()} minutes.` : '';

  // 3) Public reply, 4) DM the pinger, 5) DM the people who were pinged.
  const tasks = [
    channel
      .send(notice(`🚫 <@${message.author.id}>, please don't ping ${targets}. If you have a question or an issue, open a ticket instead.${timeoutNote}`, { color: config.accentWarn, mentions: { users: [message.author.id] } }))
      .catch((err) => log(`Anti-ping: could not post the reply (${err.message})`)),
    message.author
      .send(notice(`⚠️ Please don't ping ${targets}. If you have a question or an issue, open a ticket instead.${deleted ? ' Your message was deleted.' : ''}${timeoutNote}`, { color: config.accentWarn }))
      .catch(() => {}),
  ];

  const recipients = new Map(); // userId -> ways they were pinged
  const add = (id, way) => {
    if (id === message.author.id) return;
    recipients.set(id, [...(recipients.get(id) ?? []), way]);
  };
  for (const [id, info] of hit.users) {
    add(id, 'you');
    for (const name of info.roles) add(id, `your **@${name}** role`);
  }
  for (const roleId of hit.roles) {
    const role = guild.roles.cache.get(roleId);
    for (const m of role?.members?.values() ?? []) if (!m.user.bot) add(m.id, `the **@${role.name}** role`);
  }

  const dmed = [];
  let skippedForCap = 0;
  const pinger = member.displayName ?? message.author.username;
  for (const [id, ways] of recipients) {
    const key = `${message.author.id}:${id}`;
    if (Date.now() - (recentDms.get(key) ?? 0) < DM_COOLDOWN_MS) continue; // don't spam them if the pinger keeps going
    if (dmed.length >= MAX_DM_RECIPIENTS) {
      skippedForCap++;
      continue;
    }
    recentDms.set(key, Date.now());
    dmed.push(id);
    const text = `👋 Sorry about that! **${pinger}** pinged ${[...new Set(ways)].join(' and ')} in <#${channel.id}>. I've ${deleted ? 'deleted their message' : 'seen it'}${timedOut ? ` and timed them out for ${minutes()} minutes` : ''}.`;
    tasks.push(
      client.users
        .fetch(id)
        .then((u) => u.send(notice(text, { mentions: { parse: [] } })))
        .catch((err) => log(`Anti-ping: could not DM ${id} (${err.code === 50007 ? 'their DMs are closed' : err.message})`)),
    );
  }
  await Promise.allSettled(tasks);

  log(
    `Anti-ping: ${message.author.tag} pinged ${[...userNames, ...roleNames].join(', ')} in #${channel.name} -> message ${deleted ? 'deleted' : 'NOT deleted'}, ${timedOut ? `timed out ${minutes()}m` : 'NOT timed out'}, DMed ${dmed.length ? dmed.map((id) => client.users.cache.get(id)?.tag ?? id).join(', ') : 'nobody'}${skippedForCap ? ` (+${skippedForCap} not DMed: cap of ${MAX_DM_RECIPIENTS})` : ''}`,
  );
  return true;
}
