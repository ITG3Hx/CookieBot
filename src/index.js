require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const env = (name, fallback = "") => String(process.env[name] || fallback).trim();

const TOKEN = env("DISCORD_TOKEN");
const STAFF_REVIEW_CHANNEL_ID = env("STAFF_REVIEW_CHANNEL_ID");
const TESTER_REVIEW_CHANNEL_ID = env("TESTER_REVIEW_CHANNEL_ID", STAFF_REVIEW_CHANNEL_ID);
const REVIEWER_ROLE_ID = env("REVIEWER_ROLE_ID");
const PORT = Number(env("PORT", "3000"));
const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS", "*").split(",").map(x => x.trim()).filter(Boolean);

const STAFF_APPLICATION_LINK = env("STAFF_APPLICATION_LINK", "https://c050a4db.cookiesmp-site.pages.dev/");
const TESTER_APPLICATION_LINK = env("TESTER_APPLICATION_LINK", "https://02481932.cookiesmp-site.pages.dev/");
const CREATOR_APPLICATION_LINK = env("CREATOR_APPLICATION_LINK", "PASTE_CREATOR_APPLICATION_LINK_HERE");

const COUNTRY_ROLE_NAMES = env("COUNTRY_ROLE_NAMES", "Russia,Germany,USA")
  .split(",")
  .map(role => role.trim())
  .filter(Boolean);

const NO_COUNTRY_ROLE_NAME = env("NO_COUNTRY_ROLE_NAME", "NoCountry");
const COUNTRY_REMINDER_DELAY_MS = Number(env("COUNTRY_REMINDER_DELAY_MS", "600000"));
const COUNTRY_CHANNEL_MENTION = env("COUNTRY_CHANNEL_MENTION", "🌏｜Country");

const STATUS_ROTATION_MS = Number(env("STATUS_ROTATION_MS", "120000"));
const BOT_STATUSES = [
  "Watching Cookie SMP",
  "Reviewing applications",
  "Preparing testing",
  "Building Cookie SMP",
  "Checking applications",
  "Preparing new updates",
  "Watching the community",
  "Working on testing",
  "Managing Cookie SMP",
  "Preparing launch systems"
];

if (!TOKEN || !STAFF_REVIEW_CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or STAFF_REVIEW_CHANNEL_ID in environment variables.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "applications.json");
const COUNTRY_REMINDER_FILE = path.join(DATA_DIR, "country-reminders.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(applications, null, 2), "utf8");
}

const applications = loadStore();

function loadCountryReminderStore() {
  try {
    if (!fs.existsSync(COUNTRY_REMINDER_FILE)) {
      return { sent: {}, pending: {} };
    }

    const data = JSON.parse(fs.readFileSync(COUNTRY_REMINDER_FILE, "utf8"));

    return {
      sent: data.sent || {},
      pending: data.pending || {}
    };
  } catch {
    return { sent: {}, pending: {} };
  }
}

function saveCountryReminderStore() {
  fs.writeFileSync(COUNTRY_REMINDER_FILE, JSON.stringify(countryReminders, null, 2), "utf8");
}

const countryReminders = loadCountryReminderStore();
const countryReminderTimers = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function clean(text, max = 1500) {
  return String(text || "")
    .replace(/@everyone/g, "@ everyone")
    .replace(/@here/g, "@ here")
    .trim()
    .slice(0, max);
}

function parseDiscordUserId(input) {
  const raw = String(input || "").trim();

  const mention = raw.match(/^<@!?(\d{16,25})>$/);
  if (mention) return mention[1];

  const id = raw.match(/\b\d{16,25}\b/);
  return id ? id[0] : null;
}

