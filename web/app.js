"use strict";

/* CookieBot Control - client. Plain JS, no dependencies.
   Talks to the /api routes; a 401 anywhere drops back to the login screen. */

// ── tiny helpers ──────────────────────────────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function relTime(ts) {
  if (!ts) return "-";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
function relTimeUntil(ts) {
  if (!ts) return "-";
  const d = ts - Date.now();
  if (d <= 0) return "expired";
  if (d < 3_600_000) return `in ${Math.max(1, Math.floor(d / 60_000))}m`;
  if (d < 86_400_000) return `in ${Math.floor(d / 3_600_000)}h`;
  return `in ${Math.floor(d / 86_400_000)}d`;
}
function fmtDur(ms) {
  if (ms == null) return "-";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
function toast(text, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
}

async function api(path, opts = {}) {
  const init = { headers: {}, credentials: "same-origin", ...opts };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  let res;
  try { res = await fetch("/api" + path, init); }
  catch (e) { throw new Error("Can't reach the bot. Is it running?"); }
  if (res.status === 401 && path !== "/me") { showLogin(); throw new Error("Logged out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
// wrap an async click handler: disable the button, toast on failure
function busy(btn, fn) {
  return async (...args) => {
    btn.disabled = true;
    try { await fn(...args); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  };
}

// ── state ─────────────────────────────────────────────────────────────────────
const state = {
  view: "overview",
  channels: [], roles: [],
  guildLoaded: false,
  security: null,
  ticketSettings: null,
  userCache: new Map(),      // id -> tag
  overviewTimer: null,
  modalTimer: null,
};

// ── login flow ────────────────────────────────────────────────────────────────
function showLogin() {
  clearInterval(state.overviewTimer);
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-pass").focus();
}
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  switchView(state.view, true);
}
$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  try {
    const res = await fetch("/dash/login", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#login-pass").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");
    $("#login-pass").value = "";
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
});
$("#logout").addEventListener("click", async () => {
  await fetch("/dash/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  showLogin();
});

// ── navigation ────────────────────────────────────────────────────────────────
const loaders = {
  overview: loadOverview,
  tickets: loadTickets,
  automation: loadAutomation,
  applications: loadApplications,
  moderation: loadModeration,
  security: loadSecurity,
  giveaways: loadGiveaways,
  testers: loadTesters,
  messages: loadMessages,
  bot: loadBot,
};
function switchView(name, force = false) {
  if (!force && state.view === name) return;
  state.view = name;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach(v => v.classList.toggle("hidden", v.id !== `view-${name}`));
  clearInterval(state.overviewTimer);
  if (name === "overview") state.overviewTimer = setInterval(() => { if (!document.hidden) loadOverview().catch(() => {}); }, 10_000);
  loaders[name]().catch(e => toast(e.message, true));
}
$("#nav").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".nav-item");
  if (btn) switchView(btn.dataset.view);
});

// ── shared guild data (channels + roles for every dropdown) ───────────────────
const TEXTY = [0, 5];   // GuildText, GuildAnnouncement
async function loadGuildData(force = false) {
  if (state.guildLoaded && !force) return;
  try {
    const [ch, ro] = await Promise.all([api("/guild/channels"), api("/guild/roles")]);
    state.channels = ch.channels; state.roles = ro.roles;
    state.guildLoaded = true;
  } catch (e) {
    state.channels = []; state.roles = [];
    throw e;
  }
}
function channelName(id) { return state.channels.find(c => c.id === id)?.name || id; }
function roleName(id) { return state.roles.find(r => r.id === id)?.name || id; }
function fillChannelSelect(sel, { types = TEXTY, none = null, value = null } = {}) {
  const options = [];
  if (none) options.push(`<option value="">${esc(none)}</option>`);
  for (const c of state.channels.filter(c => types.includes(c.type))) {
    options.push(`<option value="${c.id}" ${c.id === value ? "selected" : ""}>#${esc(c.name)}</option>`);
  }
  sel.innerHTML = options.join("") || `<option value="">no channels</option>`;
}
function fillRoleSelect(sel, { none = null, value = null } = {}) {
  const options = [];
  if (none) options.push(`<option value="">${esc(none)}</option>`);
  for (const r of state.roles.filter(r => !r.managed)) {
    options.push(`<option value="${r.id}" ${r.id === value ? "selected" : ""}>${esc(r.name)}</option>`);
  }
  sel.innerHTML = options.join("") || `<option value="">no roles</option>`;
}

async function resolveUsers(root) {
  const els = [...root.querySelectorAll("[data-uid]")];
  const ids = [...new Set(els.map(e => e.dataset.uid))].filter(id => !state.userCache.has(id));
  for (const id of ids) {
    try { const r = await api(`/users/${id}`); state.userCache.set(id, r.user.tag); }
    catch (e) { state.userCache.set(id, id); }
  }
  for (const el of els) el.textContent = state.userCache.get(el.dataset.uid) || el.dataset.uid;
}

// member search dropdown helper
function wireMemberSearch(inputEl, resultsEl, onPick) {
  let timer = null;
  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (/^\d{5,25}$/.test(q)) { onPick({ id: q, tag: q }); return; }
    if (q.length < 2) { resultsEl.classList.add("hidden"); return; }
    timer = setTimeout(async () => {
      try {
        const r = await api(`/guild/members/search?q=${encodeURIComponent(q)}`);
        if (!r.members.length) { resultsEl.classList.add("hidden"); return; }
        resultsEl.innerHTML = r.members.map(m =>
          `<button type="button" data-id="${m.id}" data-tag="${esc(m.tag)}">
             <img src="${esc(m.avatar)}" alt=""> ${esc(m.displayName)} <span class="muted">${esc(m.tag)}</span>
           </button>`).join("");
        resultsEl.classList.remove("hidden");
      } catch (e) { resultsEl.classList.add("hidden"); }
    }, 300);
  });
  resultsEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-id]");
    if (!btn) return;
    resultsEl.classList.add("hidden");
    onPick({ id: btn.dataset.id, tag: btn.dataset.tag });
  });
  document.addEventListener("click", (ev) => {
    if (!resultsEl.contains(ev.target) && ev.target !== inputEl) resultsEl.classList.add("hidden");
  });
}

// ── modal ─────────────────────────────────────────────────────────────────────
function openModal(title) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = "";
  $("#modal-foot").innerHTML = "";
  $("#modal").classList.remove("hidden");
}
function closeModal() {
  $("#modal").classList.add("hidden");
  clearInterval(state.modalTimer);
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });

