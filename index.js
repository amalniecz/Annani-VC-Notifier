// ========================================
// === AnnaniBot | Voice Alert Bot       ===
// ========================================

console.log('Loaded Token:', process.env.DISCORD_TOKEN);
const mySecret = process.env['DISCORD_TOKEN'];
process.env.FFMPEG_PATH = './ffmpeg';

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const fs = require('fs');
const express = require('express');
const prism = require('prism-media');

// ========================================
// === CONFIG =============================
const AUDIO_FILE = './annani vanne.mp3';
const SPECIAL_AUDIO_FILE = './Vaishakkentry.mp3';

const TOKEN = process.env.DISCORD_TOKEN;

const ADMIN_IDS = [
  '754021929480093809',
  '1343891672102080542'
];

const ALLOWED_COMMAND_CHANNEL = '1390955411858919434';
const LOG_CHANNEL_ID = '1392031425741455390';

const ID_FILE = 'target_user_id.txt';
const LOG_FILE = 'logs.txt';

// Special users map
const USER_AUDIO_MAP = {
  '1342167127360274463': SPECIAL_AUDIO_FILE
};

let allowedUserId = '';
if (fs.existsSync(ID_FILE)) {
  allowedUserId = fs.readFileSync(ID_FILE, 'utf8').trim();
  console.log(`✅ Loaded allowed user ID from file: ${allowedUserId}`);
}

// ========================================
// === CLIENT =============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.GuildMember]
});

// ========================================
// === HELPERS ============================
function getCurrentTime() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: true
  });
}

function appendToLog(data) {
  fs.appendFileSync(LOG_FILE, `${data}\n\n`);
}

async function sendLogToChannel(message) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(`\`\`\`\n${message}\n\`\`\``);
    } else {
      console.error('❌ Log channel not found or is not text-based');
    }
  } catch (error) {
    console.error('❌ Failed to send log to channel:', error);
  }
}

function clearOldLogs() {
  if (!fs.existsSync(LOG_FILE)) return;
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  const now = Date.now();
  const threshold = 5 * 24 * 60 * 60 * 1000;

  const keptLines = lines.filter(line => {
    const match = line.match(/Date\/Time:\s*([^\n]+)/);
    if (!match) return true;
    const timestamp = Date.parse(match[1]);
    if (isNaN(timestamp)) return true;
    return (now - timestamp) < threshold;
  });

  fs.writeFileSync(LOG_FILE, keptLines.join('\n'));
}

function createVolumeResource(file, volumeLevel = 0.8) {
  const ffmpeg = new prism.FFmpeg({
    args: [
      '-i', file,
      '-af', `volume=${volumeLevel}`,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2'
    ]
  });
  return createAudioResource(ffmpeg, { inputType: StreamType.Raw });
}

// ========================================
// === VOICE PLAYER STATE ================
let activeConnection = null;
let activePlayer = null;
let lastMoveTime = 0;

// ========================================
// === ON READY ==========================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const setidCommand = new SlashCommandBuilder()
    .setName('setid')
    .setDescription('Set the allowed user ID for VC alerts (Admin only)')
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('Discord User ID to allow')
        .setRequired(true)
    );

  try {
    console.log('✅ Registering /setid slash command...');
    const guilds = await client.guilds.fetch();
    for (const [guildId] of guilds) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: [setidCommand.toJSON()] }
      );
      console.log(`✅ /setid command registered in guild: ${guildId}`);
    }
  } catch (error) {
    console.error('❌ Failed to register slash command:', error);
  }

  clearOldLogs();
});

