"use strict";

/**
 * CookieBot - Custom commands (MEE6-style).
 *
 * Prefix text commands (default "!") created entirely from the dashboard:
 * !name -> replies with text or a small embed. Placeholders:
 *   {user} mention, {username}, {server}, {membercount}, {args}
 * 3 second per-command-per-channel cooldown so spam can't make the bot spam.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "custom-commands.json");
const COOLDOWN_MS = 3000;
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

let client = null;
let saveTimer = null;
const cooldowns = new Map();   // `${cmdId}:${channelId}` -> ts

let store = { prefix: "!", commands: [] };
// command: { id, name, response, useEmbed, embedTitle, embedColor, enabled, uses }

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store = { prefix: raw.prefix || "!", commands: Array.isArray(raw.commands) ? raw.commands : [] };
    }
  } catch (e) { console.error("[customcmd] load:", e.message); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error("[customcmd] save:", e.message); }
  }, 1000);
}
load();

function fill(template, message, args) {
  return String(template || "")
    .replaceAll("{user}", `<@${message.author.id}>`)
    .replaceAll("{username}", message.member?.displayName || message.author.username)
    .replaceAll("{server}", message.guild?.name || "")
    .replaceAll("{membercount}", String(message.guild?.memberCount || 0))
    .replaceAll("{args}", args.join(" "));
}

async function onMessage(message) {
  if (!message.guild || message.author.bot) return;
  const prefix = store.prefix || "!";
  if (!message.content.startsWith(prefix)) return;

  const parts = message.content.slice(prefix.length).trim().split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  if (!name) return;

  const cmd = store.commands.find(c => c.enabled !== false && c.name === name);
  if (!cmd) return;

  const key = `${cmd.id}:${message.channelId}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < COOLDOWN_MS) return;
  cooldowns.set(key, now);

  cmd.uses = (cmd.uses || 0) + 1;
  save();

  try {
    if (cmd.useEmbed) {
      let color = 0xff8c00;
      if (typeof cmd.embedColor === "string" && /^#?[0-9a-f]{6}$/i.test(cmd.embedColor)) {
        color = parseInt(cmd.embedColor.replace("#", ""), 16);
      }
      const embed = new EmbedBuilder().setColor(color).setDescription(fill(cmd.response, message, parts).slice(0, 4000));
      if (cmd.embedTitle) embed.setTitle(fill(cmd.embedTitle, message, parts).slice(0, 256));
      await message.channel.send({ embeds: [embed] });
    } else {
      await message.channel.send({
        content: fill(cmd.response, message, parts).slice(0, 1900),
        allowedMentions: { parse: ["users"] },   // custom commands can't ping @everyone/roles
      });
    }
  } catch (e) { console.error("[customcmd] send:", e.message); }
}

function initCustomCommands(discordClient) {
  client = discordClient;
  client.on("messageCreate", (m) => { onMessage(m).catch(e => console.error("[customcmd]", e.message)); });
  console.log(`[customcmd] Ready (${store.commands.length} commands, prefix "${store.prefix}")`);
}

// ── web accessors ─────────────────────────────────────────────────────────────
function webGetCustomCommands() {
  return { prefix: store.prefix, commands: store.commands };
}

function webUpdateCustomCommands(body) {
  const prefix = String(body.prefix ?? store.prefix).trim();
  if (!prefix || prefix.length > 3 || /\s/.test(prefix)) return { error: "prefix must be 1-3 characters, no spaces" };
  if (!Array.isArray(body.commands)) return { error: "commands must be a list" };
  if (body.commands.length > 100) return { error: "max 100 custom commands" };

  const seen = new Set();
  const next = [];
  for (const c of body.commands) {
    const name = String(c.name || "").trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: `bad command name "${name}" (a-z, 0-9, - and _ only, max 32)` };
    if (seen.has(name)) return { error: `duplicate command name "${name}"` };
    seen.add(name);
    const response = String(c.response || "").trim();
    if (!response) return { error: `command "${name}" needs a response` };
    const prev = store.commands.find(x => x.id === c.id);
    next.push({
      id: prev ? prev.id : crypto.randomBytes(5).toString("hex"),
      name,
      response: response.slice(0, 3000),
      useEmbed: !!c.useEmbed,
      embedTitle: String(c.embedTitle || "").slice(0, 256),
      embedColor: /^#?[0-9a-f]{6}$/i.test(String(c.embedColor || "")) ? String(c.embedColor) : "#ff8c00",
      enabled: c.enabled !== false,
      uses: prev ? (prev.uses || 0) : 0,
    });
  }
  store.prefix = prefix;
  store.commands = next;
  save();
  return { prefix: store.prefix, commands: store.commands };
}

module.exports = { initCustomCommands, webGetCustomCommands, webUpdateCustomCommands };
