const { Client, GatewayIntentBits, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Partials } = require('discord.js');
const express = require('express');
const fs = require('fs');

const BOT_OWNER_ID = '814297978620739595';
const app = express();
app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('🌐 Express server running on port 3000'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const queueMessageFile = 'queueMessage.json';
let queue = [];
let playerData = {};
let checkInStatus = {};
let timeouts = {};
let queueTimeouts = {};

let currentMatchTimeout = null;
let matchCheckInCountdowns = {}; // map userId -> { interval, msg }

try { playerData = JSON.parse(fs.readFileSync('playerData.json', 'utf8')); } catch { playerData = {}; }
try { queueTimeouts = JSON.parse(fs.readFileSync('timeouts.json', 'utf8')); } catch { queueTimeouts = {}; }

function savePlayerData() { fs.writeFileSync('playerData.json', JSON.stringify(playerData, null, 2)); }
function saveQueueTimeouts() { fs.writeFileSync('timeouts.json', JSON.stringify(queueTimeouts, null, 2)); }
function isUserTimedOut(userId) {
  const expiresAt = queueTimeouts[userId];
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    delete queueTimeouts[userId];
    saveQueueTimeouts();
    return false;
  }
  return true;
}

function calculateRank(player) {
  const stats = playerData[player.id] || { wins: 0, losses: 0 };
  return stats.wins - stats.losses;
}

function queueButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join_queue').setLabel('Enter Queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('leave_queue').setLabel('Leave Queue').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('view_queue').setLabel('View Queue').setStyle(ButtonStyle.Secondary)
  );
}

function startTimeout(user) {
  const warning = setTimeout(async () => {
    try {
      const dm = await user.createDM();
      await dm.send('⚠️ You will be removed from the queue in 5 minutes due to inactivity. Please re-queue if you’re still playing.');
    } catch {}
  }, 25 * 60 * 1000);

  const kick = setTimeout(() => {
    queue = queue.filter(p => p.id !== user.id);
    delete timeouts[user.id];
  }, 30 * 60 * 1000);

  timeouts[user.id] = { warning, kick };
}

function clearTimeouts(userId) {
  if (timeouts[userId]) {
    clearTimeout(timeouts[userId].warning);
    clearTimeout(timeouts[userId].kick);
    delete timeouts[userId];
  }
}