// ══════════════════════════════════════════════════════════════════════════════
// Overview
// ══════════════════════════════════════════════════════════════════════════════
async function loadOverview() {
  const d = await api("/overview");
  state.bot = { tag: d.bot.ready ? d.bot.tag : "CookieBot", avatar: d.bot.ready ? d.bot.avatar : null };

  state.guildName = d.guild?.name || "your server";

  const pill = $("#bot-pill");
  pill.className = "pill " + (d.bot.ready ? "on" : "off");
  pill.textContent = d.bot.ready ? `${d.bot.tag} online` : "bot offline";
  $("#guild-label").textContent = d.guild ? `${d.guild.name} / ${d.guild.members} members` : "no guild connected";

  const stats = [
    { k: "Bot", v: d.bot.ready ? "online" : "offline", cls: d.bot.ready ? "ok" : "bad" },
    { k: "Uptime", v: d.bot.ready ? fmtDur(d.bot.uptimeMs) : "-" },
    { k: "Ping", v: d.bot.ready ? `${d.bot.wsPing}ms` : "-" },
    { k: "Members", v: d.guild ? d.guild.members : "-" },
    { k: "Open tickets", v: d.counts.openTickets },
    { k: "Giveaways", v: d.counts.activeGiveaways },
    { k: "Infractions", v: d.counts.infractions },
    { k: "Testers", v: d.counts.linkedTesters },
  ];
  $("#ov-stats").innerHTML = stats.map(s =>
    `<div class="stat"><div class="k">${esc(s.k)}</div><div class="v ${s.cls || ""}">${esc(s.v)}</div></div>`).join("");

  const sec = d.security;
  $("#ov-security").innerHTML = [
    ["Anti-nuke", sec.antiNuke ? "on" : "off"],
    ["Lockdown", sec.lockdown ? "ACTIVE" : "off"],
    ["Ban lock", sec.lockBans ? "on (only /ban)" : "off"],
    ["Punishment", sec.punishment],
  ].map(([k, v]) => `<div class="row-kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join("");

  $("#ov-activity").innerHTML = d.activity.length
    ? d.activity.map(a =>
        `<div class="feed-item"><span class="feed-tag ${esc(a.type)}">${esc(a.type)}</span>
         <span>${esc(a.text)}</span><span class="feed-time">${relTime(a.at)}</span></div>`).join("")
    : `<div class="empty">Nothing yet. Events show up here as the bot works.</div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tickets
// ══════════════════════════════════════════════════════════════════════════════

// Discord-flavoured markdown -> HTML, for the live previews. Escapes first, so
// nothing user-typed can inject markup.
function discordMd(raw) {
  let s = esc(raw);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre class="dc-pre">${c.replace(/^\n/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code class="dc-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<u>$1</u>");
  s = s.replace(/\*(.+?)\*/g, "<i>$1</i>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/^&gt;\s?(.*)$/gm, '<span class="dc-quote">$1</span>');
  s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, ":$1:");
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="dc-mention">@${esc(roleName(id))}</span>`);
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="dc-mention">#${esc(channelName(id))}</span>`);
  s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="dc-mention">@${esc(state.userCache.get(id) || "user")}</span>`);
  s = s.replace(/\n/g, "<br>");
  return s;
}
function normalizeHex(v) {
  v = String(v || "").trim();
  if (/^#?[0-9a-f]{6}$/i.test(v)) return v.startsWith("#") ? v.toLowerCase() : "#" + v.toLowerCase();
  return null;
}
function botAvatarHTML() {
  const b = state.bot || {};
  return b.avatar ? `<img class="dc-avatar" src="${esc(b.avatar)}" alt="">` : `<div class="dc-avatar dc-avatar-fallback">B</div>`;
}

function setTicketTab(name) {
  $("#tk-manage").classList.toggle("hidden", name !== "manage");
  $("#tk-setup").classList.toggle("hidden", name !== "setup");
  $$("[data-tk-tab]").forEach(b => {
    const active = b.dataset.tkTab === name;
    b.classList.toggle("primary", active);
    b.classList.toggle("ghost", !active);
  });
}

async function loadTickets() {
  const d = await api("/tickets");
  const s = d.settings;
  state.ticketSettings = s;
  state.ticketTopics = (s.topics || []).map(t => ({ ...t }));

  await loadGuildData().catch(() => {});
  fillChannelSelect($("#tk-panel-channel"), { none: "pick a channel for the panel" });
  fillChannelSelect($("#tks-category"), { types: [4], none: "no category (top level)", value: s.categoryId });
  fillChannelSelect($("#tks-log"), { none: "no log channel", value: s.logChannelId });
  fillRoleSelect($("#tks-role"), { none: "no support role", value: s.supportRoleId });

  // behavior
  $("#tks-max").value = s.maxOpenPerUser;
  $("#tks-naming").value = s.naming || "number";
  $("#tks-prefix").value = s.namePrefix;
  $("#tks-close-delay").value = s.closeDelaySeconds ?? 5;
  $("#tks-autoclose").value = s.autoCloseHours ?? 0;
  $("#tks-ping").checked = s.pingSupport;
  $("#tks-dmclose").checked = s.dmOnClose;
  $("#tks-welcome").value = s.welcomeMessage;
  // appearance
  $("#tks-title").value = s.panelTitle;
  $("#tks-text").value = s.panelText;
  $("#tks-color").value = normalizeHex(s.panelColor) || "#ff8c00";
  $("#tks-color-hex").value = normalizeHex(s.panelColor) || "#ff8c00";
  $("#tks-button").value = s.buttonLabel;
  $("#tks-emoji").value = s.buttonEmoji || "";
  $("#tks-btnstyle").value = s.buttonStyle || "primary";

  renderTopics();
  renderPanelPreview();
  if (!$$("[data-tk-tab].primary").length) setTicketTab("manage");

  // ── open tickets ──
  $("#tk-open-count").textContent = String(d.open.length);
  $("#tk-open").innerHTML = d.open.length ? `
    <table><thead><tr><th>#</th><th>Subject</th><th>Topic</th><th>Opened by</th><th>Claimed by</th><th>Age</th><th></th></tr></thead><tbody>
    ${d.open.map(t => {
      const claimed = t.claimedById || t.claimedByTag;
      return `
      <tr>
        <td class="mono">#${String(t.id).padStart(4, "0")}</td>
        <td>${esc(t.subject)}</td>
        <td>${t.topic ? esc(t.topic) : '<span class="muted">-</span>'}</td>
        <td>${esc(t.openerTag)}</td>
        <td>${claimed ? esc(t.claimedByTag || "claimed") : '<span class="muted">unclaimed</span>'}</td>
        <td class="mono">${relTime(t.createdAt)}</td>
        <td class="row">
          <button class="btn mini" data-tk-view="${t.channelId}">Open</button>
          ${claimed
            ? `<button class="btn mini ghost" data-tk-unclaim="${t.channelId}">Unclaim</button>`
            : `<button class="btn mini ghost" data-tk-claim="${t.channelId}">Claim</button>`}
          <button class="btn mini danger" data-tk-close="${t.channelId}">Close</button>
        </td>
      </tr>`;
    }).join("")}
    </tbody></table>` : `<div class="empty">No open tickets. Nice.</div>`;

  // ── closed tickets ──
  $("#tk-closed").innerHTML = d.closed.length ? `
    <table><thead><tr><th>#</th><th>Subject</th><th>Opened by</th><th>Closed by</th><th>Msgs</th><th>Closed</th><th></th></tr></thead><tbody>
    ${d.closed.map(t => `
      <tr>
        <td class="mono">#${String(t.id).padStart(4, "0")}</td>
        <td>${esc(t.subject)}</td>
        <td>${esc(t.openerTag)}</td>
        <td>${esc(t.closedBy || "-")}</td>
        <td class="mono">${t.messageCount || 0}</td>
        <td class="mono">${relTime(t.closedAt)}</td>
        <td><button class="btn mini" data-tk-view="${t.channelId}">Transcript</button></td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty">No closed tickets yet.</div>`;
}

// ── panel preview + topics editor ──
function renderPanelPreview() {
  const title = $("#tks-title").value.trim() || "Panel title";
  const text = $("#tks-text").value.trim() || "Panel text goes here.";
  const color = normalizeHex($("#tks-color-hex").value) || "#ff8c00";
  const label = esc($("#tks-button").value.trim() || "Open a ticket");
  const topics = (state.ticketTopics || []).filter(t => (t.label || "").trim());
  let components;
  if (topics.length) {
    components = `<div class="dc-select"><span>${esc($("#tks-button").value.trim() || "Open a ticket")}</span><span class="dc-select-caret">⌄</span></div>`;
  } else {
    const style = $("#tks-btnstyle").value;
    const emoji = $("#tks-emoji").value.trim();
    components = `<span class="dc-btn dc-btn-${esc(style)}">${emoji ? esc(emoji) + " " : ""}${label}</span>`;
  }
  $("#tk-panel-preview").innerHTML = `
    <div class="dc-embed" style="border-left-color:${esc(color)}">
      <div class="dc-embed-title">${esc(title)}</div>
      <div class="dc-embed-desc">${discordMd(text)}</div>
    </div>
    <div class="dc-components">${components}</div>`;
}

function renderTopics() {
  const topics = state.ticketTopics || [];
  $("#tk-topics").innerHTML = topics.length ? topics.map((t, i) => `
    <div class="topic-row">
      <input class="input" data-topic-i="${i}" data-topic-f="emoji" value="${esc(t.emoji || "")}" placeholder="🍪" maxlength="64">
      <input class="input" data-topic-i="${i}" data-topic-f="label" value="${esc(t.label || "")}" placeholder="Topic name" maxlength="100">
      <input class="input" data-topic-i="${i}" data-topic-f="description" value="${esc(t.description || "")}" placeholder="Short description (optional)" maxlength="100">
      <button class="btn ghost mini" data-topic-rm="${i}" title="remove">✕</button>
    </div>`).join("") : `<p class="muted small">No topics yet, the panel shows a single button.</p>`;
}

// live-preview bindings for the appearance fields
["#tks-title", "#tks-text", "#tks-button", "#tks-emoji"].forEach(sel =>
  $(sel).addEventListener("input", renderPanelPreview));
$("#tks-btnstyle").addEventListener("change", renderPanelPreview);
$("#tks-color").addEventListener("input", () => { $("#tks-color-hex").value = $("#tks-color").value; renderPanelPreview(); });
$("#tks-color-hex").addEventListener("input", () => {
  const hex = normalizeHex($("#tks-color-hex").value);
  if (hex) $("#tks-color").value = hex;
  renderPanelPreview();
});

// topic editing: update the model on input, only re-render the preview (keeps focus)
$("#tk-topics").addEventListener("input", (ev) => {
  const el = ev.target.closest("[data-topic-i]");
  if (!el) return;
  const i = +el.dataset.topicI;
  if (state.ticketTopics[i]) { state.ticketTopics[i][el.dataset.topicF] = el.value; renderPanelPreview(); }
});
$("#tk-topics").addEventListener("click", (ev) => {
  const rm = ev.target.closest("[data-topic-rm]");
  if (!rm) return;
  state.ticketTopics.splice(+rm.dataset.topicRm, 1);
  renderTopics(); renderPanelPreview();
});
$("#tk-topic-add").addEventListener("click", () => {
  (state.ticketTopics = state.ticketTopics || []).push({ label: "", emoji: "", description: "" });
  renderTopics(); renderPanelPreview();
});

function collectTicketSettings() {
  return {
    categoryId: $("#tks-category").value || null,
    supportRoleId: $("#tks-role").value || null,
    logChannelId: $("#tks-log").value || null,
    maxOpenPerUser: parseInt($("#tks-max").value, 10) || 1,
    naming: $("#tks-naming").value,
    namePrefix: ($("#tks-prefix").value.trim() || "ticket").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) || "ticket",
    closeDelaySeconds: Math.max(0, Math.min(60, parseInt($("#tks-close-delay").value, 10) || 0)),
    autoCloseHours: Math.max(0, Math.min(336, parseInt($("#tks-autoclose").value, 10) || 0)),
    pingSupport: $("#tks-ping").checked,
    dmOnClose: $("#tks-dmclose").checked,
    welcomeMessage: $("#tks-welcome").value.trim(),
    panelTitle: $("#tks-title").value.trim() || "Support",
    panelText: $("#tks-text").value.trim() || "Click below to open a ticket.",
    panelColor: normalizeHex($("#tks-color-hex").value) || "#ff8c00",
    buttonLabel: $("#tks-button").value.trim() || "Open a ticket",
    buttonEmoji: $("#tks-emoji").value.trim(),
    buttonStyle: $("#tks-btnstyle").value,
    topics: (state.ticketTopics || []).filter(t => (t.label || "").trim())
      .map(t => ({ label: t.label.trim(), emoji: (t.emoji || "").trim(), description: (t.description || "").trim() })),
  };
}

$("#tks-save").addEventListener("click", busy($("#tks-save"), async () => {
  await api("/tickets/settings", { method: "PUT", body: collectTicketSettings() });
  $("#tks-status").textContent = "Saved " + new Date().toLocaleTimeString();
  toast("Ticket settings saved");
}));

$("#tk-post-panel").addEventListener("click", busy($("#tk-post-panel"), async () => {
  const channelId = $("#tk-panel-channel").value;
  if (!channelId) throw new Error("Pick the channel to post the panel in");
  await api("/tickets/settings", { method: "PUT", body: collectTicketSettings() });   // save first so the panel matches the preview
  await api("/tickets/panel", { method: "POST", body: { channelId } });
  toast("Panel posted to Discord");
}));

// tabs + table actions
$("#view-tickets").addEventListener("click", async (ev) => {
  const tab = ev.target.closest("[data-tk-tab]");
  if (tab) { setTicketTab(tab.dataset.tkTab); return; }

  const viewBtn = ev.target.closest("[data-tk-view]");
  const closeBtn = ev.target.closest("[data-tk-close]");
  const claimBtn = ev.target.closest("[data-tk-claim]");
  const unclaimBtn = ev.target.closest("[data-tk-unclaim]");
  try {
    if (viewBtn) await openTicketModal(viewBtn.dataset.tkView);
    else if (claimBtn) { await api(`/tickets/${claimBtn.dataset.tkClaim}/claim`, { method: "POST" }); toast("Claimed"); loadTickets(); }
    else if (unclaimBtn) { await api(`/tickets/${unclaimBtn.dataset.tkUnclaim}/unclaim`, { method: "POST" }); toast("Unclaimed"); loadTickets(); }
    else if (closeBtn) {
      const reason = prompt("Close this ticket. Reason (optional):");
      if (reason === null) return;
      await api(`/tickets/${closeBtn.dataset.tkClose}/close`, { method: "POST", body: { reason } });
      toast("Ticket closing");
      setTimeout(() => loadTickets().catch(() => {}), 800);
    }
  } catch (e) { toast(e.message, true); }
});

async function openTicketModal(channelId) {
  const d = await api(`/tickets/${channelId}/messages`);
  const t = d.ticket;
  const claimed = t.claimedById || t.claimedByTag;
  openModal(`Ticket #${String(t.id).padStart(4, "0")}: ${t.subject}`);

  // render the real conversation as Discord-style bubbles
  const render = (messages) => {
    $("#modal-body").innerHTML = messages.length ? messages.map(m => `
      <div class="dc-msg">
        ${m.bot ? botAvatarHTML() : `<div class="dc-avatar dc-avatar-user">${esc((m.authorTag || "?")[0].toUpperCase())}</div>`}
        <div class="dc-msg-main">
          <div class="dc-msg-head">
            <span class="dc-name">${esc(m.authorTag)}</span>
            ${m.bot ? '<span class="dc-badge">BOT</span>' : ""}
            <span class="dc-time">${new Date(m.at).toLocaleString()}</span>
          </div>
          <div class="dc-body">${discordMd(m.content)}
            ${(m.attachments || []).map(a => `<a class="att" href="${esc(a.url)}" target="_blank" rel="noopener">📎 ${esc(a.name)}</a>`).join("")}
            ${(m.embeds || []).length ? `<span class="embed-note">[embed] ${esc(m.embeds.join(", "))}</span>` : ""}
          </div>
        </div>
      </div>`).join("") : `<div class="empty">No messages yet.</div>`;
    $("#modal-body").scrollTop = $("#modal-body").scrollHeight;
  };
  render(d.messages);

  if (t.status !== "open") { $("#modal-foot").innerHTML = `<span class="muted small">This ticket is closed, read-only transcript.</span>`; return; }

  $("#modal-foot").innerHTML = `
    <div class="reply-area">
      <div id="tkm-preview" class="dc-msg reply-preview hidden"></div>
      <div class="reply-row">
        <textarea id="tkm-reply" class="input" rows="1" placeholder="Reply as the bot… (Discord markdown works, Enter to send)" maxlength="1900"></textarea>
        <button id="tkm-send" class="btn primary">Send</button>
      </div>
      <div class="reply-actions">
        ${claimed
          ? `<button id="tkm-unclaim" class="btn">Unclaim (${esc(t.claimedByTag || "claimed")})</button>`
          : `<button id="tkm-claim" class="btn">Claim ticket</button>`}
        <button id="tkm-close" class="btn danger">Close ticket</button>
      </div>
    </div>`;

  const previewBox = $("#tkm-preview");
  const renderPreview = () => {
    const raw = $("#tkm-reply").value;
    if (!raw.trim()) { previewBox.classList.add("hidden"); return; }
    const b = state.bot || {};
    previewBox.classList.remove("hidden");
    previewBox.innerHTML = `
      ${botAvatarHTML()}
      <div class="dc-msg-main">
        <div class="dc-msg-head"><span class="dc-name">${esc(b.tag || "CookieBot")}</span><span class="dc-badge">BOT</span><span class="dc-time">preview</span></div>
        <div class="dc-body">${discordMd(raw)}</div>
      </div>`;
  };
  $("#tkm-reply").addEventListener("input", renderPreview);

  let sending = false;
  const doSend = async () => {
    const content = $("#tkm-reply").value.trim();
    if (!content || sending) return;
    sending = true;
    try {
      await api(`/tickets/${channelId}/reply`, { method: "POST", body: { content } });
      $("#tkm-reply").value = "";
      renderPreview();
      const fresh = await api(`/tickets/${channelId}/messages`);
      render(fresh.messages);
    } finally { sending = false; }
  };
  $("#tkm-send").addEventListener("click", busy($("#tkm-send"), doSend));
  $("#tkm-reply").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); doSend().catch(e => toast(e.message, true)); }
  });

  if ($("#tkm-claim")) $("#tkm-claim").addEventListener("click", busy($("#tkm-claim"), async () => {
    await api(`/tickets/${channelId}/claim`, { method: "POST" }); toast("Claimed"); closeModal(); loadTickets();
  }));
  if ($("#tkm-unclaim")) $("#tkm-unclaim").addEventListener("click", busy($("#tkm-unclaim"), async () => {
    await api(`/tickets/${channelId}/unclaim`, { method: "POST" }); toast("Unclaimed"); closeModal(); loadTickets();
  }));
  $("#tkm-close").addEventListener("click", busy($("#tkm-close"), async () => {
    const reason = prompt("Reason (optional):");
    if (reason === null) return;
    await api(`/tickets/${channelId}/close`, { method: "POST", body: { reason } });
    toast("Ticket closing");
    closeModal();
    setTimeout(() => loadTickets().catch(() => {}), 800);
  }));

  // keep the conversation live while the modal is open
  clearInterval(state.modalTimer);
  state.modalTimer = setInterval(async () => {
    if ($("#modal").classList.contains("hidden")) { clearInterval(state.modalTimer); return; }
    try { const fresh = await api(`/tickets/${channelId}/messages`); render(fresh.messages); } catch (e) {}
  }, 7000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Automation
// ══════════════════════════════════════════════════════════════════════════════
const RR_STYLE_LABELS = { primary: "Blurple", secondary: "Grey", success: "Green", danger: "Red" };
const RESP_MATCHES = [["contains", "contains"], ["word", "whole word"], ["startsWith", "starts with"], ["exact", "exact"]];

// fill {placeholders} with readable sample values for the live previews
function samplePlaceholders(str) {
  return String(str || "")
    .replace(/\{user\}/g, "@You")
    .replace(/\{tag\}/g, "You#0001")
    .replace(/\{name\}/g, "You")
    .replace(/\{username\}/g, "You")
    .replace(/\{server\}/g, state.guildName || "CookieSMP")
    .replace(/\{membercount\}|\{memberCount\}|\{count\}/g, "128")
    .replace(/\{id\}/g, "123456789012345678");
}

async function loadAutomation() {
  await loadGuildData().catch(() => {});
  const d = await api("/automation");
  const a = d.automation;
  state.automation = a;

  fillRoleSelect($("#au-ar-role-pick"), { none: "pick a role" });
  fillRoleSelect($("#au-ar-botrole-pick"), { none: "pick a role" });
  fillRoleSelect($("#au-rr-role-pick"), { none: "pick a role" });
  fillRoleSelect($("#au-mod-ignore-role-pick"), { none: "pick a role" });
  fillChannelSelect($("#au-wel-channel"), { none: "no channel set", value: a.welcome.channelId });
  fillChannelSelect($("#au-bye-channel"), { none: "no channel set", value: a.goodbye.channelId });
  fillChannelSelect($("#au-rr-channel"), { none: "pick a channel" });
  fillChannelSelect($("#au-log-channel"), { none: "no channel set", value: a.messageLogger.channelId });
  fillChannelSelect($("#au-log-ignore-pick"), { none: "pick a channel" });
  fillChannelSelect($("#au-mod-ignore-ch-pick"), { none: "pick a channel" });
  fillChannelSelect($("#au-sticky-channel-pick"), { none: "pick a channel" });

  // autorole
  $("#au-ar-enabled").checked = a.autorole.enabled;
  $("#au-ar-delay").value = a.autorole.delaySeconds || 0;
  renderAutoroleChips();

  // welcome
  $("#au-wel-enabled").checked = a.welcome.enabled;
  $("#au-wel-msg").value = a.welcome.message;
  $("#au-wel-embed").checked = a.welcome.useEmbed;
  $("#au-wel-color").value = normalizeHex(a.welcome.embedColor) || "#ff8c00";
  $("#au-wel-ping").checked = a.welcome.pingUser;
  $("#au-wel-dm").checked = a.welcome.dmEnabled;
  $("#au-wel-dmmsg").value = a.welcome.dmMessage;
  $("#au-wel-dm-wrap").classList.toggle("hidden", !a.welcome.dmEnabled);

  // goodbye
  $("#au-bye-enabled").checked = a.goodbye.enabled;
  $("#au-bye-msg").value = a.goodbye.message;
  $("#au-bye-embed").checked = a.goodbye.useEmbed;
  $("#au-bye-color").value = normalizeHex(a.goodbye.embedColor) || "#8b6cff";

  // reaction roles
  $("#au-rr-title").value = a.reactionRoles.title;
  $("#au-rr-text").value = a.reactionRoles.text;
  $("#au-rr-color").value = normalizeHex(a.reactionRoles.color) || "#8b6cff";
  renderRRRows();

  renderResponders();
  renderWelcomePreview();
  renderGoodbyePreview();
  renderRRPreview();

  // message logger
  $("#au-log-enabled").checked = a.messageLogger.enabled;
  $("#au-log-deletes").checked = a.messageLogger.logDeletes !== false;
  $("#au-log-edits").checked = a.messageLogger.logEdits !== false;
  renderLogIgnore();

  // auto-moderation
  const m = a.autoModeration;
  $("#au-mod-enabled").checked = m.enabled;
  $("#au-mod-invites").checked = !!m.blockInvites;
  $("#au-mod-links").checked = !!m.blockLinks;
  $("#au-mod-caps").value = m.capsSensitivity;
  $("#au-mod-capslen").value = m.capsMinLength;
  $("#au-mod-mentions").value = m.mentionLimit;
  $("#au-mod-repeat").value = m.repeatLimit;
  $("#au-mod-timeout").value = m.timeoutSeconds;
  $("#au-mod-deleteonly").checked = !!m.deleteOnly;
  renderModIgnoreRoles();
  renderModIgnoreChannels();
  renderModWords();

  // sticky messages
  renderStickies();

  // channel mention autocomplete on message fields
  setupChannelMention($("#au-wel-msg"));
  setupChannelMention($("#au-wel-dmmsg"));
  setupChannelMention($("#au-bye-msg"));
  setupChannelMention($("#au-rr-text"));
}

// ── autorole chips ──
function renderAutoroleChips() {
  const a = state.automation.autorole;
  renderChips($("#au-ar-roles"), a.roleIds, roleName, "au-ar-rm");
  renderChips($("#au-ar-botroles"), a.botRoleIds, roleName, "au-ar-bot-rm");
}
$("#au-ar-role-add").addEventListener("click", () => {
  const id = $("#au-ar-role-pick").value; if (!id) return;
  const arr = state.automation.autorole.roleIds;
  if (!arr.includes(id)) arr.push(id);
  renderAutoroleChips();
});
$("#au-ar-botrole-add").addEventListener("click", () => {
  const id = $("#au-ar-botrole-pick").value; if (!id) return;
  const arr = state.automation.autorole.botRoleIds;
  if (!arr.includes(id)) arr.push(id);
  renderAutoroleChips();
});

// ── reaction-role rows ──
function renderRRRows() {
  const roles = state.automation.reactionRoles.roles;
  $("#au-rr-roles").innerHTML = roles.length ? roles.map((r, i) => `
    <div class="rr-row">
      <span class="rr-role-name" title="${esc(roleName(r.roleId))}">${esc(roleName(r.roleId))}</span>
      <input class="input" data-rr-i="${i}" data-rr-f="emoji" value="${esc(r.emoji || "")}" placeholder="emoji" maxlength="64">
      <input class="input" data-rr-i="${i}" data-rr-f="label" value="${esc(r.label || "")}" placeholder="Button label" maxlength="80">
      <select class="input" data-rr-i="${i}" data-rr-f="style">
        ${Object.entries(RR_STYLE_LABELS).map(([v, l]) => `<option value="${v}" ${r.style === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button class="btn ghost mini" data-rr-rm="${i}" title="remove">✕</button>
    </div>`).join("") : `<p class="muted small">No roles on the panel yet. Add one below.</p>`;
}
$("#au-rr-role-add").addEventListener("click", () => {
  const id = $("#au-rr-role-pick").value; if (!id) return;
  const roles = state.automation.reactionRoles.roles;
  if (roles.some(r => r.roleId === id)) { toast("That role is already on the panel", true); return; }
  roles.push({ roleId: id, label: roleName(id).slice(0, 80), emoji: "", style: "secondary" });
  renderRRRows(); renderRRPreview();
});
function rrRowEdit(el) {
  const i = +el.dataset.rrI;
  const r = state.automation.reactionRoles.roles[i];
  if (r) { r[el.dataset.rrF] = el.value; renderRRPreview(); }
}
$("#au-rr-roles").addEventListener("input", (ev) => { const el = ev.target.closest("[data-rr-i]"); if (el) rrRowEdit(el); });
$("#au-rr-roles").addEventListener("change", (ev) => { const el = ev.target.closest("[data-rr-i]"); if (el) rrRowEdit(el); });
$("#au-rr-roles").addEventListener("click", (ev) => {
  const rm = ev.target.closest("[data-rr-rm]"); if (!rm) return;
  state.automation.reactionRoles.roles.splice(+rm.dataset.rrRm, 1);
  renderRRRows(); renderRRPreview();
});

// ── auto-responder rows ──
function renderResponders() {
  const list = state.automation.autoResponders;
  $("#au-resp-list").innerHTML = list.length ? list.map((r, i) => `
    <div class="resp-row">
      <label class="switch sm"><input type="checkbox" data-resp-i="${i}" data-resp-f="enabled" ${r.enabled !== false ? "checked" : ""}><span class="track"></span></label>
      <input class="input" data-resp-i="${i}" data-resp-f="trigger" value="${esc(r.trigger || "")}" placeholder="trigger word" maxlength="100">
      <select class="input" data-resp-i="${i}" data-resp-f="match">
        ${RESP_MATCHES.map(([v, l]) => `<option value="${v}" ${r.match === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <input class="input" data-resp-i="${i}" data-resp-f="response" value="${esc(r.response || "")}" placeholder="what the bot replies" maxlength="1500">
      <label class="check mini" title="delete the triggering message"><input type="checkbox" data-resp-i="${i}" data-resp-f="deleteTrigger" ${r.deleteTrigger ? "checked" : ""}> del</label>
      <button class="btn ghost mini" data-resp-rm="${i}" title="remove">✕</button>
    </div>`).join("") : `<p class="muted small">No auto-replies yet.</p>`;
  // add channel mention to response inputs
  $$("[data-resp-f='response']").forEach(el => setupChannelMention(el));
}
function respRowEdit(el) {
  const r = state.automation.autoResponders[+el.dataset.respI];
  if (r) r[el.dataset.respF] = (el.type === "checkbox") ? el.checked : el.value;
}
$("#au-resp-list").addEventListener("input", (ev) => { const el = ev.target.closest("[data-resp-i]"); if (el) respRowEdit(el); });
$("#au-resp-list").addEventListener("change", (ev) => { const el = ev.target.closest("[data-resp-i]"); if (el) respRowEdit(el); });
$("#au-resp-list").addEventListener("click", (ev) => {
  const rm = ev.target.closest("[data-resp-rm]"); if (!rm) return;
  state.automation.autoResponders.splice(+rm.dataset.respRm, 1);
  renderResponders();
});
$("#au-resp-add").addEventListener("click", () => {
  state.automation.autoResponders.push({ id: "", trigger: "", match: "contains", response: "", deleteTrigger: false, enabled: true });
  renderResponders();
});

// ── autorole chip removal (delegated) ──
$("#view-automation").addEventListener("click", (ev) => {
  const arRm = ev.target.closest("[data-au-ar-rm]");
  const botRm = ev.target.closest("[data-au-ar-bot-rm]");
  const a = state.automation?.autorole;
  if (!a) return;
  if (arRm) { const i = a.roleIds.indexOf(arRm.dataset.auArRm); if (i >= 0) a.roleIds.splice(i, 1); renderAutoroleChips(); }
  else if (botRm) { const i = a.botRoleIds.indexOf(botRm.dataset.auArBotRm); if (i >= 0) a.botRoleIds.splice(i, 1); renderAutoroleChips(); }
});

// ── live previews ──
function botBubble(inner) {
  const b = state.bot || {};
  return `<div class="dc-msg">${botAvatarHTML()}<div class="dc-msg-main">
    <div class="dc-msg-head"><span class="dc-name">${esc(b.tag || "CookieBot")}</span><span class="dc-badge">BOT</span><span class="dc-time">now</span></div>
    ${inner}</div></div>`;
}
function renderWelcomePreview() {
  const useEmbed = $("#au-wel-embed").checked;
  const color = normalizeHex($("#au-wel-color").value) || "#ff8c00";
  const text = discordMd(samplePlaceholders($("#au-wel-msg").value || ""));
  const ping = (useEmbed && $("#au-wel-ping").checked) ? `<div class="dc-body" style="margin-bottom:4px"><span class="dc-mention">@You</span></div>` : "";
  const body = useEmbed
    ? `${ping}<div class="dc-embed" style="border-left-color:${esc(color)}"><div class="dc-embed-desc">${text}</div></div>`
    : `<div class="dc-body">${text}</div>`;
  $("#au-wel-preview").innerHTML = botBubble(body);
}
function renderGoodbyePreview() {
  const useEmbed = $("#au-bye-embed").checked;
  const color = normalizeHex($("#au-bye-color").value) || "#8b6cff";
  const text = discordMd(samplePlaceholders($("#au-bye-msg").value || ""));
  const body = useEmbed
    ? `<div class="dc-embed" style="border-left-color:${esc(color)}"><div class="dc-embed-desc">${text}</div></div>`
    : `<div class="dc-body">${text}</div>`;
  $("#au-bye-preview").innerHTML = botBubble(body);
}
function renderRRPreview() {
  const color = normalizeHex($("#au-rr-color").value) || "#8b6cff";
  const title = esc($("#au-rr-title").value.trim() || "Pick your roles");
  const text = discordMd(samplePlaceholders($("#au-rr-text").value || "Click a button to get a role."));
  const roles = state.automation?.reactionRoles.roles || [];
  const btns = roles.length
    ? roles.map(r => `<span class="dc-btn dc-btn-${esc(r.style || "secondary")}">${r.emoji ? esc(r.emoji) + " " : ""}${esc(r.label || "Role")}</span>`).join("")
    : `<span class="muted small">add roles to see the buttons</span>`;
  $("#au-rr-preview").innerHTML = `
    <div class="dc-embed" style="border-left-color:${esc(color)}">
      <div class="dc-embed-title">${title}</div>
      <div class="dc-embed-desc">${text}</div>
    </div>
    <div class="dc-components">${btns}</div>`;
}
["#au-wel-msg", "#au-wel-color", "#au-wel-embed", "#au-wel-ping"].forEach(s => {
  const el = $(s); el.addEventListener("input", renderWelcomePreview); el.addEventListener("change", renderWelcomePreview);
});
["#au-bye-msg", "#au-bye-color", "#au-bye-embed"].forEach(s => {
  const el = $(s); el.addEventListener("input", renderGoodbyePreview); el.addEventListener("change", renderGoodbyePreview);
});
["#au-rr-title", "#au-rr-text", "#au-rr-color"].forEach(s => {
  const el = $(s); el.addEventListener("input", renderRRPreview); el.addEventListener("change", renderRRPreview);
});
$("#au-wel-dm").addEventListener("change", () => $("#au-wel-dm-wrap").classList.toggle("hidden", !$("#au-wel-dm").checked));

// ── auto-mod + logger chip lists ──
function renderModIgnoreRoles()    { renderChips($("#au-mod-ignore-roles"),    state.automation.autoModeration.ignoreRoles,    roleName,    "au-mod-ig-rm"); }
function renderModIgnoreChannels() { renderChips($("#au-mod-ignore-channels"), state.automation.autoModeration.ignoreChannels, channelName, "au-mod-igch-rm"); }
function renderLogIgnore()         { renderChips($("#au-log-ignore"),          state.automation.messageLogger.ignoreChannels,  channelName, "au-log-ig-rm"); }
function renderModWords() {
  const words = state.automation.autoModeration.bannedWords;
  $("#au-mod-words").innerHTML = words.length
    ? words.map(w => `<span class="chip">${esc(w)}<button title="remove" data-au-mod-word-rm="${esc(w)}">x</button></span>`).join("")
    : `<span class="muted small">none</span>`;
}

// add a value (id or word) to a list, dedupe, re-render, save
function addToList(arr, val, render) { if (!val) return; if (!arr.includes(val)) arr.push(val); render(); scheduleAutoSave(); }
// delegated, id/word-based chip removal (matches how renderChips stores the value)
function bindChipRemoval(sel, attr, getArr, render) {
  $(sel).addEventListener("click", (ev) => {
    const btn = ev.target.closest(`[data-${attr}]`); if (!btn) return;
    const arr = getArr();
    const i = arr.indexOf(btn.getAttribute(`data-${attr}`));
    if (i >= 0) arr.splice(i, 1);
    render(); scheduleAutoSave();
  });
}

$("#au-mod-ignore-role-add").addEventListener("click", () => addToList(state.automation.autoModeration.ignoreRoles, $("#au-mod-ignore-role-pick").value, renderModIgnoreRoles));
$("#au-mod-ignore-ch-add").addEventListener("click",   () => addToList(state.automation.autoModeration.ignoreChannels, $("#au-mod-ignore-ch-pick").value, renderModIgnoreChannels));
$("#au-log-ignore-add").addEventListener("click",      () => addToList(state.automation.messageLogger.ignoreChannels, $("#au-log-ignore-pick").value, renderLogIgnore));
$("#au-mod-word-add").addEventListener("click", () => {
  const w = $("#au-mod-word-input").value.trim().toLowerCase(); if (!w) return;
  addToList(state.automation.autoModeration.bannedWords, w, renderModWords);
  $("#au-mod-word-input").value = "";
});
$("#au-mod-word-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("#au-mod-word-add").click(); } });

bindChipRemoval("#au-mod-ignore-roles",    "au-mod-ig-rm",    () => state.automation.autoModeration.ignoreRoles,    renderModIgnoreRoles);
bindChipRemoval("#au-mod-ignore-channels", "au-mod-igch-rm",  () => state.automation.autoModeration.ignoreChannels, renderModIgnoreChannels);
bindChipRemoval("#au-log-ignore",          "au-log-ig-rm",    () => state.automation.messageLogger.ignoreChannels,  renderLogIgnore);
bindChipRemoval("#au-mod-words",            "au-mod-word-rm", () => state.automation.autoModeration.bannedWords,    renderModWords);

// ── sticky messages ──
function renderStickies() {
  const list = state.automation.stickyMessages;
  $("#au-sticky-list").innerHTML = list.length ? list.map((s, i) => `
    <div class="sticky-row">
      <div class="row between">
        <label class="switch sm"><input type="checkbox" data-sticky-i="${i}" data-sticky-f="enabled" ${s.enabled !== false ? "checked" : ""}><span class="track"></span></label>
        <span class="sticky-ch">#${esc(channelName(s.channelId))}</span>
        <label class="check mini"><input type="checkbox" data-sticky-i="${i}" data-sticky-f="useEmbed" ${s.useEmbed ? "checked" : ""}> embed</label>
        <input class="input mini-color" type="color" data-sticky-i="${i}" data-sticky-f="embedColor" value="${esc(normalizeHex(s.embedColor) || "#ff8c00")}">
        <button class="btn ghost mini" data-sticky-rm="${i}" title="remove">✕</button>
      </div>
      <textarea class="input" data-sticky-i="${i}" data-sticky-f="message" rows="2" maxlength="1500" placeholder="Sticky message text (Discord markdown works)">${esc(s.message || "")}</textarea>
    </div>`).join("") : `<p class="muted small">No sticky messages yet. Pick a channel below to add one.</p>`;
}
function stickyEdit(el) {
  const s = state.automation.stickyMessages[+el.dataset.stickyI];
  if (s) s[el.dataset.stickyF] = (el.type === "checkbox") ? el.checked : el.value;
}
$("#au-sticky-list").addEventListener("input",  (ev) => { const el = ev.target.closest("[data-sticky-i]"); if (el) { stickyEdit(el); scheduleAutoSave(); } });
$("#au-sticky-list").addEventListener("change", (ev) => { const el = ev.target.closest("[data-sticky-i]"); if (el) { stickyEdit(el); scheduleAutoSave(); } });
$("#au-sticky-list").addEventListener("click",  (ev) => {
  const rm = ev.target.closest("[data-sticky-rm]"); if (!rm) return;
  state.automation.stickyMessages.splice(+rm.dataset.stickyRm, 1);
  renderStickies(); scheduleAutoSave();
});
$("#au-sticky-add").addEventListener("click", () => {
  const chId = $("#au-sticky-channel-pick").value; if (!chId) { toast("Pick a channel first", true); return; }
  const list = state.automation.stickyMessages;
  if (list.some(s => s.channelId === chId)) { toast("That channel already has a sticky", true); return; }
  list.push({ id: "", channelId: chId, message: "", useEmbed: false, embedColor: "#ff8c00", enabled: true });
  renderStickies(); scheduleAutoSave();
});

// ── channel autocomplete ──
function setupChannelMention(inputEl) {
  let dropdown = null;
  inputEl.addEventListener("input", (ev) => {
    const text = ev.target.value;
    const lastHash = text.lastIndexOf("#");
    if (lastHash === -1 || lastHash === text.length - 1) { if (dropdown) dropdown.remove(); return; }

    const query = text.slice(lastHash + 1).toLowerCase();
    const matches = state.channels.filter(ch => ch.name.toLowerCase().includes(query)).slice(0, 8);
    if (!matches.length) { if (dropdown) dropdown.remove(); return; }

    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "dropdown visible";
      inputEl.parentElement.appendChild(dropdown);
    }
    dropdown.innerHTML = matches.map(ch => `<div class="dropdown-item" data-ch-id="${ch.id}" data-ch-hash-pos="${lastHash}">#${ch.name}</div>`).join("");

    matches.forEach(ch => {
      dropdown.querySelector(`[data-ch-id="${ch.id}"]`).addEventListener("click", () => {
        const pos = +dropdown.querySelector(`[data-ch-id="${ch.id}"]`).dataset.chHashPos;
        const before = inputEl.value.slice(0, pos);
        const after = inputEl.value.slice(inputEl.value.length);
        inputEl.value = before + "#" + ch.name + after;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        dropdown.remove();
        dropdown = null;
        scheduleAutoSave();
      });
    });
  });
  inputEl.addEventListener("blur", () => { if (dropdown) setTimeout(() => dropdown?.remove(), 200); });
}

// ── auto-save ──
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    api("/automation", { method: "PUT", body: collectAutomation() })
      .then(r => { state.automation = r.automation; $("#au-status").textContent = "Saved " + new Date().toLocaleTimeString(); })
      .catch(e => console.error("Auto-save failed:", e));
  }, 1200);  // wait 1.2s after last change
}
// add auto-save listeners to all automation fields
document.querySelectorAll("#au-ar-enabled, #au-ar-delay, #au-wel-enabled, #au-wel-msg, #au-wel-channel, #au-wel-embed, #au-wel-color, #au-wel-ping, #au-wel-dm, #au-wel-dmmsg, #au-bye-enabled, #au-bye-msg, #au-bye-channel, #au-bye-embed, #au-bye-color, #au-rr-title, #au-rr-text, #au-rr-color, #au-log-enabled, #au-log-channel, #au-log-deletes, #au-log-edits, #au-mod-enabled, #au-mod-caps, #au-mod-capslen, #au-mod-mentions, #au-mod-repeat, #au-mod-invites, #au-mod-links, #au-mod-timeout, #au-mod-deleteonly")
  .forEach(el => { el.addEventListener("input", scheduleAutoSave); el.addEventListener("change", scheduleAutoSave); });

// ── collect + save + actions ──
function collectAutomation() {
  const a = state.automation;
  return {
    autorole: {
      enabled: $("#au-ar-enabled").checked,
      roleIds: a.autorole.roleIds,
      botRoleIds: a.autorole.botRoleIds,
      delaySeconds: Math.max(0, Math.min(600, parseInt($("#au-ar-delay").value, 10) || 0)),
    },
    welcome: {
      enabled: $("#au-wel-enabled").checked,
      channelId: $("#au-wel-channel").value || null,
      message: $("#au-wel-msg").value,
      useEmbed: $("#au-wel-embed").checked,
      embedColor: normalizeHex($("#au-wel-color").value) || "#ff8c00",
      pingUser: $("#au-wel-ping").checked,
      dmEnabled: $("#au-wel-dm").checked,
      dmMessage: $("#au-wel-dmmsg").value,
    },
    goodbye: {
      enabled: $("#au-bye-enabled").checked,
      channelId: $("#au-bye-channel").value || null,
      message: $("#au-bye-msg").value,
      useEmbed: $("#au-bye-embed").checked,
      embedColor: normalizeHex($("#au-bye-color").value) || "#8b6cff",
    },
    reactionRoles: {
      title: $("#au-rr-title").value,
      text: $("#au-rr-text").value,
      color: normalizeHex($("#au-rr-color").value) || "#8b6cff",
      roles: a.reactionRoles.roles,
    },
    autoResponders: a.autoResponders,
    messageLogger: {
      enabled: $("#au-log-enabled").checked,
      channelId: $("#au-log-channel").value || null,
      ignoreChannels: a.messageLogger.ignoreChannels,
      logDeletes: $("#au-log-deletes").checked,
      logEdits: $("#au-log-edits").checked,
    },
    autoModeration: {
      enabled: $("#au-mod-enabled").checked,
      capsSensitivity: Math.max(0, Math.min(100, parseInt($("#au-mod-caps").value, 10) || 70)),
      capsMinLength: Math.max(5, Math.min(1000, parseInt($("#au-mod-capslen").value, 10) || 10)),
      mentionLimit: Math.max(1, Math.min(50, parseInt($("#au-mod-mentions").value, 10) || 5)),
      repeatLimit: Math.max(1, Math.min(20, parseInt($("#au-mod-repeat").value, 10) || 3)),
      blockInvites: $("#au-mod-invites").checked,
      blockLinks: $("#au-mod-links").checked,
      bannedWords: a.autoModeration.bannedWords,
      timeoutSeconds: Math.max(10, Math.min(2419200, parseInt($("#au-mod-timeout").value, 10) || 60)),
      deleteOnly: $("#au-mod-deleteonly").checked,
      ignoreRoles: a.autoModeration.ignoreRoles,
      ignoreChannels: a.autoModeration.ignoreChannels,
    },
    stickyMessages: a.stickyMessages,
  };
}
$("#au-save").addEventListener("click", busy($("#au-save"), async () => {
  const r = await api("/automation", { method: "PUT", body: collectAutomation() });
  state.automation = r.automation;
  $("#au-status").textContent = "Saved " + new Date().toLocaleTimeString();
  toast("Automation saved");
}));
$("#au-ar-applyall").addEventListener("click", busy($("#au-ar-applyall"), async () => {
  if (!confirm("Give the configured autoroles to every current member now?")) return;
  await api("/automation", { method: "PUT", body: collectAutomation() });
  const r = await api("/automation/autorole/apply-all", { method: "POST" });
  toast(`Autorole applied: ${r.changed} updated${r.failed ? `, ${r.failed} failed` : ""}`);
}));
$("#au-wel-test").addEventListener("click", busy($("#au-wel-test"), async () => {
  await api("/automation", { method: "PUT", body: collectAutomation() });
  await api("/automation/welcome/test", { method: "POST" });
  toast("Test welcome sent to the channel");
}));
$("#au-rr-post").addEventListener("click", busy($("#au-rr-post"), async () => {
  const channelId = $("#au-rr-channel").value;
  if (!channelId) throw new Error("Pick a channel to post the panel in");
  await api("/automation", { method: "PUT", body: collectAutomation() });
  await api("/automation/reaction-roles/post", { method: "POST", body: { channelId } });
  toast("Reaction-role panel posted");
}));

// ══════════════════════════════════════════════════════════════════════════════
// Moderation
// ══════════════════════════════════════════════════════════════════════════════
async function loadModeration() {
  await loadGuildData().catch(() => {});
  const d = await api("/moderation");
  $("#mod-count").textContent = String(d.infractions.length);
  $("#mod-list").innerHTML = d.infractions.length ? `
    <table><thead><tr><th>ID</th><th>Type</th><th>User</th><th>Reason</th><th>When</th><th></th></tr></thead><tbody>
    ${d.infractions.map(i => `
      <tr>
        <td class="mono">${esc(i.id)}</td>
        <td><span class="tag ${{ warn: "warn", timeout: "warn", kick: "bad", ban: "bad" }[i.type] || "info"}">${esc(i.type)}</span></td>
        <td><span data-uid="${esc(i.userId)}" class="mono">${esc(i.userId)}</span></td>
        <td>${esc(i.reason || "-")}${i.duration ? ` <span class="muted mono">(${fmtDur(i.duration)})</span>` : ""}</td>
        <td class="mono">${relTime(i.at)}</td>
        <td><button class="btn mini ghost" data-del-inf="${esc(i.id)}">Delete</button></td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty">Clean record everywhere.</div>`;
  resolveUsers($("#mod-list")).catch(() => {});
}

// clear the picked ID whenever the query changes, so a stale pick can never
// be actioned; registered BEFORE wireMemberSearch so raw-ID pastes still stick
$("#mod-user-q").addEventListener("input", () => { $("#mod-user-id").value = ""; });
wireMemberSearch($("#mod-user-q"), $("#mod-user-results"), (m) => {
  $("#mod-user-id").value = m.id;
  $("#mod-user-q").value = m.tag === m.id ? m.id : `${m.tag} (${m.id})`;
});

$("#mod-action").addEventListener("change", () => {
  const a = $("#mod-action").value;
  $("#mod-duration-wrap").classList.toggle("hidden", a !== "timeout");
  $("#mod-days-wrap").classList.toggle("hidden", a !== "ban");
});
$("#mod-duration-wrap").classList.add("hidden");   // default action is warn

$("#mod-go").addEventListener("click", busy($("#mod-go"), async () => {
  const action = $("#mod-action").value;
  const userId = $("#mod-user-id").value || $("#mod-user-q").value.trim();
  if (!/^\d{5,25}$/.test(userId)) throw new Error("Pick a member (or paste a raw user ID)");
  if (["ban", "kick"].includes(action) && !confirm(`Really ${action} this user?`)) return;
  const r = await api("/moderation/action", { method: "POST", body: {
    action, userId,
    reason: $("#mod-reason").value.trim(),
    duration: $("#mod-duration").value.trim(),
    deleteDays: parseInt($("#mod-days").value, 10) || 0,
  }});
  toast(r.note || "Done");
  $("#mod-reason").value = "";
  loadModeration().catch(() => {});
}));

$("#mod-list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-del-inf]");
  if (!btn) return;
  if (!confirm(`Delete infraction ${btn.dataset.delInf}?`)) return;
  try { await api(`/moderation/${btn.dataset.delInf}`, { method: "DELETE" }); toast("Infraction removed"); loadModeration(); }
  catch (e) { toast(e.message, true); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Applications (owner config for the /apply site)
// ══════════════════════════════════════════════════════════════════════════════
async function loadApplications() {
  await loadGuildData().catch(() => {});
  const [cfg, stats] = await Promise.all([api("/applications/config"), api("/applications/stats").catch(() => null)]);
  const c = cfg.config;
  state.appConfig = c;

  $("#ap-open").checked = c.open;
  $("#ap-servername").value = c.serverName || "";
  $("#ap-minage").value = c.minAge;
  $("#ap-cooldown").value = c.cooldownHours;
  $("#ap-assignrole").checked = c.assignRoleOnAccept;
  $("#ap-dm-accept").checked = c.dmOnAccept;
  $("#ap-dm-deny").checked = c.dmOnDeny;
  $("#ap-dm-interview").checked = c.dmOnInterview;
  $("#ap-msg-accept").value = c.acceptDM || "";
  $("#ap-msg-deny").value = c.denyDM || "";
  $("#ap-msg-interview").value = c.interviewDM || "";

  const st = $("#ap-revpw-state");
  st.textContent = c.reviewerPasswordSet ? "password set" : "no password yet, set one so mods can log in";
  st.className = "tag " + (c.reviewerPasswordSet ? "ok" : "warn");

  renderAppPositions();
  renderAppDepartments();
  renderAppStats(stats);
  loadReviewerCodes().catch(() => {});
}

async function loadReviewerCodes() {
  const d = await api("/applications/reviewer-codes");
  renderReviewerCodes(d.codes || []);
}
function renderReviewerCodes(codes) {
  const el = $("#ap-code-list");
  if (!el) return;
  if (!codes.length) { el.innerHTML = `<p class="muted small">No codes yet. Generate one below and send it to a moderator.</p>`; return; }
  el.innerHTML = `<table><thead><tr><th>For</th><th>Code</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>
    ${codes.map(c => {
      const used = !!c.usedAt;
      const status = used ? `used by ${esc(c.usedBy || c.label)}` : "unused";
      return `<tr>
        <td>${esc(c.label)}</td>
        <td class="mono">${c.code ? esc(c.code) : `<span class="muted">spent</span>`}</td>
        <td><span class="tag ${used ? "" : "ok"}">${status}</span></td>
        <td class="muted small">${used ? "-" : relTimeUntil(c.expiresAt)}</td>
        <td><button class="btn ghost mini" data-code-rm="${esc(c.code || "")}" ${c.code ? "" : "disabled"} title="revoke">✕</button></td>
      </tr>`;
    }).join("")}
  </tbody></table>`;
}
$("#ap-code-create").addEventListener("click", busy($("#ap-code-create"), async () => {
  const label = $("#ap-code-label").value.trim();
  if (!label) { toast("Say who the code is for", true); return; }
  const r = await api("/applications/reviewer-codes", { method: "POST", body: { label } });
  $("#ap-code-label").value = "";
  await loadReviewerCodes();
  toast(`Code for ${r.label}: ${r.code} (copy it now, shown once)`);
}));
$("#ap-code-list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-code-rm]");
  if (!btn || !btn.dataset.codeRm) return;
  if (!confirm("Revoke this code? It will stop working immediately.")) return;
  try { await api(`/applications/reviewer-codes/${encodeURIComponent(btn.dataset.codeRm)}`, { method: "DELETE" }); await loadReviewerCodes(); toast("Code revoked"); }
  catch (e) { toast(e.message, true); }
});

