"use strict";

/**
 * CookieBot Security / Anti-Raid module.
 *
 * Self-contained: everything lives here and is wired into index.js with a single
 * initSecurity(client, options) call plus a command-routing hook. It never touches
 * the application system.
 *
 * Features:
 *  - Audit-log tracking of channel/role deletions, channel/role updates, bans, kicks
 *  - Mass-action detection (e.g. 3+ deletions in 10s by one actor) => treated as a raid
 *  - On raid: strip the actor's dangerous roles + auto-restore what was deleted
 *  - Single deletions by non-whitelisted users are auto-restored too
 *  - Whitelist (owner always allowed) so trusted staff don't trigger rollbacks
 *  - Snapshots of channels/roles kept in memory + on disk so /restore can rebuild them
 *  - Slash commands: /security, /restore, /whitelist
 *
 * Requires the GuildModeration (audit log) intent to read "who did it".
 */

const fs = require("fs");
const path = require("path");
const {
  AuditLogEvent,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} = require("discord.js");

// ── Config ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "..", "data");
const SNAP_FILE = path.join(DATA_DIR, "security-snapshots.json");
const CONFIG_FILE = path.join(DATA_DIR, "security-config.json");

const MASS_WINDOW_MS = 10_000;   // window for counting actions
const MASS_THRESHOLD = 3;        // 3+ destructive actions in window = raid
const ACTION_TTL_MS = 60_000;    // how long we remember recent actions per actor

// dangerous permissions a raider would use; we strip roles carrying these on raid
const DANGER_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks
];

// ── State ───────────────────────────────────────────────────────────────────
let client = null;
let logChannelId = null;
let ownerId = null;

// snapshots[guildId] = { channels: {id: {...}}, roles: {id: {...}} }
let snapshots = {};
// config = { whitelistUsers: [], whitelistRoles: [] }
let config = { whitelistUsers: [], whitelistRoles: [] };
// recentActions[actorId] = [{type, at}]
const recentActions = new Map();
// recently restored ids, to avoid restore loops
const recentlyRestored = new Set();

// ── Persistence ──────────────────────────────────────────────────────────────
function ensureData() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error("[security] could not create data dir:", e.message); }
}

function loadState() {
  ensureData();
  try { if (fs.existsSync(SNAP_FILE)) snapshots = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8")) || {}; }
  catch (e) { console.error("[security] snapshot load failed:", e.message); snapshots = {}; }
  try { if (fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || config; }
  catch (e) { console.error("[security] config load failed:", e.message); }
  if (!config.whitelistUsers) config.whitelistUsers = [];
  if (!config.whitelistRoles) config.whitelistRoles = [];
}

function saveSnapshots() {
  ensureData();
  try { fs.writeFileSync(SNAP_FILE, JSON.stringify(snapshots, null, 2)); }
  catch (e) { console.error("[security] snapshot save failed:", e.message); }
}

function saveConfig() {
  ensureData();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error("[security] config save failed:", e.message); }
}

// ── Snapshotting ─────────────────────────────────────────────────────────────
function snapChannel(ch) {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    parentId: ch.parentId || null,
    position: ch.rawPosition ?? ch.position ?? 0,
    topic: ch.topic || null,
    nsfw: ch.nsfw || false,
    bitrate: ch.bitrate || null,
    userLimit: ch.userLimit || null,
    rateLimitPerUser: ch.rateLimitPerUser || null,
    overwrites: ch.permissionOverwrites?.cache
      ? [...ch.permissionOverwrites.cache.values()].map(o => ({
          id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString()
        }))
      : []
  };
}

function snapRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    position: role.rawPosition ?? role.position ?? 0,
    permissions: role.permissions.bitfield.toString(),
    mentionable: role.mentionable
  };
}

function snapshotGuild(guild) {
  const g = { channels: {}, roles: {} };
  guild.channels.cache.forEach(ch => { g.channels[ch.id] = snapChannel(ch); });
  guild.roles.cache.forEach(role => { if (!role.managed && role.id !== guild.id) g.roles[role.id] = snapRole(role); });
  snapshots[guild.id] = g;
  saveSnapshots();
}