// ========================================
// === SLASH COMMAND HANDLER =============
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setid') {
    if (interaction.channelId !== ALLOWED_COMMAND_CHANNEL) {
      await interaction.reply({ content: '❌ This command can only be used in the authorized channel.', ephemeral: true });
      return;
    }

    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ You are not authorized to use this command.', ephemeral: true });
      return;
    }

    const newId = interaction.options.getString('userid').trim();
    if (!/^\d+$/.test(newId)) {
      await interaction.reply({ content: '❌ Invalid ID format. Must be numeric.', ephemeral: true });
      return;
    }

    allowedUserId = newId;
    fs.writeFileSync(ID_FILE, allowedUserId);
    console.log(`✅ Allowed user ID updated: ${allowedUserId}`);
    await interaction.reply({ content: `✅ Allowed user ID updated to: \`${allowedUserId}\``, ephemeral: true });
  }
});

// ========================================
// === VOICE STATE HANDLER ===============
const movingUsers = new Map();

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.member?.id;
  if (!userId) return;

  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;

  const specialAudio = USER_AUDIO_MAP[userId];
  const isWatchedUser = specialAudio || userId === allowedUserId;
  if (!isWatchedUser) return;

  // ========== Handle Leave ==========
  if (!newChannel && oldChannel) {
    // User left *somewhere*. Wait to see if they rejoin soon.
    if (movingUsers.has(userId)) clearTimeout(movingUsers.get(userId));

    // Wait 2 seconds before destroying
    const timeout = setTimeout(() => {
      if (activePlayer) activePlayer.stop();
      if (activeConnection) {
        activeConnection.destroy();
        activeConnection = null;
      }
      movingUsers.delete(userId);
      console.log(`✅ User ${userId} fully left VC. Destroyed connection.`);
    }, 2000);

    movingUsers.set(userId, timeout);
    return;
  }

  // ========== Handle Join ==========
  if (newChannel) {
    // Cancel any pending "leave" cleanup
    if (movingUsers.has(userId)) {
      clearTimeout(movingUsers.get(userId));
      movingUsers.delete(userId);
    }

    // Only act if moved channels
    if (newChannel !== oldChannel) {
      try {
        if (activePlayer) activePlayer.stop();
        if (activeConnection) {
          activeConnection.destroy();
          activeConnection = null;
        }

        activeConnection = joinVoiceChannel({
          channelId: newChannel,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false
        });

        activePlayer = createAudioPlayer();
        const resource = createVolumeResource(specialAudio || AUDIO_FILE, 0.8);
        activePlayer.play(resource);
        activeConnection.subscribe(activePlayer);

        const userTag = newState.member?.user.tag;
        const logBlock = [
          '━━━━━━━━━━━━━━━ 🔊 VC ALERT ━━━━━━━━━━━━━━━',
          `📅  Date/Time: ${getCurrentTime()}`,
          `👤  User: ${userTag} (ID: ${userId})`,
          `📢  Joined VC: ${newState.channel.name}`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n');

        console.log(logBlock);
        appendToLog(logBlock);
        sendLogToChannel(logBlock);

        activePlayer.on(AudioPlayerStatus.Idle, () => {
          if (activeConnection) {
            activeConnection.destroy();
            activeConnection = null;
          }
        });

        activePlayer.on('error', error => {
          console.error('❌ AudioPlayer error:', error);
          if (activeConnection) {
            activeConnection.destroy();
            activeConnection = null;
          }
        });
      } catch (error) {
        console.error('❌ Error joining VC or playing audio:', error);
      }
    }
  }
});


// ========================================
// === EXPRESS KEEP-ALIVE SERVER =========
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  const pingLog = [
    '━━━━━━━━━━━━━━━ 📡 KEEP-ALIVE ━━━━━━━━━━━━━━━',
    `📅  Date/Time: ${getCurrentTime()}`,
    `✅  Ping received!`,
    `📈  Data Spike: ▓▓▓▓`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  console.log(pingLog);
  appendToLog(pingLog);
  sendLogToChannel(pingLog);

  res.send('✅ Bot is alive!');
});

app.listen(PORT, () => {
  console.log(`✅ Web server listening on port ${PORT}`);
});

// ========================================
// === LOGIN =============================
client.login(TOKEN);