function renderAppStats(stats) {
  const el = $("#ap-stats");
  if (!el) return;
  const c = stats?.counts;
  if (!c) { el.innerHTML = ""; return; }
  const cell = (label, val, cls) => `<div class="stat"><div class="k">${label}</div><div class="v ${cls || ""}">${val}</div></div>`;
  el.innerHTML =
    cell("PENDING", c.pending, c.pending ? "bad" : "") +
    cell("INTERVIEW", c.interview) +
    cell("ACCEPTED", c.accepted, c.accepted ? "ok" : "") +
    cell("DENIED", c.denied) +
    cell("TOTAL", c.all);
}

function renderAppPositions() {
  const positions = state.appConfig.positions;
  $("#ap-positions").innerHTML = positions.map((p, i) => `
    <div class="ap-pos ${p.enabled ? "" : "off"}">
      <div class="ap-pos-head">
        <label class="switch sm"><input type="checkbox" data-ap-i="${i}" data-ap-f="enabled" ${p.enabled ? "checked" : ""}><span class="track"></span></label>
        <input class="input ap-pos-name" data-ap-i="${i}" data-ap-f="name" value="${esc(p.name)}" maxlength="40">
        <select class="input" data-ap-i="${i}" data-ap-f="roleId" data-role-value="${esc(p.roleId || "")}"></select>
      </div>
      <input class="input" data-ap-i="${i}" data-ap-f="description" value="${esc(p.description || "")}" maxlength="200" placeholder="Short blurb shown on the apply page">
    </div>`).join("");
  // fill each role select
  positions.forEach((p, i) => {
    const sel = $(`#ap-positions [data-ap-i="${i}"][data-ap-f="roleId"]`);
    if (sel) fillRoleSelect(sel, { none: "no role (assign manually)", value: p.roleId });
  });
}
function apPosEdit(el) {
  const p = state.appConfig.positions[+el.dataset.apI];
  if (!p) return;
  const f = el.dataset.apF;
  p[f] = (el.type === "checkbox") ? el.checked : (f === "roleId" ? (el.value || null) : el.value);
  if (f === "enabled") el.closest(".ap-pos").classList.toggle("off", !el.checked);
}
$("#ap-positions").addEventListener("input",  (ev) => { const el = ev.target.closest("[data-ap-i]"); if (el) apPosEdit(el); });
$("#ap-positions").addEventListener("change", (ev) => { const el = ev.target.closest("[data-ap-i]"); if (el) apPosEdit(el); });

