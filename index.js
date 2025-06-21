const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!')) return;

  if (message.content === '!ping') {
    await message.reply('🏓 Pong!');
  }

  if (message.content === '!hello') {
    await message.reply(`👋 Hello, ${message.author.username}`);
  }
});

client.login(process.env.TOKEN);
