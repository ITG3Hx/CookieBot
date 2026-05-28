require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const STAFF_REVIEW_CHANNEL_ID = process.env.STAFF_REVIEW_CHANNEL_ID;
const TESTER_REVIEW_CHANNEL_ID = process.env.TESTER_REVIEW_CHANNEL_ID || STAFF_REVIEW_CHANNEL_ID;
const REVIEWER_ROLE_ID = process.env.REVIEWER_ROLE_ID || "";
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(x => x.trim()).filter(Boolean);

if (!TOKEN || !STAFF_REVIEW_CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or STAFF_REVIEW_CHANNEL_ID in .env");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "applications.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
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
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
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

function buildEmbed(app) {
  const a = app.answers || {};
  const typeName = app.type === "staff" ? "Staff Application" : "Tester Application";
  const color = app.status === "Accepted" ? 0x43B581 : app.status === "Denied" ? 0xED4245 : app.status === "On Hold" ? 0xF1C40F : 0xBA7945;
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

function buttons(id, userId) {
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

  const dmSent = await tryDm(userId, `🍪 Cookie SMP Application\n\nYour application was received.\n\nID: ${id}\nStatus: Pending Review\n\nStaff will review your application.`);

  const channel = await client.channels.fetch(channelForType(body.type));
  if (!channel || !channel.isTextBased()) throw new Error("Review channel is not a text channel.");

  await channel.send({ embeds: [buildEmbed(app)], components: [buttons(id, userId)] });

  const chunks = rawText.match(/[\s\S]{1,1800}/g) || [rawText];
  for (const chunk of chunks.slice(0, 4)) await channel.send(`\`\`\`\n${chunk}\n\`\`\``);

  return { id, dmSent };
}

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton() || !interaction.customId.startsWith("app_")) return;

  if (!canReview(interaction.member)) {
    await interaction.reply({ content: "You cannot review applications.", ephemeral: true });
    return;
  }

  const [actionRaw, id, userIdRaw] = interaction.customId.split(":");
  const app = applications[id];
  if (!app) {
    await interaction.reply({ content: "Application not found in storage.", ephemeral: true });
    return;
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
    embeds: [buildEmbed(app)],
    components: [],
    content: `Reviewed by ${interaction.user} — **${status}**${dmSent ? " — DM sent" : " — DM not sent"}`
  });
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed by CORS"));
    }
  }));
  app.use(express.json({ limit: "300kb" }));
  app.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false }));

  app.get("/", (req, res) => res.json({ ok: true, name: "CookieApplicationsBot", version: "2.0.0" }));

  app.get("/applications/:id", (req, res) => {
    const found = applications[String(req.params.id || "").trim()];
    if (!found) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, id: found.id, type: found.type, status: found.status });
  });

  app.post("/applications", async (req, res) => {
    try {
      const body = req.body || {};
      if (!["tester", "staff"].includes(body.type)) return res.status(400).json({ ok: false, error: "Invalid type." });
      const answers = body.answers || {};
      if (!answers.mcName || !answers.discord) return res.status(400).json({ ok: false, error: "Missing required fields." });
      const result = await submitApplication(body);
      res.json({ ok: true, id: result.id, dmSent: result.dmSent });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, error: "Could not submit application." });
    }
  });

  app.listen(PORT, () => console.log(`Application API listening on port ${PORT}`));
});

client.login(TOKEN);
