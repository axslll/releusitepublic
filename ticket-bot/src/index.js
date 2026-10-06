import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { aiEnabled } from './ai.js';
import { handleProtectedPing } from './antiping.js';
import { handleModeration, handleModerationCommand, startModeration } from './moderation.js';
import { config } from './config.js';
import {
  cleanupChannel,
  handleMessage,
  handleModal,
  handleOffer,
  handleOpenButton,
  handleStaffPanel,
  handleStaffSelect,
  handleStats,
  handleTicketButton,
  sweepOffers,
} from './tickets.js';
import { notice, panelMessage } from './ui.js';

if (!config.token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: needed to see who has the support role
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: needed so the AI can read the ticket opener's messages
  ],
  partials: [Partials.Message], // so edits to old (uncached) messages are still seen by the anti-ping check
});

const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post the "open a ticket" panel')
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('staffpanel').setDescription('Staff controls for this ticket (claim, call staff, pause AI)'),
  new SlashCommandBuilder()
    .setName('moderation')
    .setDescription('Turn the chat moderation on or off (moderation role only)')
    .addStringOption((o) =>
      o
        .setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
          { name: 'test mode on (also check protected users, 30 min)', value: 'test_on' },
          { name: 'test mode off', value: 'test_off' },
        ),
    ),
  new SlashCommandBuilder().setName('ticketstats').setDescription('Show how tickets are distributed across support staff'),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} • AI ${aiEnabled() ? `on (${config.groqModel})` : 'off (no GROQ_API_KEY)'}`);
  if (config.guildId) {
    const guild = await c.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
  } else {
    await c.application.commands.set(commands);
  }
  for (const guild of c.guilds.cache.values()) await guild.members.fetch().catch(() => {});

  startModeration(c); // loads the local moderation model in the background (never blocks or crashes the bot)

  // Move on any ticket offer that wasn't answered in time (also catches offers that expired while offline).
  const sweep = () => sweepOffers(c).catch((e) => console.error('Offer sweep failed:', e));
  await sweep();
  setInterval(sweep, 30_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketstats') return await handleStats(interaction);
      if (interaction.commandName === 'staffpanel') return await handleStaffPanel(interaction);
      if (interaction.commandName === 'moderation') return await handleModerationCommand(interaction);
      if (interaction.commandName === 'ticketpanel') {
        // Discord already hides this from non-admins, but never trust that alone.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
          return await interaction.reply(notice('Only administrators can use this command.', { ephemeral: true, color: config.accentWarn }));
        }
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        await channel.send(panelMessage());
        return await interaction.reply(notice(`Panel posted in <#${channel.id}>.`, { ephemeral: true }));
      }
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith('offer:')) return await handleOffer(interaction);
      if (interaction.customId === 'ticket:open') return await handleOpenButton(interaction);
      if (interaction.customId.startsWith('ticket:')) return await handleTicketButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId === 'ticket:modal') {
      return await handleModal(interaction);
    } else if (interaction.isUserSelectMenu() && interaction.customId === 'ticket:addselect') {
      return await handleStaffSelect(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const reply = notice('Something went wrong. Please try again.', { ephemeral: true });
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (await handleProtectedPing(message)) return; // deleted: nothing else to do with it
    if (await handleModeration(message)) return; // removed by moderation: the ticket AI must not see it either
    await handleMessage(message);
  } catch (e) {
    console.error('Message error:', e);
  }
});

// Editing a ping into an existing message must not get around the anti-ping check.
client.on(Events.MessageUpdate, async (_old, updated) => {
  try {
    const message = updated.partial ? await updated.fetch().catch(() => null) : updated;
    if (message && !(await handleProtectedPing(message))) await handleModeration(message);
  } catch (e) {
    console.error('Message update error:', e);
  }
});
client.on(Events.ChannelDelete, (channel) => cleanupChannel(channel));

client.login(config.token);
