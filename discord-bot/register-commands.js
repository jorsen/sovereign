// One-time (or whenever the command definition changes) setup script --
// registers /uniongr with Discord. Run with: node register-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
// Same boss list as the site's Log Attendance dropdown. (This script is run
// from a checkout of the whole repo, so ../lib is always there.)
const { SCANNABLE_BOSSES } = require('../lib/bosses');

// Two sub-commands instead of one form, so the "old or new IGN?" question
// comes first and only /uniongr switched-ign asks for the old IGN (Discord
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

// /attendance descriptions in the growth guide's other languages, keyed by
// Discord locale codes.
const ATTENDANCE_TEXT = {
  command: { 'zh-CN': '从 Boss 截图读取出席者名字', ja: 'ボスのスクショから出席者の名前を読み取る', th: 'อ่านชื่อผู้เข้าร่วมจากภาพหน้าจอบอส', vi: 'Đọc tên người tham gia từ ảnh chụp boss' },
  boss: { 'zh-CN': '选择 Boss', ja: 'ボスを選択', th: 'เลือกบอส', vi: 'Chọn boss' },
  time: { 'zh-CN': '击杀时间，菲律宾时间（例如 21:30 或 9:30pm）——留空 = 现在', ja: '討伐時刻・フィリピン時間（例：21:30、9:30pm）— 空欄 = 今', th: 'เวลาที่ล่า เวลาฟิลิปปินส์ (เช่น 21:30 หรือ 9:30pm) — เว้นว่าง = ตอนนี้', vi: 'Giờ hạ boss, giờ Philippines (vd: 21:30 hoặc 9:30pm) — để trống = bây giờ' },
  date: { 'zh-CN': '击杀日期（例如 11/20）——留空 = 今天', ja: '討伐日（例：11/20）— 空欄 = 今日', th: 'วันที่ล่า (เช่น 11/20) — เว้นว่าง = วันนี้', vi: 'Ngày hạ boss (vd: 11/20) — để trống = hôm nay' },
  screenshot: { 'zh-CN': '能看到名字的截图', ja: '名前が写っているスクショ', th: 'ภาพหน้าจอที่เห็นชื่อ', vi: 'Ảnh chụp có hiện tên' },
  another: { 'zh-CN': '另一张截图（可选）', ja: '追加のスクショ（任意）', th: 'ภาพหน้าจอเพิ่มเติม (ไม่บังคับ)', vi: 'Ảnh chụp khác (không bắt buộc)' },
};

// Growth Rate + screenshot are always required. class/guild/lamp are
// required on switched-ign, but optional on same-ign: left empty, they're
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
            .setName('switched-ign')
            .setDescription('I Changed My IGN (needs admin approval)')
            .addStringOption((opt) => opt.setName('oldign').setDescription('Your OLD In-Game Name — Start Typing and Pick It').setRequired(true).setAutocomplete(true))
            .addStringOption((opt) => opt.setName('ign').setDescription('Your NEW In-Game Name').setRequired(true)),
          true
        )
      )
    )
    .toJSON(),
  // Boss attendance: reads the blue/green/light-green nameplates off the
  // screenshots (lib/attendanceOcr.js) and posts the list. Only answers in
  // the attendance channel. Screenshot option names are kept in sync with
  // ATTENDANCE_SCREENSHOT_OPTIONS in lib/discordInteractions.js.
  // Descriptions are localized into the growth guide's other languages --
  // Discord shows each member the one matching their client language.
  new SlashCommandBuilder()
    .setName('attendance')
    .setDescription('Read attendee names from boss screenshots')
    .setDescriptionLocalizations(ATTENDANCE_TEXT.command)
    // A fixed dropdown of the site's own boss list (lib/bosses.js), so only a
    // real boss can be picked -- no typing, no typos.
    .addStringOption((opt) =>
      opt
        .setName('boss')
        .setDescription('Pick the Boss')
        .setDescriptionLocalizations(ATTENDANCE_TEXT.boss)
        .setRequired(true)
        .addChoices(...SCANNABLE_BOSSES.map((b) => ({ name: b.boss, value: b.boss })))
    )
    .addAttachmentOption((opt) => opt.setName('screenshot').setDescription('Screenshot Showing the Name Tags').setDescriptionLocalizations(ATTENDANCE_TEXT.screenshot).setRequired(true))
    .addAttachmentOption((opt) => opt.setName('screenshot2').setDescription('Another Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot3').setDescription('Another Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot4').setDescription('Another Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    // Both default to now (Philippines time); only for logging a kill later.
    .addStringOption((opt) => opt.setName('time').setDescription('Kill Time, PH Time (e.g. 21:30 or 9:30pm) — Empty = Now').setDescriptionLocalizations(ATTENDANCE_TEXT.time).setRequired(false).setMaxLength(10))
    .addStringOption((opt) => opt.setName('date').setDescription('Kill Date (e.g. 11/20) — Empty = Today').setDescriptionLocalizations(ATTENDANCE_TEXT.date).setRequired(false).setMaxLength(10))
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
    console.log(`Registered /uniongr and /attendance for guild ${GUILD_ID} (instant).`);
  } else {
    // Global commands can take up to an hour to appear everywhere the bot
    // is installed.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered /uniongr and /attendance globally (can take up to an hour to show up).');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