// ── Whitelist ────────────────────────────────────────────────────────────────
function isWhitelisted(member) {
  if (!member) return false;
  if (member.id === ownerId) return true;
  if (member.id === client?.user?.id) return true; // the bot itself
  if (config.whitelistUsers.includes(member.id)) return true;
  if (member.roles?.cache?.some(r => config.whitelistRoles.includes(r.id))) return true;
  return false;
}

// ── Logging ──────────────────────────────────────────────────────────────────
async function log(guild, embed) {
  if (!logChannelId) return;
  try {
    const ch = guild.channels.cache.get(logChannelId) || await guild.channels.fetch(logChannelId).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (e) { /* logging must never throw */ }
}

function embed(title, color, lines) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

// ── Audit-log lookup ─────────────────────────────────────────────────────────
async function findActor(guild, auditType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 });
    const entry = logs.entries.find(e =>
      (!targetId || (e.target && e.target.id === targetId)) &&
      (Date.now() - e.createdTimestamp) < 15_000
    );
    return entry ? { executor: entry.executor, entry } : null;
  } catch (e) {
    return null; // missing intent/permission — fail safe (no actor => no auto-punish)
  }
}

// ── Mass-action tracking ─────────────────────────────────────────────────────
function recordAction(actorId, type) {
  const now = Date.now();
  const arr = (recentActions.get(actorId) || []).filter(a => now - a.at < ACTION_TTL_MS);
  arr.push({ type, at: now });
  recentActions.set(actorId, arr);
  const inWindow = arr.filter(a => now - a.at < MASS_WINDOW_MS);
  return inWindow.length;
}

async function punishRaider(guild, executor) {
  try {
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;
    if (isWhitelisted(member)) return; // never strip whitelisted
    // remove dangerous roles
    const dangerRoles = member.roles.cache.filter(r =>
      !r.managed && r.id !== guild.id && DANGER_PERMS.some(p => r.permissions.has(p)));
    for (const role of dangerRoles.values()) {
      await member.roles.remove(role, "CookieBot anti-raid: mass destructive actions").catch(() => {});
    }
    await log(guild, embed("🚨 Raid Stopped", 0xff3030, [
      `**Actor:** <@${executor.id}> (${executor.tag || executor.id})`,
      `**Action:** Removed ${dangerRoles.size} dangerous role(s)`,
      `Restoring deleted items automatically.`
    ]));
  } catch (e) { console.error("[security] punishRaider:", e.message); }
}

// ── Restore ──────────────────────────────────────────────────────────────────
async function restoreChannel(guild, snap) {
  const opts = {
    type: snap.type,
    topic: snap.topic || undefined,
    nsfw: snap.nsfw || undefined,
    parent: snap.parentId || undefined,
    position: snap.position || undefined,
    rateLimitPerUser: snap.rateLimitPerUser || undefined,
    permissionOverwrites: (snap.overwrites || []).map(o => ({
      id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny)
    }))
  };
  if (snap.type === ChannelType.GuildVoice) {
    if (snap.bitrate) opts.bitrate = snap.bitrate;
    if (snap.userLimit) opts.userLimit = snap.userLimit;
  }
  return guild.channels.create({ name: snap.name, ...opts });
}

async function restoreRole(guild, snap) {
  return guild.roles.create({
    name: snap.name,
    color: snap.color,
    hoist: snap.hoist,
    mentionable: snap.mentionable,
    permissions: BigInt(snap.permissions),
    reason: "CookieBot restore"
  });
}

