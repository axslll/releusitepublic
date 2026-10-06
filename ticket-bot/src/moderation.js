import os from 'node:os';
import { config } from './config.js';
import { isExempt } from './antiping.js';
import { CpuGuard } from './cpuguard.js';
import { store } from './store.js';
import { notice } from './ui.js';

/**
 * Chat moderation with a local model (toxic-bert) - no word list and no external API.
 *
 * The model scores every message on six labels. Only two things are acted on:
 *   - hate:  racism / hatred of a group (identity_hate), and
 *   - abuse: strong profanity aimed at a person (a high "insult" score together with a high "obscene" score).
 * Swearing that isn't aimed at anyone ("fucking hell, I forgot to do this") and mild insults ("dumb", "stupid")
 * score too low on one of the two and are left alone.
 *
 * It is optional and switches itself off safely:
 *   - if @huggingface/transformers isn't installed or the model can't load, moderation is simply off;
 *   - if it uses more than MOD_CPU_LIMIT_PERCENT of the machine's CPU it pauses for a while, then resumes;
 *   - staff with the moderation role can turn it on/off with /moderation.
 */

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const REASONS = {
  hate: 'contained hateful or discriminatory language',
  abuse: 'contained strong profanity aimed at another person',
};

let now = () => Date.now();
let classifier = null; // (text, options) => Promise<[{label, score}]>
let state = 'idle'; // idle | loading | ready | unavailable
let pending = 0;
let chain = Promise.resolve();
let pausedUntil = 0; // set when the CPU guard trips
let discordClient = null;
const stats = { checked: 0, deleted: 0 };
const guard = new CpuGuard({
  limitPercent: config.moderationCpuLimit,
  windowMs: config.moderationCpuWindowMs,
  cores: os.cpus().length,
  now: () => now(),
});

/* ---- test hooks ---- */
export function _setClassifier(fn) {
  classifier = fn;
  state = fn ? 'ready' : 'idle';
  pausedUntil = 0;
  guard.reset();
}
export const _setState = (s) => (state = s);
export const _setNow = (fn) => (now = fn);
export const _guard = guard;
export const _resetStats = () => Object.assign(stats, { checked: 0, deleted: 0 });

/** Posts a short status card to the moderation log channel, if one is set. */
async function announce(text) {
  if (!discordClient || !config.moderationLogChannelId) return;
  try {
    const channel = await discordClient.channels.fetch(config.moderationLogChannelId);
    if (channel?.isTextBased()) await channel.send(notice(text, { color: config.accentWarn, mentions: { parse: [] } }));
  } catch {
    /* the log channel is optional */
  }
}

/** Loads the model in the background at startup. Never throws. */
export async function startModeration(client = null) {
  discordClient = client;
  if (!config.moderationEnabled) return log('Moderation is OFF (MODERATION=off)');
  if (state !== 'idle') return;
  state = 'loading';
  try {
    log(`Moderation: loading ${config.moderationModelId} (the first run downloads ~110 MB)...`);
    const { pipeline } = await import('@huggingface/transformers');
    classifier = await pipeline('text-classification', config.moderationModelId);
    state = 'ready';
    const manual = store.getSetting('moderationEnabled', true) ? '' : ' - but staff have it switched OFF (/moderation on)';
    log(`Moderation is ready${config.moderationDryRun ? ' (DRY RUN: only logs what it would delete)' : ''}${manual}`);
  } catch (err) {
    state = 'unavailable';
    log(`Moderation is OFF - the local model isn't available (${err.message.split('\n')[0]}). Run "npm install" to add it.`);
  }
}

/* ---- on / off / paused ---- */

/** Resumes by itself once the CPU pause is over. */
function checkResume() {
  if (pausedUntil && pausedUntil <= now()) {
    pausedUntil = 0;
    guard.reset();
    log('Moderation: resumed after the CPU pause');
    announce('✅ Chat moderation has resumed after its CPU pause.');
  }
}

function pauseForCpu() {
  const percent = guard.percent();
  pausedUntil = now() + config.moderationCpuPauseMs;
  const minutes = Math.round(config.moderationCpuPauseMs / 60000);
  log(`Moderation: PAUSED for ${minutes} min - it used ${percent.toFixed(1)}% of the machine's CPU (limit ${config.moderationCpuLimit}%)`);
  announce(`⏸️ Chat moderation paused for ${minutes} minutes: it used ${percent.toFixed(1)}% of the machine's CPU (limit ${config.moderationCpuLimit}%). It will switch itself back on.`);
}