function renderAppDepartments() {
  const departments = state.appConfig.departments || [];
  $("#ap-departments").innerHTML = departments.map((d, i) => `
    <div class="ap-pos ${d.enabled ? "" : "off"}">
      <div class="ap-pos-head">
        <label class="switch sm"><input type="checkbox" data-apd-i="${i}" data-apd-f="enabled" ${d.enabled ? "checked" : ""}><span class="track"></span></label>
        <input class="input ap-pos-name" data-apd-i="${i}" data-apd-f="name" value="${esc(d.name)}" maxlength="40">
        <select class="input" data-apd-i="${i}" data-apd-f="roleId" data-role-value="${esc(d.roleId || "")}"></select>
      </div>
      <input class="input" data-apd-i="${i}" data-apd-f="description" value="${esc(d.description || "")}" maxlength="200" placeholder="Short blurb shown on the apply page">
    </div>`).join("");
  departments.forEach((d, i) => {
    const sel = $(`#ap-departments [data-apd-i="${i}"][data-apd-f="roleId"]`);
    if (sel) fillRoleSelect(sel, { none: "no role (falls back to Department Leader's role)", value: d.roleId });
  });
}
function apDeptEdit(el) {
  const d = (state.appConfig.departments || [])[+el.dataset.apdI];
  if (!d) return;
  const f = el.dataset.apdF;
  d[f] = (el.type === "checkbox") ? el.checked : (f === "roleId" ? (el.value || null) : el.value);
  if (f === "enabled") el.closest(".ap-pos").classList.toggle("off", !el.checked);
}
$("#ap-departments").addEventListener("input",  (ev) => { const el = ev.target.closest("[data-apd-i]"); if (el) apDeptEdit(el); });
$("#ap-departments").addEventListener("change", (ev) => { const el = ev.target.closest("[data-apd-i]"); if (el) apDeptEdit(el); });

