"use strict";

/**
 * CookieBot - Leveling (MEE6-style XP system).
 *
 * Members earn 15-25 XP per message (60s cooldown by default, both tunable).
 * Level curve matches MEE6: going from level n to n+1 costs 5n^2 + 50n + 100 XP.
 * Level-ups can announce in the same channel or a fixed one, and can grant
 * role rewards (stacked, or replaced so only the highest applies).
 *
 * Slash commands: /rank [user], /leaderboard
 * Dashboard: config + leaderboard + reset/give XP via the web* accessors.
 * Optional public leaderboard page served by the dashboard at /levels.
 */

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "leveling.json");

const XP_MIN = 15;
const XP_MAX = 25;
const SAVE_DELAY_MS = 1500;
const LEADERBOARD_CAP = 50;

let client = null;
let saveTimer = null;
const cooldowns = new Map();   // userId -> last xp timestamp

const DEFAULT_CONFIG = {
  enabled: false,              // master switch, off until activated in the dashboard
  multiplier: 1,               // 0.25 - 3
  cooldownSec: 60,
  voiceXpEnabled: false,
  voiceXpPerMin: 5,            // XP per minute spent in voice (not muted, not alone)
  levelUpMode: "same",         // same | channel | off
  levelUpChannelId: "",
  levelUpMessage: "GG {user}, you just reached **level {level}**!",
  noXpChannels: [],
  noXpRoles: [],
  rewardMode: "stack",         // stack | replace
  roleRewards: [],             // [{ level, roleId }]
  publicLeaderboard: false,
};

let store = { config: { ...DEFAULT_CONFIG }, users: {} };

// ── persistence ───────────────────────────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store = {
        config: { ...DEFAULT_CONFIG, ...(raw.config || {}) },
        users: raw.users || {},
      };
    }
  } catch (e) {
    console.error("[leveling] load:", e.message);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error("[leveling] save:", e.message); }
  }, SAVE_DELAY_MS);
}
load();

// ── level math (MEE6 curve) ───────────────────────────────────────────────────
function xpToNext(level) { return 5 * level * level + 50 * level + 100; }
function levelFromXp(totalXp) {
  let level = 0, rem = Math.max(0, Math.floor(totalXp));
  while (rem >= xpToNext(level)) { rem -= xpToNext(level); level++; }
  return { level, into: rem, need: xpToNext(level) };
}

function userRecord(userId) {
  if (!store.users[userId]) store.users[userId] = { xp: 0, messages: 0, tag: "", avatar: "" };
  return store.users[userId];
}

function sortedUsers() {
  return Object.entries(store.users)
    .map(([userId, u]) => ({ userId, ...u }))
    .sort((a, b) => b.xp - a.xp);
}

function rankOf(userId) {
  const list = sortedUsers();
  const idx = list.findIndex(u => u.userId === userId);
  return idx === -1 ? null : idx + 1;
}

function fillPlaceholders(template, member, level) {
  return String(template || "")
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.displayName || member.user.username)
    .replaceAll("{level}", String(level))
    .replaceAll("{server}", member.guild.name);
}

