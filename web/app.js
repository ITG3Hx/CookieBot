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
    </div>`).join("") : `<p class="muted small">No topics yet — the panel shows a single button.</p>`;
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

  if (t.status !== "open") { $("#modal-foot").innerHTML = `<span class="muted small">This ticket is closed — read-only transcript.</span>`; return; }

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
