import { config } from './config.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const MAX_LISTED = 50;

async function describeRole(guild, roleId, label) {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    log(`${label}: role ${roleId} was NOT found in "${guild.name}" - check the role ID`);
    return;
  }
  const members = [...role.members.values()].filter((m) => !m.user.bot);
  if (!members.length) {
    log(`${label}: role "${role.name}" (${roleId}) has NO members I can see - nobody gets tickets offered. Is the Server Members Intent on?`);
    return;
  }
  const shown = members.slice(0, MAX_LISTED).map((m) => `${m.user.tag} (${m.id})`);
  const more = members.length > MAX_LISTED ? ` ... and ${members.length - MAX_LISTED} more` : '';
  log(`${label}: role "${role.name}" (${roleId}) - ${members.length} member${members.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`);
}

/** Logs, at startup, who is on the support team (gets ticket offers) and who can use /moderation. */
export async function logTeams(client) {
  for (const guild of client.guilds.cache.values()) {
    if (config.guildId && guild.id !== config.guildId) continue;
    await describeRole(guild, config.supportRoleId, 'Ticket support team');
    await describeRole(guild, config.moderationCommandRoleId, '/moderation role');
  }
}