// ── Event handlers ───────────────────────────────────────────────────────────
async function onChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;
  const snap = (snapshots[guild.id]?.channels || {})[channel.id] || snapChannel(channel);

  const actor = await findActor(guild, AuditLogEvent.ChannelDelete, channel.id);
  const executor = actor?.executor;
  let member = executor ? await guild.members.fetch(executor.id).catch(() => null) : null;

  // whitelisted actor: log only, don't restore
  if (member && isWhitelisted(member)) {
    await log(guild, embed("Channel Deleted", 0xffaa00, [
      `**Channel:** #${snap.name}`,
      `**By:** <@${executor.id}> (whitelisted — not restored)`
    ]));
    // update snapshot to forget the deleted channel
    if (snapshots[guild.id]) { delete snapshots[guild.id].channels[channel.id]; saveSnapshots(); }
    return;
  }

  // count actions; if mass => punish
  if (executor) {
    const count = recordAction(executor.id, "delete");
    if (count >= MASS_THRESHOLD) await punishRaider(guild, executor);
  }

  // auto-restore
  try {
    const created = await restoreChannel(guild, snap);
    recentlyRestored.add(created.id);
    setTimeout(() => recentlyRestored.delete(created.id), 30_000);
    await log(guild, embed("♻️ Channel Restored", 0x30ff60, [
      `**Channel:** #${snap.name}`,
      executor ? `**Deleted by:** <@${executor.id}>` : `**Deleted by:** unknown`,
      `**Restored as:** <#${created.id}>`
    ]));
    // refresh snapshot id mapping
    if (snapshots[guild.id]) {
      delete snapshots[guild.id].channels[channel.id];
      snapshots[guild.id].channels[created.id] = snapChannel(created);
      saveSnapshots();
    }
  } catch (e) {
    await log(guild, embed("⚠️ Restore Failed", 0xff3030, [
      `Could not restore #${snap.name}: ${e.message}`,
      `Use /restore channel to try manually.`
    ]));
  }
}

async function onRoleDelete(role) {
  const guild = role.guild;
  if (!guild) return;
  const snap = (snapshots[guild.id]?.roles || {})[role.id] || snapRole(role);

  const actor = await findActor(guild, AuditLogEvent.RoleDelete, role.id);
  const executor = actor?.executor;
  let member = executor ? await guild.members.fetch(executor.id).catch(() => null) : null;

  if (member && isWhitelisted(member)) {
    await log(guild, embed("Role Deleted", 0xffaa00, [
      `**Role:** ${snap.name}`,
      `**By:** <@${executor.id}> (whitelisted — not restored)`
    ]));
    if (snapshots[guild.id]) { delete snapshots[guild.id].roles[role.id]; saveSnapshots(); }
    return;
  }

  if (executor) {
    const count = recordAction(executor.id, "delete");
    if (count >= MASS_THRESHOLD) await punishRaider(guild, executor);
  }

  try {
    const created = await restoreRole(guild, snap);
    await log(guild, embed("♻️ Role Restored", 0x30ff60, [
      `**Role:** ${snap.name}`,
      executor ? `**Deleted by:** <@${executor.id}>` : `**Deleted by:** unknown`
    ]));
    if (snapshots[guild.id]) {
      delete snapshots[guild.id].roles[role.id];
      snapshots[guild.id].roles[created.id] = snapRole(created);
      saveSnapshots();
    }
  } catch (e) {
    await log(guild, embed("⚠️ Restore Failed", 0xff3030, [
      `Could not restore role ${snap.name}: ${e.message}`,
      `Use /restore role to try manually.`
    ]));
  }
}

async function onChannelCreate(channel) {
  if (!channel.guild) return;
  if (snapshots[channel.guild.id]) {
    snapshots[channel.guild.id].channels[channel.id] = snapChannel(channel);
    saveSnapshots();
  }
}

async function onRoleCreate(role) {
  if (!role.guild) return;
  if (snapshots[role.guild.id]) {
    snapshots[role.guild.id].roles[role.id] = snapRole(role);
    saveSnapshots();
  }
}

async function onChannelUpdate(_oldCh, newCh) {
  if (!newCh.guild) return;
  if (snapshots[newCh.guild.id]) {
    snapshots[newCh.guild.id].channels[newCh.id] = snapChannel(newCh);
    saveSnapshots();
  }
}

