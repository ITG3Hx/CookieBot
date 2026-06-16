"use strict";

/**
 * CookieBot — Tester linking module.
 *
 * Self-contained, wired into index.js with one initTesters(client, options) call
 * plus a command-routing hook (mirrors how security.js is wired in).
 *
 * Flow:
 *   1. In Minecraft the player runs /testlink -> gets a code (e.g. COOKIE-4827).
 *   2. In the Discord TESTING channel they run /link <code>.
 *   3. The bot checks they have the Tester or SR Tester role, then stores the
 *      link { code -> {discordId, mcName, rank} } and marks it verified.
 *   4. The Minecraft plugin polls GET /testers/check?code=... (or ?mc=name) and
 *      gets back whether this player is a verified tester + their rank.
 *
 * Security:
 *   - /link only works in the configured TESTING channel.
 *   - Only members with Tester or SR Tester roles can complete a link.
 *   - The MC plugin authenticates to the API with a shared secret header.
 */

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

// ── Config (override via initTesters options / env) ──────────────────────────
const DATA_DIR    = path.join(__dirname, "..", "data");
const LINK_FILE   = path.join(DATA_DIR, "tester-links.json");

const TESTING_CHANNEL_ID = process.env.TESTING_CHANNEL_ID || "1508191242171715737";
const ROLE_TESTER        = process.env.ROLE_TESTER        || "1507472974175797288";
const ROLE_SR_TESTER     = process.env.ROLE_SR_TESTER     || "1496840324209836062";
// shared secret the MC plugin sends in the x-api-key header
const API_SECRET = process.env.TESTER_API_SECRET || "change-me-cookiesmp-secret";

// ── State ────────────────────────────────────────────────────────────────────
let client = null;
// links keyed by UPPERCASE code: { code: {discordId, discordTag, mcName, rank, verified, createdAt} }
let links = {};

