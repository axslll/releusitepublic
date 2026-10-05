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
import { aiEnabled, askAI, imageUrls, splitHandoff } from './ai.js';
import { config } from './config.js';
import { store } from './store.js';
import {
  aiMessage,
  closeConfirm,
  notice,
  offerMessage,
  offerResult,
  staffPanel,
  statsMessage,
  ticketMessage,
  V2_EPHEMERAL,
} from './ui.js';

const TICKET_PERMS = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
};
const MAX_HISTORY = 30;
const STAFF_HELP = [
  '**Staff controls** — inside the ticket, run `/staffpanel` (only staff can see it) to:',
  '• **Call Staff** — add other support members to the ticket',
  '• **Pause / Resume AI** — turn the AI helper off or on (it also pauses by itself once you reply)',
  '• **Claim** — take over a ticket nobody has accepted',
  'The **Close** button on the ticket ends it and saves a transcript.',
].join('\n');
const aiBusy = new Set();
const advancing = new Set(); // ticket numbers whose offer is being moved to the next person

export const isStaff = (member) =>
  Boolean(member?.roles.cache.has(config.supportRoleId) || member?.permissions.has(PermissionFlagsBits.Administrator));

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const who = (client, id) => {
  const u = client.users.cache.get(id);
  return u ? `${u.tag} (${id})` : String(id);
};

const ephemeral = (message, opts = {}) => notice(message, { ...opts, ephemeral: true });
const pad = (n) => String(n).padStart(4, '0');

async function staffIds(guild) {
  const role = (await guild.roles.fetch(config.supportRoleId).catch(() => null)) ?? null;
  if (!role) return [];
  if (role.members.size === 0) await guild.members.fetch().catch(() => {});
  return guild.roles.cache.get(config.supportRoleId).members.filter((m) => !m.user.bot).map((m) => m.id);
}

const ticketChannel = (client, ticket) => client.guilds.cache.get(ticket.guildId)?.channels.cache.get(ticket.channelId);

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

  const ticket = store.create({
    guildId: guild.id,
    userId: user.id,
    subject: interaction.fields.getTextInputValue('subject').trim(),
    description: interaction.fields.getTextInputValue('description').trim(),
  });

  let channel;
  try {
    const parent =
      config.categoryId && guild.channels.cache.get(config.categoryId)?.type === ChannelType.GuildCategory
        ? config.categoryId
        : undefined;
    const name = `ticket-${pad(ticket.number)}-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);

    // Only the opener and the bot can see it until a staff member accepts.
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent,
      topic: `Ticket #${ticket.number} • ${ticket.subject}`.slice(0, 1024),
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: Object.keys(TICKET_PERMS) },
        { id: guild.members.me.id, allow: [...Object.keys(TICKET_PERMS), 'ManageChannels'] },
      ],
    });
    store.update(ticket, { channelId: channel.id, ai: aiEnabled() });

    const sent = await channel.send({ ...ticketMessage(ticket), allowedMentions: { users: [user.id] } });
    store.update(ticket, { messageId: sent.id });
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    if (channel) await channel.delete().catch(() => {});
    store.remove(ticket);
    return interaction.editReply(
      notice('Something went wrong creating your ticket. Please try again or contact a staff member.', {
        color: config.accentWarn,
      }),
    );
  }

  log(`Ticket #${ticket.number} opened by ${who(interaction.client, user.id)}: "${ticket.subject}"`);
  await interaction.editReply(notice(`Your ticket is ready: <#${channel.id}>`, { color: config.accentOk }));
  await offerToNext(interaction.client, ticket).catch((e) => console.error('Offer failed:', e));

  // Answer the opening question right away instead of waiting for a second message.
  if (ticket.ai && aiEnabled()) {
    await runAI(channel, ticket, `${ticket.subject}\n\n${ticket.description}`.slice(0, 2000));
  }
}

/* ------------------------- offers (DM accept / skip) ------------------------ */