/** Where moderation currently stands. */
export function moderationStatus() {
  checkResume();
  const base = { cpu: guard.percent(), limit: config.moderationCpuLimit, windowSeconds: Math.round(config.moderationCpuWindowMs / 1000), ...stats, dryRun: config.moderationDryRun };
  if (!config.moderationEnabled) return { ...base, state: 'disabled' }; // MODERATION=off in .env
  if (state === 'unavailable') return { ...base, state: 'unavailable' };
  if (state !== 'ready') return { ...base, state: 'loading' };
  if (!store.getSetting('moderationEnabled', true)) return { ...base, state: 'off' }; // staff turned it off
  if (pausedUntil > now()) return { ...base, state: 'paused', resumesAt: pausedUntil };
  return { ...base, state: 'on' };
}

/** `/moderation on|off|status` - only for people with MOD_COMMAND_ROLE_ID. */
export async function handleModerationCommand(interaction) {
  const reply = (text, color) => interaction.reply(notice(text, { ephemeral: true, color: color ?? config.accent, mentions: { parse: [] } }));
  if (!interaction.member?.roles?.cache?.has(config.moderationCommandRoleId)) {
    return reply('You need the moderation role to use this command.', config.accentWarn);
  }

  const action = interaction.options.getString('action');
  const who = interaction.user.tag;
  if (action === 'off') {
    store.setSetting('moderationEnabled', false);
    log(`Moderation: switched OFF by ${who}`);
  } else if (action === 'on') {
    if (!config.moderationEnabled) return reply('Moderation is disabled in the bot\'s settings (`MODERATION=off` in `.env`), so it cannot be turned on here.', config.accentWarn);
    if (state === 'unavailable') return reply("The moderation model isn't installed on the bot's machine, so it cannot be turned on. Run `npm install` there and restart the bot.", config.accentWarn);
    store.setSetting('moderationEnabled', true);
    pausedUntil = 0; // turning it on also ends a CPU pause
    guard.reset();
    log(`Moderation: switched ON by ${who}`);
  }

  const s = moderationStatus();
  const line =
    {
      on: `🟢 **ON**${s.dryRun ? ' (dry run: only logs what it would delete)' : ''}`,
      off: '🔴 **OFF** (turned off by staff)',
      paused: `⏸️ **PAUSED** for using too much CPU - resumes <t:${Math.floor((s.resumesAt ?? 0) / 1000)}:R> (or run \`/moderation on\`)`,
      disabled: '⚫ **DISABLED** in the bot settings (`MODERATION=off`)',
      unavailable: '⚠️ **UNAVAILABLE** - the model is not installed on the bot\'s machine',
      loading: '⏳ **LOADING** the model...',
    }[s.state] ?? s.state;
  return reply(
    [
      `### 🛡️ Chat moderation`,
      line,
      `**CPU use** (last ${s.windowSeconds}s): ${s.cpu.toFixed(1)}% of the machine (pauses above ${s.limit}%)`,
      `**Since the bot started:** ${s.checked} messages checked, ${s.deleted} deleted`,
    ].join('\n'),
    s.state === 'on' ? config.accentOk : config.accent,
  );
}

/* ---- scoring ---- */

