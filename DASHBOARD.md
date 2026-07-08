# CookieBot control panel + tickets

## Dashboard

Open `https://<your-railway-url>/dashboard` (locally: `http://localhost:3000/dashboard`).

Set `DASHBOARD_PASSWORD` in your Railway variables. If you don't, the bot generates a random password on every boot and prints it in the deploy logs, so set it once and forget it.

What you can do from the page:

- Overview: bot status, uptime, ping, member count, open tickets, live activity feed
- Tickets: two tabs. **Manage** lists open + closed tickets; click one to read it live, reply as the bot with a **live Discord preview** as you type, claim/unclaim, or close. **Set up** customizes the whole panel with a live preview (title, text, accent color, button label/emoji/color, or a dropdown of ticket **topics**) plus behavior (category, support role, log channel, max open, channel naming, close delay, DM-on-close, auto-close after inactivity, welcome message)
- Automation: **Autorole** (give roles to people/bots on join, optional delay, one-click apply-to-all), **Welcome** and **Goodbye** messages (plain or embed, optional welcome DM, live Discord preview, placeholders like `{user}` `{server}` `{count}`), **Reaction roles** (a button panel members click to self-assign roles, live preview, post to any channel), and an **Auto-responder** (keyword in chat -> the bot replies, e.g. "ip" -> your server address)
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

## Automation (Automation tab)

Everything here is optional and off until you switch it on with the toggle in each card. Changes **auto-save as you type** (you'll see "Saved" at the bottom), and there's still a **Save all automation** button if you want it. A card with an orange edge is currently switched on.

- **Autorole**, pick the role(s) new members get the instant they join (and separate role(s) for bots). Optional delay before assigning. "Apply to all current members" backfills everyone already in the server. The bot's role must sit **above** any role it gives out, and it needs **Manage Roles**.
- **Welcome / Goodbye**, post to a channel when someone joins or leaves, as plain text or an embed, with a live preview. Welcome can also DM the new member. Placeholders: `{user}` (mention), `{name}`, `{tag}`, `{username}`, `{server}`, `{count}` (member count), `{id}`.
- **Reaction roles**, build a panel of buttons; members click one to give themselves that role, click again to remove it. Customize each button's label, emoji and color, preview it live, then post it to any channel.
- **Auto-responder**, when a message matches a trigger (contains / whole word / starts with / exact) the bot replies. Optionally delete the triggering message. Each trigger has a short per-channel cooldown so it can't be spammed. Good for FAQ answers ("ip", "rules", "store"). Type `#` in any message field to pick a channel.
- **Sticky messages**, keep a message glued to the bottom of a channel; it reposts after people talk (only when someone actually sends a message, so it never spams an idle channel). One per channel, plain or embed. Great for a rules reminder or the server IP.
- **Message logger**, log messages to a channel for audits, including **edits and deletes**. Add channels to the **skip list** so noisy or protected channels (like #rules) are never logged.
- **Auto-moderation**, auto-delete rule-breaking messages and optionally time the user out. Filters: caps spam, mention spam, repeated messages, banned words, Discord-invite links, and all links. Set the timeout length or choose "just delete, don't timeout". **Exclusions** let you exempt staff **roles** and whole **channels** (e.g. #memes, #rules) so it never touches them.

**Nothing here edits, resets, or clears your existing channel content.** Auto-mod only removes new rule-breaking messages, and only in channels you haven't excluded. Put #rules on the ignore lists and the bot will leave it completely alone.

## Staff applications (its own site at `/apply`)

A separate, reddish, professional website for staff applications, served by the bot so it can DM applicants and hand out roles. Three parts:

- **Public apply page** at `/apply`, people pick a position (Administrator, Department Leader, Helper, Partner), fill in the form, and get a reference code. No Discord post, nothing public.
- **Status check** at `/apply/status`, applicants look up where their application stands with that code.
- **Moderator review panel** at `/apply/review`, your mods log in with a **reviewer password** (separate from your admin password, so they only ever see applications). They read every answer, filter by status, and Accept / Interview / Deny with an optional internal note. On **Accept** the bot DMs the applicant and assigns the Discord role you mapped to that position.

You configure all of it from the dashboard's **Applications** tab: open or close applications, edit each position's blurb, map positions to Discord roles, set the DM messages, the re-apply cooldown, the minimum age, and the reviewer password.

Notes:
- For auto-assign and DMs to work, give the applicant's Discord user ID on the form (optional field) or make sure their username matches in the server. The bot's role must sit **above** the roles it grants.
- Set the reviewer password once in the Applications tab (or the `APPLICATIONS_REVIEW_PASSWORD` env var), then share it with your review team.
- Applications persist in `data/applications.json`. On Railway that is wiped on redeploy unless you attach a volume, so add one if you want a permanent record.

## Notes

- The bot needs Manage Channels + Manage Roles to create ticket channels, and its role must be above the support role's members it manages.
- `@discordjs/opus` moved to optionalDependencies so `npm install` works on machines without a C++ toolchain (Railway is unaffected; `opusscript` is the fallback).
- Without `DISCORD_TOKEN` the process now stays up in dashboard-only mode instead of crashing, so you can still reach the panel.