/** DMs the ticket to the next staff member in the fair rotation; escalates if there is nobody left. */
async function offerToNext(client, ticket) {
  if (advancing.has(ticket.number) || ticket.staffId) return;
  advancing.add(ticket.number);
  try {
    const guild = client.guilds.cache.get(ticket.guildId);
    const channel = ticketChannel(client, ticket);
    if (!guild || !channel) return;

    const staff = await staffIds(guild);
    const opener = await client.users.fetch(ticket.userId).catch(() => null);
    log(`Ticket #${ticket.number}: finding a staff member (${staff.length} in the support role, ${ticket.offered.length} already asked)`);

    for (;;) {
      const id = store.nextOffer(ticket, staff, config.offerTimeoutMs);
      if (!id) break;
      try {
        const user = await client.users.fetch(id);
        const dm = await user.send(offerMessage(ticket, opener?.username ?? 'Unknown user', guild.name));
        store.update(ticket, { offer: { ...ticket.offer, dmChannelId: dm.channelId, dmMessageId: dm.id } });
        log(`Ticket #${ticket.number}: DM sent to ${who(client, id)} - waiting until ${new Date(ticket.offer.expiresAt).toISOString()}`);
        await refreshTicketMessage(channel, ticket);
        return;
      } catch (err) {
        // DMs closed etc. - treat it like a skip and move on.
        log(`Ticket #${ticket.number}: could NOT DM ${who(client, id)} (${err.code === 50007 ? 'their DMs are closed' : err.message}) - trying the next person`);
        store.update(ticket, { offer: null });
      }
    }

    // Nobody left to ask: open the ticket to the whole support team so anyone can Claim it.
    log(`Ticket #${ticket.number}: nobody accepted - opened to the whole support team`);
    store.update(ticket, { escalated: true });
    await channel.permissionOverwrites.edit(config.supportRoleId, TICKET_PERMS).catch(() => {});
    await refreshTicketMessage(channel, ticket);
    await channel.send(
      notice(`<@&${config.supportRoleId}> nobody has accepted this ticket yet — if you can take it, run \`/staffpanel\` and press **Claim**.`, {
        mentions: { roles: [config.supportRoleId] },
      }),
    );
  } finally {
    advancing.delete(ticket.number);
  }
}

/** Clears the pending offer and rewrites the DM that carried it. */
async function endOffer(client, ticket, message, color) {
  const offer = ticket.offer;
  store.update(ticket, { offer: null });
  if (!offer?.dmChannelId) return;
  try {
    const dm = await client.channels.fetch(offer.dmChannelId);
    const msg = await dm.messages.fetch(offer.dmMessageId);
    await msg.edit(offerResult(message, { color }));
  } catch {
    /* DM gone - nothing to update */
  }
}

/** Gives the ticket to a staff member (accepted offer or manual claim). */
async function assignTicket(client, ticket, staffId) {
  const guild = client.guilds.cache.get(ticket.guildId);
  const channel = ticketChannel(client, ticket);
  store.assign(ticket, staffId, await staffIds(guild));
  await channel.permissionOverwrites.edit(staffId, TICKET_PERMS);
  await refreshTicketMessage(channel, ticket);
  log(`Ticket #${ticket.number}: now handled by ${who(client, staffId)}`);
  await channel.send(notice(`🛡️ <@${staffId}> is now handling this ticket.\n-# Staff: run \`/staffpanel\` to call other staff or pause/resume the AI.`, { mentions: { users: [staffId] } }));
}

export async function handleOffer(interaction) {
  const [, action, number] = interaction.customId.split(':');
  const ticket = store.byNumber(number);
  const gone = () =>
    interaction.update(
      offerResult('This offer is no longer available (it expired, was taken by someone else, or the ticket was closed).', {
        color: config.accentWarn,
      }),
    );

  if (!ticket || ticket.offer?.staffId !== interaction.user.id || ticket.offer.expiresAt <= Date.now()) return gone();

  if (action === 'skip') {
    log(`Ticket #${ticket.number}: ${who(interaction.client, interaction.user.id)} skipped it`);
    store.update(ticket, { offer: null });
    await interaction.update(offerResult(`⏭️ You skipped ticket #${pad(ticket.number)}. It has been passed on.`));
    return offerToNext(interaction.client, ticket);
  }

  const channel = ticketChannel(interaction.client, ticket);
  if (!channel) return gone();
  log(`Ticket #${ticket.number}: ${who(interaction.client, interaction.user.id)} accepted it`);
  await assignTicket(interaction.client, ticket, interaction.user.id);
  return interaction.update(
    offerResult(`✅ You accepted ticket #${pad(ticket.number)}.\n\n${STAFF_HELP}`, {
      color: config.accentOk,
      url: `https://discord.com/channels/${ticket.guildId}/${ticket.channelId}`,
    }),
  );
}

