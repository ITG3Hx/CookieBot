"use strict";

/**
 * CookieBot - Starboard.
 *
 * When a message collects enough of a chosen reaction (default star), the bot
 * reposts it into a starboard channel with a jump link, and keeps the count
 * up to date as reactions come and go. Drops below the threshold -> the
 * starboard copy is removed.
 *
 * Needs the GuildMessageReactions intent and Reaction/Message partials.
 */

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "starboard.json");
const POSTS_CAP = 400;

let client = null;
let saveTimer = null;

const DEFAULT_CONFIG = {
  enabled: false,
  channelId: "",
  emoji: "⭐",
  threshold: 3,
  allowSelf: false,
  ignoreChannels: [],
};

let store = { config: { ...DEFAULT_CONFIG }, posts: {} };
// posts: srcMessageId -> { starMessageId, count }

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store = { config: { ...DEFAULT_CONFIG, ...(raw.config || {}) }, posts: raw.posts || {} };
    }
  } catch (e) { console.error("[starboard] load:", e.message); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const ids = Object.keys(store.posts);
      if (ids.length > POSTS_CAP) for (const id of ids.slice(0, ids.length - POSTS_CAP)) delete store.posts[id];
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error("[starboard] save:", e.message); }
  }, 1000);
}
load();

function emojiMatches(reaction) {
  const want = store.config.emoji || "⭐";
  const e = reaction.emoji;
  return e.name === want || e.toString() === want || (e.id && want.includes(e.id));
}

async function effectiveCount(reaction, message) {
  let count = reaction.count || 0;
  if (!store.config.allowSelf && count > 0) {
    try {
      const users = await reaction.users.fetch();
      if (users.has(message.author.id)) count -= 1;
    } catch (e) { /* keep the raw count if the fetch fails */ }
  }
  return count;
}

function buildStarEmbed(message, count) {
  const embed = new EmbedBuilder()
    .setColor(0xf0b429)
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL({ size: 64 }) })
    .setDescription((message.content || "").slice(0, 4000) || "*no text*")
    .addFields({ name: "Source", value: `[Jump to message](${message.url}) in <#${message.channelId}>` })
    .setFooter({ text: `${store.config.emoji} ${count}` })
    .setTimestamp(message.createdTimestamp);
  const image = message.attachments.find(a => (a.contentType || "").startsWith("image/"));
  if (image) embed.setImage(image.url);
  return embed;
}

async function syncStarPost(message, count) {
  const cfg = store.config;
  const board = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!board || !board.isTextBased()) return;

  const entry = store.posts[message.id];

  if (count < cfg.threshold) {
    if (entry) {
      const old = await board.messages.fetch(entry.starMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
      delete store.posts[message.id];
      save();
    }
    return;
  }

  const embed = buildStarEmbed(message, count);
  if (entry) {
    const old = await board.messages.fetch(entry.starMessageId).catch(() => null);
    if (old) {
      await old.edit({ embeds: [embed] }).catch(() => {});
      entry.count = count;
      save();
      return;
    }
    delete store.posts[message.id];
  }
  const sent = await board.send({ embeds: [embed] }).catch(() => null);
  if (sent) {
    store.posts[message.id] = { starMessageId: sent.id, count };
    save();
  }
}

async function onReaction(reaction) {
  const cfg = store.config;
  if (!cfg.enabled || !cfg.channelId) return;
  if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
  if (!reaction) return;
  if (!emojiMatches(reaction)) return;

  let message = reaction.message;
  if (message.partial) message = await message.fetch().catch(() => null);
  if (!message || !message.guild || !message.author) return;
  if (message.author.bot) return;
  if (message.channelId === cfg.channelId) return;   // never star the starboard
  if (cfg.ignoreChannels.includes(message.channelId)) return;
  if (message.channel.parentId && cfg.ignoreChannels.includes(message.channel.parentId)) return;

  const count = await effectiveCount(reaction, message);
  await syncStarPost(message, count);
}

function initStarboard(discordClient) {
  client = discordClient;
  client.on("messageReactionAdd", (r) => { onReaction(r).catch(e => console.error("[starboard]", e.message)); });
  client.on("messageReactionRemove", (r) => { onReaction(r).catch(e => console.error("[starboard]", e.message)); });
  console.log(`[starboard] Ready (enabled: ${store.config.enabled})`);
}

// ── web accessors ─────────────────────────────────────────────────────────────
function webGetStarboard() {
  return { config: store.config, starred: Object.keys(store.posts).length };
}

function webUpdateStarboard(body) {
  // build the candidate first so a validation error never half-applies
  const c = { ...store.config };
  if (typeof body.enabled === "boolean") c.enabled = body.enabled;
  if (body.channelId !== undefined) c.channelId = String(body.channelId || "");
  if (body.emoji !== undefined) {
    const e = String(body.emoji || "").trim();
    if (!e || e.length > 64) return { error: "bad emoji" };
    c.emoji = e;
  }
  if (body.threshold !== undefined) {
    const n = parseInt(body.threshold, 10);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "threshold must be 1-100" };
    c.threshold = n;
  }
  if (typeof body.allowSelf === "boolean") c.allowSelf = body.allowSelf;
  if (Array.isArray(body.ignoreChannels)) c.ignoreChannels = body.ignoreChannels.filter(x => /^\d{5,25}$/.test(x)).slice(0, 100);
  if (c.enabled && !c.channelId) return { error: "pick a starboard channel before enabling" };
  store.config = c;
  save();
  return { config: c };
}

module.exports = { initStarboard, webGetStarboard, webUpdateStarboard };
