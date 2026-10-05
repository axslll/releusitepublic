import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { aiEnabled, askAI } from './ai.js';
import { config } from './config.js';
import { store } from './store.js';
import { aiMessage, closeConfirm, notice, statsMessage, ticketMessage, V2_EPHEMERAL } from './ui.js';

const TICKET_PERMS = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
};
const MAX_HISTORY = 30;
const aiBusy = new Set();

export const isStaff = (member) =>
  Boolean(member?.roles.cache.has(config.supportRoleId) || member?.permissions.has(PermissionFlagsBits.Administrator));

const ephemeral = (message, opts = {}) => notice(message, { ...opts, ephemeral: true });

async function staffIds(guild) {
  let role = guild.roles.cache.get(config.supportRoleId) ?? (await guild.roles.fetch(config.supportRoleId));
  if (!role) return [];
  if (role.members.size === 0) await guild.members.fetch();
  role = guild.roles.cache.get(config.supportRoleId);
  return role.members.filter((m) => !m.user.bot).map((m) => m.id);
}

async function refreshTicketMessage(channel, ticket) {
  if (!ticket.messageId) return;
  const msg = await channel.messages.fetch(ticket.messageId).catch(() => null);
  if (msg) await msg.edit(ticketMessage(ticket)).catch(() => {});
}

/* ---------------------------------- open ---------------------------------- */

export async function handleOpenButton(interaction) {
  const open = store.openByUser(interaction.user.id);
  if (open.length >= config.maxOpenPerUser) {
    const links = open.map((t) => `<#${t.channelId}>`).join(', ');
    return interaction.reply(ephemeral(`You already have an open ticket: ${links}`, { color: config.accentWarn }));
  }
  const modal = new ModalBuilder()
    .setCustomId('ticket:modal')
    .setTitle('Open a support ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('subject')
          .setLabel('Subject')
          .setPlaceholder('A short summary of your issue')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('How can we help?')
          .setPlaceholder('Describe the problem in as much detail as you can')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

export async function handleModal(interaction) {
  await interaction.deferReply({ flags: V2_EPHEMERAL });
  const { guild, user } = interaction;

  if (store.openByUser(user.id).length >= config.maxOpenPerUser) {
    return interaction.editReply(notice('You already have an open ticket.', { color: config.accentWarn }));
  }

  const subject = interaction.fields.getTextInputValue('subject').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const staff = await staffIds(guild);
  const ticket = store.create({ userId: user.id, subject, description, staffIds: staff });

  try {
    const parent = config.categoryId && guild.channels.cache.get(config.categoryId)?.type === ChannelType.GuildCategory
      ? config.categoryId
      : undefined;
    const name = `ticket-${String(ticket.number).padStart(4, '0')}-${user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: Object.keys(TICKET_PERMS) },
      { id: guild.members.me.id, allow: [...Object.keys(TICKET_PERMS), 'ManageChannels'] },
    ];
    if (ticket.staffId) overwrites.push({ id: ticket.staffId, allow: Object.keys(TICKET_PERMS) });

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent,
      topic: `Ticket #${ticket.number} • ${subject}`.slice(0, 1024),
      permissionOverwrites: overwrites,
    });
    store.update(ticket, { channelId: channel.id });

    const sent = await channel.send({
      ...ticketMessage({ ...ticket, ai: ticket.ai && aiEnabled() }),
      allowedMentions: { users: [user.id, ...(ticket.staffId ? [ticket.staffId] : [])] },
    });
    store.update(ticket, { messageId: sent.id, ai: ticket.ai && aiEnabled() });

    const ping = ticket.staffId ? `<@${ticket.staffId}>` : `<@&${config.supportRoleId}>`;
    await channel.send(
      notice(`${ping}, <@${user.id}> needs help. ${aiEnabled() ? 'While you get here, the AI assistant will answer questions.' : ''}`, {
        mentions: ticket.staffId ? { users: [ticket.staffId] } : { roles: [config.supportRoleId] },
      }),
    );

    return interaction.editReply(notice(`Your ticket is ready: <#${channel.id}>`, { color: config.accentOk }));
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    store.abort(ticket);
    return interaction.editReply(
      notice('Something went wrong creating your ticket. Please try again or contact a staff member.', {
        color: config.accentWarn,
      }),
    );
  }
}

