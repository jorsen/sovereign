// The "how to log a boss kill" guide kept as the newest message in the
// attendance channel(s): restickAttendanceGuide in lib/discordInteractions.js
// deletes the bot's previous copy and posts it again after every boss post
// the bot reads. Same five languages as the growth guide
// (discord-bot/growthGuide.js). Boss names are never translated.
const { SCANNABLE_BOSSES } = require('./bosses');

const ATTENDANCE_GUIDE_TITLE = '⚔️ How to Log a Boss Kill';
// Drawn by discord-bot/make-attendance-infographic.js, served from
// public/guide/ on the site. Bump ?v= after re-drawing it -- Discord caches
// embed images by URL.
const ATTENDANCE_GUIDE_IMAGE = 'https://sovereign-nightcrows.vercel.app/guide/attendance-guide.png?v=1';
const BOSS_LIST = SCANNABLE_BOSSES.map((b) => b.boss).join(' · ');

const ATTENDANCE_GUIDE = {
  embeds: [
    {
      title: ATTENDANCE_GUIDE_TITLE,
      color: 0xf59e0b,
      image: { url: ATTENDANCE_GUIDE_IMAGE },
      description:
        'Post your screenshots **in this channel** with the **boss name in the same message**. The bot reads them by itself — no command needed.\n\n' +
        '**Quick steps**\n' +
        '1. Attach the **battle screenshots** (name tags visible) **and the loot list** screenshot — up to **10** in one message.\n' +
        '2. Type the **boss name** in that same message: `Kafka`, `RK`, `Baltha`, `Ducas 88/96`…\n' +
        '3. Send it. The bot marks it 🔍 while reading, then replies with a **Review** 📝.\n' +
        '4. Check the Review, fix what\'s wrong, and press **Save** ✅.',
      fields: [
        {
          name: '📸 Screenshots — What They Must Show',
          value:
            '• **Full screen, not cropped** — the name tags above everyone must be readable.\n' +
            '• Party (**blue**), guild (**green**) and alliance (**light green**) names are read. In big fights, take a few angles so nobody is hidden.\n' +
            '• The **loot list** (with the date & time) gives the exact **Time of Death** and the loot. Without it, the time is when you posted.\n' +
            '• Attach images, paste Discord image/message links, or forward the post.',
        },
        {
          name: '📝 The Review — Check It Before Saving',
          value:
            '• Ticked = sure. **Untick** anyone who wasn\'t there.\n' +
            '• "Not sure" guesses start unticked — **tick** them if they were there.\n' +
            '• **➕ Add a missed member** — type part of the name and pick it.\n' +
            '• Forgot the loot list? **🎁 Add loot** — post it here, Copy Link, paste it.\n' +
            '• **Save** logs it to the site, **Cancel** drops it. Only the poster or an admin can press them.',
        },
        {
          name: '💡 Tips',
          value:
            '• **One kill per message** — two bosses = two messages.\n' +
            '• Same kill posted again? The Review says so, and **Update** replaces the saved names.\n' +
            '• After saving, use **➕ Add member / ➖ Remove** and **🎁 Loot** on the post to fix mistakes.\n' +
            '• Marks on your post: 🔍 reading · 📝 Review posted · ✅ saved · ❌ cancelled / couldn\'t read\n' +
            `• Bosses: ${BOSS_LIST}`,
        },
      ],
    },
    // The other four languages, shortened, as a 2×2 grid (a blank
    // full-width field between the rows forces the break).
    {
      title: '🌏 中文 · 日本語 · ภาษาไทย · Tiếng Việt',
      color: 0xf59e0b,
      fields: [
        {
          name: '🇨🇳 中文',
          inline: true,
          value:
            '在本频道发送截图，**同一条消息里写上 Boss 名字**（如 `Kafka`、`RK`、`Ducas 88/96`），机器人会自动读取。\n' +
            '1. 附上**战斗截图**（能看清名字）和**战利品列表截图**，一条消息最多 10 张\n' +
            '2. 机器人显示 🔍 读取中，然后回复 **Review** 📝\n' +
            '3. 取消勾选没来的人，勾选来了的“不确定”名字，用 **➕** 添加漏掉的成员\n' +
            '4. 按 **Save** ✅ 保存\n\n' +
            '📸 全屏截图，不要裁剪。战利品列表决定击杀时间。**一条消息只发一次击杀。**',
        },
        {
          name: '🇯🇵 日本語',
          inline: true,
          value:
            'このチャンネルにスクショを投稿し、**同じメッセージにボス名を書いてください**（例：`Kafka`、`RK`、`Ducas 88/96`）。ボットが自動で読み取ります。\n' +
            '1. **戦闘のスクショ**（名前が見える）と**戦利品リストのスクショ**を添付（1メッセージ最大10枚）\n' +
            '2. 🔍 読み取り中 → **Review** 📝 が返信されます\n' +
            '3. いなかった人はチェックを外し、「不確か」の名前で参加者はチェック、漏れは **➕** で追加\n' +
            '4. **Save** ✅ で保存\n\n' +
            '📸 切り取らない全画面スクショで。討伐時刻は戦利品リストから。**1メッセージにつき1討伐。**',
        },
        { name: '​', value: '​' },
        {
          name: '🇹🇭 ภาษาไทย',
          inline: true,
          value:
            'โพสต์ภาพในช่องนี้ และ**พิมพ์ชื่อบอสในข้อความเดียวกัน** (เช่น `Kafka`, `RK`, `Ducas 88/96`) บอทจะอ่านให้เอง\n' +
            '1. แนบ**ภาพการต่อสู้** (เห็นชื่อ) และ**ภาพรายการของดรอป** ได้สูงสุด 10 ภาพต่อข้อความ\n' +
            '2. บอทขึ้น 🔍 ระหว่างอ่าน แล้วตอบกลับเป็น **Review** 📝\n' +
            '3. เอาติ๊กออกคนที่ไม่ได้มา ติ๊กชื่อ "ไม่แน่ใจ" ที่มาจริง และกด **➕** เพื่อเพิ่มคนที่ขาด\n' +
            '4. กด **Save** ✅ เพื่อบันทึก\n\n' +
            '📸 ภาพเต็มจอ ห้ามครอป เวลาบอสตายอ่านจากรายการของดรอป **หนึ่งข้อความต่อหนึ่งบอส**',
        },
        {
          name: '🇻🇳 Tiếng Việt',
          inline: true,
          value:
            'Đăng ảnh trong kênh này và **ghi tên boss trong cùng tin nhắn** (vd: `Kafka`, `RK`, `Ducas 88/96`). Bot sẽ tự đọc.\n' +
            '1. Đính kèm **ảnh trận đánh** (thấy tên) và **ảnh danh sách vật phẩm rơi**, tối đa 10 ảnh mỗi tin\n' +
            '2. Bot hiện 🔍 khi đang đọc, rồi trả lời bằng **Review** 📝\n' +
            '3. Bỏ tick người không có mặt, tick tên "không chắc" nếu họ có mặt, bấm **➕** để thêm người bị sót\n' +
            '4. Bấm **Save** ✅ để lưu\n\n' +
            '📸 Ảnh toàn màn hình, không cắt. Giờ hạ boss lấy từ danh sách vật phẩm. **Mỗi tin nhắn một trận.**',
        },
      ],
    },
  ],
};

module.exports = { ATTENDANCE_GUIDE, ATTENDANCE_GUIDE_TITLE };
