"use strict";

/**
 * CookieBot Security / Anti-Nuke module  (v2)
 *
 * Self-contained: wired into index.js with initSecurity(client, options) plus the
 * handleSecurityCommand routing hook. It never touches the application system.
 *
 * Protects against a compromised admin / nuke bot:
 *   - Channel & role deletions  -> auto-restore from snapshot
 *   - Mass destructive actions (deletes, bans, kicks, webhook spam, create spam)
 *     by one actor in a short window -> treated as a raid -> punish the actor
 *   - Role permission escalation (a role gains Administrator/dangerous perms)
 *     -> reverted to the snapshot, actor punished
 *   - @everyone gaining dangerous perms -> stripped back
 *   - A member being granted a dangerous role by a non-whitelisted actor -> removed
 *   - Mass bans -> actor punished AND the banned victims auto-unbanned
 *   - Rogue webhooks created by non-whitelisted actors -> deleted
 *   - Join raids (a flood of new / very-new accounts) -> verification raised +
 *     brand-new accounts kicked + owner alerted
 *   - Lockdown (auto on a severe raid, or manual via /lockdown)
 *
 * Punishment is configurable: log | strip | quarantine | kick | ban.
 * Whitelisted users/roles (and the owner + the bot) never trigger punishment.
 *
 * Needs: View Audit Log permission, and the GuildModeration + GuildWebhooks intents
 * (added in index.js). Without audit-log access it fails safe (logs, never auto-bans).
 */

const fs = require("fs");
const path = require("path");
const {
  AuditLogEvent,
  ChannelType,
  PermissionFlagsBits,
  GuildVerificationLevel,
  EmbedBuilder
} = require("discord.js");
const { pushActivity } = require("./activity");

// ── Files ─────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "..", "data");
const SNAP_FILE = path.join(DATA_DIR, "security-snapshots.json");
const CONFIG_FILE = path.join(DATA_DIR, "security-config.json");

// dangerous permissions a raider would use
const DANGER_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.MentionEveryone
];
const DANGER_MASK = DANGER_PERMS.reduce((m, p) => m | p, 0n);

const DEFAULT_CONFIG = {
  whitelistUsers: [],
  whitelistRoles: [],
  punishment: "quarantine",     // log | strip | quarantine | kick | ban
  antiNuke: true,
  lockBans: true,               // only the bot's /ban may ban; manual Discord bans are auto-reversed
  massWindowMs: 12_000,
  massThreshold: 4,             // destructive actions in window by one actor => raid
  actionTtlMs: 60_000,
  protectedChannels: [],        // ids: deletion is always a raid (instant punish)
  protectedRoles: [],
  joinRaid: {
    enabled: true,
    windowMs: 15_000,
    threshold: 8,               // joins in window => join raid
    minAccountAgeDays: 3,       // during a surge, kick accounts younger than this
    raiseVerification: true
  },
  lockdown: false
};

// ── State ───────────────────────────────────────────────────────────────────
let client = null;
let logChannelId = null;
let ownerId = null;

let snapshots = {};                       // snapshots[guildId] = { channels:{}, roles:{} }
let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

const recentActions = new Map();          // actorId -> [{type, at}]
const recentlyRestored = new Set();       // ids we just recreated (avoid loops)
const punishedRecently = new Map();       // actorId -> ts (cooldown so we act once)
const bannedByActor = new Map();          // actorId -> [{userId, at}] (to undo raid bans)
const recentJoins = new Map();            // guildId -> [ts]
const auditCache = new Map();             // `${guild}:${type}` -> {at, entries}

// ── Persistence ────────────────────────────────────────────────────────────────
function ensureData() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error("[security] data dir:", e.message); }
}
function loadState() {
  ensureData();
  try { if (fs.existsSync(SNAP_FILE)) snapshots = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8")) || {}; }
  catch (e) { snapshots = {}; }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
      config = normalizeConfig(loaded);
    }
  } catch (e) { console.error("[security] config load:", e.message); }
}
function normalizeConfig(c) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (c[k] === undefined) continue;
    if (k === "joinRaid" && typeof c[k] === "object") out.joinRaid = { ...out.joinRaid, ...c[k] };
    else out[k] = c[k];
  }
  return out;
}
function saveSnapshots() { ensureData(); try { fs.writeFileSync(SNAP_FILE, JSON.stringify(snapshots, null, 2)); } catch (e) {} }
function saveConfig() { ensureData(); try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {} }

