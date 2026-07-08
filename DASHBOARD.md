# CookieBot control panel + tickets

## Dashboard

Open `https://<your-railway-url>/dashboard` (locally: `http://localhost:3000/dashboard`).

Set `DASHBOARD_PASSWORD` in your Railway variables. If you don't, the bot generates a random password on every boot and prints it in the deploy logs, so set it once and forget it.

What you can do from the page:

- Overview: bot status, uptime, ping, member count, open tickets, live activity feed
- Tickets: two tabs. **Manage** lists open + closed tickets; click one to read it live, reply as the bot with a **live Discord preview** as you type, claim/unclaim, or close. **Set up** customizes the whole panel with a live preview (title, text, accent color, button label/emoji/color, or a dropdown of ticket **topics**) plus behavior (category, support role, log channel, max open, channel naming, close delay, DM-on-close, auto-close after inactivity, welcome message)
- Moderation: warn / timeout / kick / ban / unban by member search or ID, full infraction list with delete
- Security: every anti-nuke setting (punishment, thresholds, ban lock, join-raid guard, whitelist, protected channels/roles), lockdown on/off, snapshot refresh
- Giveaways: start, end now, reroll
- Testers: see all links, unlink
- Messages: send a plain message or an embed to any channel as the bot
- Bot: set status + activity (survives restarts)

## Ticket system (Discord side)

1. In the dashboard under Tickets > Set up, pick the ticket category, support role and log channel, tune the appearance and behavior, then Save.
2. Post the panel into your support channel (the Post panel button, or `/ticketpanel` in Discord). Posting saves your settings first so the live panel matches the preview.
3. Members click the button (or pick a topic from the dropdown if you added topics), fill in subject + details, and get a private ticket channel.
4. Buttons in the ticket: Close (asks for a reason) and Claim/Unclaim. Slash commands: `/ticket close`, `/ticket claim`, `/ticket unclaim`, `/ticket add`, `/ticket remove`, `/ticket rename`.
5. Closing saves a transcript to `data/transcripts/` and posts a summary + `.txt` transcript to the log channel, optionally DMs the opener a copy, then deletes the channel after the configured delay.

### Ticket customization (all in the Set up tab)

- **Panel:** title, text (Discord markdown works), accent color, button label, button emoji, button color.
- **Topics:** add categories (label + emoji + description) and the button becomes a dropdown; leave empty for a single button.
- **Behavior:** ticket category, support role, log channel, max open per user, channel naming (`ticket-0001` or `ticket-username`), channel prefix, close delay, DM-the-opener-a-transcript on close, auto-close after N hours of inactivity, and the welcome message shown inside each ticket.
- Everything shows a live preview of exactly how it will look in Discord.

## Notes

- The bot needs Manage Channels + Manage Roles to create ticket channels, and its role must be above the support role's members it manages.
- `@discordjs/opus` moved to optionalDependencies so `npm install` works on machines without a C++ toolchain (Railway is unaffected; `opusscript` is the fallback).
- Without `DISCORD_TOKEN` the process now stays up in dashboard-only mode instead of crashing, so you can still reach the panel.
