import 'dotenv/config';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const config = {
  botName: 'Selyn Support Tickets',
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID || null,
  supportRoleId: process.env.SUPPORT_ROLE_ID || '1556338723958816778',
  categoryId: process.env.TICKET_CATEGORY_ID || null,
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  offerTimeoutMs: num(process.env.OFFER_TIMEOUT_HOURS, 3) * 60 * 60 * 1000,
  maxOpenPerUser: num(process.env.MAX_OPEN_PER_USER, 1),
  groqKey: process.env.GROQ_API_KEY || null,
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  accent: 0x7c5cff,
  accentOk: 0x3ba55d,
  accentWarn: 0xed4245,
};
