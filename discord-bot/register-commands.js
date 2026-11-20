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
  command: { 'zh-CN': '记录 Boss 击杀：战斗截图 + 战利品列表截图（必需）', ja: 'ボス討伐を記録：戦闘のスクショ＋戦利品リストのスクショ（必須）', th: 'บันทึกการล่าบอส: ภาพการต่อสู้ + ภาพรายการของดรอป (จำเป็น)', vi: 'Ghi trận boss: ảnh trận đánh + ảnh danh sách vật phẩm rơi (bắt buộc)' },
  boss: { 'zh-CN': '选择 Boss', ja: 'ボスを選択', th: 'เลือกบอส', vi: 'Chọn boss' },
  screenshot: { 'zh-CN': '战斗截图（能看到名字）或战利品列表截图', ja: '戦闘のスクショ（名前が見える）または戦利品リストのスクショ', th: 'ภาพการต่อสู้ (เห็นชื่อ) หรือภาพรายการของดรอป', vi: 'Ảnh trận đánh (thấy tên) hoặc ảnh danh sách vật phẩm rơi' },
  another: { 'zh-CN': '另一张战斗或战利品列表截图（可选）', ja: '追加の戦闘または戦利品リストのスクショ（任意）', th: 'ภาพการต่อสู้หรือรายการของดรอปเพิ่มเติม (ไม่บังคับ)', vi: 'Ảnh trận đánh hoặc danh sách vật phẩm khác (không bắt buộc)' },
  link: { 'zh-CN': '或粘贴包含截图的 Discord 消息链接（可多个，用空格分隔）', ja: 'またはスクショのある Discord メッセージのリンク（複数可、スペース区切り）', th: 'หรือวางลิงก์ข้อความ Discord ที่มีภาพ (หลายลิงก์ได้ คั่นด้วยเว้นวรรค)', vi: 'Hoặc dán link tin nhắn Discord có ảnh (nhiều link, cách nhau bằng dấu cách)' },
  rescan: { 'zh-CN': 'True = 用这次扫描替换该次击杀已保存的名字和战利品（修正错误扫描）', ja: 'True = この討伐の保存済みの名前と戦利品を今回のスキャンで置き換える（誤スキャンの修正）', th: 'True = แทนที่ชื่อและของดรอปที่บันทึกไว้ของการล่านี้ด้วยการสแกนนี้ (แก้การสแกนผิด)', vi: 'True = Thay tên và vật phẩm đã lưu của trận này bằng lần quét này (sửa quét sai)' },
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
    .setDescription('Log a boss kill: battle screenshots + the loot list screenshot (required)')
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
    // Instead of uploading again: the link of the Discord message(s) that
    // already have the screenshots (right-click the message > Copy Message
    // Link). Several links, space-separated.
    .addStringOption((opt) => opt.setName('link').setDescription('Or Paste Discord Message Link(s) With the Screenshots (Space-Separated)').setDescriptionLocalizations(ATTENDANCE_TEXT.link).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot').setDescription('Battle Screenshot (Name Tags) or Loot List Screenshot').setDescriptionLocalizations(ATTENDANCE_TEXT.screenshot).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot2').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot3').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot4').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    // Big fights: more angles of the same kill, all merged into one list.
    .addAttachmentOption((opt) => opt.setName('screenshot5').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot6').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot7').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot8').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot9').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    .addAttachmentOption((opt) => opt.setName('screenshot10').setDescription('Another Battle or Loot List Screenshot (Optional)').setDescriptionLocalizations(ATTENDANCE_TEXT.another).setRequired(false))
    // True = replace this kill's saved names (and loot, unless it already has
    // prices/sales) with this scan, to correct a wrong one. Default: add.
    .addBooleanOption((opt) => opt.setName('rescan').setDescription("True = Replace This Kill's Saved Names & Loot With This Scan (to Fix a Wrong Scan)").setDescriptionLocalizations(ATTENDANCE_TEXT.rescan).setRequired(false))
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