// ── Persistence ──────────────────────────────────────────────────────────────
function ensureData() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error("[testers] data dir:", e.message); }
}
function load() {
  ensureData();
  try { if (fs.existsSync(LINK_FILE)) links = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")) || {}; }
  catch (e) { console.error("[testers] load failed:", e.message); links = {}; }
}
function save() {
  ensureData();
  try { fs.writeFileSync(LINK_FILE, JSON.stringify(links, null, 2)); }
  catch (e) { console.error("[testers] save failed:", e.message); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function rankOf(member) {
  if (member.roles.cache.has(ROLE_SR_TESTER)) return "SR Tester";
  if (member.roles.cache.has(ROLE_TESTER))    return "Tester";
  return null;
}

function findByCode(code) {
  return links[String(code).toUpperCase()] || null;
}
function findByMc(mcName) {
  const n = String(mcName).toLowerCase();
  return Object.values(links).find(l => l.mcName && l.mcName.toLowerCase() === n && l.verified) || null;
}
function findByDiscord(discordId) {
  return Object.values(links).find(l => l.discordId === discordId) || null;
}

// ── Slash command ────────────────────────────────────────────────────────────
const TESTER_COMMANDS = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Minecraft account to test on CookieSMP")
    .addStringOption(o => o.setName("code")
      .setDescription("The code from /testlink in Minecraft")
      .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove your Minecraft tester link")
    .toJSON()
];

async function handleTesterCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  const name = interaction.commandName;
  if (name !== "link" && name !== "unlink") return false;

  // must be used in the testing channel
  if (interaction.channelId !== TESTING_CHANNEL_ID) {
    await interaction.reply({
      content: `❌ Use this in <#${TESTING_CHANNEL_ID}> only.`,
      ephemeral: true
    });
    return true;
  }

  const member = interaction.member;
  const rank = rankOf(member);
  if (!rank) {
    await interaction.reply({
      content: "❌ You need the **Tester** or **SR Tester** role to link an account.",
      ephemeral: true
    });
    return true;
  }

  if (name === "unlink") {
    const existing = findByDiscord(interaction.user.id);
    if (!existing) {
      await interaction.reply({ content: "You don't have a linked account.", ephemeral: true });
      return true;
    }
    delete links[existing.code];
    save();
    await interaction.reply({ content: "✅ Your Minecraft link has been removed.", ephemeral: true });
    return true;
  }

  // /link <code>
  const code = interaction.options.getString("code").toUpperCase().trim();
  const entry = findByCode(code);
  if (!entry) {
    await interaction.reply({
      content: "❌ Invalid or expired code. Run `/testlink` in Minecraft to get a fresh one.",
      ephemeral: true
    });
    return true;
  }
  if (entry.verified) {
    await interaction.reply({ content: "That code was already used.", ephemeral: true });
    return true;
  }
  // code expires after 10 minutes
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    delete links[code];
    save();
    await interaction.reply({
      content: "❌ That code expired. Run `/testlink` in Minecraft again.",
      ephemeral: true
    });
    return true;
  }

  // one link per discord user: clear any previous
  const prev = findByDiscord(interaction.user.id);
  if (prev && prev.code !== code) { delete links[prev.code]; }

  entry.discordId = interaction.user.id;
  entry.discordTag = interaction.user.tag;
  entry.rank = rank;
  entry.verified = true;
  entry.linkedAt = Date.now();
  save();

  const embed = new EmbedBuilder()
    .setTitle("✅ Account Linked")
    .setColor(0x55dd55)
    .setDescription(
      `**${entry.mcName}** is now linked to ${interaction.user}.\n` +
      `Rank: **${rank}**\n\nYou can now use \`/testmode\` in-game.`);
  await interaction.reply({ embeds: [embed], ephemeral: true });
  return true;
}

// ── HTTP API (mounted onto the bot's existing express app) ───────────────────
/**
 * Call this with your express app instance from index.js:
 *   const app = express(); ... ; mountTesterApi(app);
 */
function mountTesterApi(app) {
  // the MC plugin registers a pending code: POST /testers/register {code, mcName}
  app.post("/testers/register", (req, res) => {
    if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ ok: false, error: "bad key" });
    const { code, mcName } = req.body || {};
    if (!code || !mcName) return res.status(400).json({ ok: false, error: "missing code or mcName" });
    const up = String(code).toUpperCase();
    links[up] = { code: up, mcName: String(mcName), verified: false, createdAt: Date.now() };
    save();
    return res.json({ ok: true });
  });

  // the MC plugin checks a player's tester status: GET /testers/check?mc=Name
  app.get("/testers/check", (req, res) => {
    if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ ok: false, error: "bad key" });
    const mc = req.query.mc;
    const code = req.query.code;
    let entry = null;
    if (mc) entry = findByMc(mc);
    else if (code) { const c = findByCode(code); if (c && c.verified) entry = c; }
    if (!entry) return res.json({ ok: true, linked: false });

    // re-verify the discord role is still present (so removing the role revokes access)
    let stillHasRole = true;
    try {
      const guild = client.guilds.cache.first();
      const member = guild && guild.members.cache.get(entry.discordId);
      if (member) {
        const rank = rankOf(member);
        stillHasRole = !!rank;
        if (rank && rank !== entry.rank) { entry.rank = rank; save(); }
      }
    } catch (_) {}
    return res.json({
      ok: true,
      linked: stillHasRole,
      mcName: entry.mcName,
      rank: entry.rank,
      discordTag: entry.discordTag
    });
  });

  console.log("[testers] API routes mounted (/testers/register, /testers/check)");
}

// ── Init ─────────────────────────────────────────────────────────────────────
function initTesters(discordClient, options = {}) {
  client = discordClient;
  load();
  console.log("[testers] tester linking ready. Testing channel:", TESTING_CHANNEL_ID);
}

module.exports = { initTesters, handleTesterCommand, mountTesterApi, TESTER_COMMANDS };
