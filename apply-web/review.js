"use strict";
/* Cookie SMP, moderator review panel.
   DOM shells: #login-screen (#login-form #login-name #login-pass #login-error)
               #panel (#reviewer-name #logout-btn #filters #app-list #detail)
   Everything inside #app-list and #detail is rendered here. */

(function () {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { filter: "all", list: [], counts: {}, currentId: null };

const STATUS = {
  pending:   { label: "Pending",   cls: "pending" },
  interview: { label: "Interview", cls: "interview" },
  accepted:  { label: "Accepted",  cls: "accepted" },
  denied:    { label: "Denied",    cls: "denied" },
};
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmt(ts) { if (!ts) return "-"; const d = new Date(ts); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

async function api(path, opts = {}) {
  const init = { headers: {}, credentials: "same-origin", ...opts };
  if (init.body && typeof init.body !== "string") { init.body = JSON.stringify(init.body); init.headers["content-type"] = "application/json"; }
  const res = await fetch("/apply/api" + path, init);
  if (res.status === 401) { showLogin(); throw new Error("logged out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

// ── auth ──
function showLogin() { $("#login-screen").classList.remove("hidden"); $("#panel").classList.add("hidden"); }
function showPanel(name) {
  $("#login-screen").classList.add("hidden");
  $("#panel").classList.remove("hidden");
  if (name) $("#reviewer-name").textContent = name;
  loadList();
}

async function init() {
  try { const me = await api("/me"); showPanel(me.name); }
  catch (e) { showLogin(); }
}

$("#login-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  try {
    const res = await fetch("/apply/review/login", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("#login-pass").value, name: $("#login-name").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");
    $("#login-pass").value = "";
    showPanel(data.name);
  } catch (e) { err.textContent = e.message; }
});
$("#logout-btn")?.addEventListener("click", async () => {
  await fetch("/apply/review/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  state.currentId = null;
  showLogin();
});

// ── list ──
async function loadList() {
  const q = state.filter === "all" ? "" : "?status=" + state.filter;
  const data = await api("/applications" + q);
  state.list = data.applications;
  state.counts = data.counts;
  renderFilters();
  renderList();
}
function renderFilters() {
  $$("#filters [data-filter]").forEach(b => {
    const f = b.dataset.filter;
    b.classList.toggle("active", f === state.filter);
    const badge = b.querySelector(".fcount");
    if (badge) badge.textContent = state.counts[f] ?? 0;
  });
}
function renderList() {
  const el = $("#app-list");
  if (!state.list.length) { el.innerHTML = `<p class="empty">No applications here.</p>`; return; }
  el.innerHTML = state.list.map(a => {
    const s = STATUS[a.status] || STATUS.pending;
    return `<button class="app-item${a.id === state.currentId ? " active" : ""}" data-id="${a.id}">
      <div class="app-item-top">
        <span class="app-pos">${esc(a.positionName)}${a.departmentName ? ` &middot; ${esc(a.departmentName)}` : ""}</span>
        <span class="dot ${s.cls}">${s.label}</span>
      </div>
      <div class="app-who">${esc(a.discord)} · <span class="mono">${esc(a.minecraft)}</span></div>
      <div class="app-meta">${esc(a.ref)} · ${fmt(a.createdAt)}</div>
    </button>`;
  }).join("");
}
$("#filters")?.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-filter]");
  if (!b) return;
  state.filter = b.dataset.filter;
  loadList().catch(e => toast(e.message, true));
});
$("#app-list")?.addEventListener("click", (ev) => {
  const b = ev.target.closest(".app-item");
  if (!b) return;
  openDetail(b.dataset.id).catch(e => toast(e.message, true));
});

// ── detail ──
async function openDetail(id) {
  state.currentId = id;
  renderList();
  const data = await api("/applications/" + id);
  renderDetail(data.application);
}
function field(label, value, mono) {
  if (!value && value !== 0) return "";
  return `<div class="d-field"><dt>${esc(label)}</dt><dd class="${mono ? "mono" : ""}">${esc(value)}</dd></div>`;
}
function block(label, value) {
  return `<div class="d-block"><dt>${esc(label)}</dt><dd>${esc(value || "-")}</dd></div>`;
}
function renderDetail(a) {
  const s = STATUS[a.status] || STATUS.pending;
  $("#detail").innerHTML = `
    <div class="d-head">
      <div>
        <h2>${esc(a.positionName)} application</h2>
        <p class="d-sub">${esc(a.ref)} · submitted ${fmt(a.createdAt)}</p>
      </div>
      <span class="dot big ${s.cls}">${s.label}</span>
    </div>

    <div class="d-grid">
      ${field("Department", a.departmentName)}
      ${field("Discord", a.discord)}
      ${field("Discord ID", a.discordId, true)}
      ${field("Minecraft", a.minecraft, true)}
      ${field("Age", a.age)}
      ${field("Timezone", a.timezone)}
      ${field("Hours / week", a.hours)}
    </div>

    ${block("Past experience", a.experience)}
    ${block("Why should we pick you?", a.why)}
    ${block("Scenario answer", a.scenario)}
    ${a.extra ? block("Extra", a.extra) : ""}

    ${a.decidedBy ? `<p class="d-decided">Last decision by <b>${esc(a.decidedBy)}</b> · ${fmt(a.decidedAt)}</p>` : ""}

    <div class="d-actions">
      <label class="d-note-label">Note (kept internal)
        <textarea id="decide-note" rows="2" maxlength="1000" placeholder="Optional note for the team">${esc(a.reviewerNote || "")}</textarea>
      </label>
      <div class="d-btns">
        <button class="rbtn accept"    data-action="accept">Accept</button>
        <button class="rbtn interview" data-action="interview">Interview</button>
        <button class="rbtn deny"      data-action="deny">Deny</button>
        <button class="rbtn ghost"     data-action="pending">Reset to pending</button>
        <button class="rbtn danger"    data-del title="Delete application">Delete</button>
      </div>
    </div>`;
}
function detailEmpty() {
  $("#detail").innerHTML = `<div class="d-empty"><p>Select an application to review it.</p></div>`;
}

$("#detail")?.addEventListener("click", async (ev) => {
  const act = ev.target.closest("[data-action]");
  const del = ev.target.closest("[data-del]");
  if (act) {
    const action = act.dataset.action;
    const note = $("#decide-note")?.value || "";
    const verb = { accept: "Accept", deny: "Deny", interview: "mark for interview", pending: "reset" }[action];
    if ((action === "accept" || action === "deny") && !confirm(`${verb} this application?`)) return;
    ev.target.closest(".d-btns")?.querySelectorAll("button").forEach(b => b.disabled = true);
    try {
      const r = await api(`/applications/${state.currentId}/decide`, { method: "POST", body: { action, note } });
      let msg = `Marked ${r.application.status}`;
      if (r.roleGiven) msg += " · role assigned";
      if (r.dmSent) msg += " · DM sent";
      toast(msg);
      if (r.warn) toast("Heads up: " + r.warn, true);
      await loadList();
      renderDetail(r.application);
    } catch (e) { toast(e.message, true); ev.target.closest(".d-btns")?.querySelectorAll("button").forEach(b => b.disabled = false); }
    return;
  }
  if (del) {
    if (!confirm("Delete this application permanently?")) return;
    try {
      await api("/applications/" + state.currentId, { method: "DELETE" });
      toast("Application deleted");
      state.currentId = null;
      detailEmpty();
      await loadList();
    } catch (e) { toast(e.message, true); }
  }
});

document.addEventListener("DOMContentLoaded", () => { detailEmpty(); init(); });
})();
