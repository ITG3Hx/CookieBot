"use strict";

/**
 * CookieBot - Ticket system.
 *
 * Panel message with an "Open a ticket" button in the support channel. Each
 * ticket is a private text channel under a configurable category, visible to
 * the opener, the support role and the bot. Closing a ticket saves a full
 * transcript to data/transcripts/ and posts a summary (plus a .txt copy) to
 * the ticket log channel, then deletes the channel.
 *
 * Wire into index.js:
 *   initTickets(client)             call once when client is ready
 *   handleTicketInteraction(inter)  call at top of interactionCreate
 *   TICKET_COMMANDS                 spread into the slash-command registration array
 *
 * Commands:
 *   /ticketpanel [channel]                    post the open-a-ticket panel (Manage Server)
 *   /ticket close [reason]                    close this ticket (opener or staff)
 *   /ticket claim                             claim this ticket (staff)
 *   /ticket add <user> | remove <user>        manage who can see this ticket (staff)
 *   /ticket rename <name>                     rename this ticket channel (staff)
 *
 * Everything (settings, panel, replies, closing, transcripts) is also driven
 * by the web dashboard through the web* exports at the bottom.
 */

const fs   = require("fs");
const path = require("path");
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits, AttachmentBuilder,
} = require("discord.js");
const { pushActivity } = require("./activity");

// ── Config ────────────────────────────────────────────────────────────────────
const COLOR             = 0xff8c00;
const OPEN_COOLDOWN_MS  = 30_000;      // per user, between ticket opens
const TRANSCRIPT_LIMIT  = 1000;        // max messages saved per ticket
const ACTIVITY_SAVE_MS  = 30_000;      // debounce for persisting last-activity timestamps

const BUTTON_STYLES = {
  primary:   ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success:   ButtonStyle.Success,
  danger:    ButtonStyle.Danger,
};

const DEFAULT_SETTINGS = {
  categoryId: null,          // category the ticket channels are created under
  supportRoleId: null,       // role that can see and work tickets
  logChannelId: null,        // where close summaries + transcripts get posted
  maxOpenPerUser: 1,         // open tickets one user may have at once (1-10)
  pingSupport: true,         // mention the support role when a ticket opens
  namePrefix: "ticket",      // channel name prefix: ticket-0001
  naming: "number",          // "number" -> ticket-0001, "name" -> ticket-username
  panelTitle: "CookieSMP Support",
  panelText: "Need help? Click the button below and a private channel opens up for you and the team.",
  panelColor: "#ff8c00",     // embed colour for the panel + welcome message
  buttonLabel: "Open a ticket",
  buttonEmoji: "",           // optional emoji on the panel button (unicode or <:name:id>)
  buttonStyle: "primary",    // primary | secondary | success | danger
  welcomeMessage: "Support will be with you shortly. Describe your issue with as much detail as you can.",
  closeDelaySeconds: 5,      // grace period before the channel is deleted on close (0-60)
  dmOnClose: false,          // DM the opener a copy of the transcript when their ticket closes
  autoCloseHours: 0,         // auto-close tickets with no activity for this many hours (0 = off)
  topics: [],                // optional categories: [{ label, emoji, description }]
};

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, "data");
const TICKET_FILE    = path.join(DATA_DIR, "tickets.json");
const TRANSCRIPT_DIR = path.join(DATA_DIR, "transcripts");

let client = null;
let state = { settings: { ...DEFAULT_SETTINGS }, counter: 0, tickets: {} };
// state.tickets[channelId] = { id, channelId, guildId, openerId, openerTag, subject,
//   details, status: "open"|"closed", createdAt, claimedById, claimedByTag,
//   closedAt, closedBy, closeReason, messageCount, transcriptFile }

