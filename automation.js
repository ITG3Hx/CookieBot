"use strict";

/**
 * CookieBot, Automation module.
 *
 * One place for the "set it and forget it" server automations, all driven from
 * the dashboard (no slash commands needed):
 *   - Autorole          give roles to humans / bots the moment they join
 *   - Welcome messages  post to a channel (plain or embed) + optional DM
 *   - Goodbye messages  post when someone leaves
 *   - Reaction roles     a button panel members click to self-assign roles
 *   - Auto-responder     keyword in chat -> the bot replies
 *
 * Wire into index.js:
 *   initAutomation(client)                once when the client is ready
 *   handleAutomationInteraction(inter)    in interactionCreate (handles rr_ buttons)
 *
 * Web accessors used by dashboard.js:
 *   webGetAutomation, webUpdateAutomation, webPostReactionRoles,
 *   webApplyAutoroleToAll, webWelcomeTest
 */

const fs   = require("fs");
const path = require("path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { pushActivity } = require("./activity");

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const FILE     = path.join(DATA_DIR, "automation.json");

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};

const DEFAULT = {
  autorole: { enabled: false, roleIds: [], botRoleIds: [], delaySeconds: 0 },
  welcome: {
    enabled: false, channelId: null,
    message: "Welcome {user} to **{server}**! You're member #{count}. 🍪",
    useEmbed: false, embedColor: "#ff8c00", pingUser: true,
    dmEnabled: false, dmMessage: "",
  },
  goodbye: {
    enabled: false, channelId: null,
    message: "**{tag}** left. We're now {count} members.",
    useEmbed: false, embedColor: "#8b6cff",
  },
  reactionRoles: {
    title: "Pick your roles",
    text: "Click a button to give yourself a role. Click it again to remove it.",
    color: "#8b6cff",
    roles: [],   // { roleId, label, emoji, style }
  },
  autoResponders: [],  // { id, trigger, match, response, deleteTrigger, enabled }
  messageLogger: {
    enabled: false,
    channelId: null,
    ignoreChannels: [],   // channels whose messages are never logged (e.g. #rules)
    logDeletes: true,     // log messages that get deleted
    logEdits: true,       // log messages that get edited
  },
  autoModeration: {
    enabled: false,
    capsSensitivity: 70,
    capsMinLength: 10,
    mentionLimit: 5,
    repeatLimit: 3,
    blockInvites: false,  // delete Discord invite links
    blockLinks: false,    // delete all links
    bannedWords: [],      // words that get the message deleted
    timeoutSeconds: 60,   // how long the timeout lasts
    deleteOnly: false,    // just delete, don't timeout
    ignoreRoles: [],      // roles exempt from auto-mod (staff)
    ignoreChannels: [],   // channels auto-mod never touches (e.g. #rules, #memes)
  },
  stickyMessages: [],  // { id, channelId, message, useEmbed, embedColor, enabled }
};

let client = null;
let state  = clone(DEFAULT);

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function ensureData() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function load() {
  ensureData();
  try {
    if (fs.existsSync(FILE)) {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
      // deep-merge onto defaults so new fields appear on old data
      state = {
        autorole:      { ...DEFAULT.autorole,      ...(saved.autorole || {}) },
        welcome:       { ...DEFAULT.welcome,       ...(saved.welcome || {}) },
        goodbye:       { ...DEFAULT.goodbye,       ...(saved.goodbye || {}) },
        reactionRoles: { ...DEFAULT.reactionRoles, ...(saved.reactionRoles || {}) },
        autoResponders: Array.isArray(saved.autoResponders) ? saved.autoResponders : [],
        messageLogger: { ...DEFAULT.messageLogger,   ...(saved.messageLogger || {}) },
        autoModeration: { ...DEFAULT.autoModeration, ...(saved.autoModeration || {}) },
        stickyMessages: Array.isArray(saved.stickyMessages) ? saved.stickyMessages : [],
      };
    }
  } catch (e) { console.error("[automation] load:", e.message); state = clone(DEFAULT); }
}
function save() { ensureData(); try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error("[automation] save:", e.message); } }