// ── Snapshotting ─────────────────────────────────────────────────────────────
function snapChannel(ch) {
  return {
    id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null,
    position: ch.rawPosition ?? ch.position ?? 0, topic: ch.topic || null, nsfw: ch.nsfw || false,
    bitrate: ch.bitrate || null, userLimit: ch.userLimit || null, rateLimitPerUser: ch.rateLimitPerUser || null,
    overwrites: ch.permissionOverwrites?.cache
      ? [...ch.permissionOverwrites.cache.values()].map(o => ({
          id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }))
      : []
  };
}
function snapRole(role) {
  return {
    id: role.id, name: role.name, color: role.color, hoist: role.hoist,
    position: role.rawPosition ?? role.position ?? 0,
    permissions: role.permissions.bitfield.toString(), mentionable: role.mentionable
  };
}
function snapshotGuild(guild) {
  const g = { channels: {}, roles: {}, name: guild.name };
  guild.channels.cache.forEach(ch => { g.channels[ch.id] = snapChannel(ch); });
  guild.roles.cache.forEach(role => { if (!role.managed && role.id !== guild.id) g.roles[role.id] = snapRole(role); });
  snapshots[guild.id] = g;
  saveSnapshots();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isWhitelisted(member) {
  if (!member) return false;
  const id = member.id || member.user?.id;
  if (id === ownerId) return true;
  if (id === client?.user?.id) return true;
  if (config.whitelistUsers.includes(id)) return true;
  if (member.roles?.cache?.some(r => config.whitelistRoles.includes(r.id))) return true;
  return false;
}
function hasDanger(bitfield) { try { return (BigInt(bitfield) & DANGER_MASK) !== 0n; } catch (e) { return false; } }

async function log(guild, eb) {
  try { pushActivity("security", `${eb.data?.title || "event"}: ${(eb.data?.description || "").replace(/\*\*/g, "").slice(0, 200)}`); } catch (e) {}
  if (!logChannelId) return;
  try {
    const ch = guild.channels.cache.get(logChannelId) || await guild.channels.fetch(logChannelId).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send({ embeds: [eb] });
  } catch (e) { /* logging must never throw */ }
}
function embed(title, color, lines) {
  return new EmbedBuilder().setTitle(title).setColor(color).setDescription(lines.join("\n")).setTimestamp();
}
async function alertOwner(guild, text) {
  if (!ownerId) return;
  try {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    if (owner) await owner.send(`**[CookieBot Security · ${guild.name}]** ${text}`).catch(() => {});
  } catch (e) {}
}

// ── Audit-log lookup (cached briefly to avoid hammering the API) ───────────────
async function getEntries(guild, auditType) {
  const key = `${guild.id}:${auditType}`;
  const cached = auditCache.get(key);
  if (cached && Date.now() - cached.at < 2_500) return cached.entries;
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 8 });
    const entries = [...logs.entries.values()];
    auditCache.set(key, { at: Date.now(), entries });
    return entries;
  } catch (e) { return []; } // missing intent/permission -> no actor -> fail safe
}
async function findActor(guild, auditType, targetId, maxAgeMs = 15_000) {
  const entries = await getEntries(guild, auditType);
  const entry = entries.find(e =>
    (!targetId || (e.target && e.target.id === targetId)) && (Date.now() - e.createdTimestamp) < maxAgeMs);
  return entry ? { executor: entry.executor, entry } : null;
}
async function memberOf(guild, userId) { return userId ? guild.members.fetch(userId).catch(() => null) : null; }

// ── Threat tracking + punishment ──────────────────────────────────────────────
function recordAction(actorId, type) {
  const now = Date.now();
  const arr = (recentActions.get(actorId) || []).filter(a => now - a.at < config.actionTtlMs);
  arr.push({ type, at: now });
  recentActions.set(actorId, arr);
  return arr.filter(a => now - a.at < config.massWindowMs).length;
}

async function applyPunishment(guild, executor, reason, { severe = false } = {}) {
  if (!executor) return;
  if (punishedRecently.has(executor.id) && Date.now() - punishedRecently.get(executor.id) < 30_000) return;
  punishedRecently.set(executor.id, Date.now());

  const member = await memberOf(guild, executor.id);
  if (member && isWhitelisted(member)) return;

  const mode = config.punishment;
  const tag = executor.tag || executor.id;
  let outcome = "logged";

  // declaw immediately, whatever the mode — stops ongoing damage even if a later ban/kick fails
  if (member) {
    const danger = member.roles.cache.filter(r => !r.managed && r.id !== guild.id && hasDanger(r.permissions.bitfield));
    for (const role of danger.values()) await member.roles.remove(role, "CookieBot anti-nuke: declaw").catch(() => {});
  }

  try {
    if (mode === "ban") {
      await guild.bans.create(executor.id, { reason: `CookieBot anti-nuke: ${reason}` }).catch(() => {});
      outcome = "banned";
    } else if (mode === "kick" && member) {
      await member.kick(`CookieBot anti-nuke: ${reason}`).catch(() => {});
      outcome = "kicked";
    } else if ((mode === "quarantine" || mode === "strip") && member) {
      const roles = member.roles.cache.filter(r =>
        !r.managed && r.id !== guild.id && (mode === "quarantine" || hasDanger(r.permissions.bitfield)));
      for (const role of roles.values())
        await member.roles.remove(role, `CookieBot anti-nuke: ${reason}`).catch(() => {});
      outcome = mode === "quarantine" ? `quarantined (removed ${roles.size} role(s))` : `stripped ${roles.size} dangerous role(s)`;
    }
  } catch (e) { console.error("[security] punish:", e.message); }

  // undo raid bans by this actor (only those within the window)
  await undoActorBans(guild, executor.id);

  if (severe && config.antiNuke && !config.lockdown) await setLockdown(guild, true, "automatic (severe raid)").catch(() => {});

  await log(guild, embed("🚨 Raid Action Taken", 0xff2d2d, [
    `**Actor:** <@${executor.id}> (${tag})`,
    `**Trigger:** ${reason}`,
    `**Punishment:** ${outcome}`,
    severe ? `**Server locked down automatically.**` : ``
  ].filter(Boolean)));
  await alertOwner(guild, `Raid by ${tag} — ${reason}. Action: ${outcome}.`);
}

async function undoActorBans(guild, actorId) {
  const list = (bannedByActor.get(actorId) || []).filter(b => Date.now() - b.at < 60_000);
  for (const b of list) await guild.bans.remove(b.userId, "CookieBot anti-nuke: reversing raid ban").catch(() => {});
  bannedByActor.delete(actorId);
}