function collectAppConfig() {
  const c = state.appConfig;
  return {
    open: $("#ap-open").checked,
    serverName: $("#ap-servername").value,
    minAge: parseInt($("#ap-minage").value, 10) || 13,
    cooldownHours: parseInt($("#ap-cooldown").value, 10) || 0,
    assignRoleOnAccept: $("#ap-assignrole").checked,
    dmOnAccept: $("#ap-dm-accept").checked,
    dmOnDeny: $("#ap-dm-deny").checked,
    dmOnInterview: $("#ap-dm-interview").checked,
    acceptDM: $("#ap-msg-accept").value,
    denyDM: $("#ap-msg-deny").value,
    interviewDM: $("#ap-msg-interview").value,
    positions: c.positions.map(p => ({ id: p.id, name: p.name, description: p.description, enabled: p.enabled, roleId: p.roleId })),
    departments: (c.departments || []).map(d => ({ id: d.id, name: d.name, description: d.description, enabled: d.enabled, roleId: d.roleId })),
  };
}
$("#ap-save").addEventListener("click", busy($("#ap-save"), async () => {
  const r = await api("/applications/config", { method: "PUT", body: collectAppConfig() });
  state.appConfig = r.config;
  $("#ap-status").textContent = "Saved " + new Date().toLocaleTimeString();
  toast("Applications settings saved");
}));
$("#ap-revpw-save").addEventListener("click", busy($("#ap-revpw-save"), async () => {
  const pw = $("#ap-revpw").value;
  if (pw.length < 4) { toast("Reviewer password must be at least 4 characters", true); return; }
  await api("/applications/reviewer-password", { method: "POST", body: { password: pw } });
  $("#ap-revpw").value = "";
  const st = $("#ap-revpw-state"); st.textContent = "password set"; st.className = "tag ok";
  toast("Reviewer password set, share it with your mods");
}));

