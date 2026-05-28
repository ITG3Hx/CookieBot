CookieApplicationsBot V2

New:
- Saves applications in data/applications.json
- Status survives restarts
- Separate staff/tester review channels
- Accept / Deny / Hold buttons
- DMs applicant if Discord User ID or mention is provided
- Website API: POST /applications
- Status API: GET /applications/:id

Setup:
1. Create Discord bot
2. Enable Server Members Intent
3. Invite bot with bot + applications.commands
4. Give permissions:
   View Channels, Send Messages, Embed Links, Read Message History
5. Copy .env.example to .env
6. Fill:
   DISCORD_TOKEN
   STAFF_REVIEW_CHANNEL_ID
   TESTER_REVIEW_CHANNEL_ID
7. Run:
   npm install
   npm start

Host on Railway / Render / VPS / Pterodactyl Node.

Important:
Ask for Discord User ID or mention in the form.
Username alone cannot reliably receive DMs.