/** Moves on any offer that has run out of time. Runs on a timer and at startup. */
export async function sweepOffers(client) {
  const now = Date.now();
  for (const ticket of store.all()) {
    if (!ticket.channelId || !ticket.messageId || ticket.staffId || ticket.escalated || advancing.has(ticket.number)) continue;
    try {
      if (ticket.offer && ticket.offer.expiresAt <= now) {
        log(`Ticket #${ticket.number}: ${who(client, ticket.offer.staffId)} didn't respond in time - passing it on`);
        await endOffer(client, ticket, '⌛ You didn\'t respond in time, so this ticket was passed on.', config.accentWarn);
        await offerToNext(client, ticket);
      } else if (!ticket.offer) {
        await offerToNext(client, ticket); // e.g. the bot restarted mid-handoff
      }
    } catch (err) {
      console.error(`Sweep failed for ticket #${ticket.number}:`, err);
    }
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

    case 'ticket:claim': {
      if (!staff) return interaction.reply(ephemeral('Only support staff can claim tickets.', { color: config.accentWarn }));
      if (ticket.staffId === interaction.user.id) return interaction.reply(ephemeral("You're already handling this ticket.", { color: config.accentWarn }));
      await interaction.deferUpdate();
      const previous = ticket.staffId;
      if (previous) {
        // Taking over: the previous handler stays in the ticket as a helper.
        log(`Ticket #${ticket.number}: ${who(interaction.client, interaction.user.id)} took it over from ${who(interaction.client, previous)}`);
        if (!ticket.helpers.includes(previous)) store.update(ticket, { helpers: [...ticket.helpers, previous] });
      } else {
        log(`Ticket #${ticket.number}: ${who(interaction.client, interaction.user.id)} claimed it`);
      }
      await endOffer(interaction.client, ticket, '✋ Another staff member claimed this ticket.', config.accent);
      await assignTicket(interaction.client, ticket, interaction.user.id);
      return interaction.editReply(staffPanel(ticket, interaction.user.id));
    }

    case 'ticket:ai': {
      if (!staff) return interaction.reply(ephemeral('Only support staff can change this.', { color: config.accentWarn }));
      if (!aiEnabled()) return interaction.reply(ephemeral('The AI assistant is not configured.', { color: config.accentWarn }));
      store.update(ticket, { ai: !ticket.ai });
      await interaction.deferUpdate();
      await refreshTicketMessage(interaction.channel, ticket);
      return interaction.editReply(staffPanel(ticket, interaction.user.id));
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
    log(`Ticket #${ticket.number}: ${who(interaction.client, interaction.user.id)} called ${added.map((id) => who(interaction.client, id)).join(', ')}`);
    store.update(ticket, { helpers: [...ticket.helpers, ...added] });
    await interaction.channel.send(
      notice(`${added.map((id) => `<@${id}>`).join(' ')} — <@${interaction.user.id}> called you to this ticket.\n-# Run \`/staffpanel\` for the staff controls.`, {
        mentions: { users: added },
      }),
    );
    await refreshTicketMessage(interaction.channel, ticket);
  }

  const parts = [];
  if (added.length) parts.push(`Added ${added.map((id) => `<@${id}>`).join(', ')}.`);
  if (skipped.length) parts.push(`Skipped ${skipped.map((id) => `<@${id}>`).join(', ')} (not support staff, a bot, or already here).`);
  return interaction.update({
    ...ephemeral(parts.join('\n'), { color: added.length ? config.accentOk : config.accentWarn }),
    allowedMentions: { users: [] },
  });
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
  const header = `Ticket #${ticket.number} — ${ticket.subject}\nOpened by ${ticket.userId}, handled by ${ticket.staffId ?? 'nobody'}\n${'-'.repeat(40)}\n`;
  return header + lines.map((l) => `[${new Date(l.at).toISOString()}] ${l.who}: ${l.body}`).join('\n');
}

async function closeTicket(interaction, ticket) {
  const channel = interaction.channel;
  log(`Ticket #${ticket.number} closed by ${who(interaction.client, interaction.user.id)}`);
  try {
    if (config.logChannelId) {
      const log = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
      if (log?.isTextBased()) {
        const file = new AttachmentBuilder(Buffer.from(await buildTranscript(channel, ticket)), {
          name: `ticket-${pad(ticket.number)}.txt`,
        });
        await log.send({
          ...notice(
            `### 🔒 Ticket #${ticket.number} closed\n**Subject:** ${ticket.subject}\n**Opened by:** <@${ticket.userId}>\n**Handled by:** ${ticket.staffId ? `<@${ticket.staffId}>` : '—'}\n**Closed by:** <@${interaction.user.id}>`,
            { mentions: { parse: [] } },
          ),
          files: [file],
        });
      }
    }
  } catch (err) {
    console.error('Failed to save transcript:', err);
  }
  await endOffer(interaction.client, ticket, '🔒 This ticket was closed before you responded.');
  store.remove(ticket);
  await channel.send(notice('🔒 Closing this ticket in 5 seconds…', { color: config.accentWarn })).catch(() => {});
  setTimeout(() => channel.delete(`Ticket closed by ${interaction.user.tag}`).catch(() => {}), 5000);
}

export async function cleanupChannel(channel) {
  const ticket = store.byChannel(channel.id);
  if (!ticket) return;
  await endOffer(channel.client, ticket, '🔒 This ticket was closed before you responded.');
  store.remove(ticket);
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

  const images = imageUrls([...message.attachments.values()]);
  if (!ticket.ai || !aiEnabled() || (!message.content.trim() && !images.length)) return;
  await runAI(message.channel, ticket, message.content.slice(0, 2000), images);
}

/** Asks the AI to answer `userText`, posts the reply, and calls staff if the AI hands over. */
async function runAI(channel, ticket, userText, images = []) {
  if (aiBusy.has(ticket.number)) return;
  aiBusy.add(ticket.number);
  try {
    await channel.sendTyping();
    // Images aren't stored: the saved history keeps a text note, so later text-only turns still know one was sent.
    const note = images.length ? `[The user attached ${images.length} image${images.length > 1 ? 's' : ''}]` : '';
    const content = [userText.trim(), note].filter(Boolean).join('\n');
    const history = [...ticket.history, { role: 'user', content, at: Date.now() }];
    const { answer, model } = await askAI(ticket, history.slice(-12), images);
    log(`Ticket #${ticket.number}: AI replied using ${model}${images.length ? ` (${images.length} image${images.length > 1 ? 's' : ''})` : ''}`);
    const { text, handoff } = splitHandoff(answer);
    store.update(ticket, {
      history: [...history, { role: 'assistant', content: text || answer, at: Date.now() }].slice(-MAX_HISTORY),
    });
    if (text) await channel.send(aiMessage(text));
    if (handoff) await callStaffForHelp(channel, ticket, !text);
  } catch (err) {
    console.error('AI reply failed:', err.message);
    await channel
      .send(notice('🤖 The AI assistant is unavailable right now — a support member will help you.', { color: config.accentWarn }))
      .catch(() => {});
  } finally {
    aiBusy.delete(ticket.number);
  }
}

/** The AI gave up (it wrote [CALL STAFF]): pause it and get a human's attention. */
async function callStaffForHelp(channel, ticket, needsIntro) {
  log(`Ticket #${ticket.number}: the AI handed over to staff`);
  store.update(ticket, { ai: false });
  await refreshTicketMessage(channel, ticket);

  const intro = needsIntro ? "I can't help with this one, so I'm calling a support member for you. " : '';
  if (ticket.staffId) {
    await channel.send(
      notice(`🙋 ${intro}<@${ticket.staffId}> — <@${ticket.userId}> needs a human.`, { mentions: { users: [ticket.staffId, ticket.userId] } }),
    );
  } else if (ticket.escalated) {
    await channel.send(
      notice(`🙋 ${intro}<@&${config.supportRoleId}> — <@${ticket.userId}> needs a human. Run \`/staffpanel\` and press **Claim**.`, {
        mentions: { roles: [config.supportRoleId], users: [ticket.userId] },
      }),
    );
  } else {
    await channel.send(
      notice(`🙋 ${intro}A support member has been asked and will join as soon as one accepts this ticket.`, { mentions: { users: [] } }),
    );
  }
}

/* ---------------------------------- stats ---------------------------------- */

export async function handleStats(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Support staff only.', { color: config.accentWarn }));
  const staff = await staffIds(interaction.guild);
  const totals = store.totals();
  const tickets = store.all();
  const rows = staff
    .map((id) => ({
      id,
      total: totals[id] ?? 0,
      open: tickets.filter((t) => t.staffId === id).length,
      pending: tickets.filter((t) => !t.staffId && t.offer?.staffId === id).length,
    }))
    .sort((a, b) => b.total - a.total);
  return interaction.reply(statsMessage(rows));
}

export async function handleStaffPanel(interaction) {
  const ticket = store.byChannel(interaction.channelId);
  if (!ticket) return interaction.reply(ephemeral('Run this inside a ticket channel.', { color: config.accentWarn }));
  if (!isStaff(interaction.member)) return interaction.reply(ephemeral('Support staff only.', { color: config.accentWarn }));
  return interaction.reply(staffPanel(ticket, interaction.user.id));
}