// ══════════════════════════════════════════════════════════════════════════════
// Security
// ══════════════════════════════════════════════════════════════════════════════
function renderChips(el, ids, nameFn, removeAttr) {
  el.innerHTML = ids.length
    ? ids.map(id => `<span class="chip">${esc(nameFn(id))}<button title="remove" data-${removeAttr}="${esc(id)}">x</button></span>`).join("")
    : `<span class="muted small">none</span>`;
}

async function loadSecurity() {
  await loadGuildData().catch(() => {});
  const d = await api("/security");
  state.security = d.config;
  const c = d.config;

  $("#sec-enabled").checked = c.antiNuke;
  $("#sec-banlock").checked = c.lockBans;
  $("#sec-punishment").value = c.punishment;
  $("#sec-threshold").value = c.massThreshold;
  $("#sec-window").value = Math.round(c.massWindowMs / 1000);
  $("#sec-jr-enabled").checked = c.joinRaid.enabled;
  $("#sec-jr-verify").checked = c.joinRaid.raiseVerification;
  $("#sec-jr-threshold").value = c.joinRaid.threshold;
  $("#sec-jr-window").value = Math.round(c.joinRaid.windowMs / 1000);
  $("#sec-jr-age").value = c.joinRaid.minAccountAgeDays;

  $("#sec-lockdown").textContent = c.lockdown ? "Lift lockdown" : "Lock down server";
  $("#sec-lockdown").classList.toggle("danger", !c.lockdown);
  $("#sec-snapshot").textContent = `Snapshot: ${d.snapshot.channels} channels, ${d.snapshot.roles} roles`;

  renderChips($("#sec-wl-users"), c.whitelistUsers, id => state.userCache.get(id) || id, "wl-user-rm");
  renderChips($("#sec-wl-roles"), c.whitelistRoles, roleName, "wl-role-rm");
  renderChips($("#sec-prot-channels"), c.protectedChannels, id => `#${channelName(id)}`, "prot-ch-rm");
  renderChips($("#sec-prot-roles"), c.protectedRoles, roleName, "prot-role-rm");
  // resolve whitelist user tags in the background, then re-label the chips
  (async () => {
    let changed = false;
    for (const id of c.whitelistUsers) {
      if (state.userCache.has(id)) continue;
      try { const r = await api(`/users/${id}`); state.userCache.set(id, r.user.tag); changed = true; } catch (e) {}
    }
    if (changed) renderChips($("#sec-wl-users"), c.whitelistUsers, id => state.userCache.get(id) || id, "wl-user-rm");
  })();

  fillRoleSelect($("#sec-wl-role-pick"), { none: "pick a role" });
  fillRoleSelect($("#sec-prot-role-pick"), { none: "pick a role" });
  fillChannelSelect($("#sec-prot-ch-pick"), { types: [0, 2, 4, 5, 15], none: "pick a channel" });
}

