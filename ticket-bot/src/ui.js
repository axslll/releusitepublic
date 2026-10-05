import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { config } from './config.js';

export const V2 = MessageFlags.IsComponentsV2;
export const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const btn = (id, label, style, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
};
const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

/** The "open a ticket" panel posted by /ticketpanel. */
export function panelMessage() {
  const c = new ContainerBuilder()
    .setAccentColor(config.accent)
    .addTextDisplayComponents(
      text('# 🎫 Selyn Support'),
      text('Need a hand? Open a ticket and a member of our team will be with you shortly.'),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          '**How it works**',
          '> **1.** Press the button below',
          '> **2.** Tell us what you need help with',
          '> **3.** A support member is assigned to you, and our AI assistant can help right away',
        ].join('\n'),
      ),
    )
    .addActionRowComponents(row(btn('ticket:open', 'Open a Ticket', ButtonStyle.Primary, '🎫')))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`-# ${config.botName}`));
  return { components: [c], flags: V2 };
}

/** The main message inside a ticket channel. */
export function ticketMessage(ticket) {
  const helpers = ticket.helpers.length ? ticket.helpers.map((id) => `<@${id}>`).join(', ') : '—';
  const assigned = ticket.staffId
    ? `<@${ticket.staffId}>`
    : ticket.offer
      ? '⏳ Waiting for a support member to accept'
      : ticket.escalated
        ? '📣 Open to the whole support team — press **Claim**'
        : '⏳ Finding a support member…';
  const c = new ContainerBuilder()
    .setAccentColor(config.accent)
    .addTextDisplayComponents(
      text(`# 🎫 Ticket #${String(ticket.number).padStart(4, '0')}`),
      text(`**${clip(ticket.subject, 100)}**`),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(
        [
          `👤 **Opened by** <@${ticket.userId}>`,
          `🛡️ **Assigned to** ${assigned}`,
          `👥 **Also helping** ${helpers}`,
          `🤖 **AI assistant** ${ticket.ai ? '`● Active`' : '`○ Paused`'}`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`**Description**\n${clip(ticket.description, 1500)}`))
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        btn('ticket:close', 'Close', ButtonStyle.Danger, '🔒'),
        ...(ticket.staffId ? [] : [btn('ticket:claim', 'Claim', ButtonStyle.Success, '✋')]),
        btn('ticket:add', 'Call Staff', ButtonStyle.Secondary, '👥'),
        btn('ticket:ai', ticket.ai ? 'Pause AI' : 'Resume AI', ButtonStyle.Secondary, '🤖'),
      ),
    )
    .addTextDisplayComponents(text(`-# ${config.botName} • opened <t:${Math.floor(ticket.createdAt / 1000)}:R>`));
  return { components: [c], flags: V2, allowedMentions: { users: [] } };
}

/** An AI reply inside a ticket. */
export function aiMessage(answer) {
  const c = new ContainerBuilder()
    .setAccentColor(config.accent)
    .addTextDisplayComponents(text('-# 🤖 Selyn AI Assistant'), text(clip(answer, 3500)))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text('-# Not what you needed? Your assigned staff member will take over.'));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
}

/** A small status / info card. */
export function notice(message, { color = config.accent, ephemeral = false, mentions } = {}) {
  const c = new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(message));
  const out = { components: [c], flags: ephemeral ? V2_EPHEMERAL : V2 };
  if (mentions) out.allowedMentions = mentions;
  return out;
}

export function closeConfirm() {
  const c = new ContainerBuilder()
    .setAccentColor(config.accentWarn)
    .addTextDisplayComponents(text('### Close this ticket?\nThe channel will be deleted and a transcript saved.'))
    .addActionRowComponents(
      row(
        btn('ticket:close:yes', 'Yes, close it', ButtonStyle.Danger, '🔒'),
        btn('ticket:close:no', 'Cancel', ButtonStyle.Secondary),
      ),
    );
  return { components: [c], flags: V2_EPHEMERAL };
}

export function statsMessage(rows) {
  const lines = rows.length
    ? rows.map((r) => `<@${r.id}> — **${r.open}** open • **${r.pending}** offered • **${r.total}** accepted in total`).join('\n')
    : 'No support staff found.';
  const c = new ContainerBuilder()
    .setAccentColor(config.accent)
    .addTextDisplayComponents(text('# 📊 Ticket distribution'), text(lines))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(`-# ${config.botName}`));
  return { components: [c], flags: V2_EPHEMERAL, allowedMentions: { users: [] } };
}

/** The DM sent to a support member offering them a ticket. */
export function offerMessage(ticket, openerName, guildName) {
  const c = new ContainerBuilder()
    .setAccentColor(config.accent)
    .addTextDisplayComponents(
      text(`# 🎫 New ticket for you — #${String(ticket.number).padStart(4, '0')}`),
      text(`**${clip(ticket.subject, 100)}**`),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(`👤 **From** ${openerName} in **${guildName}**\n\n${clip(ticket.description, 900)}`),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      text(`Do you want to take this one? Respond <t:${Math.floor(ticket.offer.expiresAt / 1000)}:R> or it moves on to the next support member.`),
    )
    .addActionRowComponents(
      row(
        btn(`offer:accept:${ticket.number}`, 'Accept', ButtonStyle.Success, '✅'),
        btn(`offer:skip:${ticket.number}`, 'Skip', ButtonStyle.Secondary, '⏭️'),
      ),
    )
    .addTextDisplayComponents(text(`-# ${config.botName}`));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
}

/** What the offer DM turns into once it's answered, expired or withdrawn. */
export function offerResult(message, { color = config.accent, url } = {}) {
  const c = new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(text(message));
  if (url) c.addActionRowComponents(row(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open ticket').setURL(url)));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
}
