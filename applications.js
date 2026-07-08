"use strict";

/**
 * CookieBot, Staff applications.
 *
 * A self-contained applications site + moderator review panel, served by the bot
 * so it can DM applicants and assign Discord roles on accept.
 *
 *   Public site (no login):
 *     GET  /apply                 the application form
 *     GET  /apply/status          check an application by its reference code
 *     GET  /apply/api/config      open/closed + positions (no secrets)
 *     POST /apply/api/submit      submit an application (rate limited + honeypot)
 *     GET  /apply/api/status?ref  look up one application's status
 *
 *   Moderator review panel (its own login, separate from the owner dashboard):
 *     GET  /apply/review          the panel UI
 *     POST /apply/review/login    { password, name }
 *     POST /apply/review/logout
 *     GET  /apply/api/applications           list (reviewer session)
 *     GET  /apply/api/applications/:id        one application
 *     POST /apply/api/applications/:id/decide { action, note, reviewer }
 *     DELETE /apply/api/applications/:id
 *
 *   Owner config (called from dashboard.js under the owner session):
 *     webGetAppConfig / webUpdateAppConfig / webSetReviewerPassword / webAppStats
 *
 * Wire into index.js:
 *   initApplications(client, { guildId })
 *   mountApplications(app, client, { guildId })   before the routes 404
 */

const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const express   = require("express");
const rateLimit = require("express-rate-limit");
const { pushActivity } = require("./activity");

// ── Persistence ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const FILE     = path.join(DATA_DIR, "applications.json");
const WEB_DIR  = path.join(__dirname, "apply-web");

const RV_COOKIE   = "cb_apply";
const SESSION_TTL = 7 * 86_400_000;   // 7 days

const DEFAULT_POSITIONS = [
  { id: "administrator",     name: "Administrator",     roleId: null, enabled: true,  description: "Help lead the server and the staff team. The highest level of trust." },
  { id: "department-leader", name: "Department Leader", roleId: null, enabled: true,  description: "Run a department (moderation, media, events) and guide its team." },
  { id: "helper",            name: "Helper",            roleId: null, enabled: true,  description: "Front-line support: answer questions and keep chat friendly and safe." },
  { id: "partner",           name: "Partner",           roleId: null, enabled: true,  description: "Represent your own community or channel as a Cookie SMP partner." },
];

const DEFAULT_CONFIG = {
  open: true,
  minAge: 13,
  cooldownHours: 24,
  serverName: "Cookie SMP",
  positions: DEFAULT_POSITIONS,
  assignRoleOnAccept: true,
  dmOnAccept: true,
  dmOnDeny: true,
  dmOnInterview: true,
  acceptDM:   "Congrats {name}! Your application for **{position}** on {server} was accepted. Welcome to the team, a staff member will help you get settled.",
  denyDM:     "Hi {name}, thanks for applying for **{position}** on {server}. We won't be moving forward this time, but you're welcome to apply again later.",
  interviewDM:"Hi {name}, your application for **{position}** on {server} looks promising. A staff member will reach out for a short chat soon.",
  reviewerPassHash: null,   // sha256 hex; null -> env APPLICATIONS_REVIEW_PASSWORD -> generated
};

let client  = null;
let guildId = null;
let state   = { config: clone(DEFAULT_CONFIG), applications: [] };
let genReviewerPass = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function ensureData() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function load() {
  ensureData();
  try {
    if (fs.existsSync(FILE)) {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
      const cfg = saved.config || {};
      state = {
        config: {
          ...DEFAULT_CONFIG,
          ...cfg,
          positions: Array.isArray(cfg.positions) && cfg.positions.length
            ? cfg.positions.map(p => ({ ...DEFAULT_POSITIONS.find(d => d.id === p.id), ...p }))
            : clone(DEFAULT_POSITIONS),
        },
        applications: Array.isArray(saved.applications) ? saved.applications : [],
      };
    }
  } catch (e) { console.error("[applications] load:", e.message); state = { config: clone(DEFAULT_CONFIG), applications: [] }; }
}
function save() {
  ensureData();
  try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[applications] save:", e.message); }
}

