"use strict";

/**
 * CookieBot - shared activity feed.
 *
 * Tiny in-memory ring buffer every module can push events into, so the
 * dashboard has one live "what has the bot been doing" stream. Nothing here
 * touches Discord and nothing here may throw.
 *
 *   pushActivity(type, text)  record an event (type is a short tag like "ticket")
 *   listActivity(limit)       newest-first slice for the dashboard
 */

const MAX_ENTRIES = 300;

let feed = [];   // [{ at, type, text }]

function pushActivity(type, text) {
  try {
    feed.push({ at: Date.now(), type: String(type).slice(0, 24), text: String(text).slice(0, 400) });
    if (feed.length > MAX_ENTRIES) feed = feed.slice(feed.length - MAX_ENTRIES);
  } catch (e) { /* the feed is best-effort only */ }
}

function listActivity(limit = 60) {
  return feed.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES))).reverse();
}

module.exports = { pushActivity, listActivity };