function makeApplicationId(type) {
  const prefix = type === "staff" ? "STAFF" : "TEST";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = `${prefix}-`;

  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

function canReview(member) {
  if (!member) return false;
  if (REVIEWER_ROLE_ID && member.roles.cache.has(REVIEWER_ROLE_ID)) return true;
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function channelForType(type) {
  return type === "staff" ? STAFF_REVIEW_CHANNEL_ID : TESTER_REVIEW_CHANNEL_ID;
}

function buildRawText(id, body) {
  const typeName = body.type === "staff" ? "Staff Application" : "Tester Application";
  const a = body.answers || {};

  return [
    `Cookie SMP ${typeName}`,
    `ID: ${id}`,
    `Status: Pending Review`,
    "",
    `IGN: ${clean(a.mcName, 64)}`,
    `Discord: ${clean(a.discord, 100)}`,
    a.age ? `Age: ${clean(a.age, 8)}` : null,
    a.timezone ? `Timezone: ${clean(a.timezone, 64)}` : null,
    a.role ? `Applying for: ${clean(a.role, 100)}` : null,
    a.focus ? `Focus: ${clean(a.focus, 100)}` : null,
    "",
    a.experience ? `Experience:\n${clean(a.experience, 1400)}\n` : null,
    a.why ? `Why should we choose you?\n${clean(a.why, 1400)}\n` : null,
    a.activity ? `Activity:\n${clean(a.activity, 900)}\n` : null,
    a.bug ? `Bug report example:\n${clean(a.bug, 1400)}\n` : null,
    a.scenarioCheat ? `Scenario - cheating report:\n${clean(a.scenarioCheat, 1400)}\n` : null,
    a.scenarioFriend ? `Scenario - friend breaks a rule:\n${clean(a.scenarioFriend, 1400)}\n` : null,
    "Agreement: Applicant agreed to the application rules."
  ].filter(Boolean).join("\n");
}

function buildApplicationEmbed(app) {
  const a = app.answers || {};
  const typeName = app.type === "staff" ? "Staff Application" : "Tester Application";

  const color =
    app.status === "Accepted" ? 0x43B581 :
    app.status === "Denied" ? 0xED4245 :
    app.status === "On Hold" ? 0xF1C40F :
    0xBA7945;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Cookie SMP ${typeName}`)
    .setDescription(`**Status:** ${app.status}\n**ID:** \`${app.id}\``)
    .addFields(
      { name: "Minecraft", value: clean(a.mcName, 100) || "Unknown", inline: true },
      { name: "Discord", value: app.userId ? `<@${app.userId}>` : clean(a.discord, 100) || "Unknown", inline: true },
      { name: "Type", value: typeName, inline: true },
      { name: app.type === "staff" ? "Role" : "Focus", value: clean(a.role || a.focus, 200) || "Not set", inline: false }
    )
    .setFooter({ text: "Cookie SMP Applications" })
    .setTimestamp(app.createdAt || Date.now());
}

function applicationButtons(id, userId) {
  const safeUser = userId || "none";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app_accept:${id}:${safeUser}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app_deny:${id}:${safeUser}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`app_hold:${id}:${safeUser}`).setLabel("Hold").setStyle(ButtonStyle.Secondary)
  );
}

async function tryDm(userId, message) {
  if (!userId) return false;

  try {
    const user = await client.users.fetch(userId);
    await user.send(message.slice(0, 1900));
    return true;
  } catch {
    return false;
  }
}

async function submitApplication(body) {
  const id = clean(body.applicationId, 32) || makeApplicationId(body.type);
  const answers = body.answers || {};
  const userId = parseDiscordUserId(answers.discord);
  const rawText = clean(body.rawText, 6000) || buildRawText(id, body);

  const app = {
    id,
    type: body.type,
    status: "Pending Review",
    userId,
    answers,
    rawText,
    createdAt: Date.now(),
    reviewedBy: null,
    reviewedAt: null
  };

  applications[id] = app;
  saveStore();

  const dmSent = await tryDm(
    userId,
    `🍪 Cookie SMP Application\n\nYour application was received.\n\nID: ${id}\nStatus: Pending Review\n\nStaff will review your application.`
  );

  const channel = await client.channels.fetch(channelForType(body.type));
  if (!channel || !channel.isTextBased()) {
    throw new Error("Review channel is not a text channel.");
  }

  await channel.send({
    embeds: [buildApplicationEmbed(app)],
    components: [applicationButtons(id, userId)]
  });

  const chunks = rawText.match(/[\s\S]{1,1800}/g) || [rawText];

  for (const chunk of chunks.slice(0, 4)) {
    await channel.send(`\`\`\`\n${chunk}\n\`\`\``);
  }

  return { id, dmSent };
}