// ── Restore ──────────────────────────────────────────────────────────────────
async function restoreChannel(guild, snap) {
  const opts = {
    type: snap.type, topic: snap.topic || undefined, nsfw: snap.nsfw || undefined,
    parent: snap.parentId || undefined, position: snap.position || undefined,
    rateLimitPerUser: snap.rateLimitPerUser || undefined,
    permissionOverwrites: (snap.overwrites || []).map(o => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }))
  };
  if (snap.type === ChannelType.GuildVoice) { if (snap.bitrate) opts.bitrate = snap.bitrate; if (snap.userLimit) opts.userLimit = snap.userLimit; }
  return guild.channels.create({ name: snap.name, ...opts });
}
async function restoreRole(guild, snap) {
  return guild.roles.create({
    name: snap.name, color: snap.color, hoist: snap.hoist, mentionable: snap.mentionable,
    permissions: BigInt(snap.permissions), reason: "CookieBot restore"
  });
}

// ── Lockdown ───────────────────────────────────────────────────────────────────
async function setLockdown(guild, on, why = "manual") {
  const everyone = guild.roles.everyone;
  let count = 0;
  for (const ch of guild.channels.cache.values()) {
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(ch.type)) continue;
    try { await ch.permissionOverwrites.edit(everyone, { SendMessages: on ? false : null }, { reason: `CookieBot lockdown (${why})` }); count++; }
    catch (e) {}
  }
  config.lockdown = on; saveConfig();
  await log(guild, embed(on ? "🔒 Server Locked Down" : "🔓 Lockdown Lifted", on ? 0xff8c00 : 0x30ff60,
    [`**Reason:** ${why}`, `**Channels affected:** ${count}`]));
  return count;
}

// ── Event handlers ───────────────────────────────────────────────────────────
async function onChannelDelete(channel) {
  const guild = channel.guild; if (!guild) return;
  const snap = (snapshots[guild.id]?.channels || {})[channel.id] || snapChannel(channel);
  const actor = await findActor(guild, AuditLogEvent.ChannelDelete, channel.id);
  const executor = actor?.executor;
  const member = await memberOf(guild, executor?.id);

  if (member && isWhitelisted(member)) {
    await log(guild, embed("Channel Deleted", 0xffaa00, [`**Channel:** #${snap.name}`, `**By:** <@${executor.id}> (whitelisted — not restored)`]));
    if (snapshots[guild.id]) { delete snapshots[guild.id].channels[channel.id]; saveSnapshots(); }
    return;
  }
  const protectedItem = config.protectedChannels.includes(channel.id);
  if (executor && config.antiNuke) {
    const count = recordAction(executor.id, "channelDelete");
    if (protectedItem || count >= config.massThreshold)
      await applyPunishment(guild, executor, protectedItem ? "deleted a protected channel" : "mass channel deletion", { severe: true });
  }
  try {
    const created = await restoreChannel(guild, snap);
    recentlyRestored.add(created.id); setTimeout(() => recentlyRestored.delete(created.id), 30_000);
    await log(guild, embed("♻️ Channel Restored", 0x30ff60,
      [`**Channel:** #${snap.name}`, `**Deleted by:** ${executor ? `<@${executor.id}>` : "unknown"}`, `**Restored as:** <#${created.id}>`]));
    if (snapshots[guild.id]) { delete snapshots[guild.id].channels[channel.id]; snapshots[guild.id].channels[created.id] = snapChannel(created); saveSnapshots(); }
  } catch (e) {
    await log(guild, embed("⚠️ Restore Failed", 0xff3030, [`Could not restore #${snap.name}: ${e.message}`, `Try /restore channel.`]));
  }
}

async function onRoleDelete(role) {
  const guild = role.guild; if (!guild) return;
  const snap = (snapshots[guild.id]?.roles || {})[role.id] || snapRole(role);
  const actor = await findActor(guild, AuditLogEvent.RoleDelete, role.id);
  const executor = actor?.executor;
  const member = await memberOf(guild, executor?.id);

  if (member && isWhitelisted(member)) {
    await log(guild, embed("Role Deleted", 0xffaa00, [`**Role:** ${snap.name}`, `**By:** <@${executor.id}> (whitelisted — not restored)`]));
    if (snapshots[guild.id]) { delete snapshots[guild.id].roles[role.id]; saveSnapshots(); }
    return;
  }
  const protectedItem = config.protectedRoles.includes(role.id);
  if (executor && config.antiNuke) {
    const count = recordAction(executor.id, "roleDelete");
    if (protectedItem || count >= config.massThreshold)
      await applyPunishment(guild, executor, protectedItem ? "deleted a protected role" : "mass role deletion", { severe: true });
  }
  try {
    const created = await restoreRole(guild, snap);
    await log(guild, embed("♻️ Role Restored", 0x30ff60, [`**Role:** ${snap.name}`, `**Deleted by:** ${executor ? `<@${executor.id}>` : "unknown"}`]));
    if (snapshots[guild.id]) { delete snapshots[guild.id].roles[role.id]; snapshots[guild.id].roles[created.id] = snapRole(created); saveSnapshots(); }
  } catch (e) {
    await log(guild, embed("⚠️ Restore Failed", 0xff3030, [`Could not restore role ${snap.name}: ${e.message}`, `Try /restore role.`]));
  }
}

async function onChannelCreate(channel) {
  const guild = channel.guild; if (!guild) return;
  if (snapshots[guild.id]) { snapshots[guild.id].channels[channel.id] = snapChannel(channel); saveSnapshots(); }
  if (recentlyRestored.has(channel.id) || !config.antiNuke) return;
  const actor = await findActor(guild, AuditLogEvent.ChannelCreate, channel.id);
  const executor = actor?.executor; if (!executor) return;
  const member = await memberOf(guild, executor.id); if (member && isWhitelisted(member)) return;
  const count = recordAction(executor.id, "channelCreate");
  if (count >= config.massThreshold) {
    await channel.delete("CookieBot anti-nuke: channel-create spam").catch(() => {});
    await applyPunishment(guild, executor, "mass channel creation (spam)");
  }
}

