// The "how to use /uniongr" guide shown in the growth-rate channel. Used by
// discord-bot/post-guide.js (the pinned copy) and by restickGrowthGuide in
// lib/discordInteractions.js and discord-bot/index.js (the copy kept at the bottom of the channel).
const GROWTH_GUIDE_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';
const GROWTH_GUIDE_TITLE = '📈 How to Submit Your Growth Rate';

const GROWTH_GUIDE = {
  embeds: [
    {
      title: GROWTH_GUIDE_TITLE,
      color: 0x22c55e,
      description:
        'Type **`/uniongr`** in this channel and pick one of the two options below. ' +
        'Every field is required — Discord will walk you through them one by one.',
      fields: [
        {
          name: '1️⃣  `/uniongr same-ign` — Same IGN as Before / First Time',
          value:
            'Use this if your in-game name hasn\'t changed (or it\'s your first submission).\n' +
            '• **ign** — start typing and **pick your name** from the list (first time? just type it exactly as in game)\n' +
            '• **growthrate** — the Growth Rate number at the top of Character Details\n' +
            '• **screenshot** — attach your screenshot (see below)\n' +
            '• **class / guild / lamp** — *optional when updating*: leave them empty to keep what you had. Fill them in only if they changed, or if it\'s your **first** submission.\n' +
            'It\'s saved right away ✅',
        },
        {
          name: '2️⃣  `/uniongr switched-ign` — I Changed My IGN',
          value:
            'Use this **only** if you renamed your character.\n' +
            '• **oldign** — start typing your OLD name and **pick it from the list**\n' +
            '• **ign** — your NEW in-game name\n' +
            '• then class, guild, lamp, growthrate and screenshot, same as above\n' +
            '⏳ This one waits for an **admin to approve** it. Once approved, your attendance and history move to your new name — nothing is lost.',
        },
        {
          name: '📸 Screenshot Rules',
          value:
            '• **Full landscape screenshot** showing your character **and the Artifacts tab**\n' +
            '• Don\'t crop it down to just the popup\n' +
            '• The Growth Rate and lamp level must be readable',
        },
        {
          name: '💡 Tips',
          value:
            '• Updating your Growth Rate? Run `/uniongr same-ign`, pick your IGN, enter the new number and screenshot — that\'s it.\n' +
            '• Made a mistake? Submit again with the right values.\n' +
            '• The bot replies only to you (✅ or what went wrong). If `/uniongr` doesn\'t show up, ask an admin.',
        },
      ],
    },
    // The other four languages, shortened, as a 2×2 grid: two inline fields
    // per row, with a blank full-width field between the rows to force the
    // break (Discord otherwise packs up to 3 inline fields per row).
    {
      title: '🌏 中文 · 日本語 · ภาษาไทย · Tiếng Việt',
      color: 0x22c55e,
      fields: [
        {
          name: '🇨🇳 中文',
          inline: true,
          value:
            '**`/uniongr same-ign`** — IGN 没变／第一次提交\n' +
            '• **ign** — 输入名字并从列表中选择（第一次请输入与游戏内完全相同的名字）\n' +
            '• **growthrate** — 角色详情顶部的成长率\n' +
            '• **screenshot** — 附上截图\n' +
            '• **class / guild / lamp** — 更新时可留空（沿用上次的资料），第一次需全部填写\n\n' +
            '**`/uniongr switched-ign`** — 我改了 IGN\n' +
            '• **oldign** — 输入旧名字并从列表中选择\n' +
            '• **ign** — 新的 IGN\n' +
            '• 其他栏位同上\n' +
            '⏳ 需管理员审核，通过后出勤和记录会转到新名字\n\n' +
            '📸 横向完整截图（角色＋Artifacts 页面），不要只截弹窗。',
        },
        {
          name: '🇯🇵 日本語',
          inline: true,
          value:
            '**`/uniongr same-ign`** — IGNが前と同じ／初めて\n' +
            '• **ign** — 名前を入力してリストから選択（初めての方はゲーム内と同じ名前を入力）\n' +
            '• **growthrate** — キャラクター詳細上部の成長率\n' +
            '• **screenshot** — スクリーンショットを添付\n' +
            '• **class / guild / lamp** — 更新時は空欄でOK（前回の内容を引き継ぎます）。初回はすべて入力\n\n' +
            '**`/uniongr switched-ign`** — IGNを変更した\n' +
            '• **oldign** — 旧IGNを入力してリストから選択\n' +
            '• **ign** — 新しいIGN\n' +
            '• その他の項目は上と同じ\n' +
            '⏳ 管理者の承認後、出席と履歴は新しい名前に引き継がれます\n\n' +
            '📸 横向きの全画面スクショ（キャラクター＋Artifactsタブ）。ポップアップだけに切り取らないでください。',
        },
        { name: '​', value: '​' },
        {
          name: '🇹🇭 ภาษาไทย',
          inline: true,
          value:
            '**`/uniongr same-ign`** — IGN เดิม / ส่งครั้งแรก\n' +
            '• **ign** — พิมพ์ชื่อแล้วเลือกจากรายการ (ครั้งแรกให้พิมพ์ชื่อให้ตรงกับในเกม)\n' +
            '• **growthrate** — ค่า Growth Rate ด้านบนของหน้า Character Details\n' +
            '• **screenshot** — แนบภาพหน้าจอ\n' +
            '• **class / guild / lamp** — ตอนอัปเดตเว้นว่างได้ (ใช้ข้อมูลเดิม) ครั้งแรกต้องกรอกให้ครบ\n\n' +
            '**`/uniongr switched-ign`** — เปลี่ยน IGN แล้ว\n' +
            '• **oldign** — พิมพ์ชื่อเก่าแล้วเลือกจากรายการ\n' +
            '• **ign** — ชื่อใหม่\n' +
            '• ช่องอื่นเหมือนด้านบน\n' +
            '⏳ รอแอดมินอนุมัติ หลังอนุมัติแล้ว การเข้าร่วมและประวัติจะย้ายไปชื่อใหม่\n\n' +
            '📸 ภาพหน้าจอแนวนอนเต็มจอ (ตัวละคร + แท็บ Artifacts) ห้ามครอปเฉพาะป๊อปอัป',
        },
        {
          name: '🇻🇳 Tiếng Việt',
          inline: true,
          value:
            '**`/uniongr same-ign`** — IGN như cũ / gửi lần đầu\n' +
            '• **ign** — gõ tên rồi chọn trong danh sách (lần đầu thì gõ đúng tên trong game)\n' +
            '• **growthrate** — chỉ số Growth Rate ở đầu trang Character Details\n' +
            '• **screenshot** — đính kèm ảnh chụp màn hình\n' +
            '• **class / guild / lamp** — khi cập nhật có thể để trống (giữ thông tin cũ); lần đầu phải điền đủ\n\n' +
            '**`/uniongr switched-ign`** — Tôi đã đổi IGN\n' +
            '• **oldign** — gõ tên cũ rồi chọn trong danh sách\n' +
            '• **ign** — tên mới\n' +
            '• các mục khác giống như trên\n' +
            '⏳ Cần admin duyệt; sau khi duyệt, điểm danh và lịch sử sẽ chuyển sang tên mới\n\n' +
            '📸 Ảnh ngang toàn màn hình (nhân vật + tab Artifacts), không cắt chỉ phần popup.',
        },
      ],
    },
  ],
};

module.exports = { GROWTH_GUIDE, GROWTH_GUIDE_TITLE, GROWTH_GUIDE_CHANNEL_ID };