function getRoleByName(guild, roleName) {
  return guild.roles.cache.find(role =>
    role.name.toLowerCase() === String(roleName).toLowerCase()
  );
}

function hasCountryRole(member) {
  return member.roles.cache.some(role =>
    COUNTRY_ROLE_NAMES.some(name => role.name.toLowerCase() === name.toLowerCase())
  );
}

async function updateNoCountry(member, reason = "NoCountry role sync") {
  if (!member || member.user.bot) {
    return { added: false, removed: false, skipped: true };
  }

  const noCountryRole = getRoleByName(member.guild, NO_COUNTRY_ROLE_NAME);

  if (!noCountryRole) {
    console.warn(`[NoCountry] Role "${NO_COUNTRY_ROLE_NAME}" not found`);
    return { added: false, removed: false, skipped: true };
  }

  const hasCountry = hasCountryRole(member);
  const hasNoCountry = member.roles.cache.has(noCountryRole.id);

  if (!hasCountry && !hasNoCountry) {
    await member.roles.add(noCountryRole, "Missing country role");
    return { added: true, removed: false, skipped: false };
  }

  if (hasCountry && hasNoCountry) {
    await member.roles.remove(noCountryRole, "Has country role");
    return { added: false, removed: true, skipped: false };
  }

  return { added: false, removed: false, skipped: false };
}

async function syncNoCountry(guild) {
  const noCountryRole = getRoleByName(guild, NO_COUNTRY_ROLE_NAME);

  if (!noCountryRole) {
    throw new Error(`Role "${NO_COUNTRY_ROLE_NAME}" not found`);
  }

  await guild.members.fetch();

  let added = 0;
  let removed = 0;
  let failed = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;

    try {
      const result = await updateNoCountry(member, "Manual NoCountry sync");

      if (result.added) added++;
      if (result.removed) removed++;

      await wait(250);
    } catch (error) {
      failed++;
      console.warn(`[NoCountry] Failed for ${member.user.tag}: ${error.message}`);
    }
  }

  return { added, removed, failed };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasCountryReminderBeenSent(member) {
  return Boolean(countryReminders.sent[member.id]);
}

function markCountryReminderSent(member) {
  countryReminders.sent[member.id] = Date.now();
  delete countryReminders.pending[member.id];
  saveCountryReminderStore();
}

function cancelCountryReminder(member) {
  const timer = countryReminderTimers.get(member.id);

  if (timer) {
    clearTimeout(timer);
    countryReminderTimers.delete(member.id);
  }

  if (countryReminders.pending[member.id]) {
    delete countryReminders.pending[member.id];
    saveCountryReminderStore();
  }
}

function scheduleCountryReminder(member) {
  if (!member || member.user.bot) return;
  if (hasCountryReminderBeenSent(member)) return;
  if (hasCountryRole(member)) {
    cancelCountryReminder(member);
    return;
  }

  const sendAt = Date.now() + COUNTRY_REMINDER_DELAY_MS;
  const currentPending = countryReminders.pending[member.id];

  if (currentPending && currentPending > Date.now()) return;

  countryReminders.pending[member.id] = sendAt;
  saveCountryReminderStore();

  startCountryReminderTimer(member.guild.id, member.id, COUNTRY_REMINDER_DELAY_MS);
}

function startCountryReminderTimer(guildId, userId, delayMs) {
  if (countryReminderTimers.has(userId)) return;

  const timer = setTimeout(async () => {
    countryReminderTimers.delete(userId);
    await sendCountryReminderIfNeeded(guildId, userId);
  }, Math.max(1000, delayMs));

  countryReminderTimers.set(userId, timer);
}