async function onRoleCreate(role) {
  const guild = role.guild; if (!guild) return;
  if (snapshots[guild.id]) { snapshots[guild.id].roles[role.id] = snapRole(role); saveSnapshots(); }
  if (recentlyRestored.has(role.id) || !config.antiNuke) return;
  const actor = await findActor(guild, AuditLogEvent.RoleCreate, role.id);
  const executor = actor?.executor; if (!executor) return;
  const member = await memberOf(guild, executor.id); if (member && isWhitelisted(member)) return;
  const count = recordAction(executor.id, "roleCreate");
  if (count >= config.massThreshold) {
    await role.delete("CookieBot anti-nuke: role-create spam").catch(() => {});
    await applyPunishment(guild, executor, "mass role creation (spam)");
  }
}

async function onChannelUpdate(_o, newCh) {
  if (!newCh.guild) return;
  if (snapshots[newCh.guild.id]) { snapshots[newCh.guild.id].channels[newCh.id] = snapChannel(newCh); saveSnapshots(); }
}

async function onRoleUpdate(oldRole, newRole) {
  const guild = newRole.guild; if (!guild) return;
  const before = oldRole?.permissions?.bitfield ?? (snapshots[guild.id]?.roles?.[newRole.id]?.permissions ? BigInt(snapshots[guild.id].roles[newRole.id].permissions) : 0n);
  const after = newRole.permissions.bitfield;
  const gainedDanger = (after & DANGER_MASK & ~BigInt(before)) !== 0n;

  if (gainedDanger && config.antiNuke) {
    const actor = await findActor(guild, AuditLogEvent.RoleUpdate, newRole.id);
    const executor = actor?.executor;
    const member = await memberOf(guild, executor?.id);
    if (!member || !isWhitelisted(member)) {
      // revert: @everyone -> just strip the danger bits; a real role -> restore snapshot perms
      try {
        if (newRole.id === guild.id) await newRole.setPermissions(after & ~DANGER_MASK, "CookieBot anti-nuke: stripped dangerous @everyone perms");
        else await newRole.setPermissions(BigInt(before), "CookieBot anti-nuke: reverted permission escalation");
      } catch (e) {}
      if (executor) {
        recordAction(executor.id, "permEscalation");
        await applyPunishment(guild, executor, `gave dangerous permissions to "${newRole.name}"`, { severe: true });
      } else {
        await log(guild, embed("⚠️ Permission Escalation Reverted", 0xff8c00, [`**Role:** ${newRole.name}`, `Dangerous permissions were added and have been removed.`]));
      }
      return;
    }
  }
  if (snapshots[guild.id]) { snapshots[guild.id].roles[newRole.id] = snapRole(newRole); saveSnapshots(); }
}

async function onMemberUpdate(oldMember, newMember) {
  const guild = newMember.guild; if (!guild || !config.antiNuke) return;
  const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && !r.managed && hasDanger(r.permissions.bitfield));
  if (!added.size) return;
  const actor = await findActor(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
  const executor = actor?.executor;
  const actMember = await memberOf(guild, executor?.id);
  if (actMember && isWhitelisted(actMember)) return;
  // a non-whitelisted actor just handed out a dangerous role -> take it back
  for (const role of added.values())
    await newMember.roles.remove(role, "CookieBot anti-nuke: unauthorized dangerous role grant").catch(() => {});
  if (executor) {
    recordAction(executor.id, "dangerRoleGrant");
    await applyPunishment(guild, executor, `granted a dangerous role to <@${newMember.id}>`, { severe: true });
  } else {
    await log(guild, embed("⚠️ Dangerous Role Removed", 0xff8c00, [`Removed ${added.size} dangerous role(s) from <@${newMember.id}> (granted with no audit trail).`]));
  }
}

async function onBanAdd(ban) {
  const guild = ban.guild; if (!guild || !config.antiNuke) return;
  const actor = await findActor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  const executor = actor?.executor; if (!executor) return;

  // BAN LOCK: only the bot's own /ban may ban. Reverse every other ban — even admins and the owner.
  if (config.lockBans && executor.id !== client.user.id) {
    await guild.bans.remove(ban.user.id, "CookieBot: manual bans disabled — use /ban").catch(() => {});
    const c = recordAction(executor.id, "ban");
    await log(guild, embed("⛔ Manual Ban Reversed", 0xff8c00, [
      `**Target:** ${ban.user.tag} (\`${ban.user.id}\`) was unbanned.`,
      `**Tried by:** <@${executor.id}>`,
      "Discord's own ban is disabled here — use the `/ban` command."
    ]));
    await alertOwner(guild, `${executor.tag || executor.id} tried to ban ${ban.user.tag} via Discord — reversed (ban lock).`);
    if (c >= config.massThreshold) await applyPunishment(guild, executor, "mass manual banning", { severe: true });
    return;
  }

  const member = await memberOf(guild, executor.id); if (member && isWhitelisted(member)) return;
  const list = (bannedByActor.get(executor.id) || []).filter(b => Date.now() - b.at < 60_000);
  list.push({ userId: ban.user.id, at: Date.now() });
  bannedByActor.set(executor.id, list);
  const count = recordAction(executor.id, "ban");
  await log(guild, embed("Member Banned", 0xffaa00, [`**User:** ${ban.user.tag}`, `**By:** <@${executor.id}>`]));
  if (count >= config.massThreshold) await applyPunishment(guild, executor, "mass banning members", { severe: true });
}