const openCooldown = new Map();        // userId -> last open attempt ts
const closing = new Set();             // channelIds mid-close (double-close guard)
let activitySaveTimer = null;          // debounce for last-activity persistence

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
}
function load() {
  ensureData();
  try {
    if (fs.existsSync(TICKET_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TICKET_FILE, "utf8")) || {};
      state = {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        counter: Number.isInteger(raw.counter) ? raw.counter : 0,
        tickets: raw.tickets || {},
      };
    }
  } catch (e) {
    console.error("[tickets] load failed, starting fresh:", e.message);
    state = { settings: { ...DEFAULT_SETTINGS }, counter: 0, tickets: {} };
  }
}
function save() { ensureData(); try { fs.writeFileSync(TICKET_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error("[tickets] save:", e.message); } }

// ── Helpers ───────────────────────────────────────────────────────────────────
function ticketNo(n) { return String(n).padStart(4, "0"); }
function byChannel(channelId) { return state.tickets[channelId] || null; }
function openTickets() { return Object.values(state.tickets).filter(t => t.status === "open"); }

function colorInt(hex, fallback = 0xff8c00) {
  if (typeof hex === "string") { const m = hex.replace("#", ""); if (/^[0-9a-f]{6}$/i.test(m)) return parseInt(m, 16); }
  return fallback;
}
function ticketName(s, id, opener) {
  if (s.naming === "name") {
    const clean = String(opener.username || "user").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "user";
    return `${s.namePrefix}-${clean}`.slice(0, 95);
  }
  return `${s.namePrefix}-${ticketNo(id)}`;
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return true;
  const roleId = state.settings.supportRoleId;
  return !!(roleId && member.roles?.cache?.has(roleId));
}

function claimedLabel(t) {
  if (t.claimedById) return `<@${t.claimedById}>`;
  if (t.claimedByTag) return t.claimedByTag;   // e.g. "Dashboard"
  return "Unclaimed";
}
function welcomeEmbed(t) {
  const e = new EmbedBuilder().setColor(colorInt(state.settings.panelColor))
    .setTitle(`Ticket #${ticketNo(t.id)}: ${t.subject}`)
    .setDescription(t.details ? t.details : "No extra details given.")
    .addFields(
      { name: "Opened by", value: `<@${t.openerId}>`, inline: true },
      { name: "Claimed by", value: claimedLabel(t), inline: true },
    );
  if (t.topic) e.addFields({ name: "Topic", value: String(t.topic).slice(0, 256), inline: true });
  e.setFooter({ text: state.settings.welcomeMessage.slice(0, 2048) }).setTimestamp(t.createdAt);
  return e;
}
function ticketButtons(t) {
  const claimBtn = t && t.claimedById
    ? new ButtonBuilder().setCustomId("tk_unclaim").setLabel("Unclaim").setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder().setCustomId("tk_claim").setLabel("Claim").setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tk_close").setLabel("Close ticket").setStyle(ButtonStyle.Danger),
    claimBtn,
  );
}

// nudge a ticket's last-activity clock (for auto-close), persisted debounced
function touchActivity(t) {
  if (!t) return;
  t.lastActivityAt = Date.now();
  if (activitySaveTimer) return;
  activitySaveTimer = setTimeout(() => { activitySaveTimer = null; save(); }, ACTIVITY_SAVE_MS);
  activitySaveTimer.unref?.();
}

async function fetchLogChannel(guild) {
  const id = state.settings.logChannelId;
  if (!id) return null;
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return ch && ch.isTextBased() ? ch : null;
}

// ── Transcript ────────────────────────────────────────────────────────────────
async function collectTranscript(channel) {
  const out = [];
  let before;
  while (out.length < TRANSCRIPT_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const m of batch.values()) {
      out.push({
        id: m.id, at: m.createdTimestamp,
        authorId: m.author?.id || "unknown",
        authorTag: m.author?.tag || "unknown",
        bot: !!m.author?.bot,
        content: m.content || "",
        attachments: [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })),
        embeds: m.embeds.map(e => e.title || e.description?.slice(0, 80) || "[embed]"),
      });
    }
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.sort((a, b) => a.at - b.at);   // oldest first
}

function transcriptText(t, messages) {
  const head = [
    `CookieSMP ticket #${ticketNo(t.id)}: ${t.subject}`,
    t.topic ? `Topic: ${t.topic}` : null,
    `Opened by ${t.openerTag} (${t.openerId}) at ${new Date(t.createdAt).toISOString()}`,
    `Closed by ${t.closedBy || "unknown"} at ${new Date(t.closedAt || Date.now()).toISOString()}`,
    `Reason: ${t.closeReason || "none given"}`,
    `Messages: ${messages.length}`,
    "-".repeat(60),
  ].filter(Boolean);
  const body = messages.map(m => {
    const ts = new Date(m.at).toISOString().replace("T", " ").slice(0, 19);
    const extra = [
      ...m.attachments.map(a => `    [attachment] ${a.name} ${a.url}`),
      ...m.embeds.map(e => `    [embed] ${e}`),
    ];
    return [`[${ts}] ${m.authorTag}${m.bot ? " [bot]" : ""}: ${m.content}`, ...extra].join("\n");
  });
  return [...head, ...body].join("\n");
}