async function sendCountryReminderIfNeeded(guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  let member = null;

  try {
    member = await guild.members.fetch(userId);
  } catch {
    delete countryReminders.pending[userId];
    saveCountryReminderStore();
    return;
  }

  if (!member || member.user.bot) return;

  if (hasCountryRole(member)) {
    cancelCountryReminder(member);
    return;
  }

  if (hasCountryReminderBeenSent(member)) {
    cancelCountryReminder(member);
    return;
  }

  try {
    await member.send(
      `Please choose your country in **${COUNTRY_CHANNEL_MENTION}**.`
    );

    markCountryReminderSent(member);
  } catch (error) {
    console.warn(`[CountryReminder] Could not DM ${member.user.tag}: ${error.message}`);
    markCountryReminderSent(member);
  }
}

function restoreCountryReminderTimers() {
  const now = Date.now();

  for (const [userId, sendAt] of Object.entries(countryReminders.pending)) {
    const delay = Number(sendAt) - now;

    if (delay <= 0) {
      for (const guild of client.guilds.cache.values()) {
        sendCountryReminderIfNeeded(guild.id, userId).catch(error =>
          console.warn(`[CountryReminder] Restore failed for ${userId}: ${error.message}`)
        );
      }

      continue;
    }

    for (const guild of client.guilds.cache.values()) {
      startCountryReminderTimer(guild.id, userId, delay);
      break;
    }
  }
}

let statusIndex = 0;
let statusTimer = null;

function updateBotStatus() {
  if (!client.user || !BOT_STATUSES.length) return;

  const status = BOT_STATUSES[statusIndex % BOT_STATUSES.length];
  statusIndex++;

  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: status,
        type: ActivityType.Watching
      }
    ]
  }).catch(error => {
    console.warn("[StatusRotation] Could not update bot status:", error.message);
  });
}

function startStatusRotation() {
  if (statusTimer) clearInterval(statusTimer);

  updateBotStatus();

  statusTimer = setInterval(() => {
    updateBotStatus();
  }, Math.max(30000, STATUS_ROTATION_MS));
}

const COOKIE_COMMANDS = [
  { name: "id", description: "Show your Discord user ID" },
  { name: "serverid", description: "Show this server ID" },
  { name: "channelid", description: "Show this channel ID" },
  { name: "avatar", description: "Show your Discord avatar" },
  { name: "applications", description: "Show Cookie SMP application links" },
  { name: "status", description: "Show Cookie SMP status" },
  { name: "help", description: "Show CookieBot commands" },
  { name: "sync-nocountry", description: "Sync the NoCountry role" },
  { name: "announce", description: "ㅤ" }
];