async function onMemberRemove(member) {
  const guild = member.guild; if (!guild || !config.antiNuke) return;
  const actor = await findActor(guild, AuditLogEvent.MemberKick, member.id, 6_000);
  const executor = actor?.executor; if (!executor) return; // a plain leave has no kick entry
  const actMember = await memberOf(guild, executor.id); if (actMember && isWhitelisted(actMember)) return;
  const count = recordAction(executor.id, "kick");
  await log(guild, embed("Member Kicked", 0xffaa00, [`**User:** ${member.user?.tag || member.id}`, `**By:** <@${executor.id}>`]));
  if (count >= config.massThreshold) await applyPunishment(guild, executor, "mass kicking members", { severe: true });
}

async function onWebhooksUpdate(channel) {
  const guild = channel.guild; if (!guild || !config.antiNuke) return;
  const entries = await getEntries(guild, AuditLogEvent.WebhookCreate);
  const recent = entries.filter(e => Date.now() - e.createdTimestamp < 12_000);
  for (const e of recent) {
    const member = await memberOf(guild, e.executor?.id);
    if (member && isWhitelisted(member)) continue;
    try {
      const hooks = await channel.fetchWebhooks().catch(() => null);
      const hook = hooks?.find(h => h.owner?.id === e.executor?.id);
      if (hook) { await hook.delete("CookieBot anti-nuke: rogue webhook").catch(() => {}); }
    } catch (err) {}
    if (e.executor) {
      const count = recordAction(e.executor.id, "webhook");
      await log(guild, embed("🪝 Rogue Webhook Removed", 0xff8c00, [`**Created by:** <@${e.executor.id}>`, `**Channel:** <#${channel.id}>`]));
      if (count >= config.massThreshold) await applyPunishment(guild, e.executor, "webhook spam");
    }
  }
}

async function onMemberAdd(member) {
  const guild = member.guild; if (!guild) return;
  // a new BOT added by a non-whitelisted actor -> kick it (raiders add nuke bots)
  if (member.user.bot && config.antiNuke) {
    const actor = await findActor(guild, AuditLogEvent.BotAdd, member.id, 15_000);
    const adder = await memberOf(guild, actor?.executor?.id);
    if (!adder || !isWhitelisted(adder)) {
      await member.kick("CookieBot anti-nuke: unauthorized bot add").catch(() => {});
      await log(guild, embed("🤖 Unauthorized Bot Removed", 0xff8c00, [`Kicked **${member.user.tag}**`, actor?.executor ? `**Added by:** <@${actor.executor.id}>` : `Added by: unknown`]));
      if (actor?.executor) { recordAction(actor.executor.id, "botAdd"); await applyPunishment(guild, actor.executor, "added an unauthorized bot", { severe: true }); }
    }
    return;
  }
  if (!config.joinRaid.enabled) return;
  const now = Date.now();
  const arr = (recentJoins.get(guild.id) || []).filter(t => now - t < config.joinRaid.windowMs);
  arr.push(now); recentJoins.set(guild.id, arr);
  const surge = arr.length >= config.joinRaid.threshold;
  const ageMs = now - member.user.createdTimestamp;
  const youngMs = config.joinRaid.minAccountAgeDays * 86_400_000;

  if (surge) {
    if (config.joinRaid.raiseVerification && guild.verificationLevel < GuildVerificationLevel.High) {
      await guild.setVerificationLevel(GuildVerificationLevel.High, "CookieBot anti-raid: join surge").catch(() => {});
    }
    if (ageMs < youngMs) {
      await member.kick("CookieBot anti-raid: new account during a join surge").catch(() => {});
      await log(guild, embed("👢 Raid Account Kicked", 0xff8c00, [`<@${member.id}> (${member.user.tag}) — account ${Math.floor(ageMs / 86_400_000)}d old, kicked during a join surge.`]));
    } else {
      await log(guild, embed("⚠️ Join Surge", 0xff8c00, [`${arr.length} joins in ${Math.round(config.joinRaid.windowMs / 1000)}s. Verification raised.`]));
    }
    await alertOwner(guild, `Possible join raid: ${arr.length} joins in ${Math.round(config.joinRaid.windowMs / 1000)}s.`);
  }
}

async function onGuildUpdate(oldG, newG) {
  if (!config.antiNuke) return;
  if (oldG.name !== newG.name) {
    const actor = await findActor(newG, AuditLogEvent.GuildUpdate, null, 15_000);
    const member = await memberOf(newG, actor?.executor?.id);
    if (actor?.executor && (!member || !isWhitelisted(member))) {
      const revertTo = snapshots[newG.id]?.name || oldG.name;
      await newG.setName(revertTo, "CookieBot anti-nuke: reverted server rename").catch(() => {});
      recordAction(actor.executor.id, "guildRename");
      await log(newG, embed("⚠️ Server Rename Reverted", 0xff8c00, [`Reverted to **${revertTo}**`, `**By:** <@${actor.executor.id}>`]));
      await applyPunishment(newG, actor.executor, "renamed the server");
      return;
    }
  }
  if (snapshots[newG.id]) { snapshots[newG.id].name = newG.name; saveSnapshots(); }
}