async function createMatchChannel(guild, players) {
  const sorted = [...players].sort((a, b) => calculateRank(b) - calculateRank(a));
  const team1 = [], team2 = [];
  sorted.forEach((p, i) => (i % 2 === 0 ? team1 : team2).push(p));
  const team1Leader = team1[0];
  const team2Leader = team2[0];

  checkInStatus = {};
  players.forEach(p => (checkInStatus[p.id] = false));

  const checkInButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('check_in').setLabel('✅ Check In').setStyle(ButtonStyle.Success)
  );

  const formatCheckInMessage = () => {
    const checked = players.filter(p => checkInStatus[p.id]).map(p => p.username).join('\n') || 'None';
    const notChecked = players.filter(p => !checkInStatus[p.id]).map(p => p.username).join('\n') || 'None';
    return `🏁 **Match Check-In**\n\n✅ **Checked In:**\n${checked}\n\n⏳ **Not Checked In:**\n${notChecked}`;
  };

  const channel = await guild.channels.create({
    name: `match-${Date.now()}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      ...players.map(p => ({
        id: p.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      }))
    ]
  });

  await channel.send(`🏆 Match Started!
**Team 1:** ${team1.map(p => p.username).join(', ')} (Leader: ${team1Leader.username})
**Team 2:** ${team2.map(p => p.username).join(', ')} (Leader: ${team2Leader.username})

Team leaders, report result with: \`!report team1\` or \`!report team2\``);

  const checkInMsg = await channel.send({
    content: formatCheckInMessage(),
    components: [checkInButtons]
  });

  // Send DMs with countdown to all players
  for (const player of players) {
    try {
      const dm = await player.createDM();
      const msg = await dm.send(`🔔 You have 5 minutes to check in for your match.\n⏳ Time remaining: **5 minutes**`);
      let timeLeft = 5;

      const interval = setInterval(async () => {
        timeLeft--;
        if (timeLeft > 0) {
          try {
            await msg.edit(`🔔 You have 5 minutes to check in for your match.\n⏳ Time remaining: **${timeLeft} minute${timeLeft !== 1 ? 's' : ''}**`);
          } catch {}
        } else {
          clearInterval(interval);
        }
      }, 60 * 1000);

      matchCheckInCountdowns[player.id] = { interval, msg };
    } catch (e) {
      console.log(`⚠️ Failed to DM ${player.username}`);
    }
  }

  // Start 5-minute auto-cancel timeout
  currentMatchTimeout = setTimeout(async () => {
    const notChecked = players.filter(p => !checkInStatus[p.id]);
    if (notChecked.length > 0) {
      await channel.send('⏱️ Match cancelled: Not all players checked in within 5 minutes.');

      for (const player of players) {
        if (!queue.find(p => p.id === player.id)) {
          queue.push(player);
          startTimeout(player);
        }

        // Stop countdown message
        if (matchCheckInCountdowns[player.id]) {
          clearInterval(matchCheckInCountdowns[player.id].interval);
          delete matchCheckInCountdowns[player.id];
        }
      }

      await channel.delete().catch(() => {});
    }
  }, 5 * 60 * 1000);
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const channelId = process.env.CHANNEL_ID;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Try to delete old queue message
  try {
    const data = JSON.parse(fs.readFileSync(queueMessageFile, 'utf8'));
    const oldMsg = await channel.messages.fetch(data.messageId);
    if (oldMsg) await oldMsg.delete();
  } catch {}

  // Send new queue message
  const newMsg = await channel.send({
    content: '🎮 Click a button to interact with the queue:',
    components: [queueButtons()]
  });
  fs.writeFileSync(queueMessageFile, JSON.stringify({ messageId: newMsg.id }, null, 2));
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const user = interaction.user;

  if (interaction.customId === 'join_queue') {
    if (isUserTimedOut(user.id)) {
      return interaction.reply({ content: '🚫 You are currently queue banned.', ephemeral: true });
    }
    if (!queue.find(p => p.id === user.id)) {
      queue.push(user);
      startTimeout(user);
      await interaction.reply({ content: `✅ You joined the queue. (${queue.length}/10)`, ephemeral: true });
    } else {
      await interaction.reply({ content: '⚠️ You are already in the queue.', ephemeral: true });
    }

    if (queue.length === 10) {
      const players = [...queue];
      queue = [];
      players.forEach(p => clearTimeouts(p.id));
      await createMatchChannel(interaction.guild, players);
    }
  }

  if (interaction.customId === 'leave_queue') {
    queue = queue.filter(p => p.id !== user.id);
    clearTimeouts(user.id);
    await interaction.reply({ content: '❌ You left the queue.', ephemeral: true });
  }

  if (interaction.customId === 'view_queue') {
    const names = queue.map(p => p.username).join('\n') || 'The queue is empty.';
    await interaction.reply({ content: `👥 Players in queue:\n${names}`, ephemeral: true });
  }

  if (interaction.customId === 'check_in') {
    if (!checkInStatus.hasOwnProperty(interaction.user.id)) {
      return interaction.reply({ content: '❌ You are not in this match.', ephemeral: true });
    }
    if (checkInStatus[interaction.user.id]) {
      return interaction.reply({ content: '✅ You already checked in.', ephemeral: true });
    }

    checkInStatus[interaction.user.id] = true;

    // Stop countdown for this player
    if (matchCheckInCountdowns[interaction.user.id]) {
      clearInterval(matchCheckInCountdowns[interaction.user.id].interval);
      delete matchCheckInCountdowns[interaction.user.id];
    }

    const message = interaction.message;
    const players = Object.keys(checkInStatus).map(id => ({
      id,
      username: (client.users.cache.get(id) || { username: `User${id}` }).username
    }));
    const checked = players.filter(p => checkInStatus[p.id]).map(p => p.username).join('\n') || 'None';
    const notChecked = players.filter(p => !checkInStatus[p.id]).map(p => p.username).join('\n') || 'None';

    await interaction.update({
      content: `🏁 **Match Check-In**\n\n✅ **Checked In:**\n${checked}\n\n⏳ **Not Checked In:**\n${notChecked}`,
      components: message.components
    });

    // If all players checked in, clear timeout & countdowns
    if (Object.values(checkInStatus).every(v => v === true)) {
      if (currentMatchTimeout) {
        clearTimeout(currentMatchTimeout);
        currentMatchTimeout = null;
      }

      for (const playerId in matchCheckInCountdowns) {
        clearInterval(matchCheckInCountdowns[playerId].interval);
        delete matchCheckInCountdowns[playerId];
      }
    }
  }
});

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!')) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  if (cmd === '!qtimeout') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('❌ You do not have permission.');
    }
    const target = message.mentions.users.first();
    if (!target) return message.reply('❌ Mention a user.');
    const days = parseInt(args[2]) || 0;
    const hours = parseInt(args[3]) || 0;
    const minutes = parseInt(args[4]) || 0;
    const duration = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
    if (duration <= 0) return message.reply('⚠️ Invalid duration.');
    queueTimeouts[target.id] = Date.now() + duration;
    saveQueueTimeouts();
    message.reply(`⏳ ${target.username} has been queue banned for ${days}d ${hours}h ${minutes}m.`);
  }

  if (cmd === '!quntimeout') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('❌ You do not have permission.');
    }
    const target = message.mentions.users.first();
    if (!target || !queueTimeouts[target.id]) return message.reply('⚠️ That user is not banned.');
    delete queueTimeouts[target.id];
    saveQueueTimeouts();
    message.reply(`✅ ${target.username} is no longer queue banned.`);
  }

  if (cmd === '!forcematch') {
    if (message.author.id !== BOT_OWNER_ID) return message.reply('❌ Not authorized.');
    const members = await message.guild.members.fetch();
    const realUsers = members.filter(m => !m.user.bot).map(m => m.user).slice(0, 10);
    if (realUsers.length < 10) return message.reply('⚠️ Not enough players.');
    await createMatchChannel(message.guild, realUsers);
  }

  if (cmd === '!report') {
    const team = args[1] === 'team1' ? 'team1' : args[1] === 'team2' ? 'team2' : null;
    if (!team) return message.reply('⚠️ Use `!report team1` or `!report team2`.');

    const members = await message.channel.members.fetch();
    const players = members.filter(m => !m.user.bot).map(m => m.user);

    for (const player of players) {
      if (!checkInStatus[player.id]) return message.reply('❌ Not all checked in.');
    }

    const team1 = players.filter((_, i) => i % 2 === 0);
    const team2 = players.filter((_, i) => i % 2 !== 0);
    const leader1 = team1[0], leader2 = team2[0];
    if (![leader1.id, leader2.id].includes(message.author.id)) return message.reply('❌ Only a team leader can report.');

    const winningTeam = team === 'team1' ? team1 : team2;
    const losingTeam = team === 'team1' ? team2 : team1;

    winningTeam.forEach(p => {
      if (!playerData[p.id]) playerData[p.id] = { wins: 0, losses: 0 };
      playerData[p.id].wins += 1;
    });
    losingTeam.forEach(p => {
      if (!playerData[p.id]) playerData[p.id] = { wins: 0, losses: 0 };
      playerData[p.id].losses += 1;
    });

    savePlayerData();
    await message.channel.send(`✅ Match result recorded. ${team} wins!`);
    await message.channel.delete();
  }

  if (cmd === '!leaderboard') {
    const top = Object.entries(playerData)
      .map(([id, stats]) => ({ id, ...stats }))
      .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses))
      .slice(0, 10);

    const board = await Promise.all(top.map(async (p, i) => {
      const user = await client.users.fetch(p.id).catch(() => ({ username: `User${p.id}` }));
      return `**${i + 1}.** ${user.username} — 🏆 ${p.wins} Wins / ❌ ${p.losses} Losses`;
    }));

    message.channel.send(`📊 **Leaderboard:**\n${board.join('\n')}`);
  }

  if (cmd === '!resetstats') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('❌ You must be an admin.');
    }
    playerData = {};
    savePlayerData();
    message.channel.send('🗑️ All player stats have been reset.');
  }
});

console.log('Token:', process.env.TOKEN ? 'FOUND' : 'MISSING');
client.login(process.env.TOKEN).catch(console.error);