wireMemberSearch($("#sec-wl-user-q"), $("#sec-wl-user-results"), async (m) => {
  $("#sec-wl-user-q").value = "";
  if (!state.security.whitelistUsers.includes(m.id)) state.security.whitelistUsers.push(m.id);
  state.userCache.set(m.id, m.tag);
  renderChips($("#sec-wl-users"), state.security.whitelistUsers, id => state.userCache.get(id) || id, "wl-user-rm");
});
$("#sec-wl-role-add").addEventListener("click", () => {
  const id = $("#sec-wl-role-pick").value;
  if (!id) return;
  if (!state.security.whitelistRoles.includes(id)) state.security.whitelistRoles.push(id);
  renderChips($("#sec-wl-roles"), state.security.whitelistRoles, roleName, "wl-role-rm");
});
$("#sec-prot-ch-add").addEventListener("click", () => {
  const id = $("#sec-prot-ch-pick").value;
  if (!id) return;
  if (!state.security.protectedChannels.includes(id)) state.security.protectedChannels.push(id);
  renderChips($("#sec-prot-channels"), state.security.protectedChannels, id2 => `#${channelName(id2)}`, "prot-ch-rm");
});
$("#sec-prot-role-add").addEventListener("click", () => {
  const id = $("#sec-prot-role-pick").value;
  if (!id) return;
  if (!state.security.protectedRoles.includes(id)) state.security.protectedRoles.push(id);
  renderChips($("#sec-prot-roles"), state.security.protectedRoles, roleName, "prot-role-rm");
});
$("#view-security").addEventListener("click", (ev) => {
  const c = state.security;
  if (!c) return;
  const rm = (attr, arr, rerender) => {
    const btn = ev.target.closest(`[data-${attr}]`);
    if (!btn) return false;
    const id = btn.dataset[attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())];
    const idx = arr.indexOf(id);
    if (idx !== -1) arr.splice(idx, 1);
    rerender();
    return true;
  };
  rm("wl-user-rm", c.whitelistUsers, () => renderChips($("#sec-wl-users"), c.whitelistUsers, id => state.userCache.get(id) || id, "wl-user-rm")) ||
  rm("wl-role-rm", c.whitelistRoles, () => renderChips($("#sec-wl-roles"), c.whitelistRoles, roleName, "wl-role-rm")) ||
  rm("prot-ch-rm", c.protectedChannels, () => renderChips($("#sec-prot-channels"), c.protectedChannels, id => `#${channelName(id)}`, "prot-ch-rm")) ||
  rm("prot-role-rm", c.protectedRoles, () => renderChips($("#sec-prot-roles"), c.protectedRoles, roleName, "prot-role-rm"));
});

