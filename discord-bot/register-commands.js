// One-time (or whenever the command definition changes) setup script --
// registers /uniongr with Discord. Run with: node register-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// Two sub-commands instead of one form, so the "old or new IGN?" question
// comes first and only /uniongr changed-ign asks for the old IGN (Discord
// can't show or hide a field based on another field's answer). Both share
// every other field via addSubmissionOptions.
const CLASS_CHOICES = [
  'Ultimate Martialist',
  'Soul Reaper',
  'Storm Hawkeye',
  'Divine Priest',
  'Mighty Demolisher',
  'Mystic Luminary',
  'Crusader',
  'Bloody Enforcer',
  'Fatal Lord',
  'Eternal Commander',
  'Prime Savior',
  'Grand Wizard',
];
const GUILD_CHOICES = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL', 'BUBBLEGANG'];

// Growth Rate + screenshot are always required. class/guild/lamp are
// required on changed-ign, but optional on same-ign: left empty, they're
// copied from that IGN's current entry (see processUniongrSubmission), so a
// returning member only has to update their GR. Discord needs every
// required option listed before the optional ones.
function addGrowthAndScreenshot(sub) {
  return sub
    .addIntegerOption((opt) => opt.setName('growthrate').setDescription('Growth Rate Stat Shown at the Top of Character Details').setRequired(true).setMinValue(0))
    .addAttachmentOption((opt) =>
      opt.setName('screenshot').setDescription('Full Landscape Screenshot Showing Your Character + Artifacts Tab (Not Just the Popup Cropped)').setRequired(true)
    );
}

function addProfileOptions(sub, required) {
  const hint = required ? '' : ' — Leave Empty to Keep Your Current One';
  return sub
    .addStringOption((opt) => opt.setName('class').setDescription(`Your Class (4th Advancement)${hint}`).setRequired(required).addChoices(...CLASS_CHOICES.map((c) => ({ name: c, value: c }))))
    .addStringOption((opt) => opt.setName('guild').setDescription(`Your Guild${hint}`).setRequired(required).addChoices(...GUILD_CHOICES.map((g) => ({ name: g, value: g }))))
    .addIntegerOption((opt) => opt.setName('lamp').setDescription(`Volcano Lamp Level (the + Number)${hint}`).setRequired(required).setMinValue(1).setMaxValue(25));
}

const commands = [
  new SlashCommandBuilder()
    .setName('uniongr')
    .setDescription('Submit your growth rate to the Growth Rate list')
    .addSubcommand((sub) =>
      addProfileOptions(
        addGrowthAndScreenshot(
          sub
            .setName('same-ign')
            .setDescription('Same IGN as Before / First Time')
            .addStringOption((opt) => opt.setName('ign').setDescription('Your In-Game Name — Start Typing and Pick It').setRequired(true).setAutocomplete(true))
        ),
        false
      )
    )
    // oldign suggestions come from every name on our lists (see the
    // autocomplete branch in lib/discordInteractions.js). The change waits
    // for an admin to approve it on the Growth Rate page.
    .addSubcommand((sub) =>
      addGrowthAndScreenshot(
        addProfileOptions(
          sub
            .setName('changed-ign')
            .setDescription('I Changed My IGN (needs admin approval)')
            .addStringOption((opt) => opt.setName('oldign').setDescription('Your OLD In-Game Name — Start Typing and Pick It').setRequired(true).setAutocomplete(true))
            .addStringOption((opt) => opt.setName('ign').setDescription('Your NEW In-Game Name').setRequired(true)),
          true
        )
      )
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
