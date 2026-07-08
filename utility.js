"use strict";

/**
 * CookieBot — Utility commands.
 *
 * Wire into index.js:
 *   handleUtilityCommand(inter)  call near the top of interactionCreate
 *   UTILITY_COMMANDS             spread into the slash-command registration array
 *
 * Commands: /id /serverid /channelid /userinfo /serverinfo /ping
 * No state, no init — self-contained.
 */

const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const UTILITY_COMMANDS = [
  { name: "id", description: "Show your (or someone's) Discord user ID",
    options: [{ type: 6, name: "user", description: "Whose ID to show (default: you)", required: false }] },
  { name: "serverid", description: "Show this server's ID" },
  { name: "channelid", description: "Show this channel's ID" },
  { name: "userinfo", description: "Show info about a user",
    options: [{ type: 6, name: "user", description: "User to look up (default: you)", required: false }] },
  { name: "serverinfo", description: "Show info about this server" },
  { name: "ping", description: "Check the bot's latency" },
];

const COLOR = 0xff8c00;
const ut = (n) => `<t:${Math.floor(n / 1000)}`;

async function handleUtilityCommand(interaction) {
  if (!interaction.isChatInputCommand?.()) return false;
  const name = interaction.commandName;
  if (!["id", "serverid", "channelid", "userinfo", "serverinfo", "ping"].includes(name)) return false;

  if (name === "id") {
    const user = interaction.options.getUser("user") || interaction.user;
    await interaction.reply({ ephemeral: true, content: `${user.id === interaction.user.id ? "Your" : `${user.tag}'s`} Discord User ID:\n\`${user.id}\`` });
    return true;
  }

  if (name === "serverid") {
    if (!interaction.guild) { await interaction.reply({ ephemeral: true, content: "Use this in a server." }); return true; }
    await interaction.reply({ ephemeral: true, content: `Server ID:\n\`${interaction.guild.id}\`` });
    return true;
  }

  if (name === "channelid") {
    await interaction.reply({ ephemeral: true, content: `Channel ID:\n\`${interaction.channelId}\`` });
    return true;
  }

  if (name === "ping") {
    const sent = await interaction.reply({ content: "Pinging…", ephemeral: true, fetchReply: true });
    const rtt = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`🏓 Pong! Round-trip **${rtt}ms** · WebSocket **${Math.round(interaction.client.ws.ping)}ms**`);
    return true;
  }

  if (name === "userinfo") {
    const user = interaction.options.getUser("user") || interaction.user;
    const member = interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
    const lines = [
      `**User:** ${user.tag} ${user.bot ? "(bot)" : ""}`,
      `**ID:** \`${user.id}\``,
      `**Account created:** ${ut(user.createdTimestamp)}:F> (${ut(user.createdTimestamp)}:R>)`,
    ];
    if (member) {
      if (member.joinedTimestamp) lines.push(`**Joined server:** ${ut(member.joinedTimestamp)}:F> (${ut(member.joinedTimestamp)}:R>)`);
      const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id);
      lines.push(`**Roles:** ${roles.size}`);
      if (member.roles.highest && member.roles.highest.id !== interaction.guild.id) lines.push(`**Top role:** <@&${member.roles.highest.id}>`);
    }
    const e = new EmbedBuilder().setColor(COLOR).setTitle("User Info")
      .setThumbnail(user.displayAvatarURL({ size: 256 })).setDescription(lines.join("\n")).setTimestamp();
    await interaction.reply({ ephemeral: true, embeds: [e] });
    return true;
  }

  if (name === "serverinfo") {
    if (!interaction.guild) { await interaction.reply({ ephemeral: true, content: "Use this in a server." }); return true; }
    const g = interaction.guild;
    const owner = await g.fetchOwner().catch(() => null);
    const channels = g.channels.cache;
    const e = new EmbedBuilder().setColor(COLOR).setTitle(g.name)
      .setThumbnail(g.iconURL({ size: 256 }) || null)
      .setDescription([
        `**ID:** \`${g.id}\``,
        `**Owner:** ${owner ? `<@${owner.id}>` : "unknown"}`,
        `**Members:** ${g.memberCount}`,
        `**Channels:** ${channels.size}`,
        `**Roles:** ${g.roles.cache.size}`,
        `**Boosts:** ${g.premiumSubscriptionCount || 0} (level ${g.premiumTier})`,
        `**Created:** ${ut(g.createdTimestamp)}:F> (${ut(g.createdTimestamp)}:R>)`,
      ].join("\n")).setTimestamp();
    await interaction.reply({ ephemeral: true, embeds: [e] });
    return true;
  }

  return false;
}

module.exports = { handleUtilityCommand, UTILITY_COMMANDS };