async function onRoleUpdate(_oldRole, newRole) {
  if (!newRole.guild) return;
  if (snapshots[newRole.guild.id]) {
    snapshots[newRole.guild.id].roles[newRole.id] = snapRole(newRole);
    saveSnapshots();
  }
}

// ── Slash command definitions (merged into COOKIE_COMMANDS) ───────────────────
const SECURITY_COMMANDS = [
  {
    name: "security",
    description: "Show anti-raid security status",
    default_member_permissions: PermissionFlagsBits.Administrator.toString()
  },
  {
    name: "whitelist",
    description: "Manage the security whitelist",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      { type: 3, name: "action", description: "add / remove / list", required: true,
        choices: [
          { name: "add-user", value: "add-user" },
          { name: "remove-user", value: "remove-user" },
          { name: "add-role", value: "add-role" },
          { name: "remove-role", value: "remove-role" },
          { name: "list", value: "list" }
        ] },
      { type: 6, name: "user", description: "User to add/remove", required: false },
      { type: 8, name: "role", description: "Role to add/remove", required: false }
    ]
  },
  {
    name: "restore",
    description: "Manually restore a deleted channel or role from the last snapshot",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      { type: 3, name: "type", description: "channel or role", required: true,
        choices: [ { name: "channel", value: "channel" }, { name: "role", value: "role" } ] },
      { type: 3, name: "name", description: "Name of the deleted channel/role", required: true }
    ]
  },
  {
    name: "resnapshot",
    description: "Re-scan all channels & roles into the security snapshot",
    default_member_permissions: PermissionFlagsBits.Administrator.toString()
  }
];