// ── Helpers ───────────────────────────────────────────────────────────────────
function colorInt(hex, fallback = 0xff8c00) {
  if (typeof hex !== "string") return fallback;
  const m = hex.replace("#", "");
  return /^[0-9a-f]{6}$/i.test(m) ? parseInt(m, 16) : fallback;
}
// {user} {tag} {name} {username} {server} {count} {memberCount} {id}
function fillPlaceholders(str, member, guild) {
  const user = member.user || member;
  return String(str || "")
    .replace(/\{user\}/g, `<@${user.id}>`)
    .replace(/\{tag\}/g, user.tag || user.username || "someone")
    .replace(/\{name\}/g, member.displayName || user.username || "someone")
    .replace(/\{username\}/g, user.username || "someone")
    .replace(/\{server\}/g, guild.name)
    .replace(/\{membercount\}|\{memberCount\}|\{count\}/g, String(guild.memberCount))
    .replace(/\{id\}/g, user.id);
}

async function fetchTextChannel(guild, id) {
  if (!id) return null;
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return ch && ch.isTextBased() ? ch : null;
}

// ── Autorole ────────────────────────────────────────────────────────────────
async function assignAutorole(member) {
  const a = state.autorole;
  if (!a.enabled) return;
  const roleIds = member.user.bot ? a.botRoleIds : a.roleIds;
  if (!roleIds.length) return;

  const doAssign = async () => {
    const fresh = await member.guild.members.fetch(member.id).catch(() => null);
    if (!fresh) return;  // member left before the delay elapsed
    const addable = roleIds.filter(id => member.guild.roles.cache.get(id)?.editable);
    const skipped = roleIds.length - addable.length;
    if (!addable.length) {
      pushActivity("automation", `Autorole: can't assign any role to ${member.user.tag}, move my role above them / grant Manage Roles`);
      return;
    }
    try {
      await fresh.roles.add(addable, "Autorole on join");
      pushActivity("automation", `Autorole: gave ${addable.length} role(s) to ${member.user.tag}${skipped ? ` (${skipped} skipped, above me)` : ""}`);
    } catch (e) {
      pushActivity("automation", `Autorole failed for ${member.user.tag}: ${e.message}`);
    }
  };

  if (a.delaySeconds > 0) setTimeout(() => doAssign().catch(() => {}), a.delaySeconds * 1000);
  else await doAssign();
}

// ── Welcome / goodbye ─────────────────────────────────────────────────────────
async function sendWelcome(member) {
  const w = state.welcome;
  if (!w.enabled) return;
  const guild = member.guild;

  const ch = await fetchTextChannel(guild, w.channelId);
  if (ch) {
    const text = fillPlaceholders(w.message, member, guild);
    const payload = {};
    if (w.useEmbed) {
      payload.embeds = [new EmbedBuilder().setColor(colorInt(w.embedColor)).setDescription(text)
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))];
      if (w.pingUser) payload.content = `<@${member.id}>`;
    } else {
      payload.content = text;
    }
    await ch.send(payload).catch(e => pushActivity("automation", `Welcome message failed: ${e.message}`));
  }

  if (w.dmEnabled && w.dmMessage) {
    await member.send(fillPlaceholders(w.dmMessage, member, guild)).catch(() => {});  // closed DMs are fine
  }
}

async function sendGoodbye(member) {
  const g = state.goodbye;
  if (!g.enabled) return;
  const guild = member.guild;
  const ch = await fetchTextChannel(guild, g.channelId);
  if (!ch) return;
  const text = fillPlaceholders(g.message, member, guild);
  const payload = g.useEmbed
    ? { embeds: [new EmbedBuilder().setColor(colorInt(g.embedColor, 0x8b6cff)).setDescription(text)] }
    : { content: text };
  await ch.send(payload).catch(e => pushActivity("automation", `Goodbye message failed: ${e.message}`));
}

// ── Auto-responder ────────────────────────────────────────────────────────────
const responderCooldown = new Map();   // `${channelId}:${id}` -> last-fired ts
const RESPONDER_COOLDOWN_MS = 3000;