// ── Commands ───────────────────────────────────────────────────────────────────
const P_ADMIN = PermissionFlagsBits.Administrator.toString();
const SECURITY_COMMANDS = [
  { name: "security", description: "Show anti-nuke security status", default_member_permissions: P_ADMIN },
  { name: "resnapshot", description: "Re-scan all channels & roles into the security snapshot", default_member_permissions: P_ADMIN },
  {
    name: "whitelist", description: "Manage the security whitelist", default_member_permissions: P_ADMIN,
    options: [
      { type: 3, name: "action", description: "add / remove / list", required: true, choices: [
        { name: "add-user", value: "add-user" }, { name: "remove-user", value: "remove-user" },
        { name: "add-role", value: "add-role" }, { name: "remove-role", value: "remove-role" }, { name: "list", value: "list" } ] },
      { type: 6, name: "user", description: "User to add/remove", required: false },
      { type: 8, name: "role", description: "Role to add/remove", required: false }
    ]
  },
  {
    name: "restore", description: "Manually restore a deleted channel or role from the last snapshot", default_member_permissions: P_ADMIN,
    options: [
      { type: 3, name: "type", description: "channel or role", required: true, choices: [ { name: "channel", value: "channel" }, { name: "role", value: "role" } ] },
      { type: 3, name: "name", description: "Name of the deleted channel/role", required: true }
    ]
  },
  {
    name: "lockdown", description: "Lock or unlock the whole server (deny @everyone sending)", default_member_permissions: P_ADMIN,
    options: [ { type: 3, name: "state", description: "on or off", required: true, choices: [ { name: "on", value: "on" }, { name: "off", value: "off" } ] } ]
  },
  {
    name: "antinuke", description: "Configure the anti-nuke protection", default_member_permissions: P_ADMIN,
    options: [
      { type: 3, name: "action", description: "what to change", required: true, choices: [
        { name: "view", value: "view" },
        { name: "enable", value: "enable" }, { name: "disable", value: "disable" },
        { name: "set-punishment", value: "set-punishment" },
        { name: "set-threshold", value: "set-threshold" },
        { name: "join-raid-on", value: "join-raid-on" }, { name: "join-raid-off", value: "join-raid-off" },
        { name: "ban-lock-on", value: "ban-lock-on" }, { name: "ban-lock-off", value: "ban-lock-off" },
        { name: "protect-channel", value: "protect-channel" }, { name: "unprotect-channel", value: "unprotect-channel" },
        { name: "protect-role", value: "protect-role" }, { name: "unprotect-role", value: "unprotect-role" } ] },
      { type: 3, name: "punishment", description: "log / strip / quarantine / kick / ban", required: false, choices: [
        { name: "log", value: "log" }, { name: "strip", value: "strip" }, { name: "quarantine", value: "quarantine" },
        { name: "kick", value: "kick" }, { name: "ban", value: "ban" } ] },
      { type: 4, name: "threshold", description: "destructive actions in the window before it's a raid", required: false, min_value: 2, max_value: 20 },
      { type: 7, name: "channel", description: "channel to protect/unprotect", required: false },
      { type: 8, name: "role", description: "role to protect/unprotect", required: false }
    ]
  }
];

