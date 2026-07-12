"use strict";

/**
 * CookieBot - Timed messages (MEE6-style timers).
 *
 * Posts a message to a channel on a schedule: every N hours, or daily at a
 * fixed HH:MM (server local time). Plain text or a small embed.
 * Placeholders: {server}, {membercount}
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "timed-messages.json");
const TICK_MS = 60_000;

let client = null;
let saveTimer = null;
let ticker = null;

let store = { enabled: false, timers: [] };
// timer: { id, channelId, message, useEmbed, embedTitle, embedColor, mode: "every"|"daily",
//          everyHours, at: "HH:MM", enabled, lastRun }

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store = { enabled: !!raw.enabled, timers: Array.isArray(raw.timers) ? raw.timers : [] };
    }
  } catch (e) { console.error("[timers] load:", e.message); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
    } catch (e) { console.error("[timers] save:", e.message); }
  }, 1000);
}
load();

function fill(template, guild) {
  return String(template || "")
    .replaceAll("{server}", guild?.name || "")
    .replaceAll("{membercount}", String(guild?.memberCount || 0));
}

async function fireTimer(t) {
  if (!client?.isReady()) return { error: "bot is not connected to Discord" };
  const channel = await client.channels.fetch(t.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return { error: "channel not found or not a text channel" };
  const guild = channel.guild;
  try {
    if (t.useEmbed) {
      let color = 0xff8c00;
      if (typeof t.embedColor === "string" && /^#?[0-9a-f]{6}$/i.test(t.embedColor)) {
        color = parseInt(t.embedColor.replace("#", ""), 16);
      }
      const embed = new EmbedBuilder().setColor(color).setDescription(fill(t.message, guild).slice(0, 4000));
      if (t.embedTitle) embed.setTitle(fill(t.embedTitle, guild).slice(0, 256));
      await channel.send({ embeds: [embed] });
    } else {
      await channel.send({ content: fill(t.message, guild).slice(0, 1900) });
    }
    return {};
  } catch (e) {
    return { error: `send failed: ${e.message}` };
  }
}

async function tick() {
  if (!store.enabled) return;
  if (!client?.isReady()) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  for (const t of store.timers) {
    if (!t.enabled) continue;
    let due = false;
    if (t.mode === "every") {
      due = (t.lastRun || 0) + Math.max(1, t.everyHours) * 3_600_000 <= Date.now();
    } else if (t.mode === "daily") {
      due = t.at === hhmm && (t.lastRun || 0) < dayStart;
    }
    if (!due) continue;
    t.lastRun = Date.now();
    save();
    const r = await fireTimer(t);
    if (r.error) console.error(`[timers] ${t.id}: ${r.error}`);
  }
}

function initTimers(discordClient) {
  client = discordClient;
  if (!ticker) {
    ticker = setInterval(() => { tick().catch(e => console.error("[timers]", e.message)); }, TICK_MS);
    ticker.unref();
  }
  console.log(`[timers] Ready (${store.timers.length} timed messages)`);
}

// ── web accessors ─────────────────────────────────────────────────────────────
function webGetTimers() {
  return { enabled: store.enabled, timers: store.timers };
}

function webUpdateTimers(body) {
  const nextEnabled = typeof body.enabled === "boolean" ? body.enabled : store.enabled;
  if (!Array.isArray(body.timers)) {
    store.enabled = nextEnabled;
    save();
    return { enabled: store.enabled, timers: store.timers };
  }
  if (body.timers.length > 30) return { error: "max 30 timed messages" };
  const next = [];
  for (const t of body.timers) {
    if (!/^\d{5,25}$/.test(String(t.channelId || ""))) return { error: "every timer needs a channel" };
    const message = String(t.message || "").trim();
    if (!message) return { error: "every timer needs a message" };
    const mode = t.mode === "daily" ? "daily" : "every";
    const everyHours = Math.min(720, Math.max(1, parseInt(t.everyHours, 10) || 24));
    const at = /^\d{2}:\d{2}$/.test(String(t.at || "")) ? t.at : "12:00";
    const prev = store.timers.find(x => x.id === t.id);
    next.push({
      id: prev ? prev.id : crypto.randomBytes(5).toString("hex"),
      channelId: String(t.channelId),
      message: message.slice(0, 3000),
      useEmbed: !!t.useEmbed,
      embedTitle: String(t.embedTitle || "").slice(0, 256),
      embedColor: /^#?[0-9a-f]{6}$/i.test(String(t.embedColor || "")) ? String(t.embedColor) : "#ff8c00",
      mode, everyHours, at,
      enabled: t.enabled !== false,
      // interval timers start counting from now; daily ones fire at the next matching time
      lastRun: prev ? (prev.lastRun || 0) : (mode === "every" ? Date.now() : 0),
    });
  }
  store.enabled = nextEnabled;
  store.timers = next;
  save();
  return { enabled: store.enabled, timers: store.timers };
}

async function webRunTimer(id) {
  const t = store.timers.find(x => x.id === id);
  if (!t) return { error: "unknown timer" };
  const r = await fireTimer(t);
  if (r.error) return r;
  t.lastRun = Date.now();
  save();
  return { fired: true };
}

module.exports = { initTimers, webGetTimers, webUpdateTimers, webRunTimer };
