// The "how to use /uniongr" guide shown in the growth-rate channel. Used by
// discord-bot/post-guide.js (the pinned copy) and by restickGrowthGuide in
// lib/discordInteractions.js and discord-bot/index.js (the copy kept at the bottom of the channel).
const GROWTH_GUIDE_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';
const GROWTH_GUIDE_TITLE = '📈 How to Submit Your Growth Rate';
// Drawn by make-infographic.js, served from public/guide/ on the site. Bump
// ?v= after re-drawing it -- Discord caches embed images by URL.
const GROWTH_GUIDE_IMAGE = 'https://sovereign-nightcrows.vercel.app/guide/uniongr-guide.png?v=1';

const GROWTH_GUIDE = {
  embeds: [
    {
      title: GROWTH_GUIDE_TITLE,
      color: 0x22c55e,
      image: { url: GROWTH_GUIDE_IMAGE },
      description:
        'Submissions only count when they go through the **`/uniongr`** command — normal chat messages are not saved.\n\n' +
        '**Quick steps**\n' +
        '1. **Take your screenshot first** (see 📸 below) so it\'s ready to attach.\n' +
        '2. In this channel, type `/uniongr` and **click** the option that pops up — don\'t send it as plain text.\n' +
        '3. Pick **same-ign** (most people) or **switched-ign** (only if you renamed your character).\n' +
        '4. Fill in each field — click the next field, or press **Tab** to move along.\n' +
        '5. Attach your screenshot and press **Enter** to send.\n' +
        '6. Check the bot\'s reply — only you can see it.',
      fields: [
        {
          name: '1️⃣  `/uniongr same-ign` — Same IGN as Before / First Time',
          value:
            'For updating your Growth Rate, or for your very first submission.\n' +
            '• **ign** *(required)* — start typing and **pick your name** from the list so it matches exactly (symbols like ・ ツ 丶 included). First time? Type your name exactly as it shows in game.\n' +
            '• **growthrate** *(required)* — the Growth Rate number at the top of **Character Details**. Numbers only — no commas or spaces.\n' +
            '• **screenshot** *(required)* — your screenshot (see 📸 below).\n' +
            '• **class / guild / lamp** *(optional when updating)* — leave them empty to keep what you had. Fill in only what changed. **First submission? Fill in all three.**\n' +
            '  ‣ **lamp** = the **+number** on your Volcano Lamp (1–25)\n' +
            '✅ Saved right away — submitting again simply replaces your old entry.',
        },
        {
          name: '2️⃣  `/uniongr switched-ign` — I Changed My IGN',
          value:
            'Use this **only** if you renamed your character in game.\n' +
            '• **oldign** — start typing your **OLD** name and **pick it from the list**\n' +
            '• **ign** — your **NEW** name, exactly as in game\n' +
            '• **class, guild, lamp, growthrate, screenshot** — all required here\n' +
            '⏳ An **admin checks and approves** it first. Once approved, your attendance, salary and history move to your new name — nothing is lost. You\'ll see a message in this channel when it\'s done.',
        },
        {
          name: '📸 Screenshot — What It Must Show',
          value:
            '• **Full screen, landscape** (wider than it is tall)\n' +
            '• Your **character** on screen **and** the **Character Details → Artifacts** tab open\n' +
            '• The **Growth Rate** number and **Volcano Lamp +level** clearly readable\n' +
            '**How to attach it**\n' +
            '• Click the **screenshot** field, then **drag the image in** or click it to choose the file\n' +
            '❌ **Rejected:** only the popup cropped out, a portrait (tall) image, blurry or cut-off numbers',
        },
        {
          name: '🤖 What the Bot Replies',
          value:
            '• ✅ **Saved** — you\'re on the Growth Rate list.\n' +
            '• ⏳ **Sent for admin approval** — switched-ign only; wait for the approval message.\n' +
            '• ❌ **Error** — the reply says exactly what to fix. Fix it and run `/uniongr` again.\n' +
            'Most common errors: cropped or portrait screenshot · picked the wrong IGN · first submission without class/guild/lamp.',
        },
        {
          name: '💡 Tips',
          value:
            '• Update whenever your Growth Rate goes up — same command, **same-ign**.\n' +
            '• Changed guild, class or lamp? Fill in just that field; everything else carries over.\n' +
            '• Made a mistake? Submit again with the right values — no duplicates are created.\n' +
            '• `/uniongr` not showing up? Make sure you\'re in this channel, then ask an admin.',
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