async function handleSecurityCommand(interaction) {
  const name = interaction.commandName;
  if (!["security", "whitelist", "restore", "resnapshot", "lockdown", "antinuke"].includes(name)) return false;
  if (!interaction.isChatInputCommand?.()) return false;
  if (!interaction.guild) { await interaction.reply({ content: "This command only works in a server.", ephemeral: true }); return true; }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "You need Administrator to use this.", ephemeral: true }); return true;
  }
  const guild = interaction.guild;

  if (name === "security") {
    const snap = snapshots[guild.id] || { channels: {}, roles: {} };
    await interaction.reply({ ephemeral: true, embeds: [embed("🛡️ Security Status", 0x30a0ff, [
      `**Anti-nuke:** ${config.antiNuke ? "ON" : "OFF"}   •   **Lockdown:** ${config.lockdown ? "ON" : "off"}   •   **Ban lock:** ${config.lockBans ? "ON (only /ban)" : "off"}`,
      `**Punishment:** \`${config.punishment}\``,
      `**Raid trigger:** ${config.massThreshold} actions / ${config.massWindowMs / 1000}s`,
      `**Join-raid guard:** ${config.joinRaid.enabled ? `ON (${config.joinRaid.threshold}/${config.joinRaid.windowMs / 1000}s, kick <${config.joinRaid.minAccountAgeDays}d)` : "off"}`,
      `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "not set (LOG_CHANNEL_ID)"}`,
      `**Snapshot:** ${Object.keys(snap.channels).length} channels, ${Object.keys(snap.roles).length} roles`,
      `**Protected:** ${config.protectedChannels.length} channels, ${config.protectedRoles.length} roles`,
      `**Whitelist:** ${config.whitelistUsers.length} users, ${config.whitelistRoles.length} roles`
    ])] });
    return true;
  }

  if (name === "resnapshot") {
    snapshotGuild(guild);
    const snap = snapshots[guild.id];
    await interaction.reply({ ephemeral: true, content: `Snapshot updated: ${Object.keys(snap.channels).length} channels, ${Object.keys(snap.roles).length} roles.` });
    return true;
  }

  if (name === "lockdown") {
    const on = interaction.options.getString("state") === "on";
    await interaction.reply({ ephemeral: true, content: `${on ? "Locking down" : "Unlocking"} the server…` });
    const n = await setLockdown(guild, on, `manual by ${interaction.user.tag}`);
    await interaction.editReply({ content: `${on ? "🔒 Locked down" : "🔓 Unlocked"} ${n} channel(s).` });
    return true;
  }

  if (name === "whitelist") {
    const action = interaction.options.getString("action");
    const user = interaction.options.getUser("user");
    const role = interaction.options.getRole("role");
    if (action === "list") {
      await interaction.reply({ ephemeral: true, embeds: [embed("Security Whitelist", 0x30a0ff, [
        `**Users:** ${config.whitelistUsers.map(id => `<@${id}>`).join(", ") || "none"}`,
        `**Roles:** ${config.whitelistRoles.map(id => `<@&${id}>`).join(", ") || "none"}` ])] });
      return true;
    }
    if (action === "add-user" && user) { if (!config.whitelistUsers.includes(user.id)) config.whitelistUsers.push(user.id); saveConfig(); await interaction.reply({ ephemeral: true, content: `Added <@${user.id}> to the whitelist.` }); return true; }
    if (action === "remove-user" && user) { config.whitelistUsers = config.whitelistUsers.filter(id => id !== user.id); saveConfig(); await interaction.reply({ ephemeral: true, content: `Removed <@${user.id}> from the whitelist.` }); return true; }
    if (action === "add-role" && role) { if (!config.whitelistRoles.includes(role.id)) config.whitelistRoles.push(role.id); saveConfig(); await interaction.reply({ ephemeral: true, content: `Added <@&${role.id}> to the whitelist.` }); return true; }
    if (action === "remove-role" && role) { config.whitelistRoles = config.whitelistRoles.filter(id => id !== role.id); saveConfig(); await interaction.reply({ ephemeral: true, content: `Removed <@&${role.id}> from the whitelist.` }); return true; }
    await interaction.reply({ ephemeral: true, content: "Provide the matching user/role for that action." });
    return true;
  }

  if (name === "restore") {
    const type = interaction.options.getString("type");
    const wanted = interaction.options.getString("name").toLowerCase();
    const snap = snapshots[guild.id] || { channels: {}, roles: {} };
    if (type === "channel") {
      const match = Object.values(snap.channels).find(c => c.name.toLowerCase() === wanted);
      if (!match) { await interaction.reply({ ephemeral: true, content: `No snapshot of a channel named "${wanted}".` }); return true; }
      try { const created = await restoreChannel(guild, match); await interaction.reply({ ephemeral: true, content: `Restored channel as <#${created.id}>.` }); }
      catch (e) { await interaction.reply({ ephemeral: true, content: `Failed: ${e.message}` }); }
      return true;
    }
    const match = Object.values(snap.roles).find(r => r.name.toLowerCase() === wanted);
    if (!match) { await interaction.reply({ ephemeral: true, content: `No snapshot of a role named "${wanted}".` }); return true; }
    try { await restoreRole(guild, match); await interaction.reply({ ephemeral: true, content: `Restored role "${match.name}".` }); }
    catch (e) { await interaction.reply({ ephemeral: true, content: `Failed: ${e.message}` }); }
    return true;
  }

  if (name === "antinuke") {
    const action = interaction.options.getString("action");
    const r = (msg) => interaction.reply({ ephemeral: true, content: msg });
    if (action === "view") {
      await interaction.reply({ ephemeral: true, embeds: [embed("Anti-Nuke Settings", 0x30a0ff, [
        `**Enabled:** ${config.antiNuke}`, `**Ban lock (only /ban):** ${config.lockBans}`, `**Punishment:** \`${config.punishment}\``,
        `**Threshold:** ${config.massThreshold} / ${config.massWindowMs / 1000}s`,
        `**Join-raid:** ${config.joinRaid.enabled} (kick accounts < ${config.joinRaid.minAccountAgeDays}d during surge)`,
        `**Protected channels:** ${config.protectedChannels.map(id => `<#${id}>`).join(", ") || "none"}`,
        `**Protected roles:** ${config.protectedRoles.map(id => `<@&${id}>`).join(", ") || "none"}`
      ])] });
      return true;
    }
    if (action === "enable") { config.antiNuke = true; saveConfig(); return (await r("Anti-nuke enabled."), true); }
    if (action === "disable") { config.antiNuke = false; saveConfig(); return (await r("Anti-nuke disabled."), true); }
    if (action === "set-punishment") {
      const p = interaction.options.getString("punishment");
      if (!p) return (await r("Pick a punishment value."), true);
      config.punishment = p; saveConfig(); return (await r(`Punishment set to \`${p}\`.`), true);
    }
    if (action === "set-threshold") {
      const t = interaction.options.getInteger("threshold");
      if (!t) return (await r("Provide a threshold (2–20)."), true);
      config.massThreshold = t; saveConfig(); return (await r(`Raid threshold set to ${t} actions / ${config.massWindowMs / 1000}s.`), true);
    }
    if (action === "join-raid-on") { config.joinRaid.enabled = true; saveConfig(); return (await r("Join-raid guard enabled."), true); }
    if (action === "join-raid-off") { config.joinRaid.enabled = false; saveConfig(); return (await r("Join-raid guard disabled."), true); }
    if (action === "ban-lock-on") { config.lockBans = true; saveConfig(); return (await r("Ban lock **ON** — only the bot's `/ban` works; manual Discord bans are auto-reversed."), true); }
    if (action === "ban-lock-off") { config.lockBans = false; saveConfig(); return (await r("Ban lock **OFF** — manual Discord bans are allowed again."), true); }
    if (action === "protect-channel") { const c = interaction.options.getChannel("channel"); if (!c) return (await r("Pick a channel."), true); if (!config.protectedChannels.includes(c.id)) config.protectedChannels.push(c.id); saveConfig(); return (await r(`Protected <#${c.id}> — deleting it now triggers an instant raid response.`), true); }
    if (action === "unprotect-channel") { const c = interaction.options.getChannel("channel"); if (!c) return (await r("Pick a channel."), true); config.protectedChannels = config.protectedChannels.filter(id => id !== c.id); saveConfig(); return (await r(`Unprotected <#${c.id}>.`), true); }
    if (action === "protect-role") { const ro = interaction.options.getRole("role"); if (!ro) return (await r("Pick a role."), true); if (!config.protectedRoles.includes(ro.id)) config.protectedRoles.push(ro.id); saveConfig(); return (await r(`Protected <@&${ro.id}>.`), true); }
    if (action === "unprotect-role") { const ro = interaction.options.getRole("role"); if (!ro) return (await r("Pick a role."), true); config.protectedRoles = config.protectedRoles.filter(id => id !== ro.id); saveConfig(); return (await r(`Unprotected <@&${ro.id}>.`), true); }
    await r("Unknown action."); return true;
  }

  return false;
}