function matchResponder(content, r) {
  const text = content.toLowerCase();
  const trig = r.trigger.toLowerCase();
  if (r.match === "exact") return text.trim() === trig;
  if (r.match === "startsWith") return text.startsWith(trig);
  if (r.match === "word") return new RegExp(`(^|\\W)${escapeRe(trig)}($|\\W)`).test(text);
  return text.includes(trig);  // contains
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function onMessage(msg) {
  if (!msg.guild || msg.author?.bot || !msg.content) return;
  for (const r of state.autoResponders) {
    if (!r.enabled || !r.trigger) continue;
    if (!matchResponder(msg.content, r)) continue;
    const key = `${msg.channelId}:${r.id}`;
    const now = Date.now();
    if (now - (responderCooldown.get(key) || 0) < RESPONDER_COOLDOWN_MS) return;
    responderCooldown.set(key, now);
    if (r.deleteTrigger) msg.delete().catch(() => {});
    const reply = fillPlaceholders(r.response, msg.member || msg.author, msg.guild);
    if (reply) msg.channel.send(reply).catch(() => {});
    pushActivity("automation", `Auto-reply fired: "${r.trigger}"`);
    return;  // first match wins, one reply per message
  }
}

// ── Reaction roles ────────────────────────────────────────────────────────────
function reactionRoleComponents() {
  const roles = (state.reactionRoles.roles || []).slice(0, 25);
  const rows = [];
  for (let i = 0; i < roles.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const r of roles.slice(i, i + 5)) {
      const btn = new ButtonBuilder()
        .setCustomId(`rr_${r.roleId}`)
        .setLabel((r.label || "Role").slice(0, 80))
        .setStyle(BUTTON_STYLES[r.style] || ButtonStyle.Secondary);
      if (r.emoji) { try { btn.setEmoji(r.emoji); } catch (e) { /* invalid emoji, skip */ } }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

async function handleAutomationInteraction(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith("rr_")) return false;
  const roleId = interaction.customId.slice(3);
  if (!state.reactionRoles.roles.some(r => r.roleId === roleId)) {
    await interaction.reply({ content: "That role isn't offered here anymore.", ephemeral: true });
    return true;
  }
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) { await interaction.reply({ content: "That role no longer exists.", ephemeral: true }); return true; }
  if (!role.editable) {
    await interaction.reply({ content: "I can't manage that role, it sits above my highest role. Ask an admin to move me up.", ephemeral: true });
    return true;
  }
  const member = interaction.member;
  const has = member.roles.cache.has(roleId);
  try {
    if (has) { await member.roles.remove(roleId, "Reaction role"); await interaction.reply({ content: `Removed **${role.name}**.`, ephemeral: true }); }
    else     { await member.roles.add(roleId, "Reaction role");    await interaction.reply({ content: `You now have **${role.name}**.`, ephemeral: true }); }
  } catch (e) {
    await interaction.reply({ content: `Couldn't update your roles: ${e.message}`, ephemeral: true });
  }
  return true;
}

// ── Message logger ───────────────────────────────────────────────────────────
// A message logger is only useful if it ignores noisy / protected channels, so
// every logger path bails early when the channel is on the ignore list.
function loggerSkips(channelId) {
  const l = state.messageLogger;
  if (!l.enabled || !isSnow(l.channelId)) return true;
  if (channelId && l.ignoreChannels.includes(channelId)) return true;   // e.g. #rules
  if (channelId && channelId === l.channelId) return true;              // never log the log channel itself
  return false;
}

async function onMessageLog(msg) {
  if (!msg.guild || !msg.author || msg.author.bot) return;
  if (loggerSkips(msg.channelId)) return;
  const ch = await fetchTextChannel(msg.guild, state.messageLogger.channelId);
  if (!ch) return;
  const content = msg.content.slice(0, 1024) || "(no text)";
  const embed = new EmbedBuilder()
    .setColor(0x7f8993)
    .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
    .setDescription(content)
    .setFooter({ text: `sent in #${msg.channel.name}` })
    .setTimestamp(msg.createdTimestamp);
  if (msg.attachments.size > 0) embed.addFields({ name: "Attachments", value: msg.attachments.map(a => `[${a.name}](${a.url})`).join("\n").slice(0, 1024) });
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function onMessageDeleteLog(msg) {
  if (!state.messageLogger.logDeletes) return;
  if (!msg.guild || msg.author?.bot) return;
  if (loggerSkips(msg.channelId)) return;
  const ch = await fetchTextChannel(msg.guild, state.messageLogger.channelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(0xff5d67)
    .setAuthor({ name: msg.author ? msg.author.tag : "Unknown", iconURL: msg.author?.displayAvatarURL() })
    .setTitle("Message deleted")
    .setDescription((msg.content || "(no text / not cached)").slice(0, 1024))
    .setFooter({ text: `deleted from #${msg.channel?.name || "?"}` })
    .setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function onMessageEditLog(oldMsg, newMsg) {
  if (!state.messageLogger.logEdits) return;
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (loggerSkips(newMsg.channelId)) return;
  if (oldMsg.content === newMsg.content) return;   // embed load, not a real edit
  const ch = await fetchTextChannel(newMsg.guild, state.messageLogger.channelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(0xffcc4d)
    .setAuthor({ name: newMsg.author ? newMsg.author.tag : "Unknown", iconURL: newMsg.author?.displayAvatarURL() })
    .setTitle("Message edited")
    .addFields(
      { name: "Before", value: (oldMsg.content || "(not cached)").slice(0, 1024) },
      { name: "After", value: (newMsg.content || "(empty)").slice(0, 1024) },
    )
    .setFooter({ text: `edited in #${newMsg.channel?.name || "?"}` })
    .setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

// ── Auto-moderation ───────────────────────────────────────────────────────────
const INVITE_RE = /(discord\.(gg|com\/invite)|discordapp\.com\/invite)\/\S+/i;
const LINK_RE   = /https?:\/\/\S+/i;
const recentByUser = new Map();   // userId -> { content, count, ts } for repeat detection

async function punish(msg, reason) {
  const m = state.autoModeration;
  await msg.delete().catch(() => {});
  if (!m.deleteOnly) {
    const ms = Math.max(1, Math.min(2419200, m.timeoutSeconds)) * 1000;   // cap at 28d (Discord max)
    msg.member.timeout(ms, reason).catch(() => {});
  }
  pushActivity("automation", `Auto-mod: ${m.deleteOnly ? "deleted a message from" : "timed out"} ${msg.author.tag} (${reason})`);
}

async function onAutoModerate(msg) {
  const m = state.autoModeration;
  if (!m.enabled || !msg.guild || !msg.member || msg.author?.bot || !msg.content) return;
  if (m.ignoreChannels.includes(msg.channelId)) return;                       // e.g. #rules, #memes
  if (m.ignoreRoles.some(rid => msg.member.roles.cache.has(rid))) return;     // staff exempt

  const lc = msg.content.toLowerCase();

  // banned words (whole-word match so "class" doesn't trip on "ass")
  for (const w of m.bannedWords) {
    if (new RegExp(`\\b${escapeRe(w.toLowerCase())}\\b`).test(lc)) { await punish(msg, "Banned word"); return; }
  }

  if (m.blockInvites && INVITE_RE.test(msg.content)) { await punish(msg, "Server invite"); return; }
  if (m.blockLinks && LINK_RE.test(msg.content))     { await punish(msg, "Link posting"); return; }

  const caps = (msg.content.match(/[A-Z]/g) || []).length;
  const lower = (msg.content.match(/[a-z]/g) || []).length;
  if (caps >= m.capsMinLength && lower > 0 && (caps / (caps + lower)) * 100 > m.capsSensitivity) {
    await punish(msg, "Caps spam"); return;
  }

  const mentions = msg.mentions.users.size + msg.mentions.roles.size + (msg.mentions.everyone ? 1 : 0);
  if (mentions > m.mentionLimit) { await punish(msg, `Mention spam (${mentions})`); return; }

  // repeated identical messages
  const prev = recentByUser.get(msg.author.id);
  if (prev && prev.content === lc && Date.now() - prev.ts < 15000) {
    prev.count++; prev.ts = Date.now();
    if (prev.count >= m.repeatLimit) { recentByUser.delete(msg.author.id); await punish(msg, "Repeated messages"); return; }
  } else {
    recentByUser.set(msg.author.id, { content: lc, count: 1, ts: Date.now() });
  }
}

// ── Sticky messages ────────────────────────────────────────────────────────────
// Keep an info message glued to the bottom of a channel by reposting it after
// other people talk. Perfect for a rules reminder or the server IP.
const stickyLast = new Map();   // channelId -> last sticky message id
async function onStickyMessage(msg) {
  if (!msg.guild || msg.author?.bot) return;
  const s = state.stickyMessages.find(x => x.enabled && x.channelId === msg.channelId);
  if (!s || !s.message.trim()) return;
  const ch = msg.channel;
  const prevId = stickyLast.get(s.channelId);
  if (prevId) { ch.messages.delete(prevId).catch(() => {}); }
  const payload = s.useEmbed
    ? { embeds: [new EmbedBuilder().setColor(colorInt(s.embedColor, 0xff8c00)).setDescription(s.message)] }
    : { content: s.message };
  const sent = await ch.send(payload).catch(() => null);
  if (sent) stickyLast.set(s.channelId, sent.id);
}

// ── Web dashboard API ─────────────────────────────────────────────────────────
const isSnow  = v => typeof v === "string" && /^\d{5,25}$/.test(v);
const isHex   = v => typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v);
const normHex = v => (isHex(v) ? (v.startsWith("#") ? v : "#" + v).toLowerCase() : null);
const clampStr = (v, n) => String(v ?? "").slice(0, n);
const snowList = (v, n) => Array.isArray(v) ? [...new Set(v.filter(isSnow))].slice(0, n) : [];

function vAutorole(o) {
  if (typeof o !== "object" || !o) return null;
  return {
    enabled: !!o.enabled,
    roleIds: snowList(o.roleIds, 10),
    botRoleIds: snowList(o.botRoleIds, 10),
    delaySeconds: Math.max(0, Math.min(600, parseInt(o.delaySeconds, 10) || 0)),
  };
}
function vWelcome(o) {
  if (typeof o !== "object" || !o) return null;
  return {
    enabled: !!o.enabled,
    channelId: isSnow(o.channelId) ? o.channelId : null,
    message: clampStr(o.message, 1500),
    useEmbed: !!o.useEmbed,
    embedColor: normHex(o.embedColor) || "#ff8c00",
    pingUser: !!o.pingUser,
    dmEnabled: !!o.dmEnabled,
    dmMessage: clampStr(o.dmMessage, 1500),
  };
}
function vGoodbye(o) {
  if (typeof o !== "object" || !o) return null;
  return {
    enabled: !!o.enabled,
    channelId: isSnow(o.channelId) ? o.channelId : null,
    message: clampStr(o.message, 1500),
    useEmbed: !!o.useEmbed,
    embedColor: normHex(o.embedColor) || "#8b6cff",
  };
}
function vReactionRoles(o) {
  if (typeof o !== "object" || !o) return null;
  const seen = new Set();
  const roles = Array.isArray(o.roles) ? o.roles.filter(r => r && isSnow(r.roleId)).filter(r => {
    if (seen.has(r.roleId)) return false;   // a member can't hold the same role twice
    seen.add(r.roleId); return true;
  }).slice(0, 25).map(r => ({
    roleId: r.roleId,
    label: clampStr(r.label, 80).trim() || "Role",
    emoji: clampStr(r.emoji, 64).trim(),
    style: (r.style in BUTTON_STYLES) ? r.style : "secondary",
  })) : [];
  return {
    title: clampStr(o.title, 256).trim() || "Pick your roles",
    text: clampStr(o.text, 2000).trim() || "Click a button to get a role.",
    color: normHex(o.color) || "#8b6cff",
    roles,
  };
}
function vResponders(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(r => r && String(r.trigger || "").trim() && String(r.response || "").trim())
    .slice(0, 50)
    .map((r, i) => ({
      id: (typeof r.id === "string" && r.id) ? r.id.slice(0, 40) : `r${i}_${clampStr(r.trigger, 8).replace(/\W/g, "")}`,
      trigger: clampStr(r.trigger, 100).trim(),
      match: ["contains", "exact", "startsWith", "word"].includes(r.match) ? r.match : "contains",
      response: clampStr(r.response, 1500).trim(),
      deleteTrigger: !!r.deleteTrigger,
      enabled: r.enabled !== false,
    }));
}

function vMessageLogger(o) {
  if (typeof o !== "object" || !o) return null;
  return {
    enabled: !!o.enabled,
    channelId: isSnow(o.channelId) ? o.channelId : null,
    ignoreChannels: snowList(o.ignoreChannels, 50),
    logDeletes: o.logDeletes !== false,
    logEdits: o.logEdits !== false,
  };
}
function vAutoModeration(o) {
  if (typeof o !== "object" || !o) return null;
  const words = Array.isArray(o.bannedWords)
    ? [...new Set(o.bannedWords.map(w => clampStr(w, 40).toLowerCase().trim()).filter(Boolean))].slice(0, 100)
    : [];
  return {
    enabled: !!o.enabled,
    capsSensitivity: Math.max(0, Math.min(100, parseInt(o.capsSensitivity, 10) || 70)),
    capsMinLength: Math.max(5, Math.min(1000, parseInt(o.capsMinLength, 10) || 10)),
    mentionLimit: Math.max(1, Math.min(50, parseInt(o.mentionLimit, 10) || 5)),
    repeatLimit: Math.max(1, Math.min(20, parseInt(o.repeatLimit, 10) || 3)),
    blockInvites: !!o.blockInvites,
    blockLinks: !!o.blockLinks,
    bannedWords: words,
    timeoutSeconds: Math.max(10, Math.min(2419200, parseInt(o.timeoutSeconds, 10) || 60)),
    deleteOnly: !!o.deleteOnly,
    ignoreRoles: snowList(o.ignoreRoles, 20),
    ignoreChannels: snowList(o.ignoreChannels, 50),
  };
}
function vStickyMessages(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  return arr
    .filter(s => s && isSnow(s.channelId) && String(s.message || "").trim())
    .filter(s => { if (seen.has(s.channelId)) return false; seen.add(s.channelId); return true; })  // one sticky per channel
    .slice(0, 25)
    .map((s, i) => ({
      id: (typeof s.id === "string" && s.id) ? s.id.slice(0, 40) : `s${i}_${s.channelId.slice(-5)}`,
      channelId: s.channelId,
      message: clampStr(s.message, 1500).trim(),
      useEmbed: !!s.useEmbed,
      embedColor: normHex(s.embedColor) || "#ff8c00",
      enabled: s.enabled !== false,
    }));
}

function publicState() { return clone(state); }
function webGetAutomation() { return { automation: publicState() }; }

function webUpdateAutomation(patch) {
  patch = patch || {};
  const applied = [];
  const sections = { autorole: vAutorole, welcome: vWelcome, goodbye: vGoodbye, reactionRoles: vReactionRoles, messageLogger: vMessageLogger, autoModeration: vAutoModeration };
  for (const [key, validate] of Object.entries(sections)) {
    if (key in patch) {
      const v = validate(patch[key]);
      if (!v) return { error: `Invalid ${key} settings` };
      state[key] = v;
      applied.push(key);
    }
  }
  if ("autoResponders" in patch) {
    const v = vResponders(patch.autoResponders);
    if (!v) return { error: "Invalid auto-responders" };
    state.autoResponders = v;
    applied.push("autoResponders");
  }
  if ("stickyMessages" in patch) {
    const v = vStickyMessages(patch.stickyMessages);
    if (!v) return { error: "Invalid sticky messages" };
    state.stickyMessages = v;
    applied.push("stickyMessages");
  }
  if (!applied.length) return { error: "Nothing valid to update" };
  save();
  pushActivity("automation", `Automation updated: ${applied.join(", ")}`);
  return { automation: publicState() };
}

async function webPostReactionRoles(channelId) {
  const ch = await client.channels.fetch(String(channelId || "")).catch(() => null);
  if (!ch || !ch.isTextBased()) return { error: "Channel not found or not a text channel" };
  if (!state.reactionRoles.roles.length) return { error: "Add at least one role to the panel first" };
  const rr = state.reactionRoles;
  const embed = new EmbedBuilder().setColor(colorInt(rr.color, 0x8b6cff)).setTitle(rr.title).setDescription(rr.text);
  try { await ch.send({ embeds: [embed], components: reactionRoleComponents() }); }
  catch (e) { return { error: `Could not post the panel: ${e.message}` }; }
  pushActivity("automation", `Reaction-role panel posted in #${ch.name}`);
  return { ok: true };
}

async function webApplyAutoroleToAll(guild) {
  if (!guild) return { error: "bot is not connected" };
  const a = state.autorole;
  if (!a.roleIds.length && !a.botRoleIds.length) return { error: "No autoroles are configured" };
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return { error: "Could not fetch the member list" };
  let changed = 0, failed = 0;
  for (const m of members.values()) {
    const roleIds = m.user.bot ? a.botRoleIds : a.roleIds;
    const toAdd = roleIds.filter(id => !m.roles.cache.has(id) && guild.roles.cache.get(id)?.editable);
    if (!toAdd.length) continue;
    try { await m.roles.add(toAdd, "Autorole apply-to-all"); changed++; }
    catch (e) { failed++; }
  }
  pushActivity("automation", `Autorole applied to everyone: ${changed} updated, ${failed} failed`);
  return { changed, failed, total: members.size };
}

async function webWelcomeTest(guild) {
  if (!guild) return { error: "bot is not connected" };
  const w = state.welcome;
  const ch = await fetchTextChannel(guild, w.channelId);
  if (!ch) return { error: "Set a valid welcome channel first" };
  const me = guild.members.me;
  if (!me) return { error: "can't resolve my own member record" };
  const text = "**[test]** " + fillPlaceholders(w.message, me, guild);
  const payload = w.useEmbed
    ? { embeds: [new EmbedBuilder().setColor(colorInt(w.embedColor)).setDescription(text).setThumbnail(me.user.displayAvatarURL({ size: 128 }))] }
    : { content: text };
  try { await ch.send(payload); } catch (e) { return { error: `Send failed: ${e.message}` }; }
  return { ok: true };
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initAutomation(discordClient) {
  client = discordClient;
  load();

  client.on("guildMemberAdd", (member) => {
    assignAutorole(member).catch(e => console.error("[automation] autorole:", e.message));
    sendWelcome(member).catch(e => console.error("[automation] welcome:", e.message));
  });
  client.on("guildMemberRemove", (member) => {
    sendGoodbye(member).catch(e => console.error("[automation] goodbye:", e.message));
  });
  client.on("messageCreate", (msg) => {
    onMessage(msg);
    onMessageLog(msg).catch(e => console.error("[automation] logger:", e.message));
    onAutoModerate(msg).catch(e => console.error("[automation] moderation:", e.message));
    onStickyMessage(msg).catch(e => console.error("[automation] sticky:", e.message));
  });
  client.on("messageDelete", (msg) => {
    onMessageDeleteLog(msg).catch(e => console.error("[automation] delete-log:", e.message));
  });
  client.on("messageUpdate", (oldMsg, newMsg) => {
    onMessageEditLog(oldMsg, newMsg).catch(e => console.error("[automation] edit-log:", e.message));
  });

  const rr = state.reactionRoles.roles.length;
  const ar = state.autoResponders.filter(r => r.enabled).length;
  const st = state.stickyMessages.filter(s => s.enabled).length;
  console.log(`[automation] Ready, autorole ${state.autorole.enabled ? "on" : "off"}, welcome ${state.welcome.enabled ? "on" : "off"}, logger ${state.messageLogger.enabled ? "on" : "off"}, moderation ${state.autoModeration.enabled ? "on" : "off"}, ${rr} reaction role(s), ${ar} responder(s), ${st} sticky.`);
}

module.exports = {
  initAutomation, handleAutomationInteraction,
  webGetAutomation, webUpdateAutomation, webPostReactionRoles, webApplyAutoroleToAll, webWelcomeTest,
};
