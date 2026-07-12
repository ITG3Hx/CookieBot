"use strict";

/**
 * CookieBot - Web control panel (server side).
 *
 * Mounts a password-protected dashboard onto the bot's existing express app:
 *   - static UI:  GET /dashboard          (files in ./web)
 *   - auth:       POST /dash/login  /dash/logout
 *   - API:        /api/*  (session cookie required on everything)
 *
 * Auth model: one owner password, set with the DASHBOARD_PASSWORD env var.
 * If the env var is missing a random password is generated at boot and printed
 * to the console, so the panel is never reachable without a secret. Sessions
 * are random tokens in an httpOnly SameSite=Strict cookie, kept in memory
 * (a restart logs you out, nothing more).
 *
 * Wire into index.js:
 *   mountDashboard(app, client, { guildId, ownerId })   before the routes 404
 *   applyStoredPresence(client)                         once on ready
 */

const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { EmbedBuilder, ActivityType, ChannelType } = require("discord.js");

const { pushActivity, listActivity } = require("./activity");
const tickets    = require("./tickets");
const moderation = require("./moderation");
const security   = require("./security");
const giveaway   = require("./giveaway");
const testers    = require("./testers");
const automation = require("./automation");
const applications = require("./applications");
const leveling = require("./leveling");
const customcommands = require("./customcommands");
const timers = require("./timers");
const starboard = require("./starboard");

// ── Config ────────────────────────────────────────────────────────────────────
const COOKIE_NAME   = "cb_dash";
const SESSION_TTL   = 7 * 86_400_000;   // 7 days
const DATA_DIR      = path.join(__dirname, "data");
const PANEL_FILE    = path.join(DATA_DIR, "dashboard.json");

let PASSWORD = process.env.DASHBOARD_PASSWORD || "";
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(9).toString("base64url");
  console.warn("[dashboard] DASHBOARD_PASSWORD is not set.");
  console.warn(`[dashboard] Temporary password for this run: ${PASSWORD}`);
  console.warn("[dashboard] Set DASHBOARD_PASSWORD in your env to make it permanent.");
}

let client  = null;
let guildId = null;

const sessions = new Map();             // token -> expiry ts
let panelState = { presence: null };    // presence: { status, activityType, activityText }

// ── Persistence (bot presence chosen in the panel survives restarts) ──────────
function loadPanelState() {
  try { if (fs.existsSync(PANEL_FILE)) panelState = { presence: null, ...JSON.parse(fs.readFileSync(PANEL_FILE, "utf8")) }; }
  catch (e) { panelState = { presence: null }; }
}
function savePanelState() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PANEL_FILE, JSON.stringify(panelState, null, 2)); }
  catch (e) { console.error("[dashboard] save:", e.message); }
}

// ── Session helpers ───────────────────────────────────────────────────────────
function sha(s) { return crypto.createHash("sha256").update(String(s)).digest(); }
function passwordMatches(given) {
  try { return crypto.timingSafeEqual(sha(given), sha(PASSWORD)); } catch (e) { return false; }
}
function createSession() {
  const token = crypto.randomBytes(24).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
function readCookie(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=");
  }
  return null;
}
function sessionValid(req) {
  const token = readCookie(req);
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}
function setCookie(res, req, token, maxAgeMs) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const bits = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}
setInterval(() => { const now = Date.now(); for (const [t, exp] of sessions) if (now > exp) sessions.delete(t); }, 3_600_000).unref();

// ── Guild / client helpers ────────────────────────────────────────────────────
function getGuild() {
  if (!client?.isReady()) return null;
  return (guildId && client.guilds.cache.get(guildId)) || client.guilds.cache.first() || null;
}
function requireAuth(req, res, next) {
  if (!sessionValid(req)) return res.status(401).json({ ok: false, error: "not logged in" });
  next();
}
function requireReady(req, res, next) {
  if (!client?.isReady()) return res.status(503).json({ ok: false, error: "bot is not connected to Discord" });
  next();
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error("[dashboard]", req.method, req.path, err.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
});
// module results look like { error } or payload; turn them into a response
function send(res, result, okPayload) {
  if (result && result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, ...(okPayload || result || {}) });
}

// ── Presence ──────────────────────────────────────────────────────────────────
const ACTIVITY_TYPES = { playing: ActivityType.Playing, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing, custom: ActivityType.Custom };
function applyStoredPresence(discordClient) {
  const p = panelState.presence;
  if (!p || !discordClient?.isReady()) return;
  try {
    discordClient.user.setPresence({
      status: p.status || "online",
      activities: p.activityText ? [{ name: p.activityText, type: ACTIVITY_TYPES[p.activityType] ?? ActivityType.Playing }] : [],
    });
  } catch (e) { console.error("[dashboard] presence:", e.message); }
}

