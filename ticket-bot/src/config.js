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
  // Chat moderation with a local model (see src/moderation.js). Thresholds are 0..1; higher = fewer deletions.
  moderationEnabled: process.env.MODERATION !== 'off',
  moderationDryRun: process.env.MODERATION_DRY_RUN === 'true', // only log what it would delete
  moderationModelId: process.env.MODERATION_MODEL_ID || 'Xenova/toxic-bert',
  moderationThresholds: {
    hate: num(process.env.MOD_HATE_THRESHOLD, 0.5), // racism / hatred of a group
    insult: num(process.env.MOD_INSULT_THRESHOLD, 0.5), // insult aimed at someone...
    obscene: num(process.env.MOD_OBSCENE_THRESHOLD, 0.9), // ...that is also strongly profane
  },
  moderationTimeoutMs: num(process.env.MOD_TIMEOUT_MINUTES, 0) * 60 * 1000, // 0 = just delete
  moderationLogScores: process.env.MOD_LOG_SCORES === 'true', // log every checked message with its scores (to tune the thresholds)
  moderationLogChannelId: process.env.MOD_LOG_CHANNEL_ID || null,
  // Moderation pauses itself when it uses more than this share of the whole machine's CPU, then resumes.
  moderationCpuLimit: num(process.env.MOD_CPU_LIMIT_PERCENT, 25),
  moderationCpuWindowMs: num(process.env.MOD_CPU_WINDOW_SECONDS, 30) * 1000,
  moderationCpuPauseMs: num(process.env.MOD_CPU_PAUSE_MINUTES, 5) * 60 * 1000,
  moderationCommandRoleId: process.env.MOD_COMMAND_ROLE_ID || '1556268367659147284', // who may use /moderation
  moderationMinMemoryMb: num(process.env.MOD_MIN_MEMORY_MB, 900), // below this container memory limit the model is not loaded (it needs ~700 MB)
  moderationMaxQueue: 25, // if more messages than this are waiting, extras skip the check instead of piling up
  accent: 0x7c5cff,
  accentOk: 0x3ba55d,
  accentWarn: 0xed4245,
};
