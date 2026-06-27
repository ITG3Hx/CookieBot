"use strict";

/**
 * CookieBot — Tester account-linking module.
 *
 * Wire into index.js:
 *   initTesters(client)         call once when client is ready
 *   handleTesterCommand(inter)  call at top of interactionCreate
 *   mountTesterApi(app)         call once with your express app
 *   TESTER_COMMANDS             spread into your slash-command registration array
 */

const fs   = require("fs");
const path = require("path");
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

// ── IDs ───────────────────────────────────────────────────────────────────────
const TESTING_CHANNEL_ID = process.env.TESTING_CHANNEL_ID || "1508191242171715737";
const ROLE_TESTER        = process.env.ROLE_TESTER        || "1507472974175797288";
const ROLE_SR_TESTER     = process.env.ROLE_SR_TESTER     || "1496840324209836062";
const API_SECRET         = process.env.TESTER_API_SECRET  || "change-me-cookiesmp-secret";

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, "data");
const LINK_FILE  = path.join(DATA_DIR, "tester-links.json");

let client = null;
let links  = {};   // { "COOKIE-XXXX": { code, mcName, discordId, discordTag, rank, verified, createdAt, linkedAt } }

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function load() {
  ensureData();
  try {
    if (fs.existsSync(LINK_FILE)) links = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")) || {};
  } catch { links = {}; }
}
function save() {
  ensureData();
  fs.writeFileSync(LINK_FILE, JSON.stringify(links, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function rankOf(member) {
  if (!member) return null;
  if (member.roles.cache.has(ROLE_SR_TESTER)) return "SR Tester";
  if (member.roles.cache.has(ROLE_TESTER))    return "Tester";
  return null;
}
function byCode(code)   { return links[String(code).toUpperCase()] || null; }
function byMc(name)     { const n = name.toLowerCase(); return Object.values(links).find(l => l.verified && l.mcName?.toLowerCase() === n) || null; }
function byDiscord(id)  { return Object.values(links).find(l => l.discordId === id) || null; }

// ── Slash commands ─────────────────────────────────────────────────────────────
const TESTER_COMMANDS = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Minecraft account to test on CookieSMP")
    .addStringOption(o => o.setName("code").setDescription("Code from /testlink in Minecraft").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove your Minecraft tester link")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("testerlist")
    .setDescription("[Staff] Show all linked tester accounts")
    .toJSON(),
];

async function handleTesterCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  const cmd = interaction.commandName;
  if (!["link","unlink","testerlist"].includes(cmd)) return false;

  // ── /testerlist (staff only) ────────────────────────────────────────────────
  if (cmd === "testerlist") {
    const member = interaction.member;
    if (!member.permissions.has("ManageGuild")) {
      await interaction.reply({ content: "❌ Staff only.", ephemeral: true }); return true;
    }
    const verified = Object.values(links).filter(l => l.verified);
    if (!verified.length) {
      await interaction.reply({ content: "No linked testers yet.", ephemeral: true }); return true;
    }
    const lines = verified.map(l =>
      `**${l.mcName}** — ${l.rank} — <@${l.discordId}> (\`${l.discordTag}\`)`);
    const embed = new EmbedBuilder()
      .setTitle(`Linked Testers (${verified.length})`)
      .setColor(0x55ddff)
      .setDescription(lines.join("\n"));
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  // /link and /unlink must be in the testing channel
  if (interaction.channelId !== TESTING_CHANNEL_ID) {
    await interaction.reply({ content: `❌ Use this in <#${TESTING_CHANNEL_ID}> only.`, ephemeral: true });
    return true;
  }

  const member = interaction.member;
  const rank   = rankOf(member);

  // ── /unlink ─────────────────────────────────────────────────────────────────
  if (cmd === "unlink") {
    const existing = byDiscord(interaction.user.id);
    if (!existing) {
      await interaction.reply({ content: "You don't have a linked Minecraft account.", ephemeral: true });
      return true;
    }
    delete links[existing.code];
    save();
    await interaction.reply({ content: `✅ **${existing.mcName}** has been unlinked.`, ephemeral: true });
    return true;
  }

  // ── /link <code> ─────────────────────────────────────────────────────────────
  if (!rank) {
    await interaction.reply({ content: "❌ You need the **Tester** or **SR Tester** role to link an account.", ephemeral: true });
    return true;
  }

  const code  = interaction.options.getString("code").toUpperCase().trim();
  const entry = byCode(code);

  if (!entry) {
    await interaction.reply({ content: "❌ Invalid code. Run `/testlink` in Minecraft to get a fresh one.", ephemeral: true });
    return true;
  }
  if (entry.verified) {
    await interaction.reply({ content: "❌ That code was already used.", ephemeral: true });
    return true;
  }
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
    delete links[code]; save();
    await interaction.reply({ content: "❌ Code expired. Run `/testlink` in Minecraft again.", ephemeral: true });
    return true;
  }

  // clear any old link for this discord user
  const prev = byDiscord(interaction.user.id);
  if (prev && prev.code !== code) { delete links[prev.code]; }

  entry.discordId  = interaction.user.id;
  entry.discordTag = interaction.user.tag;
  entry.rank       = rank;
  entry.verified   = true;
  entry.linkedAt   = Date.now();
  save();

  const embed = new EmbedBuilder()
    .setTitle("✅ Account Linked")
    .setColor(0x55dd55)
    .setDescription(
      `**${entry.mcName}** is now linked to ${interaction.user}.\n` +
      `Rank: **${rank}**\n\nYou can now use \`/testmode\` on the server.`);
  await interaction.reply({ embeds: [embed], ephemeral: true });
  return true;
}

// ── HTTP API ──────────────────────────────────────────────────────────────────
function mountTesterApi(app) {
  // called by the MC plugin to register a pending code
  app.post("/testers/register", (req, res) => {
    if (req.headers["x-api-key"] !== API_SECRET)
      return res.status(401).json({ ok: false, error: "bad key" });
    const { code, mcName } = req.body || {};
    if (!code || !mcName) return res.status(400).json({ ok: false, error: "missing fields" });
    const up = String(code).toUpperCase();
    links[up] = { code: up, mcName: String(mcName), verified: false, createdAt: Date.now() };
    save();
    return res.json({ ok: true });
  });

  // called by the MC plugin to check if a player is a verified tester
  app.get("/testers/check", (req, res) => {
    if (req.headers["x-api-key"] !== API_SECRET)
      return res.status(401).json({ ok: false, error: "bad key" });
    const entry = req.query.mc ? byMc(req.query.mc) : null;
    if (!entry) return res.json({ ok: true, linked: false });

    // re-check the discord role is still present (revoking role = instant revoke)
    try {
      const guild  = client?.guilds.cache.first();
      const member = guild?.members.cache.get(entry.discordId);
      if (member) {
        const rank = rankOf(member);
        if (!rank) return res.json({ ok: true, linked: false });
        if (rank !== entry.rank) { entry.rank = rank; save(); }
      }
    } catch (_) {}

    return res.json({ ok: true, linked: true, mcName: entry.mcName, rank: entry.rank, discordTag: entry.discordTag });
  });

  console.log("[testers] API mounted: POST /testers/register  GET /testers/check");
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initTesters(discordClient) {
  client = discordClient;
  load();
  console.log("[testers] Tester linking ready — testing channel:", TESTING_CHANNEL_ID);
}

module.exports = { initTesters, handleTesterCommand, mountTesterApi, TESTER_COMMANDS };