/* ------------------------------ ticket buttons ----------------------------- */

export async function handleTicketButton(interaction) {
  const ticket = store.byChannel(interaction.channelId);
  if (!ticket) return interaction.reply(ephemeral('This ticket no longer exists.', { color: config.accentWarn }));

  const staff = isStaff(interaction.member);
  const owner = interaction.user.id === ticket.userId;

  switch (interaction.customId) {
    case 'ticket:close':
      if (!staff && !owner) return interaction.reply(ephemeral('Only the ticket owner or staff can close this.', { color: config.accentWarn }));
      return interaction.reply(closeConfirm());

    case 'ticket:close:no':
      return interaction.update(ephemeral('Cancelled — the ticket stays open.'));

    case 'ticket:close:yes':
      if (!staff && !owner) return interaction.reply(ephemeral('Only the ticket owner or staff can close this.', { color: config.accentWarn }));
      await interaction.update(ephemeral('Closing…'));
      return closeTicket(interaction, ticket);

    case 'ticket:ai': {
      if (!staff) return interaction.reply(ephemeral('Only support staff can change this.', { color: config.accentWarn }));
      if (!aiEnabled()) return interaction.reply(ephemeral('The AI assistant is not configured.', { color: config.accentWarn }));
      store.update(ticket, { ai: !ticket.ai });
      await interaction.deferUpdate();
      return refreshTicketMessage(interaction.channel, ticket);
    }

    case 'ticket:add': {
      if (!staff) return interaction.reply(ephemeral('Only support staff can call other staff.', { color: config.accentWarn }));
      const select = new UserSelectMenuBuilder()
        .setCustomId('ticket:addselect')
        .setPlaceholder('Pick the staff members to call')
        .setMinValues(1)
        .setMaxValues(5);
      const reply = ephemeral('Who should join this ticket?');
      reply.components[0].addActionRowComponents(new ActionRowBuilder().addComponents(select));
      return interaction.reply(reply);
    }
  }
}

export async function handleStaffSelect(interaction) {
  const ticket = store.byChannel(interaction.channelId);
  if (!ticket) return interaction.update(ephemeral('This ticket no longer exists.'));
  if (!isStaff(interaction.member)) return interaction.update(ephemeral('Only support staff can do this.'));

  const added = [];
  const skipped = [];
  for (const id of interaction.values) {
    const member = await interaction.guild.members.fetch(id).catch(() => null);
    const already = id === ticket.staffId || ticket.helpers.includes(id);
    if (!member || member.user.bot || !member.roles.cache.has(config.supportRoleId) || already) {
      skipped.push(id);
      continue;
    }
    await interaction.channel.permissionOverwrites.edit(id, TICKET_PERMS);
    added.push(id);
  }

  if (added.length) {
    store.update(ticket, { helpers: [...ticket.helpers, ...added] });
    await interaction.channel.send(
      notice(`${added.map((id) => `<@${id}>`).join(' ')} — <@${interaction.user.id}> called you to this ticket.`, {
        mentions: { users: added },
      }),
    );
    await refreshTicketMessage(interaction.channel, ticket);
  }

  const parts = [];
  if (added.length) parts.push(`Added ${added.map((id) => `<@${id}>`).join(', ')}.`);
  if (skipped.length) parts.push(`Skipped ${skipped.map((id) => `<@${id}>`).join(', ')} (not support staff, a bot, or already here).`);
  return interaction.update({ ...ephemeral(parts.join('\n'), { color: added.length ? config.accentOk : config.accentWarn }), allowedMentions: { users: [] } });
}

/* --------------------------------- closing --------------------------------- */

