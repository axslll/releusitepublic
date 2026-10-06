import 'dotenv/config';

const list = (v, d = []) => (v ? v.split(/[\s,]+/).filter(Boolean) : d);
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
  groqKeyBackup: process.env.GROQ_API_KEY_BACKUP || null, // used when the primary key is rate limited or rejected
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', // text-only turns
  groqVisionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b', // used only for the reply to a message with images
  // Anti-ping: nobody may ping these users / roles. See src/antiping.js.
  protectedUserIds: list(process.env.PROTECTED_USER_IDS, ['880060587697123370']),
  protectedRoleIds: list(process.env.PROTECTED_ROLE_IDS, ['1556917397280260167', '1556917485733941280']),
  pingExemptRoleIds: list(process.env.PING_EXEMPT_ROLE_IDS), // roles that may ping them anyway (members of the protected roles always may)
  pingTimeoutMs: num(process.env.PING_TIMEOUT_MINUTES, 5) * 60 * 1000,
  accent: 0x7c5cff,
  accentOk: 0x3ba55d,
  accentWarn: 0xed4245,
};