/** Strips things that aren't the person's own words, so they can't affect the score. */
export function cleanText(content) {
  const text = String(content ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<a?:\w+:\d+>|<[@#][&!]?\d+>|<t:\d+(?::\w)?>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.replace(/[^\p{L}]/gu, '').length < 3 ? '' : text.slice(0, 400);
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

/**
 * Undoes "leetspeak" disguises (sh1t, f4ck, n1gg3r): inside a word that mixes letters with digits or @ / $, the
 * symbols are swapped for the letters they usually stand for. Plain numbers ("version 1.3") are left alone.
 * This is a character rule, not a word list.
 */
export function deLeet(text) {
  return text.replace(/\S+/g, (token) => (/\p{L}/u.test(token) && /[013457@$]/.test(token) ? token.replace(/[013457@$]/g, (c) => LEET[c]) : token));
}

/** The decision rule. `scores` is { identity_hate, insult, obscene, ... } with values 0..1. */
export function decide(scores, t = config.moderationThresholds) {
  if ((scores.identity_hate ?? 0) >= t.hate) return { delete: true, reason: 'hate' };
  if ((scores.insult ?? 0) >= t.insult && (scores.obscene ?? 0) >= t.obscene) return { delete: true, reason: 'abuse' };
  return { delete: false, reason: null };
}

/**
 * Scores one message, one at a time, and records the CPU the model used. Returns null when the model is busy,
 * slow, paused or unavailable (the message is then let through).
 */
function score(text) {
  if (state !== 'ready' || !classifier || pausedUntil > now()) return Promise.resolve(null);
  if (pending >= config.moderationMaxQueue) return Promise.resolve(null);
  pending++;
  const run = chain.then(async () => {
    if (pausedUntil > now()) return null; // the guard tripped while this was queued
    const before = process.cpuUsage();
    try {
      return await Promise.race([
        classifier(text, { top_k: null }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 10_000)),
      ]);
    } finally {
      const used = process.cpuUsage(before);
      guard.record(used.user + used.system); // CPU time across all threads while the model ran
      if (!pausedUntil && guard.exceeded()) pauseForCpu();
    }
  });
  chain = run.then(() => {}, () => {});
  return run
    .then((labels) => (labels ? Object.fromEntries(labels.map((l) => [l.label, l.score])) : null))
    .catch((err) => (log(`Moderation: could not score a message (${err.message})`), null))
    .finally(() => pending--);
}

/** Scores the message as written and with leetspeak undone, keeping the higher score per label. */
async function scoreMessage(text) {
  const variants = [text];
  const plain = deLeet(text);
  if (plain !== text) variants.push(plain);
  let merged = null;
  for (const variant of variants) {
    const scores = await score(variant);
    if (!scores) return merged;
    merged = merged ? Object.fromEntries(Object.keys(scores).map((k) => [k, Math.max(scores[k], merged[k] ?? 0)])) : scores;
  }
  return merged;
}

const pct = (n) => Math.round((n ?? 0) * 100);

/** Returns true if the message was removed. */
export async function handleModeration(message) {
  if (!message.guild || message.author?.bot || message.webhookId || !message.content) return false;
  if (moderationStatus().state !== 'on') return false;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member)) return false;

  const text = cleanText(message.content);
  if (!text) return false;
  const scores = await scoreMessage(text);
  if (!scores) return false;
  stats.checked++;
  const verdict = decide(scores);
  if (!verdict.delete) return false;

  const detail = `hate ${pct(scores.identity_hate)}% / insult ${pct(scores.insult)}% / obscene ${pct(scores.obscene)}%`;
  const where = `#${message.channel.name}`;
  if (config.moderationDryRun) {
    log(`Moderation (dry run): would delete ${message.author.tag}'s message in ${where} [${verdict.reason}; ${detail}]: "${text.slice(0, 80)}"`);
    return false;
  }

  const deleted = await message.delete().then(() => true, (err) => (log(`Moderation: could not delete the message (${err.message})`), false));
  if (deleted) stats.deleted++;
  let timedOut = false;
  if (config.moderationTimeoutMs > 0 && member.moderatable) {
    timedOut = await member.timeout(config.moderationTimeoutMs, `Moderation: ${verdict.reason}`).then(() => true, () => false);
  }

  const tasks = [
    message.author
      .send(
        notice(
          `⚠️ Your message in **${message.guild.name}** (${where}) was removed because it ${REASONS[verdict.reason]}. Please keep the chat respectful.${timedOut ? ` You have been timed out for ${Math.round(config.moderationTimeoutMs / 60000)} minutes.` : ''}`,
          { color: config.accentWarn },
        ),
      )
      .catch(() => {}),
  ];
  if (config.moderationLogChannelId) {
    tasks.push(
      message.guild.channels
        .fetch(config.moderationLogChannelId)
        .then((ch) =>
          ch?.isTextBased()
            ? ch.send(
                notice(
                  `### 🛡️ Message removed\n**User:** <@${message.author.id}> (${message.author.tag})\n**Channel:** <#${message.channel.id}>\n**Reason:** ${REASONS[verdict.reason]}\n**Scores:** ${detail}\n**Message:** ${message.content.slice(0, 500).replace(/[`@]/g, "'")}`,
                  { color: config.accentWarn, mentions: { parse: [] } },
                ),
              )
            : null,
        )
        .catch((err) => log(`Moderation: could not post to the moderation log (${err.message})`)),
    );
  }
  await Promise.allSettled(tasks);

  log(`Moderation: ${message.author.tag} in ${where} -> ${deleted ? 'deleted' : 'NOT deleted'}${timedOut ? ', timed out' : ''} [${verdict.reason}; ${detail}]`);
  return deleted;
}