// ── Small helpers ────────────────────────────────────────────────────────────
const isSnow   = v => typeof v === "string" && /^\d{5,25}$/.test(v);
const clampStr = (v, n) => String(v ?? "").slice(0, n);
function sha256hex(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function newId() { return crypto.randomBytes(9).toString("base64url"); }
function newRef() {
  // human-friendly, unambiguous reference code, e.g. CS-7F3K9Q
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return `CS-${s}`;
}
function fill(tmpl, app, guild) {
  return String(tmpl || "")
    .replace(/\{name\}/g, app.minecraft || app.discord || "there")
    .replace(/\{position\}/g, app.positionName || "staff")
    .replace(/\{server\}/g, (guild && guild.name) || state.config.serverName || "the server");
}

// ── Reviewer auth (separate from the owner dashboard) ────────────────────────────
const reviewerSessions = new Map();   // token -> { exp, name }
function effectiveReviewerHash() {
  if (state.config.reviewerPassHash) return state.config.reviewerPassHash;
  if (process.env.APPLICATIONS_REVIEW_PASSWORD) return sha256hex(process.env.APPLICATIONS_REVIEW_PASSWORD);
  if (!genReviewerPass) {
    genReviewerPass = crypto.randomBytes(9).toString("base64url");
    console.warn("[applications] No reviewer password set.");
    console.warn(`[applications] Temporary reviewer password for this run: ${genReviewerPass}`);
    console.warn("[applications] Set one in the dashboard (Applications tab) or APPLICATIONS_REVIEW_PASSWORD.");
  }
  return sha256hex(genReviewerPass);
}
function reviewerPasswordMatches(given) {
  try { return crypto.timingSafeEqual(Buffer.from(sha256hex(given), "hex"), Buffer.from(effectiveReviewerHash(), "hex")); }
  catch (e) { return false; }
}
function createReviewerSession(name) {
  const token = crypto.randomBytes(24).toString("base64url");
  reviewerSessions.set(token, { exp: Date.now() + SESSION_TTL, name: clampStr(name, 60) || "reviewer" });
  return token;
}
function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
function reviewerFromReq(req) {
  const token = readCookie(req, RV_COOKIE);
  if (!token) return null;
  const s = reviewerSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { reviewerSessions.delete(token); return null; }
  return { token, name: s.name };
}
function setReviewerCookie(res, req, token, maxAgeMs) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const bits = [`${RV_COOKIE}=${token}`, "Path=/apply", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}
setInterval(() => { const now = Date.now(); for (const [t, s] of reviewerSessions) if (now > s.exp) reviewerSessions.delete(t); }, 3_600_000).unref();

// ── Guild helper ─────────────────────────────────────────────────────────────
function getGuild() {
  if (!client?.isReady()) return null;
  return (guildId && client.guilds.cache.get(guildId)) || client.guilds.cache.first() || null;
}

// ── Public: config + submit + status ─────────────────────────────────────────
function publicConfig() {
  return {
    open: !!state.config.open,
    minAge: state.config.minAge,
    serverName: state.config.serverName,
    positions: state.config.positions
      .filter(p => p.enabled)
      .map(p => ({ id: p.id, name: p.name, description: p.description })),
  };
}

// The "you already applied" cooldown keys on the Discord username only. IP is
// deliberately not used here so housemates / mobile (shared-IP) applicants aren't
// locked out, rapid spam is handled separately by the per-IP rate limiter.
function recentFor(discordLc) {
  const windowMs = Math.max(0, state.config.cooldownHours) * 3_600_000;
  if (!windowMs || !discordLc) return null;
  const cutoff = Date.now() - windowMs;
  return state.applications.find(a =>
    a.createdAt > cutoff && String(a.discord || "").toLowerCase() === discordLc
  ) || null;
}

function webSubmit(body, ip) {
  body = body || {};
  if (!state.config.open) return { error: "Applications are currently closed. Check back later!" };
  if (body.website) return { ok: true, ref: "ignored" };   // honeypot: pretend success, drop bot

  const pos = state.config.positions.find(p => p.enabled && p.id === body.position);
  if (!pos) return { error: "Pick a position to apply for." };

  const discord   = clampStr(body.discord, 60).trim();
  const discordId = isSnow(body.discordId) ? body.discordId : null;
  const minecraft = clampStr(body.minecraft, 32).trim();
  const age       = parseInt(body.age, 10);
  const timezone  = clampStr(body.timezone, 80).trim();
  const hours     = clampStr(body.hours, 40).trim();
  const experience= clampStr(body.experience, 1500).trim();
  const why       = clampStr(body.why, 3000).trim();
  const scenario  = clampStr(body.scenario, 3000).trim();
  const extraQ    = clampStr(body.extra, 3000).trim();

  if (!discord)   return { error: "Your Discord username is required." };
  if (!minecraft) return { error: "Your Minecraft username is required." };
  if (!Number.isFinite(age) || age < state.config.minAge) return { error: `You must be at least ${state.config.minAge} to apply.` };
  if (age > 120)  return { error: "Enter a real age." };
  if (!timezone)  return { error: "Your timezone / country is required." };
  if (!hours)     return { error: "Tell us roughly how many hours per week you can give." };
  if (why.length < 20)      return { error: "Tell us a bit more about why we should pick you (at least 20 characters)." };
  if (scenario.length < 20) return { error: "Please answer the scenario question (at least 20 characters)." };

  const discordLc = discord.toLowerCase();
  const dupe = recentFor(discordLc);
  if (dupe) {
    const hrs = state.config.cooldownHours;
    return { error: `You already applied recently. You can apply again ${hrs >= 24 ? `after ${Math.round(hrs / 24)} day(s)` : `in a few hours`}.` };
  }

  const app = {
    id: newId(),
    ref: newRef(),
    positionId: pos.id,
    positionName: pos.name,
    discord, discordId, minecraft, age, timezone, hours, experience, why, scenario,
    extra: extraQ,
    status: "pending",
    reviewerNote: "",
    decidedBy: "",
    createdAt: Date.now(),
    decidedAt: null,
    ip: ip || null,
  };
  state.applications.unshift(app);
  if (state.applications.length > 2000) state.applications.length = 2000;   // safety cap
  save();
  pushActivity("applications", `New ${pos.name} application from ${discord} (${app.ref})`);
  return { ok: true, ref: app.ref };
}

function webStatus(ref) {
  const r = String(ref || "").trim().toUpperCase();
  const app = state.applications.find(a => a.ref.toUpperCase() === r);
  if (!app) return { error: "No application found with that code." };
  return {
    ok: true,
    application: {
      ref: app.ref,
      positionName: app.positionName,
      status: app.status,
      createdAt: app.createdAt,
      decidedAt: app.decidedAt,
    },
  };
}

// ── Reviewer: list / get / decide / delete ───────────────────────────────────
function reviewerView(app) { return clone(app); }

function webListApplications(filter) {
  let list = state.applications;
  if (filter && ["pending", "interview", "accepted", "denied"].includes(filter)) list = list.filter(a => a.status === filter);
  const counts = { all: state.applications.length, pending: 0, interview: 0, accepted: 0, denied: 0 };
  for (const a of state.applications) if (counts[a.status] != null) counts[a.status]++;
  return {
    counts,
    applications: list.map(a => ({
      id: a.id, ref: a.ref, positionName: a.positionName, discord: a.discord,
      minecraft: a.minecraft, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt, decidedBy: a.decidedBy,
    })),
  };
}
function webGetApplication(id) {
  const app = state.applications.find(a => a.id === id);
  if (!app) return { error: "Application not found." };
  return { application: reviewerView(app) };
}

async function resolveMember(guild, app) {
  if (app.discordId && isSnow(app.discordId)) {
    const m = await guild.members.fetch(app.discordId).catch(() => null);
    if (m) return m;
  }
  const q = String(app.discord || "").replace(/^@/, "").split("#")[0].trim();
  if (!q) return null;
  const found = await guild.members.fetch({ query: q, limit: 10 }).catch(() => null);
  if (!found || !found.size) return null;
  const lc = q.toLowerCase();
  const tagLc = String(app.discord || "").toLowerCase();
  const exact = [...found.values()].find(m =>
    m.user.username.toLowerCase() === lc ||
    (m.user.tag || "").toLowerCase() === tagLc ||
    (m.nickname || "").toLowerCase() === lc
  );
  return exact || (found.size === 1 ? found.first() : null);
}

async function webDecide(id, action, note, reviewerName) {
  const app = state.applications.find(a => a.id === id);
  if (!app) return { error: "Application not found." };
  const statusMap = { accept: "accepted", deny: "denied", interview: "interview", pending: "pending" };
  if (!Object.prototype.hasOwnProperty.call(statusMap, action)) return { error: "Unknown action." };

  app.status      = statusMap[action];
  app.reviewerNote= clampStr(note, 1000);
  app.decidedBy   = clampStr(reviewerName, 60) || "a reviewer";
  app.decidedAt   = action === "pending" ? null : Date.now();

  let dmSent = false, roleGiven = false, warn = null;

  if (action === "accept" || action === "deny" || action === "interview") {
    const guild = getGuild();
    if (!guild) {
      warn = "the bot is offline, so I couldn't DM them or assign a role, do that manually";
    } else {
      const member = await resolveMember(guild, app);
      if (!member) {
        warn = "couldn't find their Discord account from the username, assign roles / message them manually";
      } else {
        if (action === "accept" && state.config.assignRoleOnAccept) {
          const pos = state.config.positions.find(p => p.id === app.positionId);
          const role = pos && pos.roleId ? guild.roles.cache.get(pos.roleId) : null;
          if (!pos || !pos.roleId) warn = "no Discord role is mapped to this position (set it in the dashboard)";
          else if (!role)        warn = "the mapped role no longer exists";
          else if (!role.editable) warn = "I can't assign that role, move my role above it and give me Manage Roles";
          else { await member.roles.add(role, "Accepted staff application").then(() => { roleGiven = true; }).catch(() => { warn = "assigning the role failed"; }); }
        }
        const tmplMap  = { accept: state.config.acceptDM, deny: state.config.denyDM, interview: state.config.interviewDM };
        const flagMap  = { accept: state.config.dmOnAccept, deny: state.config.dmOnDeny, interview: state.config.dmOnInterview };
        if (flagMap[action] && tmplMap[action]) {
          await member.send(fill(tmplMap[action], app, guild)).then(() => { dmSent = true; }).catch(() => { warn = (warn ? warn + "; " : "") + "their DMs are closed, couldn't message them"; });
        }
      }
    }
  }

  save();
  pushActivity("applications", `Application ${app.status}: ${app.discord} for ${app.positionName} by ${app.decidedBy}`);
  return { application: reviewerView(app), dmSent, roleGiven, warn };
}

function webDeleteApplication(id) {
  const i = state.applications.findIndex(a => a.id === id);
  if (i < 0) return { error: "Application not found." };
  const [removed] = state.applications.splice(i, 1);
  save();
  pushActivity("applications", `Application deleted: ${removed.discord} (${removed.ref})`);
  return { ok: true };
}

// ── Owner config (from the owner dashboard) ──────────────────────────────────
function webAppStats() {
  const counts = { all: state.applications.length, pending: 0, interview: 0, accepted: 0, denied: 0 };
  for (const a of state.applications) if (counts[a.status] != null) counts[a.status]++;
  return { counts, open: !!state.config.open };
}
function webGetAppConfig() {
  const c = state.config;
  return {
    config: {
      open: !!c.open, minAge: c.minAge, cooldownHours: c.cooldownHours, serverName: c.serverName,
      assignRoleOnAccept: !!c.assignRoleOnAccept,
      dmOnAccept: !!c.dmOnAccept, dmOnDeny: !!c.dmOnDeny, dmOnInterview: !!c.dmOnInterview,
      acceptDM: c.acceptDM, denyDM: c.denyDM, interviewDM: c.interviewDM,
      positions: c.positions.map(p => ({ id: p.id, name: p.name, roleId: p.roleId, description: p.description, enabled: p.enabled })),
      reviewerPasswordSet: !!(c.reviewerPassHash || process.env.APPLICATIONS_REVIEW_PASSWORD),
    },
  };
}
function webUpdateAppConfig(patch) {
  patch = patch || {};
  const c = state.config;
  if ("open" in patch)               c.open = !!patch.open;
  if ("assignRoleOnAccept" in patch) c.assignRoleOnAccept = !!patch.assignRoleOnAccept;
  if ("dmOnAccept" in patch)         c.dmOnAccept = !!patch.dmOnAccept;
  if ("dmOnDeny" in patch)           c.dmOnDeny = !!patch.dmOnDeny;
  if ("dmOnInterview" in patch)      c.dmOnInterview = !!patch.dmOnInterview;
  if ("minAge" in patch)             c.minAge = Math.max(13, Math.min(21, parseInt(patch.minAge, 10) || 13));
  if ("cooldownHours" in patch)      c.cooldownHours = Math.max(0, Math.min(720, parseInt(patch.cooldownHours, 10) || 0));
  if ("serverName" in patch)         c.serverName = clampStr(patch.serverName, 60).trim() || "Cookie SMP";
  if ("acceptDM" in patch)           c.acceptDM = clampStr(patch.acceptDM, 1500);
  if ("denyDM" in patch)             c.denyDM = clampStr(patch.denyDM, 1500);
  if ("interviewDM" in patch)        c.interviewDM = clampStr(patch.interviewDM, 1500);
  if (Array.isArray(patch.positions)) {
    // only update known positions' name / roleId / description / enabled
    for (const incoming of patch.positions) {
      const p = c.positions.find(x => x.id === incoming.id);
      if (!p) continue;
      if ("name" in incoming)        p.name = clampStr(incoming.name, 40).trim() || p.name;
      if ("description" in incoming) p.description = clampStr(incoming.description, 200).trim();
      if ("enabled" in incoming)     p.enabled = !!incoming.enabled;
      if ("roleId" in incoming)      p.roleId = isSnow(incoming.roleId) ? incoming.roleId : null;
    }
  }
  save();
  pushActivity("applications", "Applications config updated");
  return webGetAppConfig();
}
function webSetReviewerPassword(pw) {
  const p = String(pw || "");
  if (p.length < 4) return { error: "Reviewer password must be at least 4 characters." };
  state.config.reviewerPassHash = sha256hex(p);
  save();
  pushActivity("applications", "Reviewer password changed");
  return { ok: true };
}

// ── Init + mount ─────────────────────────────────────────────────────────────
// mountApplications() runs synchronously at server startup, well before the
// Discord client ever connects, so state is loaded here (not in initApplications)
// so the site, review panel and config API all work from the first request
// regardless of Discord connection status, and nothing loaded pre-ready gets
// silently discarded once the client goes ready.
function initApplications(discordClient, options = {}) {
  client = discordClient;
  guildId = options.guildId || null;
  const c = webAppStats().counts;
  console.log(`[applications] Ready, ${state.config.open ? "open" : "closed"}, ${c.pending} pending, ${c.all} total.`);
}

function mountApplications(app, discordClient, options = {}) {
  if (discordClient) client = discordClient;
  if (options.guildId) guildId = options.guildId;
  load();

  // static site + clean routes
  app.use("/apply", express.static(WEB_DIR, { index: "index.html", extensions: ["html"] }));
  app.get("/apply", (_, res) => res.sendFile(path.join(WEB_DIR, "index.html")));
  app.get("/apply/status", (_, res) => res.sendFile(path.join(WEB_DIR, "status.html")));
  app.get("/apply/review", (_, res) => res.sendFile(path.join(WEB_DIR, "review.html")));

  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error("[applications]", req.method, req.path, err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
  });
  const send = (res, result, okPayload) => {
    if (result && result.error) return res.status(400).json({ ok: false, error: result.error });
    return res.json({ ok: true, ...(okPayload || result || {}) });
  };
  const clientIp = req => (req.headers["x-forwarded-for"] || req.ip || "unknown").toString().split(",")[0].trim();

  // ── public API ──
  const pub = express.Router();
  pub.get("/config", (req, res) => res.json({ ok: true, ...publicConfig() }));
  pub.post("/submit", rateLimit({ windowMs: 15 * 60_000, max: 6, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Too many submissions, wait a bit and try again." } }),
    wrap(async (req, res) => send(res, webSubmit(req.body || {}, clientIp(req)))));
  pub.get("/status", wrap(async (req, res) => send(res, webStatus(req.query.ref))));

  // ── reviewer auth ──
  const reviewLimiter = rateLimit({ windowMs: 15 * 60_000, max: 12, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Too many attempts, wait 15 minutes." } });
  app.post("/apply/review/login", reviewLimiter, express.json(), (req, res) => {
    const given = String(req.body?.password || "");
    if (!given || !reviewerPasswordMatches(given)) {
      pushActivity("applications", "Failed reviewer login");
      return res.status(401).json({ ok: false, error: "Wrong reviewer password." });
    }
    const token = createReviewerSession(req.body?.name);
    setReviewerCookie(res, req, token, SESSION_TTL);
    pushActivity("applications", `Reviewer logged in: ${clampStr(req.body?.name, 60) || "reviewer"}`);
    res.json({ ok: true, name: clampStr(req.body?.name, 60) || "reviewer" });
  });
  app.post("/apply/review/logout", (req, res) => {
    const token = readCookie(req, RV_COOKIE);
    if (token) reviewerSessions.delete(token);
    setReviewerCookie(res, req, "gone", 0);
    res.json({ ok: true });
  });

  // ── reviewer API (session required) ──
  const rev = express.Router();
  rev.use((req, res, next) => {
    const r = reviewerFromReq(req);
    if (!r) return res.status(401).json({ ok: false, error: "not logged in" });
    req.reviewer = r;
    next();
  });
  rev.get("/me", (req, res) => res.json({ ok: true, name: req.reviewer.name }));
  rev.get("/applications", wrap(async (req, res) => send(res, webListApplications(req.query.status))));
  rev.get("/applications/:id", wrap(async (req, res) => send(res, webGetApplication(req.params.id))));
  rev.post("/applications/:id/decide", wrap(async (req, res) =>
    send(res, await webDecide(req.params.id, String(req.body?.action || ""), req.body?.note, req.reviewer.name))));
  rev.delete("/applications/:id", wrap(async (req, res) => send(res, webDeleteApplication(req.params.id))));

  app.use("/apply/api", pub);
  app.use("/apply/api", rev);   // /applications/* lands here; the auth middleware on `rev` guards them

  console.log("[applications] Applications site mounted at /apply");
}

module.exports = {
  initApplications, mountApplications,
  webGetAppConfig, webUpdateAppConfig, webSetReviewerPassword, webAppStats,
};
