"use strict";

/**
 * CookieBot — Giveaway module.
 *
 * Wire into index.js:
 *   initGiveaways(client)         call once when client is ready
 *   handleGiveawayCommand(inter)  call at top of interactionCreate (handles commands + the Enter button)
 *   GIVEAWAY_COMMANDS             spread into your slash-command registration array
 *
 * Commands:
 *   /giveaway start  prize:<text> duration:<30m|2h|1d|1h30m> [winners:<n>] [channel:#ch]
 *   /giveaway end    message_id:<id>
 *   /giveaway reroll message_id:<id> [winners:<n>]
 *   /giveaway list
 *
 * Anyone who can send messages in the target channel can host a giveaway.
 *
 * Optional env:
 *   GIVEAWAY_REWARD_ROLE_ID   role auto-given to the host as a thank-you when they start one
 *   GIVEAWAY_EMOJI            entry button emoji (default 🎉)
 *   GIVEAWAY_COLOR            embed colour hex (default ff8c00)
 */

const fs   = require("fs");
const path = require("path");
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, PermissionFlagsBits,
} = require("discord.js");

// ── Config ──────────────────────────────────────────────────────────────────────
const REWARD_ROLE_ID = process.env.GIVEAWAY_REWARD_ROLE_ID || null;
const EMOJI          = process.env.GIVEAWAY_EMOJI          || "🎉";
const COLOR          = parseInt(process.env.GIVEAWAY_COLOR || "ff8c00", 16);

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const GW_FILE  = path.join(DATA_DIR, "giveaways.json");

let client    = null;
let giveaways = {};                 // { [messageId]: gw }
const timers      = new Map();      // messageId -> end timeout
const editTimers  = new Map();      // messageId -> debounced embed-edit timeout

function ensureData() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function load() {
  ensureData();
  try { if (fs.existsSync(GW_FILE)) giveaways = JSON.parse(fs.readFileSync(GW_FILE, "utf8")) || {}; }
  catch { giveaways = {}; }
}
function save() { ensureData(); fs.writeFileSync(GW_FILE, JSON.stringify(giveaways, null, 2)); }

// ── Helpers ───────────────────────────────────────────────────────────────────
// anyone who can send messages in the channel can host a giveaway there
function canPostIn(member, channel) {
  try { return !!channel?.permissionsFor?.(member)?.has(PermissionFlagsBits.SendMessages); }
  catch { return false; }
}
// the host, or staff with Manage Messages, can end / reroll a giveaway
function canManage(member, gw) {
  if (!member) return false;
  if (member.id === gw.hostId) return true;
  return !!member.permissions?.has(PermissionFlagsBits.ManageMessages);
}

// "30m", "2h", "1d", "1h30m", "90s" -> milliseconds (or null)
function parseDuration(str) {
  if (!str) return null;
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let ms = 0, matched = false;
  for (const m of String(str).toLowerCase().matchAll(/(\d+)\s*([smhd])/g)) {
    ms += parseInt(m[1], 10) * units[m[2]];
    matched = true;
  }
  if (!matched) return null;
  if (ms < 10_000) return null;            // min 10s
  if (ms > 14 * units.d) return null;      // max 14d (stays within setTimeout's safe range)
  return ms;
}

