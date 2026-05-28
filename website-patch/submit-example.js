const APPLICATION_API_URL = "https://your-bot-domain.com/applications";

async function sendApplicationToBot(type, applicationId, answers, rawText) {
  const response = await fetch(APPLICATION_API_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ type, applicationId, answers, rawText })
  });

  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit application.");
  return result;
}