// ── Core actions ──────────────────────────────────────────────────────────────
async function createTicket(guild, opener, subject, details, topic = null) {
  const s = state.settings;

  const already = openTickets().filter(t => t.openerId === opener.id);
  if (already.length >= Math.max(1, s.maxOpenPerUser)) {
    return { error: `You already have ${already.length} open ticket(s): ${already.map(t => `<#${t.channelId}>`).join(", ")}` };
  }
  const last = openCooldown.get(opener.id) || 0;
  if (Date.now() - last < OPEN_COOLDOWN_MS) return { error: "Slow down, wait a few seconds before opening another ticket." };
  openCooldown.set(opener.id, Date.now());

  const id = ++state.counter;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: opener.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
  ];
  if (s.supportRoleId) overwrites.push({ id: s.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] });

  let channel;
  try {
    channel = await guild.channels.create({
      name: ticketName(s, id, opener),
      type: ChannelType.GuildText,
      parent: s.categoryId || undefined,
      topic: `Ticket #${ticketNo(id)} | ${opener.tag} | ${topic ? `${topic} | ` : ""}${subject}`.slice(0, 1024),
      permissionOverwrites: overwrites,
      reason: `Ticket opened by ${opener.tag}`,
    });
  } catch (e) {
    state.counter--; save();
    return { error: `Could not create the ticket channel: ${e.message}. Check the category and my permissions.` };
  }

  const now = Date.now();
  const t = {
    id, channelId: channel.id, guildId: guild.id,
    openerId: opener.id, openerTag: opener.tag,
    subject: subject.slice(0, 200), details: (details || "").slice(0, 1500),
    topic: topic ? String(topic).slice(0, 100) : null,
    status: "open", createdAt: now, lastActivityAt: now,
    claimedById: null, claimedByTag: null,
    closedAt: null, closedBy: null, closeReason: null,
    messageCount: 0, transcriptFile: null,
  };
  state.tickets[channel.id] = t; save();

  const ping = [`<@${opener.id}>`, s.pingSupport && s.supportRoleId ? `<@&${s.supportRoleId}>` : ""].filter(Boolean).join(" ");
  await channel.send({ content: ping, embeds: [welcomeEmbed(t)], components: [ticketButtons(t)] }).catch(() => {});

  pushActivity("ticket", `#${ticketNo(id)} opened by ${opener.tag}${topic ? ` [${topic}]` : ""}: ${t.subject}`);
  const log = await fetchLogChannel(guild);
  if (log) await log.send({ embeds: [new EmbedBuilder().setColor(colorInt(s.panelColor)).setDescription(`Ticket #${ticketNo(id)} opened by <@${opener.id}>${topic ? ` [${topic}]` : ""}: **${t.subject}** (<#${channel.id}>)`).setTimestamp()] }).catch(() => {});

  return { ticket: t, channel };
}

