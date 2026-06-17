const APPLICATION_API_URL = "https://cookiebot-production-3ecc.up.railway.app/applications";

async function sendApplicationToBot(type, applicationId, answers, rawText) {
  try {
    const response = await fetch(APPLICATION_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, applicationId, answers, rawText })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      return { ok: false, error: result.error || `Server returned ${response.status}` };
    }
    return result;
  } catch (err) {
    // network / CORS / bad URL — handled instead of crashing the page
    return { ok: false, error: err.message || "Could not reach the bot." };
  }
}