// ── role rewards ──────────────────────────────────────────────────────────────
async function applyRewards(member, newLevel) {
  const rewards = (store.config.roleRewards || []).filter(r => r.level <= newLevel);
  if (!rewards.length) return;
  const allRewardIds = store.config.roleRewards.map(r => r.roleId);
  try {
    if (store.config.rewardMode === "replace") {
      const top = rewards.reduce((a, b) => (a.level > b.level ? a : b));
      const toRemove = allRewardIds.filter(id => id !== top.roleId && member.roles.cache.has(id));
      if (!member.roles.cache.has(top.roleId)) await member.roles.add(top.roleId, "Level reward");
      for (const id of toRemove) await member.roles.remove(id, "Level reward replaced").catch(() => {});
    } else {
      for (const r of rewards) {
        if (!member.roles.cache.has(r.roleId)) await member.roles.add(r.roleId, `Level ${r.level} reward`).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[leveling] reward roles:", e.message);
  }
}

async function announceLevelUp(message, member, level) {
  const cfg = store.config;
  if (cfg.levelUpMode === "off") return;
  const text = fillPlaceholders(cfg.levelUpMessage, member, level);
  if (!text.trim()) return;
  try {
    if (cfg.levelUpMode === "channel" && cfg.levelUpChannelId) {
      const ch = await client.channels.fetch(cfg.levelUpChannelId).catch(() => null);
      if (ch && ch.isTextBased()) await ch.send(text);
    } else {
      await message.channel.send(text);
    }
  } catch (e) { console.error("[leveling] announce:", e.message); }
}

// ── XP on messages ────────────────────────────────────────────────────────────
async function onMessage(message) {
  const cfg = store.config;
  if (!cfg.enabled) return;
  if (!message.guild || message.author.bot) return;
  if (cfg.noXpChannels.includes(message.channelId)) return;
  if (message.channel.parentId && cfg.noXpChannels.includes(message.channel.parentId)) return;

  const member = message.member;
  if (member && cfg.noXpRoles.length && member.roles.cache.some(r => cfg.noXpRoles.includes(r.id))) return;

  const now = Date.now();
  const last = cooldowns.get(message.author.id) || 0;
  if (now - last < Math.max(5, cfg.cooldownSec) * 1000) return;
  cooldowns.set(message.author.id, now);

  const rec = userRecord(message.author.id);
  const before = levelFromXp(rec.xp).level;
  const gain = Math.round((XP_MIN + Math.random() * (XP_MAX - XP_MIN)) * cfg.multiplier);
  rec.xp += gain;
  rec.messages += 1;
  rec.tag = message.author.tag;
  rec.avatar = message.author.displayAvatarURL({ size: 64, extension: "png" });
  save();

  const after = levelFromXp(rec.xp).level;
  if (after > before && member) {
    await announceLevelUp(message, member, after);
    await applyRewards(member, after);
  }
}

// ── voice XP (once a minute for everyone actively in voice) ───────────────────
async function voiceTick() {
  const cfg = store.config;
  if (!cfg.enabled || !cfg.voiceXpEnabled || !client?.isReady()) return;
  for (const guild of client.guilds.cache.values()) {
    // group voice states by channel so lone members don't farm XP
    const byChannel = new Map();
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || !vs.member || vs.member.user.bot) continue;
      if (vs.mute || vs.deaf) continue;   // covers self and server mute/deafen
      if (cfg.noXpChannels.includes(vs.channelId)) continue;
      if (vs.member.roles.cache.some(r => cfg.noXpRoles.includes(r.id))) continue;
      if (!byChannel.has(vs.channelId)) byChannel.set(vs.channelId, []);
      byChannel.get(vs.channelId).push(vs.member);
    }
    for (const members of byChannel.values()) {
      if (members.length < 2) continue;   // alone in a channel earns nothing
      for (const member of members) {
        const rec = userRecord(member.id);
        const before = levelFromXp(rec.xp).level;
        rec.xp += Math.max(1, Math.round(cfg.voiceXpPerMin * cfg.multiplier));
        rec.tag = member.user.tag;
        rec.avatar = member.user.displayAvatarURL({ size: 64, extension: "png" });
        const after = levelFromXp(rec.xp).level;
        if (after > before) {
          // no source message here, announce only if a fixed channel is set
          if (store.config.levelUpMode === "channel" && store.config.levelUpChannelId) {
            const ch = await client.channels.fetch(store.config.levelUpChannelId).catch(() => null);
            if (ch && ch.isTextBased()) await ch.send(fillPlaceholders(store.config.levelUpMessage, member, after)).catch(() => {});
          }
          await applyRewards(member, after);
        }
      }
    }
  }
  save();
}