async function closeTicket(channel, { closedBy, reason }) {
  const t = byChannel(channel.id);
  if (!t || t.status !== "open") return { error: "This is not an open ticket." };
  if (closing.has(channel.id)) return { error: "This ticket is already being closed." };
  closing.add(channel.id);

  try {
    const messages = await collectTranscript(channel);
    t.status = "closed"; t.closedAt = Date.now(); t.closedBy = closedBy;
    t.closeReason = (reason || "").slice(0, 500) || null;
    t.messageCount = messages.length;
    t.transcriptFile = `ticket-${ticketNo(t.id)}.json`;
    save();

    try {
      ensureData();
      fs.writeFileSync(path.join(TRANSCRIPT_DIR, t.transcriptFile), JSON.stringify({ ticket: t, messages }, null, 2));
    } catch (e) { console.error("[tickets] transcript write:", e.message); }

    const guild = channel.guild;
    const log = await fetchLogChannel(guild);
    if (log) {
      const mins = Math.max(1, Math.round((t.closedAt - t.createdAt) / 60_000));
      const summary = new EmbedBuilder().setColor(0x8d86a3).setTitle(`Ticket #${ticketNo(t.id)} closed`)
        .setDescription([
          `**Subject:** ${t.subject}`,
          `**Opened by:** <@${t.openerId}> (${t.openerTag})`,
          `**Closed by:** ${t.closedBy}`,
          `**Reason:** ${t.closeReason || "none given"}`,
          `**Messages:** ${t.messageCount}  |  **Open for:** ${mins} min`,
        ].join("\n")).setTimestamp();
      const file = new AttachmentBuilder(Buffer.from(transcriptText(t, messages), "utf8"), { name: `ticket-${ticketNo(t.id)}.txt` });
      await log.send({ embeds: [summary], files: [file] }).catch(() => {});
    }

    // optionally send the opener a copy of the transcript before the channel vanishes
    if (state.settings.dmOnClose) {
      const opener = await client.users.fetch(t.openerId).catch(() => null);
      if (opener) {
        const file = new AttachmentBuilder(Buffer.from(transcriptText(t, messages), "utf8"), { name: `ticket-${ticketNo(t.id)}.txt` });
        await opener.send({
          content: `Your ticket **#${ticketNo(t.id)}: ${t.subject}** in **${guild.name}** was closed by ${t.closedBy}.${t.closeReason ? `\nReason: ${t.closeReason}` : ""}\nA copy of the conversation is attached.`,
          files: [file],
        }).catch(() => {});
      }
    }

    const delayMs = Math.max(0, Math.min(60, state.settings.closeDelaySeconds ?? 5)) * 1000;
    pushActivity("ticket", `#${ticketNo(t.id)} closed by ${closedBy}${t.closeReason ? `: ${t.closeReason}` : ""}`);
    await channel.send(delayMs ? `Ticket closed by ${closedBy}. This channel goes away in ${delayMs / 1000} seconds.` : `Ticket closed by ${closedBy}.`).catch(() => {});
    setTimeout(() => { channel.delete(`Ticket #${ticketNo(t.id)} closed`).catch(() => {}); }, delayMs || 1000);
    return { ticket: t };
  } finally {
    closing.delete(channel.id);
  }
}

async function claimTicket(channel, claimer) {
  const t = byChannel(channel.id);
  if (!t || t.status !== "open") return { error: "This is not an open ticket." };
  t.claimedById = claimer.id || null;
  t.claimedByTag = claimer.tag || String(claimer);
  save();
  pushActivity("ticket", `#${ticketNo(t.id)} claimed by ${t.claimedByTag}`);
  await channel.send({ content: `Ticket claimed by ${claimer.id ? `<@${claimer.id}>` : t.claimedByTag}.`, components: [ticketButtons(t)] }).catch(() => {});
  return { ticket: t };
}

async function unclaimTicket(channel, byTag) {
  const t = byChannel(channel.id);
  if (!t || t.status !== "open") return { error: "This is not an open ticket." };
  if (!t.claimedById && !t.claimedByTag) return { error: "This ticket is not claimed." };
  t.claimedById = null; t.claimedByTag = null;
  save();
  pushActivity("ticket", `#${ticketNo(t.id)} unclaimed by ${byTag}`);
  await channel.send({ content: `Ticket unclaimed by ${byTag}. It is open for any staff again.`, components: [ticketButtons(t)] }).catch(() => {});
  return { ticket: t };
}

async function postPanel(channel) {
  const s = state.settings;
  const embed = new EmbedBuilder().setColor(colorInt(s.panelColor)).setTitle(s.panelTitle).setDescription(s.panelText);
  let row;
  if (Array.isArray(s.topics) && s.topics.length) {
    const menu = new StringSelectMenuBuilder().setCustomId("tk_open_select")
      .setPlaceholder(s.buttonLabel || "Open a ticket")
      .addOptions(s.topics.slice(0, 25).map((t, i) => {
        const opt = { label: String(t.label).slice(0, 100), value: String(i) };
        if (t.description) opt.description = String(t.description).slice(0, 100);
        if (t.emoji) opt.emoji = t.emoji;
        return opt;
      }));
    row = new ActionRowBuilder().addComponents(menu);
  } else {
    const btn = new ButtonBuilder().setCustomId("tk_open").setLabel(s.buttonLabel).setStyle(BUTTON_STYLES[s.buttonStyle] || ButtonStyle.Primary);
    if (s.buttonEmoji) { try { btn.setEmoji(s.buttonEmoji); } catch (e) { /* invalid emoji: skip it */ } }
    row = new ActionRowBuilder().addComponents(btn);
  }
  const msg = await channel.send({ embeds: [embed], components: [row] });
  pushActivity("ticket", `Ticket panel posted in #${channel.name}`);
  return msg;
}

