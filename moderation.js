"use strict";

/**
 * CookieBot — Moderation module.
 *
 * Manual staff tools + persistent infraction history. Pairs with security.js
 * (which is the automated anti-nuke); this is the human side.
 *
 * Wire into index.js:
 *   initModeration(client, { modlogChannelId, ownerId })
 *   handleModerationCommand(inter)   call near the top of interactionCreate
 *   MODERATION_COMMANDS              spread into the slash-command registration array
 *
 * Commands:
 *   /warn /warnings /delwarn /modlogs
 *   /timeout /untimeout /kick /ban /unban
 *   /purge /slowmode
 *
 * Every action is logged to data/moderation.json and (if set) a modlog channel,
 * the target is DM'd, and role-hierarchy / permission / owner / self / bot checks
 * are enforced so it can't be abused or backfire.
 *
 * Optional env: MODLOG_CHANNEL_ID (falls back to the security LOG_CHANNEL_ID).
 */

const fs = require("fs");
const path = require("path");
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { pushActivity } = require("./activity");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "moderation.json");
const MAX_TIMEOUT_MS = 28 * 86_400_000;     // Discord's hard cap

let client = null;
let modlogChannelId = null;
let ownerId = null;
let store = {};                              // store[guildId] = [ {id,userId,type,reason,modId,at,duration} ]

// ── persistence ────────────────────────────────────────────────────────────────
function ensureData() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function load() { ensureData(); try { if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (e) { store = {}; } }
function save() { ensureData(); try { fs.writeFileSync(FILE, JSON.stringify(store, null, 2)); } catch (e) {} }

function newId() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).toUpperCase(); }
function record(guildId, inf) { (store[guildId] = store[guildId] || []).push(inf); save(); return inf; }
function forGuild(guildId) { return store[guildId] || []; }

// ── helpers ──────────────────────────────────────────────────────────────────
const COLORS = { warn: 0xffcc00, timeout: 0xff8c00, untimeout: 0x30c060, kick: 0xff6a00, ban: 0xff2d2d, unban: 0x30c060, purge: 0x30a0ff, slowmode: 0x30a0ff };

function parseDuration(str) {
  if (!str) return null;
  const u = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let ms = 0, ok = false;
  for (const m of String(str).toLowerCase().matchAll(/(\d+)\s*([smhd])/g)) { ms += parseInt(m[1], 10) * u[m[2]]; ok = true; }
  return ok && ms > 0 ? ms : null;
}
function human(ms) {
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ") || "0s";
}

async function modlog(guild, action, fields) {
  pushActivity("moderation", `${action}: ${fields.join(" | ").replace(/\*\*/g, "")}`);
  const id = modlogChannelId; if (!id) return;
  try {
    const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (ch && ch.isTextBased()) {
      const e = new EmbedBuilder().setColor(COLORS[action] || 0x808080).setTitle(`Moderation · ${action}`)
        .setDescription(fields.join("\n")).setTimestamp();
      await ch.send({ embeds: [e] });
    }
  } catch (e) {}
}
async function dm(user, text) { try { await user.send(text); } catch (e) {} }

// can the actor act on this target? returns an error string, or null if OK.
function canAct(interaction, targetMember, { needHierarchy = true } = {}) {
  const actor = interaction.member;
  const guild = interaction.guild;
  if (!targetMember) return null;                                  // not in guild (e.g. ban by id) — caller handles
  if (targetMember.id === actor.id) return "You can't do that to yourself.";
  if (targetMember.id === guild.ownerId) return "You can't moderate the server owner.";
  if (targetMember.id === client.user.id) return "I'm not going to moderate myself.";
  if (needHierarchy && actor.id !== guild.ownerId) {
    if (actor.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0)
      return "That member has a role equal to or higher than yours.";
  }
  return null;
}

// ── command defs ───────────────────────────────────────────────────────────────
const P = PermissionFlagsBits;
const userOpt = (o, req = true) => o.setName("user").setDescription("Target member").setRequired(req);
const reasonOpt = (o) => o.setName("reason").setDescription("Reason").setRequired(false);