async function registerCookieCommands() {
  const commandNames = COOKIE_COMMANDS.map(command => command.name).join(", ");
  const cookieCommandNames = new Set(COOKIE_COMMANDS.map(command => command.name));

  try {
    const globalCommands = await client.application.commands.fetch();
    const keepGlobalCommands = globalCommands
      .filter(command => !cookieCommandNames.has(command.name))
      .map(command => ({
        name: command.name,
        description: command.description,
        options: command.options || [],
        default_member_permissions: command.defaultMemberPermissions?.bitfield?.toString() || null,
        dm_permission: command.dmPermission ?? false
      }));

    await client.application.commands.set(keepGlobalCommands);
    console.log("CookieBot global duplicate commands cleaned without touching unrelated global commands.");
  } catch (error) {
    console.error("Could not clean global CookieBot slash commands:", error.message);
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      const guildCommands = await guild.commands.fetch();

      const keepGuildCommands = guildCommands
        .filter(command => !cookieCommandNames.has(command.name))
        .map(command => ({
          name: command.name,
          description: command.description,
          options: command.options || [],
          default_member_permissions: command.defaultMemberPermissions?.bitfield?.toString() || null,
          dm_permission: command.dmPermission ?? false
        }));

      await guild.commands.set([...keepGuildCommands, ...COOKIE_COMMANDS]);
      console.log(`CookieBot guild slash commands merged for ${guild.name}: ${commandNames}`);
    } catch (error) {
      console.error(`Could not merge guild commands for ${guild.name}:`, error.message);
    }
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  registerCookieCommands();
  restoreCountryReminderTimers();
  startStatusRotation();

  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());

  app.use(cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }

      return cb(new Error("Origin not allowed by CORS"));
    }
  }));

  app.use(express.json({ limit: "300kb" }));

  app.use(rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false
  }));

  app.get("/", (req, res) => {
    res.json({
      ok: true,
      name: "CookieApplicationsBot",
      version: "2.1.0"
    });
  });

  app.get("/applications/:id", (req, res) => {
    const found = applications[String(req.params.id || "").trim()];

    if (!found) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    res.json({
      ok: true,
      id: found.id,
      type: found.type,
      status: found.status
    });
  });

  app.post("/applications", async (req, res) => {
    try {
      const body = req.body || {};

      if (!["tester", "staff"].includes(body.type)) {
        return res.status(400).json({ ok: false, error: "Invalid type." });
      }

      const answers = body.answers || {};

      if (!answers.mcName || !answers.discord) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
      }

      const result = await submitApplication(body);

      res.json({
        ok: true,
        id: result.id,
        dmSent: result.dmSent
      });
    } catch (error) {
      console.error("Application submit failed:", error);
      res.status(500).json({ ok: false, error: "Could not submit application." });
    }
  });

  app.listen(PORT, () => {
    console.log(`Application API listening on port ${PORT}`);
  });
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "id") {
        return interaction.reply({
          content: `Your Discord User ID:\n\`${interaction.user.id}\``,
          ephemeral: true
        });
      }

      if (interaction.commandName === "serverid") {
        return interaction.reply({
          content: interaction.guild
            ? `Server ID:\n\`${interaction.guild.id}\``
            : "This command can only be used in a server.",
          ephemeral: true
        });
      }

      if (interaction.commandName === "channelid") {
        return interaction.reply({
          content: `Channel ID:\n\`${interaction.channelId}\``,
          ephemeral: true
        });
      }

      if (interaction.commandName === "avatar") {
        return interaction.reply({
          content: interaction.user.displayAvatarURL({ size: 1024, extension: "png" }),
          ephemeral: true
        });
      }

      if (interaction.commandName === "applications") {
        return interaction.reply({
          content: [
            "🍪 **Cookie SMP Applications**",
            "",
            "Staff Application:",
            STAFF_APPLICATION_LINK,
            "",
            "Tester Application:",
            TESTER_APPLICATION_LINK,
            "",
            "Creator Application:",
            CREATOR_APPLICATION_LINK
          ].join("\n"),
          ephemeral: true
        });
      }

      if (interaction.commandName === "status") {
        return interaction.reply({
          content: [
            "🍪 **Cookie SMP Status**",
            "",
            "Server: `In development`",
            "Version: `1.21+`",
            "Region: `EU`",
            "Applications: `Open`"
          ].join("\n"),
          ephemeral: true
        });
      }

      if (interaction.commandName === "announce") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            content: "You need Manage Server to use this.",
            ephemeral: true
          });
        }

        const modal = new ModalBuilder()
          .setCustomId("cookie_announce_modal")
          .setTitle("Cookie SMP Announcement");

        const titleInput = new TextInputBuilder()
          .setCustomId("announce_title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Cookie SMP Update")
          .setRequired(true)
          .setMaxLength(100);

        const messageInput = new TextInputBuilder()
          .setCustomId("announce_message")
          .setLabel("Message")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("You can use **bold**, *italic*, __underline__ and bullet points")
          .setRequired(true)
          .setMaxLength(1800);

        const styleInput = new TextInputBuilder()
          .setCustomId("announce_style")
          .setLabel("Style optional")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("normal, big, huge, quote")
          .setRequired(false)
          .setMaxLength(20);

        const pingInput = new TextInputBuilder()
          .setCustomId("announce_ping")
          .setLabel("Ping optional")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("none, everyone, or here")
          .setRequired(false)
          .setMaxLength(20);

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(messageInput),
          new ActionRowBuilder().addComponents(styleInput),
          new ActionRowBuilder().addComponents(pingInput)
        );

        return interaction.showModal(modal);
      }

      if (interaction.commandName === "sync-nocountry") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return interaction.reply({
            content: "You need Manage Roles to use this.",
            ephemeral: true
          });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const result = await syncNoCountry(interaction.guild);

          return interaction.editReply({
            content: [
              "🍪 **NoCountry Sync Finished**",
              "",
              `Added: \`${result.added}\``,
              `Removed: \`${result.removed}\``,
              `Failed: \`${result.failed}\``
            ].join("\n")
          });
        } catch (error) {
          return interaction.editReply({
            content: `NoCountry sync failed: ${error.message}`
          });
        }
      }

      if (interaction.commandName === "help") {
        return interaction.reply({
          content: [
            "🍪 **CookieBot Commands**",
            "",
            "`/id` - Get your Discord user ID",
            "`/serverid` - Get this server ID",
            "`/channelid` - Get this channel ID",
            "`/avatar` - Get your avatar link",
            "`/applications` - Show application links",
            "`/status` - Show Cookie SMP status",
            "`/help` - Show this command list",
            "`/sync-nocountry` - Sync the NoCountry role",
            "`/announce` - Send a clean announcement embed"
          ].join("\n"),
          ephemeral: true
        });
      }

      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "cookie_announce_modal") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: "You need Manage Server to use this.",
          ephemeral: true
        });
      }

      const title = clean(interaction.fields.getTextInputValue("announce_title"), 100) || "Cookie SMP Update";
      const rawMessage = clean(interaction.fields.getTextInputValue("announce_message"), 1800);
      const style = clean(interaction.fields.getTextInputValue("announce_style"), 20).toLowerCase();
      const pingRaw = clean(interaction.fields.getTextInputValue("announce_ping"), 20).toLowerCase();

      let ping = "";
      if (pingRaw === "everyone" || pingRaw === "@everyone") ping = "@everyone";
      if (pingRaw === "here" || pingRaw === "@here") ping = "@here";

      let titleText = `🍪 ${title}`;
      let message = rawMessage;

      if (style === "big") titleText = `# 🍪 ${title}`;
      if (style === "huge") {
        titleText = `# 🍪 ${title}`;
        message = `## ${rawMessage}`;
      }
      if (style === "quote") {
        message = rawMessage
          .split("\\n")
          .map(line => line.trim() ? `> ${line}` : ">")
          .join("\\n");
      }

      const embed = new EmbedBuilder()
        .setColor(0xBA7945)
        .setDescription(`${titleText}\\n\\n${message}`)
        .setTimestamp();

      await interaction.channel.send({
        content: ping,
        embeds: [embed],
        allowedMentions: ping ? { parse: [ping.replace("@", "")] } : { parse: [] }
      });

      return interaction.reply({
        content: "Announcement sent.",
        ephemeral: true
      });
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("app_")) return;

    if (!canReview(interaction.member)) {
      return interaction.reply({
        content: "You cannot review applications.",
        ephemeral: true
      });
    }

    const [actionRaw, id, userIdRaw] = interaction.customId.split(":");
    const app = applications[id];

    if (!app) {
      return interaction.reply({
        content: "Application not found in storage.",
        ephemeral: true
      });
    }

    const action = actionRaw.replace("app_", "");
    const userId = userIdRaw === "none" ? app.userId : userIdRaw;

    let status = "On Hold";

    if (action === "accept") status = "Accepted";
    if (action === "deny") status = "Denied";

    app.status = status;
    app.reviewedBy = interaction.user.id;
    app.reviewedAt = Date.now();
    saveStore();

    const dmText =
      status === "Accepted"
        ? `🍪 Cookie SMP Application\n\nYour application was accepted.\n\nID: ${id}\nStatus: Accepted\n\nStaff will contact you with the next steps.`
        : status === "Denied"
        ? `🍪 Cookie SMP Application\n\nYour application was reviewed.\n\nID: ${id}\nStatus: Denied\n\nYou can apply again later if applications are open.`
        : `🍪 Cookie SMP Application\n\nYour application is currently on hold.\n\nID: ${id}\nStatus: On Hold\n\nStaff may contact you if more info is needed.`;

    const dmSent = await tryDm(userId, dmText);

    await interaction.update({
      embeds: [buildApplicationEmbed(app)],
      components: [],
      content: `Reviewed by ${interaction.user} — **${status}**${dmSent ? " — DM sent" : " — DM not sent"}`
    });
  } catch (error) {
    console.error("Interaction failed:", error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.on("error", error => {
  console.error("Discord client error:", error?.message || error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error?.message || error);
});


client.on("guildMemberAdd", async member => {
  try {
    await updateNoCountry(member, "Joined without country role");

    if (!hasCountryRole(member)) {
      scheduleCountryReminder(member);
    }
  } catch (error) {
    console.warn(`[NoCountry] Join update failed for ${member.user.tag}: ${error.message}`);
  }
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    await updateNoCountry(newMember, "Country role changed");

    if (hasCountryRole(newMember)) {
      cancelCountryReminder(newMember);
    } else {
      scheduleCountryReminder(newMember);
    }
  } catch (error) {
    console.warn(`[NoCountry] Role update failed for ${newMember.user.tag}: ${error.message}`);
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  if (message.content.toLowerCase() === "!syncnocountry") {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return message.reply("You need Manage Roles to use this.");
    }

    const msg = await message.reply("Syncing NoCountry roles...");

    try {
      const result = await syncNoCountry(message.guild);

      await msg.edit(
        `NoCountry sync done\nAdded: ${result.added}\nRemoved: ${result.removed}\nFailed: ${result.failed}`
      );
    } catch (error) {
      await msg.edit(`NoCountry sync failed: ${error.message}`);
    }

    return;
  }

  if (message.content.toLowerCase().startsWith("!announce ")) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return message.reply("You need Manage Server to use this.");
    }

    const raw = message.content.slice("!announce ".length).trim();
    const parts = raw.split("|").map(part => part.trim());

    const title = clean(parts[0], 100) || "Cookie SMP Update";
    const rawAnnouncement = clean(parts[1], 1800) || "No message provided.";
    const style = clean(parts[2], 20).toLowerCase();
    const pingRaw = clean(parts[3] || parts[2], 20).toLowerCase();

    let ping = "";
    if (pingRaw === "everyone" || pingRaw === "@everyone") ping = "@everyone";
    if (pingRaw === "here" || pingRaw === "@here") ping = "@here";

    let titleText = `🍪 ${title}`;
    let announcement = rawAnnouncement;

    if (style === "big") titleText = `# 🍪 ${title}`;
    if (style === "huge") {
      titleText = `# 🍪 ${title}`;
      announcement = `## ${rawAnnouncement}`;
    }
    if (style === "quote") {
      announcement = rawAnnouncement
        .split("\\n")
        .map(line => line.trim() ? `> ${line}` : ">")
        .join("\\n");
    }

    const embed = new EmbedBuilder()
      .setColor(0xBA7945)
      .setDescription(`${titleText}\\n\\n${announcement}`)
      .setTimestamp();

    await message.channel.send({
      content: ping,
      embeds: [embed],
      allowedMentions: ping ? { parse: [ping.replace("@", "")] } : { parse: [] }
    });

    await message.reply("Announcement sent.").catch(() => {});
  }
});

client.login(TOKEN);