// subject/details modal; topicIdx is -1 for a plain button, else the picked topic index
function ticketModal(topicIdx) {
  return new ModalBuilder().setCustomId(`tk_modal::${topicIdx}`).setTitle("Open a support ticket")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tk_subject").setLabel("What do you need help with?")
          .setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tk_details").setLabel("Details (optional)")
          .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false)),
    );
}

// ── Slash commands ────────────────────────────────────────────────────────────
const TICKET_COMMANDS = [
  new SlashCommandBuilder().setName("ticketpanel").setDescription("Post the open-a-ticket panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .toJSON(),
  new SlashCommandBuilder().setName("ticket").setDescription("Manage the ticket you are in")
    .addSubcommand(sc => sc.setName("close").setDescription("Close this ticket")
      .addStringOption(o => o.setName("reason").setDescription("Why it is being closed")))
    .addSubcommand(sc => sc.setName("claim").setDescription("Claim this ticket (staff)"))
    .addSubcommand(sc => sc.setName("unclaim").setDescription("Unclaim this ticket (staff)"))
    .addSubcommand(sc => sc.setName("add").setDescription("Add a user to this ticket (staff)")
      .addUserOption(o => o.setName("user").setDescription("User to add").setRequired(true)))
    .addSubcommand(sc => sc.setName("remove").setDescription("Remove a user from this ticket (staff)")
      .addUserOption(o => o.setName("user").setDescription("User to remove").setRequired(true)))
    .addSubcommand(sc => sc.setName("rename").setDescription("Rename this ticket channel (staff)")
      .addStringOption(o => o.setName("name").setDescription("New channel name").setRequired(true)))
    .toJSON(),
];

// ── Interaction handling ──────────────────────────────────────────────────────
async function handleTicketInteraction(interaction) {
  // "Open a ticket" button -> subject/details modal (no topic)
  if (interaction.isButton?.() && interaction.customId === "tk_open") {
    await interaction.showModal(ticketModal(-1));
    return true;
  }

  // topic select menu -> subject/details modal carrying the picked topic
  if (interaction.isStringSelectMenu?.() && interaction.customId === "tk_open_select") {
    const idx = parseInt(interaction.values?.[0], 10);
    await interaction.showModal(ticketModal(Number.isInteger(idx) ? idx : -1));
    return true;
  }

  // modal submit -> create the ticket
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith("tk_modal")) {
    await interaction.deferReply({ ephemeral: true });
    const idx = parseInt(interaction.customId.split("::")[1], 10);
    const topic = (Number.isInteger(idx) && idx >= 0 && state.settings.topics?.[idx]) ? state.settings.topics[idx].label : null;
    const subject = interaction.fields.getTextInputValue("tk_subject").trim();
    const details = interaction.fields.getTextInputValue("tk_details")?.trim() || "";
    const res = await createTicket(interaction.guild, interaction.user, subject, details, topic);
    if (res.error) { await interaction.editReply({ content: res.error }); return true; }
    await interaction.editReply({ content: `Your ticket is open: <#${res.channel.id}>` });
    return true;
  }

  // close button -> reason modal
  if (interaction.isButton?.() && interaction.customId === "tk_close") {
    const t = byChannel(interaction.channelId);
    if (!t || t.status !== "open") { await interaction.reply({ content: "This is not an open ticket.", ephemeral: true }); return true; }
    if (interaction.user.id !== t.openerId && !isStaff(interaction.member)) {
      await interaction.reply({ content: "Only the ticket opener or staff can close this.", ephemeral: true }); return true;
    }
    const modal = new ModalBuilder().setCustomId("tk_close_modal").setTitle(`Close ticket #${ticketNo(t.id)}`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tk_close_reason").setLabel("Reason (optional)")
          .setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false)));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit?.() && interaction.customId === "tk_close_modal") {
    await interaction.deferReply();
    const reason = interaction.fields.getTextInputValue("tk_close_reason")?.trim() || "";
    const res = await closeTicket(interaction.channel, { closedBy: interaction.user.tag, reason });
    await interaction.editReply({ content: res.error ? res.error : "Closing this ticket." }).catch(() => {});
    return true;
  }

  if (interaction.isButton?.() && interaction.customId === "tk_claim") {
    if (!isStaff(interaction.member)) { await interaction.reply({ content: "Staff only.", ephemeral: true }); return true; }
    const t = byChannel(interaction.channelId);
    if (t?.claimedById && t.claimedById !== interaction.user.id) {
      await interaction.reply({ content: `Already claimed by <@${t.claimedById}>. They (or an admin) can unclaim it first.`, ephemeral: true }); return true;
    }
    const res = await claimTicket(interaction.channel, interaction.user);
    await interaction.reply({ content: res.error ? res.error : "You claimed this ticket.", ephemeral: true });
    return true;
  }

  if (interaction.isButton?.() && interaction.customId === "tk_unclaim") {
    if (!isStaff(interaction.member)) { await interaction.reply({ content: "Staff only.", ephemeral: true }); return true; }
    const res = await unclaimTicket(interaction.channel, interaction.user.tag);
    await interaction.reply({ content: res.error ? res.error : "Ticket unclaimed.", ephemeral: true });
    return true;
  }

  if (!interaction.isChatInputCommand?.()) return false;

  // /ticketpanel
  if (interaction.commandName === "ticketpanel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server.", ephemeral: true }); return true;
    }
    const channel = interaction.options.getChannel("channel") || interaction.channel;
    if (!channel?.isTextBased?.()) { await interaction.reply({ content: "Pick a text channel.", ephemeral: true }); return true; }
    try { await postPanel(channel); }
    catch (e) { await interaction.reply({ content: `Could not post the panel: ${e.message}`, ephemeral: true }); return true; }
    await interaction.reply({ content: `Panel posted in <#${channel.id}>.`, ephemeral: true });
    return true;
  }

  // /ticket ...
  if (interaction.commandName !== "ticket") return false;
  const t = byChannel(interaction.channelId);
  if (!t || t.status !== "open") { await interaction.reply({ content: "Use this inside an open ticket channel.", ephemeral: true }); return true; }
  const sub = interaction.options.getSubcommand();

  if (sub === "close") {
    if (interaction.user.id !== t.openerId && !isStaff(interaction.member)) {
      await interaction.reply({ content: "Only the ticket opener or staff can close this.", ephemeral: true }); return true;
    }
    await interaction.deferReply();
    const res = await closeTicket(interaction.channel, { closedBy: interaction.user.tag, reason: interaction.options.getString("reason") || "" });
    await interaction.editReply({ content: res.error ? res.error : "Closing this ticket." }).catch(() => {});
    return true;
  }

  if (!isStaff(interaction.member)) { await interaction.reply({ content: "Staff only.", ephemeral: true }); return true; }

  if (sub === "claim") {
    if (t.claimedById && t.claimedById !== interaction.user.id) {
      await interaction.reply({ content: `Already claimed by <@${t.claimedById}>.`, ephemeral: true }); return true;
    }
    const res = await claimTicket(interaction.channel, interaction.user);
    await interaction.reply({ content: res.error ? res.error : "You claimed this ticket.", ephemeral: true });
    return true;
  }
  if (sub === "unclaim") {
    const res = await unclaimTicket(interaction.channel, interaction.user.tag);
    await interaction.reply({ content: res.error ? res.error : "Ticket unclaimed.", ephemeral: true });
    return true;
  }
  if (sub === "add" || sub === "remove") {
    const user = interaction.options.getUser("user");
    try {
      if (sub === "add") {
        await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await interaction.reply({ content: `Added <@${user.id}> to this ticket.` });
      } else {
        if (user.id === t.openerId) { await interaction.reply({ content: "You cannot remove the ticket opener. Close the ticket instead.", ephemeral: true }); return true; }
        await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
        await interaction.reply({ content: `Removed <@${user.id}> from this ticket.` });
      }
    } catch (e) { await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
    return true;
  }
  if (sub === "rename") {
    const name = interaction.options.getString("name").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
    if (!name) { await interaction.reply({ content: "That name has no usable characters.", ephemeral: true }); return true; }
    try { await interaction.channel.setName(name, `Renamed by ${interaction.user.tag}`); }
    catch (e) { await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true }); return true; }
    await interaction.reply({ content: `Renamed to #${name}.` });
    return true;
  }

  return true;
}