// ── Web dashboard API ─────────────────────────────────────────────────────────
const ID_LIST = v => Array.isArray(v) && v.every(x => /^\d{5,25}$/.test(String(x)));
const CONFIG_RULES = {
  whitelistUsers:    ID_LIST,
  whitelistRoles:    ID_LIST,
  protectedChannels: ID_LIST,
  protectedRoles:    ID_LIST,
  punishment:    v => ["log", "strip", "quarantine", "kick", "ban"].includes(v),
  antiNuke:      v => typeof v === "boolean",
  lockBans:      v => typeof v === "boolean",
  massThreshold: v => Number.isInteger(v) && v >= 2 && v <= 20,
  massWindowMs:  v => Number.isInteger(v) && v >= 3_000 && v <= 120_000,
};
const JOINRAID_RULES = {
  enabled:           v => typeof v === "boolean",
  windowMs:          v => Number.isInteger(v) && v >= 5_000 && v <= 120_000,
  threshold:         v => Number.isInteger(v) && v >= 2 && v <= 50,
  minAccountAgeDays: v => Number.isInteger(v) && v >= 0 && v <= 30,
  raiseVerification: v => typeof v === "boolean",
};

function webGetSecurity(guild) {
  const snap = guild ? (snapshots[guild.id] || { channels: {}, roles: {} }) : { channels: {}, roles: {} };
  return {
    config: JSON.parse(JSON.stringify(config)),
    logChannelId,
    snapshot: { channels: Object.keys(snap.channels).length, roles: Object.keys(snap.roles).length },
  };
}

function webUpdateSecurityConfig(patch) {
  const applied = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "joinRaid" && v && typeof v === "object") {
      for (const [jk, jv] of Object.entries(v)) {
        if (!(jk in JOINRAID_RULES)) continue;
        if (!JOINRAID_RULES[jk](jv)) return { error: `Invalid value for joinRaid.${jk}` };
        config.joinRaid[jk] = jv; applied.push(`joinRaid.${jk}`);
      }
      continue;
    }
    if (!(k in CONFIG_RULES)) continue;
    if (!CONFIG_RULES[k](v)) return { error: `Invalid value for ${k}` };
    config[k] = v; applied.push(k);
  }
  if (!applied.length) return { error: "Nothing valid to update" };
  saveConfig();
  pushActivity("security", `Security config updated via dashboard: ${applied.join(", ")}`);
  return { config: JSON.parse(JSON.stringify(config)) };
}

async function webSetLockdown(guild, on) {
  if (!guild) return { error: "Bot is not in a guild yet" };
  const count = await setLockdown(guild, on, "dashboard");
  return { lockdown: on, channelsAffected: count };
}

function webResnapshot(guild) {
  if (!guild) return { error: "Bot is not in a guild yet" };
  snapshotGuild(guild);
  const snap = snapshots[guild.id];
  pushActivity("security", "Snapshot refreshed via dashboard");
  return { channels: Object.keys(snap.channels).length, roles: Object.keys(snap.roles).length };
}

// ── Init ─────────────────────────────────────────────────────────────────────
function initSecurity(discordClient, options = {}) {
  client = discordClient;
  logChannelId = options.logChannelId || null;
  ownerId = options.ownerId || null;

  loadState();
  client.guilds.cache.forEach(g => snapshotGuild(g));

  const safe = fn => (...a) => fn(...a).catch(e => console.error(`[security] ${fn.name}:`, e.message));
  client.on("channelDelete", safe(onChannelDelete));
  client.on("roleDelete", safe(onRoleDelete));
  client.on("channelCreate", safe(onChannelCreate));
  client.on("roleCreate", safe(onRoleCreate));
  client.on("channelUpdate", safe(onChannelUpdate));
  client.on("roleUpdate", safe(onRoleUpdate));
  client.on("guildMemberUpdate", safe(onMemberUpdate));
  client.on("guildBanAdd", safe(onBanAdd));
  client.on("guildMemberRemove", safe(onMemberRemove));
  client.on("webhooksUpdate", safe(onWebhooksUpdate));
  client.on("guildMemberAdd", safe(onMemberAdd));
  client.on("guildUpdate", safe(onGuildUpdate));

  // keep snapshots fresh
  setInterval(() => {
    try { client.guilds.cache.forEach(g => snapshotGuild(g)); }
    catch (e) { console.error("[security] periodic snapshot:", e.message); }
  }, 30 * 60 * 1000);

  console.log(`[security] Anti-nuke active (punishment=${config.punishment}, threshold=${config.massThreshold}/${config.massWindowMs / 1000}s).`);
}

module.exports = {
  initSecurity, handleSecurityCommand, SECURITY_COMMANDS,
  webGetSecurity, webUpdateSecurityConfig, webSetLockdown, webResnapshot,
};
