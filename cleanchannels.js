"use strict";

/**
 * CookieBot - Clean channels (commands-only channels).
 *
 * Mark channels as "commands only": normal chat messages get deleted right
 * away (with an optional short-lived warning), custom command invocations
 * (!ip etc.) are cleaned up after they run, and bot replies can auto-delete
 * after a timer so the channel stays empty. Slash commands like /id never
 * leave a user message behind, and with a bot-reply timer the answer
 * disappears too.
 *
 * Standalone module with its own data file - it never touches the configs
 * of other systems. Needs the Manage Messages permission in those channels.
 */

const fs = require("fs");
const path = require("path");
const { PermissionFlagsBits } = require("discord.js");
const customcommands = require("./customcommands");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "clean-channels.json");
const WARN_TTL_MS = 5000;
const COMMAND_DELETE_DELAY_MS = 600;   // let the command module answer first

let client = null;
let saveTimer = null;
const ownWarnIds = new Set();          // our warning messages, cleaned on our own timer

const DEFAULT_CONFIG = {
  enabled: false,
  exemptRoles: [],
  channels: [],
  // channel: { channelId, deleteUserCommands: true, botLifetimeSec: 0, warn: true, warnText }
};

let store = { config: { ...DEFAULT_CONFIG } };

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store = { config: { ...DEFAULT_CONFIG, ...(raw.config || {}) } };
      if (!Array.isArray(store.config.channels)) store.config.channels = [];
      if (!Array.isArray(store.config.exemptRoles)) store.config.exemptRoles = [];
    }
  } catch (e) { console.error("[cleanch] load:", e.message); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error("[cleanch] save:", e.message); }
  }, 1000);
}
load();

function ruleFor(channelId) {
  return store.config.channels.find(c => c.channelId === channelId) || null;
}

function isCustomCommand(content) {
  const cc = customcommands.webGetCustomCommands();
  if (!cc.enabled) return false;
  const prefix = cc.prefix || "!";
  if (!content.startsWith(prefix)) return false;
  const name = content.slice(prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
  return !!name && cc.commands.some(c => c.enabled !== false && c.name === name);
}

async function deleteLater(message, delayMs, skipPinned) {
  setTimeout(async () => {
    try {
      const fresh = await message.channel.messages.fetch(message.id).catch(() => null);
      if (!fresh) return;
      if (skipPinned && fresh.pinned) return;
      await fresh.delete();
    } catch (e) { /* already gone or missing perms */ }
  }, delayMs).unref?.();
}

async function onMessage(message) {
  const cfg = store.config;
  if (!cfg.enabled) return;
  if (!message.guild) return;
  const rule = ruleFor(message.channelId);
  if (!rule) return;

  // our own short-lived warnings clean themselves up
  if (ownWarnIds.has(message.id)) return;

  // bot messages (including CookieBot's own replies and slash command answers)
  if (message.author.bot) {
    const ttl = Number(rule.botLifetimeSec) || 0;
    if (ttl > 0) deleteLater(message, ttl * 1000, true);
    return;
  }

  // humans with an exempt role may talk normally
  if (cfg.exemptRoles.length && message.member?.roles.cache.some(r => cfg.exemptRoles.includes(r.id))) return;

  // a custom command invocation: let it run, then sweep the invocation away
  if (isCustomCommand(message.content)) {
    if (rule.deleteUserCommands !== false) deleteLater(message, COMMAND_DELETE_DELAY_MS, false);
    return;
  }

  // anything else is chatter: delete it, optionally explain briefly
  try { await message.delete(); }
  catch (e) { return; }   // no permission, do not warn either

  if (rule.warn !== false) {
    const text = String(rule.warnText || "").trim() || `This channel is for bot commands only, ${message.author}. Your message was removed.`;
    const warn = await message.channel.send(text.replaceAll("{user}", `<@${message.author.id}>`)).catch(() => null);
    if (warn) {
      ownWarnIds.add(warn.id);
      setTimeout(() => {
        ownWarnIds.delete(warn.id);
        warn.delete().catch(() => {});
      }, WARN_TTL_MS).unref?.();
    }
  }
}

function initCleanChannels(discordClient) {
  client = discordClient;
  client.on("messageCreate", (m) => { onMessage(m).catch(e => console.error("[cleanch]", e.message)); });
  console.log(`[cleanch] Ready (enabled: ${store.config.enabled}, ${store.config.channels.length} clean channel(s))`);
}

// ── web accessors ─────────────────────────────────────────────────────────────
function webGetCleanChannels() {
  const missing = [];
  if (client?.isReady()) {
    for (const c of store.config.channels) {
      const ch = client.channels.cache.get(c.channelId);
      const me = ch?.guild?.members?.me;
      if (ch && me && !ch.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) missing.push(c.channelId);
    }
  }
  return { config: store.config, missingPerms: missing };
}

function webUpdateCleanChannels(body) {
  // build the candidate first so a validation error never half-applies
  const c = { ...store.config, channels: [...store.config.channels], exemptRoles: [...store.config.exemptRoles] };
  if (typeof body.enabled === "boolean") c.enabled = body.enabled;
  if (Array.isArray(body.exemptRoles)) c.exemptRoles = body.exemptRoles.filter(x => /^\d{5,25}$/.test(x)).slice(0, 50);
  if (Array.isArray(body.channels)) {
    if (body.channels.length > 25) return { error: "max 25 clean channels" };
    const seen = new Set();
    const next = [];
    for (const ch of body.channels) {
      const channelId = String(ch.channelId || "");
      if (!/^\d{5,25}$/.test(channelId)) return { error: "every row needs a channel" };
      if (seen.has(channelId)) return { error: "a channel is listed twice" };
      seen.add(channelId);
      const ttl = parseInt(ch.botLifetimeSec, 10) || 0;
      if (ttl !== 0 && (ttl < 5 || ttl > 86400)) return { error: "bot reply lifetime must be 0 (keep) or 5-86400 seconds" };
      next.push({
        channelId,
        deleteUserCommands: ch.deleteUserCommands !== false,
        botLifetimeSec: ttl,
        warn: ch.warn !== false,
        warnText: String(ch.warnText || "").slice(0, 300),
      });
    }
    c.channels = next;
  }
  if (c.enabled && !c.channels.length) return { error: "add at least one channel before activating" };
  store.config = c;
  save();
  return { config: c };
}

module.exports = { initCleanChannels, webGetCleanChannels, webUpdateCleanChannels };