// ── Web dashboard API ─────────────────────────────────────────────────────────
const isEmoji = v => !v || (typeof v === "string" && v.length <= 64);
function validTopics(v) {
  if (!Array.isArray(v) || v.length > 25) return false;
  return v.every(t => t && typeof t === "object"
    && typeof t.label === "string" && t.label.trim().length >= 1 && t.label.length <= 100
    && (t.description == null || (typeof t.description === "string" && t.description.length <= 100))
    && isEmoji(t.emoji));
}
// keys whose empty string means "clear it to null"; other keys keep their type
const NULLABLE = new Set(["categoryId", "supportRoleId", "logChannelId"]);
const SETTING_RULES = {
  categoryId:        v => v === null || /^\d{5,25}$/.test(v),
  supportRoleId:     v => v === null || /^\d{5,25}$/.test(v),
  logChannelId:      v => v === null || /^\d{5,25}$/.test(v),
  maxOpenPerUser:    v => Number.isInteger(v) && v >= 1 && v <= 10,
  pingSupport:       v => typeof v === "boolean",
  namePrefix:        v => typeof v === "string" && /^[a-z0-9-]{1,16}$/.test(v),
  naming:            v => ["number", "name"].includes(v),
  panelTitle:        v => typeof v === "string" && v.length >= 1 && v.length <= 256,
  panelText:         v => typeof v === "string" && v.length >= 1 && v.length <= 2000,
  panelColor:        v => typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v),
  buttonLabel:       v => typeof v === "string" && v.length >= 1 && v.length <= 80,
  buttonEmoji:       isEmoji,
  buttonStyle:       v => v in BUTTON_STYLES,
  welcomeMessage:    v => typeof v === "string" && v.length <= 1000,
  closeDelaySeconds: v => Number.isInteger(v) && v >= 0 && v <= 60,
  dmOnClose:         v => typeof v === "boolean",
  autoCloseHours:    v => Number.isInteger(v) && v >= 0 && v <= 336,   // up to 14 days
  topics:            validTopics,
};