// ── Command handling ─────────────────────────────────────────────────────────
// Returns true if it handled the interaction, false otherwise.
async function handleSecurityCommand(interaction) {
  const name = interaction.commandName;
  if (!["security", "whitelist", "restore", "resnapshot"].includes(name)) return false;

  if (!interaction.guild) {
    await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
    return true;
  }
  // extra gate: only Administrators (in case default perms are bypassed)
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "You need Administrator to use this.", ephemeral: true });
    return true;
  }

  if (name === "security") {
    const snap = snapshots[interaction.guild.id] || { channels: {}, roles: {} };
    await interaction.reply({ ephemeral: true, embeds: [embed("🛡️ Security Status", 0x30a0ff, [
      `**Anti-raid:** Active`,
      `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "not set (SECURITY_LOG_CHANNEL_ID)"}`,
      `**Snapshotted channels:** ${Object.keys(snap.channels).length}`,
      `**Snapshotted roles:** ${Object.keys(snap.roles).length}`,
      `**Whitelisted users:** ${config.whitelistUsers.length}`,
      `**Whitelisted roles:** ${config.whitelistRoles.length}`,
      `**Mass-delete trigger:** ${MASS_THRESHOLD} actions / ${MASS_WINDOW_MS / 1000}s`
    ])] });
    return true;
  }

  if (name === "resnapshot") {
    snapshotGuild(interaction.guild);
    const snap = snapshots[interaction.guild.id];
    await interaction.reply({ ephemeral: true, content:
      `Snapshot updated: ${Object.keys(snap.channels).length} channels, ${Object.keys(snap.roles).length} roles.` });
    return true;
  }

  if (name === "whitelist") {
    const action = interaction.options.getString("action");
    const user = interaction.options.getUser("user");
    const role = interaction.options.getRole("role");

    if (action === "list") {
      await interaction.reply({ ephemeral: true, embeds: [embed("Security Whitelist", 0x30a0ff, [
        `**Users:** ${config.whitelistUsers.map(id => `<@${id}>`).join(", ") || "none"}`,
        `**Roles:** ${config.whitelistRoles.map(id => `<@&${id}>`).join(", ") || "none"}`
      ])] });
      return true;
    }
    if (action === "add-user" && user) {
      if (!config.whitelistUsers.includes(user.id)) config.whitelistUsers.push(user.id);
      saveConfig();
      await interaction.reply({ ephemeral: true, content: `Added <@${user.id}> to the whitelist.` });
      return true;
    }
    if (action === "remove-user" && user) {
      config.whitelistUsers = config.whitelistUsers.filter(id => id !== user.id);
      saveConfig();
      await interaction.reply({ ephemeral: true, content: `Removed <@${user.id}> from the whitelist.` });
      return true;
    }
    if (action === "add-role" && role) {
      if (!config.whitelistRoles.includes(role.id)) config.whitelistRoles.push(role.id);
      saveConfig();
      await interaction.reply({ ephemeral: true, content: `Added <@&${role.id}> to the whitelist.` });
      return true;
    }
    if (action === "remove-role" && role) {
      config.whitelistRoles = config.whitelistRoles.filter(id => id !== role.id);
      saveConfig();
      await interaction.reply({ ephemeral: true, content: `Removed <@&${role.id}> from the whitelist.` });
      return true;
    }
    await interaction.reply({ ephemeral: true, content: "Provide the matching user/role for that action." });
    return true;
  }

  if (name === "restore") {
    const type = interaction.options.getString("type");
    const wanted = interaction.options.getString("name").toLowerCase();
    const snap = snapshots[interaction.guild.id] || { channels: {}, roles: {} };

    if (type === "channel") {
      const match = Object.values(snap.channels).find(c => c.name.toLowerCase() === wanted);
      if (!match) { await interaction.reply({ ephemeral: true, content: `No snapshot of a channel named "${wanted}".` }); return true; }
      try {
        const created = await restoreChannel(interaction.guild, match);
        await interaction.reply({ ephemeral: true, content: `Restored channel as <#${created.id}>.` });
      } catch (e) { await interaction.reply({ ephemeral: true, content: `Failed: ${e.message}` }); }
      return true;
    } else {
      const match = Object.values(snap.roles).find(r => r.name.toLowerCase() === wanted);
      if (!match) { await interaction.reply({ ephemeral: true, content: `No snapshot of a role named "${wanted}".` }); return true; }
      try {
        await restoreRole(interaction.guild, match);
        await interaction.reply({ ephemeral: true, content: `Restored role "${match.name}".` });
      } catch (e) { await interaction.reply({ ephemeral: true, content: `Failed: ${e.message}` }); }
      return true;
    }
  }

  return false;
}

// ── Init ─────────────────────────────────────────────────────────────────────
function initSecurity(discordClient, options = {}) {
  client = discordClient;
  logChannelId = options.logChannelId || null;
  ownerId = options.ownerId || null;

  loadState();

  // snapshot every guild on ready, then attach listeners
  client.guilds.cache.forEach(g => snapshotGuild(g));

  client.on("channelDelete", ch => onChannelDelete(ch).catch(e => console.error("[security] channelDelete:", e.message)));
  client.on("roleDelete", role => onRoleDelete(role).catch(e => console.error("[security] roleDelete:", e.message)));
  client.on("channelCreate", ch => onChannelCreate(ch).catch(() => {}));
  client.on("roleCreate", role => onRoleCreate(role).catch(() => {}));
  client.on("channelUpdate", (o, n) => onChannelUpdate(o, n).catch(() => {}));
  client.on("roleUpdate", (o, n) => onRoleUpdate(o, n).catch(() => {}));

  // Re-scan every guild's channels & roles every 30 minutes so snapshots stay fresh
  setInterval(() => {
    try {
      client.guilds.cache.forEach(g => snapshotGuild(g));
      console.log("[security] Periodic snapshot refreshed for all guilds.");
    } catch (e) {
      console.error("[security] periodic snapshot failed:", e.message);
    }
  }, 30 * 60 * 1000);

  console.log("[security] Anti-raid module active.");
}

module.exports = { initSecurity, handleSecurityCommand, SECURITY_COMMANDS };
