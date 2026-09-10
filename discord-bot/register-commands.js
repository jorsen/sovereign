// One-time (or whenever the command definition changes) setup script --
// registers /uniongr with Discord. Run with: node register-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('uniongr')
    .setDescription('Submit your growth rate to the Growth Rate list')
    .addStringOption((opt) => opt.setName('ign').setDescription('Your in-game name').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('class')
        .setDescription('Your class (4th advancement)')
        .setRequired(true)
        .addChoices(
          { name: 'Ultimate Martialist', value: 'Ultimate Martialist' },
          { name: 'Soul Reaper', value: 'Soul Reaper' },
          { name: 'Storm Hawkeye', value: 'Storm Hawkeye' },
          { name: 'Divine Priest', value: 'Divine Priest' },
          { name: 'Mighty Demolisher', value: 'Mighty Demolisher' },
          { name: 'Mystic Luminary', value: 'Mystic Luminary' },
          { name: 'Crusader', value: 'Crusader' },
          { name: 'Bloody Enforcer', value: 'Bloody Enforcer' },
          { name: 'Fatal Lord', value: 'Fatal Lord' },
          { name: 'Eternal Commander', value: 'Eternal Commander' },
          { name: 'Prime Savior', value: 'Prime Savior' },
          { name: 'Grand Wizard', value: 'Grand Wizard' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('guild')
        .setDescription('Your guild')
        .setRequired(true)
        .addChoices(
          { name: 'Helloシ', value: 'Helloシ' },
          { name: '貓貓客棧', value: '貓貓客棧' },
          { name: '巫女組', value: '巫女組' },
          { name: 'CAPITAL', value: 'CAPITAL' },
          { name: 'BUBBLEGANG', value: 'BUBBLEGANG' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('lamp')
        .setDescription('Volcano Lamp enhancement level (the + next to it)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(25)
    )
    .addAttachmentOption((opt) =>
      opt.setName('screenshot').setDescription('Character Details > Artifacts tab screenshot').setRequired(true)
    )
    .toJSON(),
];

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are both required (see .env.example).');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  if (GUILD_ID) {
    // Guild-scoped commands show up instantly -- use this while testing, or
    // permanently if the bot only ever lives in one server.
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered /uniongr for guild ${GUILD_ID} (instant).`);
  } else {
    // Global commands can take up to an hour to appear everywhere the bot
    // is installed.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered /uniongr globally (can take up to an hour to show up).');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