function normalizeTopics(v) {
  return v.map(t => ({
    label: t.label.trim().slice(0, 100),
    emoji: t.emoji ? String(t.emoji).trim().slice(0, 64) : "",
    description: t.description ? String(t.description).trim().slice(0, 100) : "",
  })).filter(t => t.label);
}

function webGetTickets() {
  const all = Object.values(state.tickets);
  return {
    settings: { ...state.settings },
    counter: state.counter,
    open: all.filter(t => t.status === "open").sort((a, b) => b.createdAt - a.createdAt),
    closed: all.filter(t => t.status !== "open").sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 100),
  };
}

function webUpdateTicketSettings(patch) {
  const applied = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SETTING_RULES)) continue;
    const value = (NULLABLE.has(k) && v === "") ? null : v;
    if (!SETTING_RULES[k](value)) return { error: `Invalid value for ${k}` };
    applied[k] = k === "topics" ? normalizeTopics(value) : value;
  }
  if (!Object.keys(applied).length) return { error: "Nothing valid to update" };
  state.settings = { ...state.settings, ...applied };
  save();
  pushActivity("ticket", `Ticket settings updated: ${Object.keys(applied).join(", ")}`);
  return { settings: { ...state.settings } };
}

async function webPostPanel(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return { error: "Channel not found or not a text channel" };
  try { await postPanel(channel); return { ok: true }; }
  catch (e) { return { error: `Could not post the panel: ${e.message}` }; }
}