async function buildTranscript(channel, ticket) {
  const lines = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const m of batch.values()) {
      if (m.author.bot) continue;
      const files = m.attachments.map((a) => a.url).join(' ');
      lines.push({ at: m.createdTimestamp, who: m.author.tag, body: `${m.content} ${files}`.trim() });
    }
    before = batch.last().id;
  }
  for (const h of ticket.history) if (h.role === 'assistant') lines.push({ at: h.at, who: 'Selyn AI', body: h.content });
  lines.sort((a, b) => a.at - b.at);
  const header = `Ticket #${ticket.number} — ${ticket.subject}\nOpened by ${ticket.userId}, assigned to ${ticket.staffId ?? 'nobody'}\n${'-'.repeat(40)}\n`;
  return header + lines.map((l) => `[${new Date(l.at).toISOString()}] ${l.who}: ${l.body}`).join('\n');
}

async function closeTicket(interaction, ticket) {
  const channel = interaction.channel;
  try {
    if (config.logChannelId) {
      const log = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
      if (log?.isTextBased()) {
        const file = new AttachmentBuilder(Buffer.from(await buildTranscript(channel, ticket)), {
          name: `ticket-${String(ticket.number).padStart(4, '0')}.txt`,
        });
        await log.send({
          ...notice(
            `### 🔒 Ticket #${ticket.number} closed\n**Subject:** ${ticket.subject}\n**Opened by:** <@${ticket.userId}>\n**Assigned to:** ${ticket.staffId ? `<@${ticket.staffId}>` : '—'}\n**Closed by:** <@${interaction.user.id}>`,
            { mentions: { parse: [] } },
          ),
          files: [file],
        });
      }
    }
  } catch (err) {
    console.error('Failed to save transcript:', err);
  }
  store.remove(ticket);
  await channel.send(notice('🔒 Closing this ticket in 5 seconds…', { color: config.accentWarn })).catch(() => {});
  setTimeout(() => channel.delete(`Ticket closed by ${interaction.user.tag}`).catch(() => {}), 5000);
}

/* ------------------------------------ AI ----------------------------------- */

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;
  const ticket = store.byChannel(message.channelId);
  if (!ticket) return;

  // A staff member joining the conversation pauses the AI.
  if (message.author.id !== ticket.userId) {
    if (ticket.ai && isStaff(message.member)) {
      store.update(ticket, { ai: false });
      await refreshTicketMessage(message.channel, ticket);
    }
    return;
  }

  if (!ticket.ai || !aiEnabled() || !message.content.trim() || aiBusy.has(ticket.number)) return;
  aiBusy.add(ticket.number);
  try {
    await message.channel.sendTyping();
    const history = [...ticket.history, { role: 'user', content: message.content.slice(0, 2000), at: Date.now() }];
    // The ticket's own subject/description are already in the system prompt.
    const answer = await askAI(ticket, history.slice(-12));
    store.update(ticket, {
      history: [...history, { role: 'assistant', content: answer, at: Date.now() }].slice(-MAX_HISTORY),
    });
    await message.channel.send(aiMessage(answer));
  } catch (err) {
    console.error('AI reply failed:', err.message);
    await message.channel
      .send(notice('🤖 The AI assistant is unavailable right now — your assigned staff member will help you.', { color: config.accentWarn }))
      .catch(() => {});
  } finally {
    aiBusy.delete(ticket.number);
  }
}

/* ---------------------------------- stats ---------------------------------- */

export async function handleStats(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Support staff only.', { color: config.accentWarn }));
  const staff = await staffIds(interaction.guild);
  const totals = store.totals();
  const open = store.all();
  const rows = staff
    .map((id) => ({ id, total: totals[id] ?? 0, open: open.filter((t) => t.staffId === id).length }))
    .sort((a, b) => b.total - a.total);
  return interaction.reply(statsMessage(rows));
}

export function cleanupChannel(channel) {
  const ticket = store.byChannel(channel.id);
  if (ticket) store.remove(ticket);
}
