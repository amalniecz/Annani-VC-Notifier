require('dotenv').config();
console.log('Loaded Token:', process.env.DISCORD_TOKEN);



// ========================================
// === AnnaniBot | Voice Alert Bot       ===
// ========================================

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require('@discordjs/voice');
const fs = require('fs');

// === CONFIG =============================

// 1️⃣ Sound file
const AUDIO_FILE = './Annani enter vc-.mp3';

// 2️⃣ Load token from .env
const TOKEN = process.env.DISCORD_TOKEN;

// 3️⃣ Admin IDs who can use /setid
const ADMIN_IDS = [
  '754021929480093809', // Owner
  '1343891672102080542' // Mod/Admin
];

// 4️⃣ Text channel restriction for /setid command
const ALLOWED_COMMAND_CHANNEL = '1390955411858919434';

// 5️⃣ File to store target user ID
const ID_FILE = 'target_user_id.txt';

let allowedUserId = '';
if (fs.existsSync(ID_FILE)) {
  allowedUserId = fs.readFileSync(ID_FILE, 'utf8').trim();
  console.log(`✅ Loaded allowed user ID from file: ${allowedUserId}`);
}

// ========================================
// === CLIENT ============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.GuildMember]
});

// ========================================
// === VOICE PLAYER STATE ================

let activeConnection = null;
let activePlayer = null;
let currentVCId = null;

// ========================================
// === ON READY ==========================

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register the /setid command
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
});

// ========================================
// === SLASH COMMAND HANDLER =============

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setid') {
    // Restrict to specific text channel
    if (interaction.channelId !== ALLOWED_COMMAND_CHANNEL) {
      await interaction.reply({ content: '❌ This command can only be used in the authorized channel.', ephemeral: true });
      return;
    }

    // Only Admins can use it
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
// === VOICE STATE HANDLER ================

client.on('voiceStateUpdate', (oldState, newState) => {
  console.log('🔔 VoiceStateUpdate detected');
  const userId = newState.member?.id;
  console.log(`👤 User: ${newState.member?.user.tag} (ID: ${userId})`);

  if (userId !== allowedUserId) {
    return;
  }

  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;

  // If user left VC entirely
  if (!newChannel) {
    console.log('👋 Target user LEFT all VCs.');
    if (activePlayer) activePlayer.stop();
    if (activeConnection) {
      activeConnection.destroy();
      activeConnection = null;
      currentVCId = null;
    }
    return;
  }

  // User joined or moved to a new channel
  if (newChannel !== oldChannel) {
    console.log(`🎯 Target user JOINED or MOVED to VC: ${newState.channel.name}`);

    if (activePlayer) activePlayer.stop();
    if (activeConnection) {
      activeConnection.destroy();
      activeConnection = null;
      currentVCId = null;
    }

    try {
      activeConnection = joinVoiceChannel({
        channelId: newChannel,
        guildId: newState.guild.id,
        adapterCreator: newState.guild.voiceAdapterCreator,
        selfDeaf: false
      });

      currentVCId = newChannel;

      activePlayer = createAudioPlayer();
      const resource = createAudioResource(AUDIO_FILE);
      activePlayer.play(resource);
      activeConnection.subscribe(activePlayer);

      console.log('▶️ Playing sound in VC...');

      activePlayer.on(AudioPlayerStatus.Idle, () => {
        console.log('✅ Done playing. Leaving VC.');
        if (activeConnection) {
          activeConnection.destroy();
          activeConnection = null;
          currentVCId = null;
        }
      });

      activePlayer.on('error', error => {
        console.error('❌ AudioPlayer error:', error);
        if (activeConnection) {
          activeConnection.destroy();
          activeConnection = null;
          currentVCId = null;
        }
      });

    } catch (error) {
      console.error('❌ Error joining VC or playing audio:', error);
    }
  }
});

// ========================================
// === LOGIN =============================

client.login(TOKEN);
