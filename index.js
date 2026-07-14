"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { Client, GatewayIntentBits, Partials, REST, Routes } = require("discord.js");
const express    = require("express");
const helmet     = require("helmet");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");

const { initSecurity, handleSecurityCommand, SECURITY_COMMANDS } = require("./security");
// ── NEW: tester linking ───────────────────────────────────────────────────────
const { initTesters, handleTesterCommand, mountTesterApi, TESTER_COMMANDS } = require("./testers");
// ── NEW: giveaways ──────────────────────────────────────────────────────────────
const { initGiveaways, handleGiveawayCommand, GIVEAWAY_COMMANDS } = require("./giveaway");
// ── NEW: utility commands (/id /serverid /channelid /userinfo /serverinfo /ping) ─
const { handleUtilityCommand, UTILITY_COMMANDS } = require("./utility");
// ── NEW: moderation (warn/timeout/kick/ban/purge + infraction history) ─────────
const { initModeration, handleModerationCommand, MODERATION_COMMANDS } = require("./moderation");
// ── NEW: ticket system (support channel panel + private ticket channels) ───────
const { initTickets, handleTicketInteraction, TICKET_COMMANDS } = require("./tickets");
// ── NEW: server automations (autorole, welcome/goodbye, reaction roles, auto-reply)
const { initAutomation, handleAutomationInteraction } = require("./automation");
// ── NEW: leveling (XP, ranks, role rewards) ────────────────────────────────────
const { initLeveling, handleLevelingCommand, LEVELING_COMMANDS } = require("./leveling");
// ── NEW: custom prefix commands built in the dashboard ─────────────────────────
const { initCustomCommands } = require("./customcommands");
// ── NEW: timed messages ────────────────────────────────────────────────────────
const { initTimers } = require("./timers");
// ── NEW: starboard ─────────────────────────────────────────────────────────────
const { initStarboard } = require("./starboard");
// ── NEW: commands-only channels (auto-delete chatter) ─────────────────────────
const { initCleanChannels } = require("./cleanchannels");
// ── NEW: web control panel ─────────────────────────────────────────────────────
const { mountDashboard, applyStoredPresence } = require("./dashboard");

const { initApplications, mountApplications } = require("./applications");

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const GUILD_ID       = process.env.GUILD_ID;
const PORT           = process.env.PORT || 3000;
const APP_CHANNEL_ID = process.env.APPLICATION_CHANNEL_ID;  // where applications get posted
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const OWNER_ID       = process.env.OWNER_ID;

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,   // ban events (anti-nuke)
    GatewayIntentBits.GuildWebhooks,     // webhook events (anti-nuke)
    GatewayIntentBits.GuildMessageReactions,   // starboard
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],   // uncached deletes/edits + starboard reactions
});

// ── Express server ─────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);   // Railway sits behind a proxy; needed for req.secure + rate limits
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { "img-src": ["'self'", "data:", "https:"] },   // Discord avatars/icons on the dashboard
  },
}));
app.use(cors());
app.use(express.json());

// 30 req/min stays on the public endpoints; the dashboard mounts its own limits
const publicLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use(["/applications", "/testers"], publicLimiter);

// ── NEW: web control panel (auth + /api + static UI) ───────────────────────────
mountDashboard(app, client, { guildId: GUILD_ID, ownerId: OWNER_ID });

// ── NEW: staff applications site + reviewer panel (served at /apply) ────────────
mountApplications(app, client, { guildId: GUILD_ID });

// ── Application endpoint (existing, unchanged) ────────────────────────────────
app.post("/applications", async (req, res) => {
  try {
    const { type, applicationId, answers, rawText } = req.body || {};
    if (!type || !answers) return res.status(400).json({ ok: false, error: "missing fields" });

    const channel = APP_CHANNEL_ID ? await client.channels.fetch(APP_CHANNEL_ID).catch(() => null) : null;
    if (channel) {
      const { EmbedBuilder } = require("discord.js");
      const embed = new EmbedBuilder()
        .setTitle(`New Application, ${type}`)
        .setColor(0xff8c00)
        .setDescription(rawText || JSON.stringify(answers, null, 2).slice(0, 4000))
        .setFooter({ text: `ID: ${applicationId || "unknown"}` })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[applications] error:", err.message);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

// ── NEW: mount tester API routes ───────────────────────────────────────────────
mountTesterApi(app);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ ok: true, bot: "CookieBot", status: "online" }));

// ── Register slash commands ────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const commands = [
    ...UTILITY_COMMANDS,
    ...MODERATION_COMMANDS,
    ...SECURITY_COMMANDS,
    ...TESTER_COMMANDS,        // ── NEW
    ...GIVEAWAY_COMMANDS,      // ── NEW
    ...TICKET_COMMANDS,        // ── NEW
    ...LEVELING_COMMANDS,      // ── NEW (/rank /leaderboard)
  ];
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[bot] Registered ${commands.length} slash commands.`);
  } catch (err) {
    console.error("[bot] Command registration failed:", err.message);
  }
}

// ── Events ─────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);

  initSecurity(client, { logChannelId: LOG_CHANNEL_ID, ownerId: OWNER_ID });
  initTesters(client);          // ── NEW
  initGiveaways(client);        // ── NEW
  initModeration(client, { modlogChannelId: process.env.MODLOG_CHANNEL_ID || LOG_CHANNEL_ID, ownerId: OWNER_ID });
  initTickets(client);          // ── NEW
  initAutomation(client);       // ── NEW: autorole / welcome / goodbye / reaction roles / auto-reply
  initApplications(client, { guildId: GUILD_ID });   // ── NEW: staff applications
  initLeveling(client);         // ── NEW: XP + levels + role rewards
  initCustomCommands(client);   // ── NEW: dashboard-made prefix commands
  initTimers(client);           // ── NEW: timed messages
  initStarboard(client);        // ── NEW: starboard
  initCleanChannels(client);    // ── NEW: commands-only channels (after custom commands so replies go out first)
  applyStoredPresence(client);  // ── NEW: presence picked in the dashboard survives restarts

  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    // utility commands (/id /serverid /channelid /userinfo /serverinfo /ping)
    if (await handleUtilityCommand(interaction)) return;

    // moderation commands (warn/timeout/kick/ban/purge + history)
    if (await handleModerationCommand(interaction)) return;

    // ── NEW: tickets (panel button, modals, /ticket, /ticketpanel) ─────────────
    if (await handleTicketInteraction(interaction)) return;

    // ── NEW: reaction-role buttons (rr_<roleId>) ───────────────────────────────
    if (await handleAutomationInteraction(interaction)) return;

    // ── NEW: tester commands handled first ─────────────────────────────────────
    if (await handleTesterCommand(interaction)) return;

    // ── NEW: giveaway commands + Enter button ──────────────────────────────────
    if (await handleGiveawayCommand(interaction)) return;

    // ── NEW: leveling (/rank /leaderboard) ─────────────────────────────────────
    if (await handleLevelingCommand(interaction)) return;

    // existing: security commands
    if (await handleSecurityCommand(interaction)) return;

  } catch (err) {
    console.error("[bot] interaction error:", err.message);
    try {
      const msg = { content: "Something went wrong.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[bot] Express listening on port ${PORT}`));
if (!TOKEN) {
  console.error("[bot] DISCORD_TOKEN is not set. Running in dashboard-only mode; Discord features are offline.");
} else {
  client.login(TOKEN).catch(err => { console.error("[bot] Login failed:", err.message); process.exit(1); });
}