// ── slash commands ────────────────────────────────────────────────────────────
const LEVELING_COMMANDS = [
  {
    name: "rank",
    description: "Show your level and XP (or someone else's)",
    options: [{ name: "user", description: "Whose rank to show", type: 6, required: false }],
  },
  { name: "leaderboard", description: "Show the server XP leaderboard" },
];

function progressBar(into, need, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((into / need) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function handleLevelingCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (!["rank", "leaderboard"].includes(interaction.commandName)) return false;

  if (!store.config.enabled) {
    await interaction.reply({ content: "Leveling is turned off right now. An admin can activate it in the dashboard.", ephemeral: true });
    return true;
  }

  if (interaction.commandName === "rank") {
    const target = interaction.options.getUser("user") || interaction.user;
    const rec = store.users[target.id];
    if (!rec || !rec.xp) {
      await interaction.reply({ content: `${target.id === interaction.user.id ? "You have" : `${target.username} has`} no XP yet. Start chatting!`, ephemeral: true });
      return true;
    }
    const { level, into, need } = levelFromXp(rec.xp);
    const rank = rankOf(target.id);
    const embed = new EmbedBuilder()
      .setColor(0xff8c00)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL({ size: 64 }) })
      .setTitle(`Level ${level}`)
      .setDescription(`\`${progressBar(into, need)}\`  ${into.toLocaleString()} / ${need.toLocaleString()} XP`)
      .addFields(
        { name: "Rank", value: `#${rank}`, inline: true },
        { name: "Total XP", value: rec.xp.toLocaleString(), inline: true },
        { name: "Messages", value: (rec.messages || 0).toLocaleString(), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === "leaderboard") {
    const top = sortedUsers().slice(0, 10);
    if (!top.length) {
      await interaction.reply({ content: "Nobody has XP yet. Start chatting!", ephemeral: true });
      return true;
    }
    const lines = top.map((u, i) => {
      const { level } = levelFromXp(u.xp);
      return `**#${i + 1}**  ${u.tag ? u.tag.replace(/#0$/, "") : `<@${u.userId}>`} — Level ${level} (${u.xp.toLocaleString()} XP)`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xff8c00)
      .setTitle(`${interaction.guild?.name || "Server"} leaderboard`)
      .setDescription(lines.join("\n"));
    if (store.config.publicLeaderboard) embed.setFooter({ text: "Full leaderboard: /levels on the bot's site" });
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  return false;
}

// ── init ──────────────────────────────────────────────────────────────────────
let voiceTicker = null;
function initLeveling(discordClient) {
  client = discordClient;
  client.on("messageCreate", (m) => { onMessage(m).catch(e => console.error("[leveling]", e.message)); });
  if (!voiceTicker) {
    voiceTicker = setInterval(() => { voiceTick().catch(e => console.error("[leveling] voice:", e.message)); }, 60_000);
    voiceTicker.unref();
  }
  console.log(`[leveling] Ready (${Object.keys(store.users).length} tracked users, enabled: ${store.config.enabled})`);
}

// ── web accessors ─────────────────────────────────────────────────────────────
function webGetLeveling() {
  return { config: store.config, trackedUsers: Object.keys(store.users).length };
}

function webUpdateLevelingConfig(body) {
  // build the candidate first so a validation error never half-applies
  const c = { ...store.config, noXpChannels: [...store.config.noXpChannels], noXpRoles: [...store.config.noXpRoles], roleRewards: [...store.config.roleRewards] };
  if (typeof body.enabled === "boolean") c.enabled = body.enabled;
  if (body.multiplier !== undefined) {
    const n = Number(body.multiplier);
    if (!Number.isFinite(n) || n < 0.25 || n > 3) return { error: "multiplier must be between 0.25 and 3" };
    c.multiplier = Math.round(n * 100) / 100;
  }
  if (body.cooldownSec !== undefined) {
    const n = parseInt(body.cooldownSec, 10);
    if (!Number.isInteger(n) || n < 5 || n > 600) return { error: "cooldown must be 5-600 seconds" };
    c.cooldownSec = n;
  }
  if (typeof body.voiceXpEnabled === "boolean") c.voiceXpEnabled = body.voiceXpEnabled;
  if (body.voiceXpPerMin !== undefined) {
    const n = parseInt(body.voiceXpPerMin, 10);
    if (!Number.isInteger(n) || n < 1 || n > 60) return { error: "voice XP must be 1-60 per minute" };
    c.voiceXpPerMin = n;
  }
  if (body.levelUpMode !== undefined) {
    if (!["same", "channel", "off"].includes(body.levelUpMode)) return { error: "bad level-up mode" };
    c.levelUpMode = body.levelUpMode;
  }
  if (body.levelUpChannelId !== undefined) c.levelUpChannelId = String(body.levelUpChannelId || "");
  if (body.levelUpMessage !== undefined) c.levelUpMessage = String(body.levelUpMessage || "").slice(0, 500);
  if (Array.isArray(body.noXpChannels)) c.noXpChannels = body.noXpChannels.filter(x => /^\d{5,25}$/.test(x)).slice(0, 100);
  if (Array.isArray(body.noXpRoles)) c.noXpRoles = body.noXpRoles.filter(x => /^\d{5,25}$/.test(x)).slice(0, 100);
  if (body.rewardMode !== undefined) {
    if (!["stack", "replace"].includes(body.rewardMode)) return { error: "bad reward mode" };
    c.rewardMode = body.rewardMode;
  }
  if (Array.isArray(body.roleRewards)) {
    const rewards = [];
    for (const r of body.roleRewards.slice(0, 30)) {
      const level = parseInt(r.level, 10);
      if (!Number.isInteger(level) || level < 1 || level > 500) return { error: "reward levels must be 1-500" };
      if (!/^\d{5,25}$/.test(String(r.roleId || ""))) return { error: "every reward needs a role" };
      rewards.push({ level, roleId: String(r.roleId) });
    }
    rewards.sort((a, b) => a.level - b.level);
    c.roleRewards = rewards;
  }
  if (typeof body.publicLeaderboard === "boolean") c.publicLeaderboard = body.publicLeaderboard;
  store.config = c;
  save();
  return { config: c };
}

function webLeaderboard(limit = LEADERBOARD_CAP) {
  return sortedUsers().slice(0, Math.min(200, limit)).map((u, i) => {
    const lv = levelFromXp(u.xp);
    return {
      rank: i + 1, userId: u.userId, tag: u.tag || "", avatar: u.avatar || "",
      xp: u.xp, level: lv.level, into: lv.into, need: lv.need, messages: u.messages || 0,
    };
  });
}

function webResetUser(userId) {
  if (!store.users[userId]) return { error: "that user has no XP" };
  delete store.users[userId];
  save();
  return { removed: userId };
}

function webResetAll() {
  const count = Object.keys(store.users).length;
  store.users = {};
  save();
  return { removed: count };
}

function webGiveXp(userId, amount) {
  if (!/^\d{5,25}$/.test(String(userId || ""))) return { error: "bad user id" };
  const n = parseInt(amount, 10);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1000000) return { error: "amount must be a non-zero number up to 1,000,000" };
  const rec = userRecord(userId);
  rec.xp = Math.max(0, rec.xp + n);
  save();
  const lv = levelFromXp(rec.xp);
  return { userId, xp: rec.xp, level: lv.level };
}

function webPublicEnabled() { return !!store.config.publicLeaderboard; }

module.exports = {
  initLeveling, handleLevelingCommand, LEVELING_COMMANDS,
  webGetLeveling, webUpdateLevelingConfig, webLeaderboard,
  webResetUser, webResetAll, webGiveXp, webPublicEnabled,
};
