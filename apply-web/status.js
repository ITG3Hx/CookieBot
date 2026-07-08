"use strict";
/* Cookie SMP, application status check.
   DOM: #status-form (form), #status-ref (input), #status-result (output). */
(function () {
const $ = (s) => document.querySelector(s);
const STATUS_LABEL = {
  pending:   { text: "Pending review", cls: "pending", note: "Your application is in the queue. The team reviews every one." },
  interview: { text: "Interview", cls: "interview", note: "You're being considered, a staff member will reach out for a short chat." },
  accepted:  { text: "Accepted", cls: "accepted", note: "Congratulations! Keep an eye on your Discord DMs." },
  denied:    { text: "Not this time", cls: "denied", note: "Thanks for applying. You're welcome to try again later." },
};
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtDate(ts) { if (!ts) return ""; const d = new Date(ts); return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }

async function check(ref) {
  const out = $("#status-result");
  out.className = "status-result loading";
  out.innerHTML = "<p>Looking that up…</p>";
  let res;
  try { res = await fetch("/apply/api/status?ref=" + encodeURIComponent(ref)); }
  catch (e) {
    out.className = "status-result error show";
    out.innerHTML = "<p>Couldn't reach the server. Check your connection and try again.</p>";
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    out.className = "status-result error show";
    out.innerHTML = `<p>${esc(data.error || "No application found with that code.")}</p>`;
    return;
  }
  const a = data.application;
  const s = STATUS_LABEL[a.status] || STATUS_LABEL.pending;
  out.className = "status-result show";
  out.innerHTML = `
    <div class="status-badge ${s.cls}">${s.text}</div>
    <dl class="status-meta">
      <div><dt>Reference</dt><dd class="mono">${esc(a.ref)}</dd></div>
      <div><dt>Position</dt><dd>${esc(a.positionName)}</dd></div>
      <div><dt>Submitted</dt><dd>${esc(fmtDate(a.createdAt))}</dd></div>
      ${a.decidedAt ? `<div><dt>Reviewed</dt><dd>${esc(fmtDate(a.decidedAt))}</dd></div>` : ""}
    </dl>
    <p class="status-note">${s.note}</p>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = $("#status-form");
  const input = $("#status-ref");
  // prefill from the last submission if we have it
  try { const saved = localStorage.getItem("cookie-apply-ref"); if (saved && input) input.value = saved; } catch (e) {}
  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const ref = (input?.value || "").trim();
    if (ref) check(ref);
  });
  // mobile nav toggle
  const burger = $("#nav-burger");
  burger?.addEventListener("click", () => $("#nav-links")?.classList.toggle("open"));
});
})();
