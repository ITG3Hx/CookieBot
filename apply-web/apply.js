"use strict";
/* Cookie SMP, public application page.
   Talks to /apply/api/config and /apply/api/submit.

   Expected DOM (ids):
     #positions-grid   container for position cards (rendered here)
     #f-position       <select> of positions
     #f-discord #f-discordid #f-minecraft #f-age #f-timezone #f-hours
     #f-experience #f-why #f-scenario     form fields
     #f-website        honeypot input (visually hidden)
     #apply-form       the <form>
     #submit-btn       submit button
     #form-error       inline error line
     #minage-note      spans showing the minimum age (optional, may be many)
     #form-card        the card wrapping the form (hidden when closed)
     #closed-note      shown when applications are closed
     #success          success panel (hidden until submitted)
     #success-ref      element that receives the reference code
   Extra questions per position are not used yet; the form is fixed.
*/

(function () {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let CONFIG = null;

async function jpost(url, body) {
  let res;
  try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, status: 0, data: { error: "Couldn't reach the server. Check your connection and try again." } }; }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, status: res.status, data };
}

function initials(name) {
  return name.split(/[\s-]+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// One small line icon per role id, standing in for real Discord role icons
// until a mapped role actually has a custom icon/emoji set. Chosen to echo
// the server's real role icons: crown for admin, checkmark for moderator,
// a rising chart for developer, a key for representative, a shield for helper.
const ROLE_ICON_PATHS = {
  administrator:     '<path d="M4 17l2-9 4.5 4.5L12 6l1.5 6.5L18 8l2 9z"/><path d="M5 20h14"/>',
  "department-leader": '<path d="M12 3l8 4-8 4-8-4z"/><path d="M4 11l8 4 8-4"/><path d="M4 15l8 4 8-4"/>',
  helper:            '<path d="M12 2l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V5z"/>',
  partner:           '<path d="M9 15l6-6"/><path d="M8 12l-3 3a3 3 0 0 0 4.2 4.2l1.3-1.3"/><path d="M16 12l3-3a3 3 0 0 0-4.2-4.2l-1.3 1.3"/>',
  moderator:         '<path d="M12 2l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V5z"/><path d="M9 12l2 2 4-4"/>',
  developer:         '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  representative:    '<circle cx="7" cy="17" r="3"/><path d="M9.5 14.5L19 5"/><path d="M16 8l2.5 2.5"/><path d="M13 11l2 2"/>',
};
function roleIconSvg(id) {
  const path = ROLE_ICON_PATHS[id];
  if (!path) return null;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
// badge = { icon, emoji, color } pulled live from the mapped Discord role. Falls
// back to a built-in role icon, and only to initials if the id is unrecognized.
function badgeHtml(badge, name, cls, id) {
  if (badge?.icon) return `<span class="${cls} img"><img src="${escapeHtml(badge.icon)}" alt=""></span>`;
  if (badge?.emoji) return `<span class="${cls} emoji">${escapeHtml(badge.emoji)}</span>`;
  const svg = roleIconSvg(id);
  if (svg) return `<span class="${cls} svgicon">${svg}</span>`;
  return `<span class="${cls}">${escapeHtml(initials(name))}</span>`;
}
function positionCard(p, active) {
  const preview = p.id === "department-leader" && CONFIG?.departments?.length
    ? `<span class="dept-preview">${CONFIG.departments.map(d => badgeHtml(d.badge, d.name, "dept-chip", d.id)).join("")}</span>`
    : "";
  return `<button type="button" class="pos-card${active ? " active" : ""}" data-pos="${p.id}">
    ${badgeHtml(p.badge, p.name, "pos-badge", p.id)}
    <span class="pos-name">${escapeHtml(p.name)}</span>
    <span class="pos-desc">${escapeHtml(p.description || "")}</span>
    ${preview}
  </button>`;
}

function toggleDepartmentField() {
  const isDeptLeader = $("#f-position")?.value === "department-leader";
  $("#f-department-wrap")?.classList.toggle("hidden", !isDeptLeader);
  const deptSel = $("#f-department");
  if (deptSel) deptSel.required = isDeptLeader;
}
function selectPosition(id) {
  const sel = $("#f-position");
  if (sel) sel.value = id;
  $$(".pos-card").forEach(c => c.classList.toggle("active", c.dataset.pos === id));
  toggleDepartmentField();
}

async function loadConfig() {
  const res = await fetch("/apply/api/config");
  CONFIG = await res.json();

  // reflect minimum age everywhere it's mentioned
  $$("#minage-note, [data-minage]").forEach(el => { el.textContent = CONFIG.minAge; });
  const ageInput = $("#f-age");
  if (ageInput) ageInput.min = CONFIG.minAge;

  if (!CONFIG.open) {
    $("#form-card")?.classList.add("hidden");
    $("#closed-note")?.classList.remove("hidden");
    return;
  }

  // position cards + select options
  const grid = $("#positions-grid");
  if (grid) grid.innerHTML = CONFIG.positions.map((p, i) => positionCard(p, i === 0)).join("");
  const sel = $("#f-position");
  if (sel) sel.innerHTML = CONFIG.positions.map((p, i) => `<option value="${p.id}"${i === 0 ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("");

  const deptSel = $("#f-department");
  if (deptSel) deptSel.innerHTML = `<option value="" disabled selected>Choose a department</option>` +
    (CONFIG.departments || []).map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");

  grid?.addEventListener("click", (ev) => {
    const card = ev.target.closest(".pos-card");
    if (!card) return;
    selectPosition(card.dataset.pos);
    $("#form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  sel?.addEventListener("change", toggleDepartmentField);
  toggleDepartmentField();
}

function showError(msg) {
  const el = $("#form-error");
  if (el) { el.textContent = msg; el.classList.add("show"); }
}
function clearError() { const el = $("#form-error"); if (el) { el.textContent = ""; el.classList.remove("show"); } }

function collect() {
  const val = id => ($(id)?.value || "").trim();
  return {
    website: $("#f-website")?.value || "",   // honeypot
    position: val("#f-position"),
    department: val("#f-department"),
    discord: val("#f-discord"),
    discordId: val("#f-discordid"),
    minecraft: val("#f-minecraft"),
    age: val("#f-age"),
    timezone: val("#f-timezone"),
    hours: val("#f-hours"),
    experience: val("#f-experience"),
    why: val("#f-why"),
    scenario: val("#f-scenario"),
  };
}

// client-side mirror of the server rules, for instant feedback
function clientValidate(b) {
  if (!b.position) return "Please choose a position.";
  if (b.position === "department-leader" && !b.department) return "Pick which department you'd like to lead.";
  if (!b.discord) return "Your Discord username is required.";
  if (!b.minecraft) return "Your Minecraft username is required.";
  const age = parseInt(b.age, 10);
  if (!Number.isFinite(age) || age < (CONFIG?.minAge || 13)) return `You must be at least ${CONFIG?.minAge || 13} to apply.`;
  if (!b.timezone) return "Your timezone / country is required.";
  if (!b.hours) return "Let us know roughly how many hours per week you can give.";
  if (b.why.length < 20) return "Tell us a bit more about why we should pick you.";
  if (b.scenario.length < 20) return "Please answer the scenario question.";
  return null;
}

function initForm() {
  const form = $("#apply-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearError();
    const body = collect();
    const problem = clientValidate(body);
    if (problem) { showError(problem); return; }

    const btn = $("#submit-btn");
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Sending…"; }
    let ok, data;
    try { ({ ok, data } = await jpost("/apply/api/submit", body)); }
    finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || "Send application"; } }

    if (!ok) { showError(data.error || "Something went wrong. Try again in a moment."); return; }

    // success
    const ref = data.ref || "";
    const refEl = $("#success-ref");
    if (refEl) refEl.textContent = ref;
    try { localStorage.setItem("cookie-apply-ref", ref); } catch (e) {}
    $("#form-card")?.classList.add("hidden");
    $("#success")?.classList.remove("hidden");
    $("#success")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadConfig().catch(() => showError("Couldn't load the application form. Refresh and try again."));
  initForm();
  // mobile nav toggle if present
  const burger = $("#nav-burger");
  burger?.addEventListener("click", () => $("#nav-links")?.classList.toggle("open"));
});
})();