function pickWinners(entrants, n) {
  const pool = [...entrants];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

function gwEmbed(gw, { ended = false, winners = null } = {}) {
  const endUnix = Math.floor(gw.endsAt / 1000);
  const e = new EmbedBuilder().setColor(COLOR).setTitle(`${EMOJI}  GIVEAWAY  ${EMOJI}`)
    .setDescription(`**${gw.prize}**\nHosted by <@${gw.hostId}>`);
  if (ended) {
    e.addFields(
      { name: "Winner(s)", value: winners && winners.length ? winners.map(id => `<@${id}>`).join(", ") : "No valid entries", inline: false },
      { name: "Entries",   value: String(gw.entrants.length), inline: true },
    ).setFooter({ text: "Giveaway ended · winners, contact the host to claim" }).setTimestamp();
  } else {
    e.addFields(
      { name: "Time left", value: `<t:${endUnix}:R>`, inline: true },
      { name: "Winners",   value: String(gw.winners), inline: true },
      { name: "Entries",   value: String(gw.entrants.length), inline: true },
    );
    if (gw.requiredRoleId) e.addFields({ name: "Requirement", value: `Must have <@&${gw.requiredRoleId}>`, inline: false });
  }
  return e;
}

function entryRow(count, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gw_enter")
      .setLabel(`Enter${count != null ? ` (${count})` : ""}`)
      .setEmoji(EMOJI)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

async function fetchMessage(gw) {
  const channel = await client.channels.fetch(gw.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return { channel: null, message: null };
  const message = await channel.messages.fetch(gw.messageId).catch(() => null);
  return { channel, message };
}

// debounced embed refresh (so a burst of clicks edits the message once, not 50x)
function scheduleEmbedUpdate(gw) {
  if (editTimers.has(gw.messageId)) return;
  editTimers.set(gw.messageId, setTimeout(async () => {
    editTimers.delete(gw.messageId);
    if (gw.ended) return;
    const { message } = await fetchMessage(gw);
    if (message) await message.edit({ embeds: [gwEmbed(gw)], components: [entryRow(gw.entrants.length)] }).catch(() => {});
  }, 4000));
}

function scheduleEnd(gw) {
  if (timers.has(gw.messageId)) clearTimeout(timers.get(gw.messageId));
  const delay = gw.endsAt - Date.now();
  timers.set(gw.messageId, setTimeout(() => endGiveaway(gw).catch(() => {}), Math.max(0, delay)));
}

async function endGiveaway(gw) {
  if (gw.ended) return;
  gw.ended = true; save();
  if (timers.has(gw.messageId)) { clearTimeout(timers.get(gw.messageId)); timers.delete(gw.messageId); }

  const { channel, message } = await fetchMessage(gw);
  const winners = pickWinners(gw.entrants, gw.winners);
  gw.winnerIds = winners; save();

  if (message) await message.edit({ embeds: [gwEmbed(gw, { ended: true, winners })], components: [entryRow(gw.entrants.length, true)] }).catch(() => {});
  if (channel) {
    const link = message ? `https://discord.com/channels/${gw.guildId}/${gw.channelId}/${gw.messageId}` : "";
    if (winners.length)
      await channel.send(`${EMOJI} Congratulations ${winners.map(id => `<@${id}>`).join(", ")}! You won **${gw.prize}**!\nContact the host <@${gw.hostId}> to claim your prize. ${link}`).catch(() => {});
    else
      await channel.send(`${EMOJI} The giveaway for **${gw.prize}** ended, but there were no valid entries.`).catch(() => {});
  }
  return winners;
}

// ── Slash commands ─────────────────────────────────────────────────────────────
const GIVEAWAY_COMMANDS = [
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Create and manage giveaways")
    .addSubcommand(s => s.setName("start").setDescription("Start a new giveaway")
      .addStringOption(o => o.setName("prize").setDescription("What you're giving away").setRequired(true))
      .addStringOption(o => o.setName("duration").setDescription("How long, e.g. 30m, 2h, 1d, 1h30m").setRequired(true))
      .addIntegerOption(o => o.setName("winners").setDescription("Number of winners (default 1)").setMinValue(1).setMaxValue(20))
      .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addRoleOption(o => o.setName("required_role").setDescription("Members must have this role to enter")))
    .addSubcommand(s => s.setName("end").setDescription("End a giveaway now and pick winners")
      .addStringOption(o => o.setName("message_id").setDescription("The giveaway message ID").setRequired(true)))
    .addSubcommand(s => s.setName("reroll").setDescription("Reroll the winners of an ended giveaway")
      .addStringOption(o => o.setName("message_id").setDescription("The giveaway message ID").setRequired(true))
      .addIntegerOption(o => o.setName("winners").setDescription("How many to reroll (default 1)").setMinValue(1).setMaxValue(20)))
    .addSubcommand(s => s.setName("list").setDescription("List the active giveaways"))
    .toJSON(),
];

async function handleGiveawayCommand(interaction) {
  // ── Enter button ──────────────────────────────────────────────────────────────
  if (interaction.isButton && interaction.isButton()) {
    if (interaction.customId !== "gw_enter") return false;
    const gw = giveaways[interaction.message.id];
    if (!gw || gw.ended) {
      await interaction.reply({ content: "This giveaway has already ended.", ephemeral: true });
      return true;
    }
    if (gw.requiredRoleId && !interaction.member?.roles?.cache?.has(gw.requiredRoleId)) {
      await interaction.reply({ content: `You need <@&${gw.requiredRoleId}> to enter this giveaway.`, ephemeral: true });
      return true;
    }
    const id = interaction.user.id;
    const idx = gw.entrants.indexOf(id);
    let reply;
    if (idx === -1) { gw.entrants.push(id); reply = `${EMOJI} You've entered the giveaway for **${gw.prize}**! Good luck.`; }
    else            { gw.entrants.splice(idx, 1); reply = "You've left the giveaway."; }
    save();
    scheduleEmbedUpdate(gw);
    await interaction.reply({ content: reply, ephemeral: true });
    return true;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== "giveaway") return false;

  const sub = interaction.options.getSubcommand();

  // ── /giveaway start ────────────────────────────────────────────────────────────
  if (sub === "start") {
    const prize    = interaction.options.getString("prize").slice(0, 240);
    const durStr   = interaction.options.getString("duration");
    const winners  = interaction.options.getInteger("winners") || 1;
    const channel  = interaction.options.getChannel("channel") || interaction.channel;
    const ms = parseDuration(durStr);
    if (!ms) {
      await interaction.reply({ content: "❌ Invalid duration. Use something like `30m`, `2h`, `1d` or `1h30m` (min 10s, max 14d).", ephemeral: true });
      return true;
    }
    if (!channel?.isTextBased?.()) {
      await interaction.reply({ content: "❌ I can't post in that channel.", ephemeral: true });
      return true;
    }
    if (!canPostIn(interaction.member, channel)) {
      await interaction.reply({ content: "❌ You can only host a giveaway in a channel you can send messages in.", ephemeral: true });
      return true;
    }

    const requiredRole = interaction.options.getRole("required_role");
    const gw = {
      messageId: null, channelId: channel.id, guildId: interaction.guildId,
      prize, winners, hostId: interaction.user.id, requiredRoleId: requiredRole?.id || null,
      createdAt: Date.now(), endsAt: Date.now() + ms, entrants: [], winnerIds: [], ended: false,
    };

    let msg;
    try { msg = await channel.send({ embeds: [gwEmbed(gw)], components: [entryRow(0)] }); }
    catch {
      await interaction.reply({ content: "❌ I couldn't send a message in that channel. Check my permissions.", ephemeral: true });
      return true;
    }

    gw.messageId = msg.id;
    giveaways[msg.id] = gw; save();
    scheduleEnd(gw);

    if (REWARD_ROLE_ID && interaction.member.roles?.add) {
      interaction.member.roles.add(REWARD_ROLE_ID).catch(() => {});  // thank-you role for the host
    }

    await interaction.reply({ content: `✅ Giveaway for **${prize}** started in ${channel}. It ends <t:${Math.floor(gw.endsAt / 1000)}:R>.`, ephemeral: true });
    return true;
  }

  // ── /giveaway end ────────────────────────────────────────────────────────────
  if (sub === "end") {
    const id = interaction.options.getString("message_id").trim();
    const gw = giveaways[id];
    if (!gw) { await interaction.reply({ content: "❌ No giveaway found with that message ID.", ephemeral: true }); return true; }
    if (!canManage(interaction.member, gw)) { await interaction.reply({ content: "❌ Only the host or staff can end this giveaway.", ephemeral: true }); return true; }
    if (gw.ended) { await interaction.reply({ content: "That giveaway has already ended. Use `/giveaway reroll` to pick new winners.", ephemeral: true }); return true; }
    await endGiveaway(gw);
    await interaction.reply({ content: "✅ Giveaway ended.", ephemeral: true });
    return true;
  }

  // ── /giveaway reroll ──────────────────────────────────────────────────────────
  if (sub === "reroll") {
    const id = interaction.options.getString("message_id").trim();
    const n  = interaction.options.getInteger("winners") || 1;
    const gw = giveaways[id];
    if (!gw) { await interaction.reply({ content: "❌ No giveaway found with that message ID.", ephemeral: true }); return true; }
    if (!canManage(interaction.member, gw)) { await interaction.reply({ content: "❌ Only the host or staff can reroll this giveaway.", ephemeral: true }); return true; }
    if (!gw.entrants.length) { await interaction.reply({ content: "❌ That giveaway had no entries to reroll.", ephemeral: true }); return true; }
    const pool = gw.entrants.filter(e => !(gw.winnerIds || []).includes(e));
    if (!pool.length) { await interaction.reply({ content: "❌ Everyone who entered has already won — no one left to reroll.", ephemeral: true }); return true; }
    const winners = pickWinners(pool, n);
    gw.winnerIds = [...(gw.winnerIds || []), ...winners]; save();
    const { channel } = await fetchMessage(gw);
    if (channel) await channel.send(`${EMOJI} **Reroll!** New winner(s) for **${gw.prize}**: ${winners.map(w => `<@${w}>`).join(", ")}!\nContact the host <@${gw.hostId}> to claim.`).catch(() => {});
    await interaction.reply({ content: "✅ Rerolled.", ephemeral: true });
    return true;
  }

  // ── /giveaway list ────────────────────────────────────────────────────────────
  if (sub === "list") {
    const active = Object.values(giveaways).filter(g => !g.ended).sort((a, b) => a.endsAt - b.endsAt);
    if (!active.length) { await interaction.reply({ content: "There are no active giveaways right now.", ephemeral: true }); return true; }
    const lines = active.map(g =>
      `• **${g.prize}** — ends <t:${Math.floor(g.endsAt / 1000)}:R> — ${g.entrants.length} entries — [jump](https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}) (\`${g.messageId}\`)`);
    const embed = new EmbedBuilder().setColor(COLOR).setTitle("Active Giveaways").setDescription(lines.join("\n").slice(0, 4000));
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  return true;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initGiveaways(discordClient) {
  client = discordClient;
  load();
  let active = 0;
  for (const gw of Object.values(giveaways)) {
    if (gw.ended) continue;
    active++;
    scheduleEnd(gw);   // past-due giveaways (missed during downtime) end immediately
  }
  console.log(`[giveaway] Ready — ${active} active giveaway(s) rescheduled.`);
}

module.exports = { initGiveaways, handleGiveawayCommand, GIVEAWAY_COMMANDS };