async function webFetchMessages(channelId, limit = 50) {
  const t = byChannel(channelId);
  if (!t) return { error: "Unknown ticket" };
  if (t.status !== "open") {
    const file = t.transcriptFile ? path.join(TRANSCRIPT_DIR, t.transcriptFile) : null;
    if (file && fs.existsSync(file)) {
      try { return { ticket: t, messages: JSON.parse(fs.readFileSync(file, "utf8")).messages || [] }; }
      catch (e) { return { error: "Transcript unreadable" }; }
    }
    return { ticket: t, messages: [] };
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { error: "Ticket channel is gone" };
  const batch = await channel.messages.fetch({ limit: Math.min(100, Math.max(1, limit)) }).catch(() => null);
  if (!batch) return { error: "Could not fetch messages" };
  const messages = [...batch.values()].map(m => ({
    id: m.id, at: m.createdTimestamp,
    authorId: m.author?.id, authorTag: m.author?.tag, bot: !!m.author?.bot,
    content: m.content || "",
    attachments: [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })),
    embeds: m.embeds.map(e => e.title || e.description?.slice(0, 80) || "[embed]"),
  })).sort((a, b) => a.at - b.at);
  return { ticket: t, messages };
}

async function webReply(channelId, content) {
  const t = byChannel(channelId);
  if (!t || t.status !== "open") return { error: "This is not an open ticket" };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { error: "Ticket channel is gone" };
  const text = String(content || "").trim().slice(0, 1900);
  if (!text) return { error: "Message is empty" };
  try { await channel.send({ content: text }); }
  catch (e) { return { error: `Send failed: ${e.message}` }; }
  pushActivity("ticket", `Dashboard replied in ticket #${ticketNo(t.id)}`);
  return { ok: true };
}

async function webCloseTicket(channelId, reason) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    // channel already gone: mark the record closed so it stops showing as open
    const t = byChannel(channelId);
    if (t && t.status === "open") { t.status = "closed"; t.closedAt = Date.now(); t.closedBy = "Dashboard"; t.closeReason = "channel missing"; save(); }
    return { error: "Ticket channel is gone, record marked closed" };
  }
  return closeTicket(channel, { closedBy: "Dashboard", reason });
}

async function webClaimTicket(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { error: "Ticket channel is gone" };
  return claimTicket(channel, "Dashboard");
}

async function webUnclaimTicket(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    const t = byChannel(channelId);
    if (t && t.status === "open") { t.claimedById = null; t.claimedByTag = null; save(); return { ok: true }; }
    return { error: "Ticket channel is gone" };
  }
  return unclaimTicket(channel, "Dashboard");
}

function webGetTranscript(idNumber) {
  const file = path.join(TRANSCRIPT_DIR, `ticket-${ticketNo(idNumber)}.json`);
  if (!fs.existsSync(file)) return { error: "No transcript for that ticket" };
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { error: "Transcript unreadable" }; }
}

// close any ticket that has gone quiet longer than the configured window
async function autoCloseSweep() {
  const hrs = state.settings.autoCloseHours;
  if (!hrs || hrs <= 0) return;
  const cutoff = Date.now() - hrs * 3_600_000;
  for (const t of openTickets()) {
    if ((t.lastActivityAt || t.createdAt) > cutoff) continue;
    const channel = await client.channels.fetch(t.channelId).catch(() => null);
    if (channel) await closeTicket(channel, { closedBy: "auto (inactive)", reason: `No activity for ${hrs}h` }).catch(() => {});
    else { t.status = "closed"; t.closedAt = Date.now(); t.closedBy = "auto (channel gone)"; save(); }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initTickets(discordClient) {
  client = discordClient;
  load();

  // ticket channel deleted by hand -> mark the record closed
  client.on("channelDelete", (channel) => {
    const t = byChannel(channel.id);
    if (t && t.status === "open") {
      t.status = "closed"; t.closedAt = Date.now(); t.closedBy = "unknown (channel deleted)";
      save();
      pushActivity("ticket", `#${ticketNo(t.id)} channel was deleted, marked closed`);
    }
  });

  // any human message in a ticket resets its inactivity clock
  client.on("messageCreate", (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    const t = byChannel(msg.channelId);
    if (t && t.status === "open") touchActivity(t);
  });

  // sweep for inactive tickets every 5 minutes
  setInterval(() => { autoCloseSweep().catch(e => console.error("[tickets] auto-close:", e.message)); }, 5 * 60_000).unref?.();

  console.log(`[tickets] Ready: ${openTickets().length} open ticket(s), counter at #${ticketNo(state.counter)}.`);
}

module.exports = {
  initTickets, handleTicketInteraction, TICKET_COMMANDS,
  webGetTickets, webUpdateTicketSettings, webPostPanel, webFetchMessages,
  webReply, webCloseTicket, webClaimTicket, webUnclaimTicket, webGetTranscript,
};