// ── Mount ─────────────────────────────────────────────────────────────────────
function mountDashboard(app, discordClient, options = {}) {
  client = discordClient;
  guildId = options.guildId || null;
  loadPanelState();

  // static UI (login handling lives in the page itself)
  app.use("/dashboard", express.static(path.join(__dirname, "web")));
  app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "web", "index.html")));

  // ── auth ──
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "too many attempts, wait 15 minutes" } });
  app.post("/dash/login", loginLimiter, (req, res) => {
    const given = String(req.body?.password || "");
    if (!given || !passwordMatches(given)) {
      pushActivity("dashboard", "Failed dashboard login attempt");
      return res.status(401).json({ ok: false, error: "wrong password" });
    }
    const token = createSession();
    setCookie(res, req, token, SESSION_TTL);
    pushActivity("dashboard", "Dashboard login");
    return res.json({ ok: true });
  });
  app.post("/dash/logout", (req, res) => {
    const token = readCookie(req);
    if (token) sessions.delete(token);
    setCookie(res, req, "gone", 0);
    return res.json({ ok: true });
  });

  // ── API ──
  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
  api.use(requireAuth);

  api.get("/me", (req, res) => res.json({ ok: true, loggedIn: true }));

  api.get("/overview", wrap(async (req, res) => {
    const guild = getGuild();
    const t = tickets.webGetTickets();
    const gws = giveaway.webListGiveaways();
    const sec = security.webGetSecurity(guild);
    res.json({
      ok: true,
      bot: client?.isReady() ? {
        ready: true, tag: client.user.tag, id: client.user.id,
        avatar: client.user.displayAvatarURL({ size: 128 }),
        uptimeMs: client.uptime, wsPing: Math.round(client.ws.ping),
      } : { ready: false },
      guild: guild ? {
        id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }),
        members: guild.memberCount, channels: guild.channels.cache.size,
        roles: guild.roles.cache.size, boosts: guild.premiumSubscriptionCount || 0,
      } : null,
      counts: {
        openTickets: t.open.length,
        activeGiveaways: gws.active.length,
        infractions: moderation.webListInfractions().length,
        linkedTesters: testers.webListTesters().filter(x => x.verified).length,
      },
      security: { antiNuke: sec.config.antiNuke, lockdown: sec.config.lockdown, lockBans: sec.config.lockBans, punishment: sec.config.punishment },
      process: { node: process.version, memMB: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(process.uptime()) },
      activity: listActivity(40),
    });
  }));

  api.get("/activity", (req, res) => res.json({ ok: true, activity: listActivity(120) }));

  // ── guild data ──
  api.get("/guild/channels", requireReady, wrap(async (req, res) => {
    const guild = getGuild();
    if (!guild) return res.status(503).json({ ok: false, error: "no guild" });
    const list = [...guild.channels.cache.values()]
      .filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildForum].includes(c.type))
      .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, position: c.rawPosition ?? 0 }))
      .sort((a, b) => a.position - b.position);
    res.json({ ok: true, channels: list });
  }));

  api.get("/guild/roles", requireReady, wrap(async (req, res) => {
    const guild = getGuild();
    if (!guild) return res.status(503).json({ ok: false, error: "no guild" });
    const list = [...guild.roles.cache.values()]
      .filter(r => r.id !== guild.id)
      .map(r => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null, managed: r.managed, position: r.position }))
      .sort((a, b) => b.position - a.position);
    res.json({ ok: true, roles: list });
  }));

  api.get("/guild/members/search", requireReady, wrap(async (req, res) => {
    const guild = getGuild();
    if (!guild) return res.status(503).json({ ok: false, error: "no guild" });
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, members: [] });
    const found = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
    const members = found ? [...found.values()].map(m => ({
      id: m.id, tag: m.user.tag, displayName: m.displayName, avatar: m.user.displayAvatarURL({ size: 64 }), bot: m.user.bot,
    })) : [];
    res.json({ ok: true, members });
  }));

  api.get("/users/:id", requireReady, wrap(async (req, res) => {
    if (!/^\d{5,25}$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "bad id" });
    const user = await client.users.fetch(req.params.id).catch(() => null);
    if (!user) return res.status(404).json({ ok: false, error: "unknown user" });
    res.json({ ok: true, user: { id: user.id, tag: user.tag, avatar: user.displayAvatarURL({ size: 64 }), bot: user.bot } });
  }));

  // ── moderation ──
  api.get("/moderation", (req, res) => res.json({ ok: true, infractions: moderation.webListInfractions().slice(0, 300) }));
  api.post("/moderation/action", requireReady, wrap(async (req, res) => {
    const result = await moderation.webModAction(getGuild(), req.body || {});
    send(res, result);
  }));
  api.delete("/moderation/:id", wrap(async (req, res) => send(res, moderation.webDeleteInfraction(req.params.id))));

  // ── security ──
  api.get("/security", (req, res) => res.json({ ok: true, ...security.webGetSecurity(getGuild()) }));
  api.put("/security/config", wrap(async (req, res) => send(res, security.webUpdateSecurityConfig(req.body || {}))));
  api.post("/security/lockdown", requireReady, wrap(async (req, res) => {
    const result = await security.webSetLockdown(getGuild(), !!req.body?.on);
    send(res, result);
  }));
  api.post("/security/resnapshot", requireReady, wrap(async (req, res) => send(res, security.webResnapshot(getGuild()))));

  // ── giveaways ──
  api.get("/giveaways", (req, res) => res.json({ ok: true, ...giveaway.webListGiveaways() }));
  api.post("/giveaways", requireReady, wrap(async (req, res) => send(res, await giveaway.webStartGiveaway(req.body || {}))));
  api.post("/giveaways/:messageId/end", requireReady, wrap(async (req, res) => send(res, await giveaway.webEndGiveaway(req.params.messageId))));
  api.post("/giveaways/:messageId/reroll", requireReady, wrap(async (req, res) => send(res, await giveaway.webRerollGiveaway(req.params.messageId, req.body?.winners))));

  // ── testers ──
  api.get("/testers", (req, res) => res.json({ ok: true, testers: testers.webListTesters() }));
  api.delete("/testers/:code", wrap(async (req, res) => {
    const result = testers.webUnlinkTester(req.params.code);
    if (!result.error) pushActivity("testers", `Unlinked ${result.removed.mcName || result.removed.code} via dashboard`);
    send(res, result, result.error ? null : { ok: true });
  }));

  // ── tickets ──
  api.get("/tickets", (req, res) => res.json({ ok: true, ...tickets.webGetTickets() }));
  api.put("/tickets/settings", wrap(async (req, res) => send(res, tickets.webUpdateTicketSettings(req.body || {}))));
  api.post("/tickets/panel", requireReady, wrap(async (req, res) => send(res, await tickets.webPostPanel(String(req.body?.channelId || "")))));
  api.get("/tickets/:channelId/messages", requireReady, wrap(async (req, res) => send(res, await tickets.webFetchMessages(req.params.channelId, 100))));
  api.post("/tickets/:channelId/reply", requireReady, wrap(async (req, res) => send(res, await tickets.webReply(req.params.channelId, req.body?.content))));
  api.post("/tickets/:channelId/close", requireReady, wrap(async (req, res) => send(res, await tickets.webCloseTicket(req.params.channelId, String(req.body?.reason || "")))));
  api.post("/tickets/:channelId/claim", requireReady, wrap(async (req, res) => send(res, await tickets.webClaimTicket(req.params.channelId))));
  api.post("/tickets/:channelId/unclaim", requireReady, wrap(async (req, res) => send(res, await tickets.webUnclaimTicket(req.params.channelId))));
  api.get("/transcripts/:id", wrap(async (req, res) => {
    const n = parseInt(req.params.id, 10);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ ok: false, error: "bad ticket number" });
    send(res, tickets.webGetTranscript(n));
  }));

  // ── automation (autorole, welcome/goodbye, reaction roles, auto-responder) ──
  api.get("/automation", (req, res) => res.json({ ok: true, ...automation.webGetAutomation() }));
  api.put("/automation", wrap(async (req, res) => send(res, automation.webUpdateAutomation(req.body || {}))));
  api.post("/automation/reaction-roles/post", requireReady, wrap(async (req, res) => send(res, await automation.webPostReactionRoles(String(req.body?.channelId || "")))));
  api.post("/automation/autorole/apply-all", requireReady, wrap(async (req, res) => send(res, await automation.webApplyAutoroleToAll(getGuild()))));
  api.post("/automation/welcome/test", requireReady, wrap(async (req, res) => send(res, await automation.webWelcomeTest(getGuild()))));

  // ── staff applications config (positions -> roles, reviewer password, open/closed) ──
  api.get("/applications/config", (req, res) => res.json({ ok: true, ...applications.webGetAppConfig() }));
  api.put("/applications/config", wrap(async (req, res) => send(res, applications.webUpdateAppConfig(req.body || {}))));
  api.post("/applications/reviewer-password", wrap(async (req, res) => send(res, applications.webSetReviewerPassword(String(req.body?.password || "")))));
  api.get("/applications/stats", (req, res) => res.json({ ok: true, ...applications.webAppStats() }));

  // ── one-time reviewer codes (an alternative to the shared reviewer password) ──
  api.get("/applications/reviewer-codes", (req, res) => res.json({ ok: true, codes: applications.webListReviewerCodes() }));
  api.post("/applications/reviewer-codes", wrap(async (req, res) => send(res, applications.webCreateReviewerCode(req.body?.label))));
  api.delete("/applications/reviewer-codes/:code", wrap(async (req, res) => send(res, applications.webDeleteReviewerCode(req.params.code))));

  // ── send a message / announcement as the bot ──
  api.post("/message", requireReady, wrap(async (req, res) => {
    const { channelId, content, embedTitle, embedText, embedColor } = req.body || {};
    const channel = await client.channels.fetch(String(channelId || "")).catch(() => null);
    if (!channel || !channel.isTextBased()) return res.status(400).json({ ok: false, error: "channel not found or not a text channel" });
    const payload = {};
    const text = String(content || "").trim().slice(0, 1900);
    if (text) payload.content = text;
    if (embedTitle || embedText) {
      let color = 0xff8c00;
      if (typeof embedColor === "string" && /^#?[0-9a-f]{6}$/i.test(embedColor)) color = parseInt(embedColor.replace("#", ""), 16);
      const e = new EmbedBuilder().setColor(color);
      if (embedTitle) e.setTitle(String(embedTitle).slice(0, 256));
      if (embedText) e.setDescription(String(embedText).slice(0, 4000));
      payload.embeds = [e];
    }
    if (!payload.content && !payload.embeds) return res.status(400).json({ ok: false, error: "message is empty" });
    try { await channel.send(payload); }
    catch (e) { return res.status(400).json({ ok: false, error: `send failed: ${e.message}` }); }
    pushActivity("message", `Sent a message to #${channel.name} via dashboard`);
    res.json({ ok: true });
  }));

  // ── leveling ──
  api.get("/leveling", (req, res) => res.json({ ok: true, ...leveling.webGetLeveling() }));
  api.put("/leveling", wrap(async (req, res) => {
    const result = leveling.webUpdateLevelingConfig(req.body || {});
    if (!result.error) pushActivity("leveling", "Leveling settings updated via dashboard");
    send(res, result);
  }));
  api.get("/leveling/leaderboard", (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ ok: true, leaderboard: leveling.webLeaderboard(limit) });
  });
  api.post("/leveling/givexp", wrap(async (req, res) => {
    const result = leveling.webGiveXp(String(req.body?.userId || ""), req.body?.amount);
    if (!result.error) pushActivity("leveling", `Gave ${req.body?.amount} XP via dashboard`);
    send(res, result);
  }));
  api.delete("/leveling/users/:id", wrap(async (req, res) => {
    const result = leveling.webResetUser(req.params.id);
    if (!result.error) pushActivity("leveling", "Reset a member's XP via dashboard");
    send(res, result);
  }));
  api.post("/leveling/reset-all", wrap(async (req, res) => {
    const result = leveling.webResetAll();
    pushActivity("leveling", `Full XP reset via dashboard (${result.removed} members)`);
    send(res, result);
  }));

  // ── custom commands ──
  api.get("/customcommands", (req, res) => res.json({ ok: true, ...customcommands.webGetCustomCommands() }));
  api.put("/customcommands", wrap(async (req, res) => {
    const result = customcommands.webUpdateCustomCommands(req.body || {});
    if (!result.error) pushActivity("commands", "Custom commands updated via dashboard");
    send(res, result);
  }));

  // ── timed messages ──
  api.get("/timers", (req, res) => res.json({ ok: true, ...timers.webGetTimers() }));
  api.put("/timers", wrap(async (req, res) => {
    const result = timers.webUpdateTimers(req.body || {});
    if (!result.error) pushActivity("timers", "Timed messages updated via dashboard");
    send(res, result);
  }));
  api.post("/timers/:id/run", requireReady, wrap(async (req, res) => send(res, await timers.webRunTimer(req.params.id))));

  // ── starboard ──
  api.get("/starboard", (req, res) => res.json({ ok: true, ...starboard.webGetStarboard() }));
  api.put("/starboard", wrap(async (req, res) => {
    const result = starboard.webUpdateStarboard(req.body || {});
    if (!result.error) pushActivity("starboard", "Starboard settings updated via dashboard");
    send(res, result);
  }));

  // ── bot presence ──
  api.get("/presence", (req, res) => res.json({ ok: true, presence: panelState.presence }));
  api.put("/presence", requireReady, wrap(async (req, res) => {
    const { status, activityType, activityText } = req.body || {};
    if (!["online", "idle", "dnd", "invisible"].includes(status)) return res.status(400).json({ ok: false, error: "bad status" });
    if (activityText && String(activityText).length > 128) return res.status(400).json({ ok: false, error: "activity text too long" });
    if (activityText && !(activityType in ACTIVITY_TYPES)) return res.status(400).json({ ok: false, error: "bad activity type" });
    panelState.presence = { status, activityType: activityType || "playing", activityText: String(activityText || "").trim() };
    savePanelState();
    applyStoredPresence(client);
    pushActivity("dashboard", `Bot presence set: ${status}${panelState.presence.activityText ? `, ${panelState.presence.activityType} ${panelState.presence.activityText}` : ""}`);
    res.json({ ok: true, presence: panelState.presence });
  }));

  app.use("/api", api);

  // ── public leaderboard (no login), only when turned on in the panel ──
  app.get("/levels.json", (req, res) => {
    if (!leveling.webPublicEnabled()) return res.status(404).json({ ok: false, error: "not enabled" });
    const guild = getGuild();
    res.json({
      ok: true,
      server: guild ? { name: guild.name, icon: guild.iconURL({ size: 128 }) } : null,
      leaderboard: leveling.webLeaderboard(50).map(u => ({
        rank: u.rank, tag: (u.tag || "member").replace(/#0$/, ""), avatar: u.avatar,
        level: u.level, xp: u.xp, into: u.into, need: u.need,
      })),
    });
  });
  app.get("/levels", (req, res) => {
    if (!leveling.webPublicEnabled()) return res.status(404).send("Leaderboard is not public.");
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leaderboard</title>
<style>
body{background:#0e0b09;color:#f2ede7;font:15px/1.6 -apple-system,"Segoe UI",sans-serif;margin:0;padding:36px 16px}
.wrap{max-width:640px;margin:0 auto}
.head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.head img{width:52px;height:52px;border-radius:14px}
h1{font-size:20px;margin:0}
p.sub{color:#9a8f83;font-size:13px;margin:2px 0 0}
.row{display:flex;align-items:center;gap:12px;background:#171310;border:1px solid #2a231d;border-radius:12px;padding:11px 14px;margin-bottom:8px}
.rank{width:34px;text-align:center;font-weight:700;color:#9a8f83}
.row:nth-child(1) .rank{color:#ffd700}.row:nth-child(2) .rank{color:#c0c0c0}.row:nth-child(3) .rank{color:#cd7f32}
.row img{width:36px;height:36px;border-radius:99px;background:#2a231d}
.who{flex:1;min-width:0}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{height:6px;background:#2a231d;border-radius:99px;margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;background:#ff8c00;border-radius:99px}
.lv{text-align:right;font-size:12.5px;color:#9a8f83;min-width:86px}
.lv b{display:block;color:#f2ede7;font-size:14px}
.empty{color:#9a8f83;text-align:center;padding:40px 0}
</style></head><body><div class="wrap">
<div class="head" id="head"><div><h1>Leaderboard</h1><p class="sub">Most active members, updated live.</p></div></div>
<div id="list"><p class="empty">Loading...</p></div>
</div><script>
async function load(){
  try{
    const r=await fetch("/levels.json");const d=await r.json();
    if(d.server){document.getElementById("head").innerHTML=(d.server.icon?'<img src="'+d.server.icon+'" alt="">':'')+'<div><h1>'+d.server.name.replace(/[<>&]/g,"")+' leaderboard</h1><p class="sub">Most active members, updated live.</p></div>';}
    const list=document.getElementById("list");
    if(!d.leaderboard.length){list.innerHTML='<p class="empty">Nobody has XP yet.</p>';return}
    list.innerHTML=d.leaderboard.map(function(u){
      var pct=Math.round(u.into/u.need*100);
      return '<div class="row"><div class="rank">#'+u.rank+'</div>'+(u.avatar?'<img src="'+u.avatar+'" alt="">':'<img alt="">')+'<div class="who"><div class="name">'+u.tag.replace(/[<>&]/g,"")+'</div><div class="bar"><i style="width:'+pct+'%"></i></div></div><div class="lv"><b>Level '+u.level+'</b>'+u.xp.toLocaleString()+' XP</div></div>';
    }).join("");
  }catch(e){}
}
load();setInterval(load,60000);
</script></body></html>`);
  });

  console.log("[dashboard] Control panel mounted at /dashboard");
}

module.exports = { mountDashboard, applyStoredPresence };