$("#sec-save").addEventListener("click", busy($("#sec-save"), async () => {
  const c = state.security;
  await api("/security/config", { method: "PUT", body: {
    antiNuke: $("#sec-enabled").checked,
    lockBans: $("#sec-banlock").checked,
    punishment: $("#sec-punishment").value,
    massThreshold: parseInt($("#sec-threshold").value, 10),
    massWindowMs: (parseInt($("#sec-window").value, 10) || 12) * 1000,
    whitelistUsers: c.whitelistUsers,
    whitelistRoles: c.whitelistRoles,
    protectedChannels: c.protectedChannels,
    protectedRoles: c.protectedRoles,
    joinRaid: {
      enabled: $("#sec-jr-enabled").checked,
      raiseVerification: $("#sec-jr-verify").checked,
      threshold: parseInt($("#sec-jr-threshold").value, 10),
      windowMs: (parseInt($("#sec-jr-window").value, 10) || 15) * 1000,
      minAccountAgeDays: parseInt($("#sec-jr-age").value, 10),
    },
  }});
  toast("Security config saved");
}));

$("#sec-lockdown").addEventListener("click", busy($("#sec-lockdown"), async () => {
  const on = !state.security?.lockdown;
  if (!confirm(on ? "Lock down the whole server? @everyone loses send access." : "Lift the lockdown?")) return;
  const r = await api("/security/lockdown", { method: "POST", body: { on } });
  toast(`${on ? "Locked down" : "Unlocked"} ${r.channelsAffected} channel(s)`);
  loadSecurity().catch(() => {});
}));

$("#sec-resnapshot").addEventListener("click", busy($("#sec-resnapshot"), async () => {
  const r = await api("/security/resnapshot", { method: "POST" });
  toast(`Snapshot refreshed: ${r.channels} channels, ${r.roles} roles`);
  $("#sec-snapshot").textContent = `Snapshot: ${r.channels} channels, ${r.roles} roles`;
}));

// ══════════════════════════════════════════════════════════════════════════════
// Giveaways
// ══════════════════════════════════════════════════════════════════════════════
async function loadGiveaways() {
  await loadGuildData().catch(() => {});
  fillChannelSelect($("#gw-channel"), { none: "pick a channel" });
  fillRoleSelect($("#gw-role"), { none: "anyone can enter" });

  const d = await api("/giveaways");
  $("#gw-active").innerHTML = d.active.length ? `
    <table><thead><tr><th>Prize</th><th>Channel</th><th>Entries</th><th>Winners</th><th>Ends</th><th></th></tr></thead><tbody>
    ${d.active.map(g => `
      <tr>
        <td>${esc(g.prize)}</td>
        <td class="mono">#${esc(channelName(g.channelId))}</td>
        <td class="mono">${g.entries}</td>
        <td class="mono">${g.winners}</td>
        <td class="mono">${new Date(g.endsAt).toLocaleString()}</td>
        <td><button class="btn mini danger" data-gw-end="${esc(g.messageId)}">End now</button></td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty">No active giveaways.</div>`;

  $("#gw-ended").innerHTML = d.ended.length ? `
    <table><thead><tr><th>Prize</th><th>Entries</th><th>Winners picked</th><th>Ended</th><th></th></tr></thead><tbody>
    ${d.ended.map(g => `
      <tr>
        <td>${esc(g.prize)}</td>
        <td class="mono">${g.entries}</td>
        <td class="mono">${g.winnerIds.length}</td>
        <td class="mono">${relTime(g.endsAt)}</td>
        <td><button class="btn mini" data-gw-reroll="${esc(g.messageId)}">Reroll</button></td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty">No ended giveaways yet.</div>`;
}

$("#gw-start").addEventListener("click", busy($("#gw-start"), async () => {
  const body = {
    prize: $("#gw-prize").value.trim(),
    channelId: $("#gw-channel").value,
    duration: $("#gw-duration").value.trim(),
    winners: parseInt($("#gw-winners").value, 10) || 1,
    requiredRoleId: $("#gw-role").value || null,
  };
  if (!body.prize) throw new Error("Give the giveaway a prize");
  if (!body.channelId) throw new Error("Pick a channel");
  await api("/giveaways", { method: "POST", body });
  toast("Giveaway started");
  $("#gw-prize").value = ""; $("#gw-duration").value = "";
  loadGiveaways().catch(() => {});
}));

$("#view-giveaways").addEventListener("click", async (ev) => {
  const end = ev.target.closest("[data-gw-end]");
  const reroll = ev.target.closest("[data-gw-reroll]");
  try {
    if (end) {
      if (!confirm("End this giveaway now and pick winners?")) return;
      await api(`/giveaways/${end.dataset.gwEnd}/end`, { method: "POST" });
      toast("Giveaway ended");
      loadGiveaways();
    }
    if (reroll) {
      const n = prompt("How many new winners?", "1");
      if (n === null) return;
      await api(`/giveaways/${reroll.dataset.gwReroll}/reroll`, { method: "POST", body: { winners: parseInt(n, 10) || 1 } });
      toast("Rerolled");
      loadGiveaways();
    }
  } catch (e) { toast(e.message, true); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Testers
// ══════════════════════════════════════════════════════════════════════════════
async function loadTesters() {
  const d = await api("/testers");
  $("#testers-list").innerHTML = d.testers.length ? `
    <table><thead><tr><th>MC name</th><th>Discord</th><th>Rank</th><th>Status</th><th>Linked</th><th></th></tr></thead><tbody>
    ${d.testers.map(t => `
      <tr>
        <td class="mono">${esc(t.mcName)}</td>
        <td>${esc(t.discordTag || "-")}</td>
        <td>${esc(t.rank || "-")}</td>
        <td><span class="tag ${t.verified ? "ok" : "warn"}">${t.verified ? "linked" : "pending"}</span></td>
        <td class="mono">${relTime(t.linkedAt || t.createdAt)}</td>
        <td><button class="btn mini ghost" data-unlink="${esc(t.code)}">Unlink</button></td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty">No linked testers yet.</div>`;
}
$("#testers-list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-unlink]");
  if (!btn) return;
  if (!confirm("Remove this tester link?")) return;
  try { await api(`/testers/${encodeURIComponent(btn.dataset.unlink)}`, { method: "DELETE" }); toast("Unlinked"); loadTesters(); }
  catch (e) { toast(e.message, true); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Messages
// ══════════════════════════════════════════════════════════════════════════════
async function loadMessages() {
  await loadGuildData().catch(() => {});
  fillChannelSelect($("#msg-channel"), { none: "pick a channel" });
}
$("#msg-send").addEventListener("click", busy($("#msg-send"), async () => {
  const body = {
    channelId: $("#msg-channel").value,
    content: $("#msg-content").value,
    embedTitle: $("#msg-embed-title").value.trim(),
    embedText: $("#msg-embed-text").value.trim(),
    embedColor: $("#msg-embed-color").value.trim(),
  };
  if (!body.channelId) throw new Error("Pick a channel");
  await api("/message", { method: "POST", body });
  toast("Message sent");
  $("#msg-content").value = ""; $("#msg-embed-title").value = ""; $("#msg-embed-text").value = "";
}));

// ══════════════════════════════════════════════════════════════════════════════
// Bot
// ══════════════════════════════════════════════════════════════════════════════
async function loadBot() {
  const [p, o] = await Promise.all([api("/presence"), api("/overview")]);
  if (p.presence) {
    $("#bot-status").value = p.presence.status || "online";
    $("#bot-acttype").value = p.presence.activityType || "playing";
    $("#bot-acttext").value = p.presence.activityText || "";
  }
  $("#bot-process").innerHTML = [
    ["Node", o.process.node],
    ["Memory", `${o.process.memMB} MB`],
    ["Process uptime", fmtDur(o.process.uptimeS * 1000)],
    ["Discord", o.bot.ready ? `${o.bot.tag} (${o.bot.wsPing}ms)` : "offline"],
  ].map(([k, v]) => `<div class="row-kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join("");
}
$("#bot-presence-save").addEventListener("click", busy($("#bot-presence-save"), async () => {
  await api("/presence", { method: "PUT", body: {
    status: $("#bot-status").value,
    activityType: $("#bot-acttype").value,
    activityText: $("#bot-acttext").value.trim(),
  }});
  toast("Presence applied");
}));

// ── boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.ok) showApp(); else showLogin();
  } catch (e) { showLogin(); }
})();