const MODERATION_COMMANDS = [
  new SlashCommandBuilder().setName("warn").setDescription("Warn a member")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(userOpt).addStringOption(reasonOpt).toJSON(),
  new SlashCommandBuilder().setName("warnings").setDescription("List a member's warnings")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(o => userOpt(o)).toJSON(),
  new SlashCommandBuilder().setName("delwarn").setDescription("Delete a warning / infraction by its ID")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addStringOption(o => o.setName("id").setDescription("Infraction ID (from /warnings)").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("modlogs").setDescription("Show a member's full moderation history")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(o => userOpt(o)).toJSON(),
  new SlashCommandBuilder().setName("timeout").setDescription("Time a member out (mute)")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(userOpt)
    .addStringOption(o => o.setName("duration").setDescription("e.g. 10m, 1h, 2d (max 28d)").setRequired(true))
    .addStringOption(reasonOpt).toJSON(),
  new SlashCommandBuilder().setName("untimeout").setDescription("Remove a member's timeout")
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(userOpt).toJSON(),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member")
    .setDefaultMemberPermissions(P.KickMembers)
    .addUserOption(userOpt).addStringOption(reasonOpt).toJSON(),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member")
    .setDefaultMemberPermissions(P.BanMembers)
    .addUserOption(userOpt)
    .addStringOption(reasonOpt)
    .addIntegerOption(o => o.setName("delete_days").setDescription("Delete this many days of their messages (0-7)").setMinValue(0).setMaxValue(7)).toJSON(),
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID")
    .setDefaultMemberPermissions(P.BanMembers)
    .addStringOption(o => o.setName("user_id").setDescription("The user's ID").setRequired(true))
    .addStringOption(reasonOpt).toJSON(),
  new SlashCommandBuilder().setName("purge").setDescription("Bulk-delete recent messages in this channel")
    .setDefaultMemberPermissions(P.ManageMessages)
    .addIntegerOption(o => o.setName("amount").setDescription("How many (1-100)").setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption(o => o.setName("user").setDescription("Only delete this user's messages").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("slowmode").setDescription("Set this channel's slowmode")
    .setDefaultMemberPermissions(P.ManageChannels)
    .addIntegerOption(o => o.setName("seconds").setDescription("Seconds between messages (0 to disable, max 21600)").setMinValue(0).setMaxValue(21600).setRequired(true)).toJSON(),
];

const NAMES = ["warn", "warnings", "delwarn", "modlogs", "timeout", "untimeout", "kick", "ban", "unban", "purge", "slowmode"];

// ── handling ───────────────────────────────────────────────────────────────────
async function handleModerationCommand(interaction) {
  if (!interaction.isChatInputCommand?.()) return false;
  const name = interaction.commandName;
  if (!NAMES.includes(name)) return false;
  if (!interaction.guild) { await interaction.reply({ content: "This command only works in a server.", ephemeral: true }); return true; }
  const guild = interaction.guild;
  const mod = interaction.user;
  const reply = (content) => interaction.reply({ content, ephemeral: true });

  // ── /warn ──
  if (name === "warn") {
    if (!interaction.memberPermissions.has(P.ModerateMembers)) return (await reply("You need Moderate Members."), true);
    const user = interaction.options.getUser("user");
    const reason = (interaction.options.getString("reason") || "No reason provided").slice(0, 500);
    const target = await guild.members.fetch(user.id).catch(() => null);
    const err = canAct(interaction, target); if (err) return (await reply(err), true);
    const inf = record(guild.id, { id: newId(), userId: user.id, type: "warn", reason, modId: mod.id, at: Date.now() });
    const count = forGuild(guild.id).filter(i => i.userId === user.id && i.type === "warn").length;
    await dm(user, `You were **warned** in **${guild.name}**.\nReason: ${reason}\nThis is warning #${count}.`);
    await modlog(guild, "warn", [`**User:** <@${user.id}>`, `**Moderator:** <@${mod.id}>`, `**Reason:** ${reason}`, `**Warning #:** ${count}`, `**ID:** \`${inf.id}\``]);
    return (await reply(`⚠️ Warned <@${user.id}> (warning #${count}). ID \`${inf.id}\`.`), true);
  }

  // ── /warnings & /modlogs ──
  if (name === "warnings" || name === "modlogs") {
    if (!interaction.memberPermissions.has(P.ModerateMembers)) return (await reply("You need Moderate Members."), true);
    const user = interaction.options.getUser("user");
    let list = forGuild(guild.id).filter(i => i.userId === user.id);
    if (name === "warnings") list = list.filter(i => i.type === "warn");
    list = list.sort((a, b) => b.at - a.at).slice(0, 25);
    if (!list.length) return (await reply(`<@${user.id}> has a clean record.`), true);
    const lines = list.map(i => `\`${i.id}\` · **${i.type}** · <t:${Math.floor(i.at / 1000)}:R> · by <@${i.modId}>${i.duration ? ` · ${human(i.duration)}` : ""}\n> ${i.reason || "—"}`);
    const e = new EmbedBuilder().setColor(0xff8c00).setTitle(`${name === "warnings" ? "Warnings" : "Moderation history"} — ${user.tag}`)
      .setDescription(lines.join("\n").slice(0, 4000)).setFooter({ text: `${list.length} record(s)` });
    await interaction.reply({ ephemeral: true, embeds: [e] });
    return true;
  }

  // ── /delwarn ──
  if (name === "delwarn") {
    if (!interaction.memberPermissions.has(P.ModerateMembers)) return (await reply("You need Moderate Members."), true);
    const id = interaction.options.getString("id").trim().toUpperCase();
    const arr = forGuild(guild.id);
    const idx = arr.findIndex(i => i.id === id);
    if (idx === -1) return (await reply(`No infraction with ID \`${id}\`.`), true);
    const [removed] = arr.splice(idx, 1); save();
    await modlog(guild, "warn", [`**Infraction removed:** \`${id}\` (${removed.type} on <@${removed.userId}>)`, `**By:** <@${mod.id}>`]);
    return (await reply(`🗑️ Removed infraction \`${id}\` (${removed.type} on <@${removed.userId}>).`), true);
  }

  // ── /timeout ──
  if (name === "timeout") {
    if (!interaction.memberPermissions.has(P.ModerateMembers)) return (await reply("You need Moderate Members."), true);
    const user = interaction.options.getUser("user");
    const reason = (interaction.options.getString("reason") || "No reason provided").slice(0, 500);
    const ms = parseDuration(interaction.options.getString("duration"));
    if (!ms) return (await reply("Invalid duration. Use e.g. `10m`, `1h`, `2d`."), true);
    if (ms > MAX_TIMEOUT_MS) return (await reply("Max timeout is 28 days."), true);
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) return (await reply("That user isn't in the server."), true);
    const err = canAct(interaction, target); if (err) return (await reply(err), true);
    if (!target.moderatable) return (await reply("I can't time that member out (my role is too low)."), true);
    try { await target.timeout(ms, `${reason} — by ${mod.tag}`); }
    catch (e) { return (await reply(`Failed: ${e.message}`), true); }
    record(guild.id, { id: newId(), userId: user.id, type: "timeout", reason, modId: mod.id, at: Date.now(), duration: ms });
    await dm(user, `You were **timed out** for ${human(ms)} in **${guild.name}**.\nReason: ${reason}`);
    await modlog(guild, "timeout", [`**User:** <@${user.id}>`, `**Moderator:** <@${mod.id}>`, `**Duration:** ${human(ms)}`, `**Reason:** ${reason}`]);
    return (await reply(`🔇 Timed out <@${user.id}> for ${human(ms)}.`), true);
  }

  // ── /untimeout ──
  if (name === "untimeout") {
    if (!interaction.memberPermissions.has(P.ModerateMembers)) return (await reply("You need Moderate Members."), true);
    const user = interaction.options.getUser("user");
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) return (await reply("That user isn't in the server."), true);
    try { await target.timeout(null, `Timeout removed by ${mod.tag}`); }
    catch (e) { return (await reply(`Failed: ${e.message}`), true); }
    record(guild.id, { id: newId(), userId: user.id, type: "untimeout", reason: "Timeout removed", modId: mod.id, at: Date.now() });
    await modlog(guild, "untimeout", [`**User:** <@${user.id}>`, `**Moderator:** <@${mod.id}>`]);
    return (await reply(`🔊 Removed timeout from <@${user.id}>.`), true);
  }

  // ── /kick ──
  if (name === "kick") {
    if (!interaction.memberPermissions.has(P.KickMembers)) return (await reply("You need Kick Members."), true);
    const user = interaction.options.getUser("user");
    const reason = (interaction.options.getString("reason") || "No reason provided").slice(0, 500);
    const target = await guild.members.fetch(user.id).catch(() => null);
    if (!target) return (await reply("That user isn't in the server."), true);
    const err = canAct(interaction, target); if (err) return (await reply(err), true);
    if (!target.kickable) return (await reply("I can't kick that member (my role is too low)."), true);
    await dm(user, `You were **kicked** from **${guild.name}**.\nReason: ${reason}`);
    try { await target.kick(`${reason} — by ${mod.tag}`); }
    catch (e) { return (await reply(`Failed: ${e.message}`), true); }
    record(guild.id, { id: newId(), userId: user.id, type: "kick", reason, modId: mod.id, at: Date.now() });
    await modlog(guild, "kick", [`**User:** ${user.tag} (\`${user.id}\`)`, `**Moderator:** <@${mod.id}>`, `**Reason:** ${reason}`]);
    return (await reply(`👢 Kicked ${user.tag}.`), true);
  }

  // ── /ban ──
  if (name === "ban") {
    if (!interaction.memberPermissions.has(P.BanMembers)) return (await reply("You need Ban Members."), true);
    const user = interaction.options.getUser("user");
    const reason = (interaction.options.getString("reason") || "No reason provided").slice(0, 500);
    const days = interaction.options.getInteger("delete_days") || 0;
    const target = await guild.members.fetch(user.id).catch(() => null);
    const err = canAct(interaction, target); if (err) return (await reply(err), true);
    if (target && !target.bannable) return (await reply("I can't ban that member (my role is too low)."), true);
    await dm(user, `You were **banned** from **${guild.name}**.\nReason: ${reason}`);
    try { await guild.bans.create(user.id, { reason: `${reason} — by ${mod.tag}`, deleteMessageSeconds: days * 86_400 }); }
    catch (e) { return (await reply(`Failed: ${e.message}`), true); }
    record(guild.id, { id: newId(), userId: user.id, type: "ban", reason, modId: mod.id, at: Date.now() });
    await modlog(guild, "ban", [`**User:** ${user.tag} (\`${user.id}\`)`, `**Moderator:** <@${mod.id}>`, `**Reason:** ${reason}`, days ? `**Cleared:** ${days}d of messages` : ""].filter(Boolean));
    return (await reply(`🔨 Banned ${user.tag}.`), true);
  }

  // ── /unban ──
  if (name === "unban") {
    if (!interaction.memberPermissions.has(P.BanMembers)) return (await reply("You need Ban Members."), true);
    const id = interaction.options.getString("user_id").trim();
    const reason = (interaction.options.getString("reason") || "No reason provided").slice(0, 500);
    try { await guild.bans.remove(id, `${reason} — by ${mod.tag}`); }
    catch (e) { return (await reply(`Couldn't unban (are they banned? valid ID?): ${e.message}`), true); }
    record(guild.id, { id: newId(), userId: id, type: "unban", reason, modId: mod.id, at: Date.now() });
    await modlog(guild, "unban", [`**User:** \`${id}\``, `**Moderator:** <@${mod.id}>`, `**Reason:** ${reason}`]);
    return (await reply(`✅ Unbanned \`${id}\`.`), true);
  }

  // ── /purge ──
  if (name === "purge") {
    if (!interaction.memberPermissions.has(P.ManageMessages)) return (await reply("You need Manage Messages."), true);
    const amount = interaction.options.getInteger("amount");
    const onlyUser = interaction.options.getUser("user");
    const ch = interaction.channel;
    if (!ch?.bulkDelete) return (await reply("Can't purge here."), true);
    try {
      let msgs = await ch.messages.fetch({ limit: 100 });
      if (onlyUser) msgs = msgs.filter(m => m.author.id === onlyUser.id);
      const toDelete = [...msgs.values()].slice(0, amount);
      const deleted = await ch.bulkDelete(toDelete, true);   // true = skip messages older than 14d
      await modlog(guild, "purge", [`**Channel:** <#${ch.id}>`, `**Deleted:** ${deleted.size}`, onlyUser ? `**From:** <@${onlyUser.id}>` : "", `**Moderator:** <@${mod.id}>`].filter(Boolean));
      return (await reply(`🧹 Deleted ${deleted.size} message(s)${onlyUser ? ` from <@${onlyUser.id}>` : ""}.${deleted.size < toDelete.length ? " (some were too old to bulk-delete)" : ""}`), true);
    } catch (e) { return (await reply(`Failed: ${e.message}`), true); }
  }

  // ── /slowmode ──
  if (name === "slowmode") {
    if (!interaction.memberPermissions.has(P.ManageChannels)) return (await reply("You need Manage Channels."), true);
    const secs = interaction.options.getInteger("seconds");
    const ch = interaction.channel;
    try { await ch.setRateLimitPerUser(secs, `by ${mod.tag}`); }
    catch (e) { return (await reply(`Failed: ${e.message}`), true); }
    await modlog(guild, "slowmode", [`**Channel:** <#${ch.id}>`, `**Slowmode:** ${secs ? human(secs * 1000) : "off"}`, `**Moderator:** <@${mod.id}>`]);
    return (await reply(secs ? `🐌 Slowmode set to ${human(secs * 1000)}.` : "🐌 Slowmode disabled."), true);
  }

  return false;
}

// ── Web dashboard API ─────────────────────────────────────────────────────────
function webListInfractions() {
  const out = [];
  for (const [guildId, arr] of Object.entries(store))
    for (const inf of arr) out.push({ guildId, ...inf });
  return out.sort((a, b) => b.at - a.at);
}

function webDeleteInfraction(id) {
  const wanted = String(id).trim().toUpperCase();
  for (const guildId of Object.keys(store)) {
    const idx = store[guildId].findIndex(i => i.id === wanted);
    if (idx !== -1) {
      const [removed] = store[guildId].splice(idx, 1); save();
      pushActivity("moderation", `Infraction ${wanted} (${removed.type} on ${removed.userId}) removed via dashboard`);
      return { removed };
    }
  }
  return { error: `No infraction with ID ${wanted}` };
}

/**
 * Perform a moderation action from the dashboard. No role-hierarchy check:
 * the dashboard is owner-level access. Records the infraction, DMs the target
 * and posts to the modlog exactly like the slash commands do.
 * opts: { action, userId, reason, duration (string like "1h"), deleteDays }
 */
async function webModAction(guild, opts) {
  const { action, userId } = opts || {};
  const reason = (opts.reason || "No reason provided").slice(0, 500);
  const via = `${reason} (via dashboard)`;
  if (!guild) return { error: "Bot is not in a guild yet" };
  if (!/^\d{5,25}$/.test(String(userId || ""))) return { error: "Invalid user ID" };

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return { error: "No Discord user with that ID" };
  if (user.id === client.user.id) return { error: "Not moderating myself" };
  if (user.id === guild.ownerId && action !== "unban") return { error: "Not moderating the server owner" };
  const target = await guild.members.fetch(userId).catch(() => null);

  if (action === "warn") {
    const inf = record(guild.id, { id: newId(), userId, type: "warn", reason, modId: client.user.id, at: Date.now() });
    const count = forGuild(guild.id).filter(i => i.userId === userId && i.type === "warn").length;
    await dm(user, `You were **warned** in **${guild.name}**.\nReason: ${reason}\nThis is warning #${count}.`);
    await modlog(guild, "warn", [`**User:** <@${userId}>`, `**Moderator:** dashboard`, `**Reason:** ${reason}`, `**Warning #:** ${count}`, `**ID:** \`${inf.id}\``]);
    return { ok: true, infraction: inf, note: `Warned ${user.tag} (warning #${count})` };
  }

  if (action === "timeout") {
    const ms = parseDuration(opts.duration);
    if (!ms) return { error: "Invalid duration, use e.g. 10m, 1h, 2d" };
    if (ms > MAX_TIMEOUT_MS) return { error: "Max timeout is 28 days" };
    if (!target) return { error: "That user is not in the server" };
    if (!target.moderatable) return { error: "I cannot time that member out (my role is too low)" };
    try { await target.timeout(ms, via); } catch (e) { return { error: `Failed: ${e.message}` }; }
    record(guild.id, { id: newId(), userId, type: "timeout", reason, modId: client.user.id, at: Date.now(), duration: ms });
    await dm(user, `You were **timed out** for ${human(ms)} in **${guild.name}**.\nReason: ${reason}`);
    await modlog(guild, "timeout", [`**User:** <@${userId}>`, `**Moderator:** dashboard`, `**Duration:** ${human(ms)}`, `**Reason:** ${reason}`]);
    return { ok: true, note: `Timed out ${user.tag} for ${human(ms)}` };
  }

  if (action === "untimeout") {
    if (!target) return { error: "That user is not in the server" };
    try { await target.timeout(null, "Timeout removed via dashboard"); } catch (e) { return { error: `Failed: ${e.message}` }; }
    record(guild.id, { id: newId(), userId, type: "untimeout", reason: "Timeout removed", modId: client.user.id, at: Date.now() });
    await modlog(guild, "untimeout", [`**User:** <@${userId}>`, `**Moderator:** dashboard`]);
    return { ok: true, note: `Removed timeout from ${user.tag}` };
  }

  if (action === "kick") {
    if (!target) return { error: "That user is not in the server" };
    if (!target.kickable) return { error: "I cannot kick that member (my role is too low)" };
    await dm(user, `You were **kicked** from **${guild.name}**.\nReason: ${reason}`);
    try { await target.kick(via); } catch (e) { return { error: `Failed: ${e.message}` }; }
    record(guild.id, { id: newId(), userId, type: "kick", reason, modId: client.user.id, at: Date.now() });
    await modlog(guild, "kick", [`**User:** ${user.tag} (\`${userId}\`)`, `**Moderator:** dashboard`, `**Reason:** ${reason}`]);
    return { ok: true, note: `Kicked ${user.tag}` };
  }

  if (action === "ban") {
    const days = Math.min(7, Math.max(0, parseInt(opts.deleteDays, 10) || 0));
    if (target && !target.bannable) return { error: "I cannot ban that member (my role is too low)" };
    await dm(user, `You were **banned** from **${guild.name}**.\nReason: ${reason}`);
    try { await guild.bans.create(userId, { reason: via, deleteMessageSeconds: days * 86_400 }); }
    catch (e) { return { error: `Failed: ${e.message}` }; }
    record(guild.id, { id: newId(), userId, type: "ban", reason, modId: client.user.id, at: Date.now() });
    await modlog(guild, "ban", [`**User:** ${user.tag} (\`${userId}\`)`, `**Moderator:** dashboard`, `**Reason:** ${reason}`, days ? `**Cleared:** ${days}d of messages` : ""].filter(Boolean));
    return { ok: true, note: `Banned ${user.tag}` };
  }

  if (action === "unban") {
    try { await guild.bans.remove(userId, via); }
    catch (e) { return { error: `Could not unban (are they banned?): ${e.message}` }; }
    record(guild.id, { id: newId(), userId, type: "unban", reason, modId: client.user.id, at: Date.now() });
    await modlog(guild, "unban", [`**User:** \`${userId}\``, `**Moderator:** dashboard`, `**Reason:** ${reason}`]);
    return { ok: true, note: `Unbanned ${user.tag}` };
  }

  return { error: `Unknown action "${action}"` };
}

// ── init ─────────────────────────────────────────────────────────────────────
function initModeration(discordClient, options = {}) {
  client = discordClient;
  modlogChannelId = options.modlogChannelId || null;
  ownerId = options.ownerId || null;
  load();
  const total = Object.values(store).reduce((n, a) => n + a.length, 0);
  console.log(`[moderation] Ready — ${total} infraction(s) on record.`);
}

module.exports = {
  initModeration, handleModerationCommand, MODERATION_COMMANDS,
  webListInfractions, webDeleteInfraction, webModAction,
};
