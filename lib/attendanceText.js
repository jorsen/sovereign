// Member-facing attendance texts, in the same five languages as the
// growth-rate guide (discord-bot/growthGuide.js): English, 中文, 日本語,
// ภาษาไทย, Tiếng Việt. Names and boss names are never translated.

const LANGS = [
  { code: 'zh', flag: '🇨🇳' },
  { code: 'ja', flag: '🇯🇵' },
  { code: 'th', flag: '🇹🇭' },
  { code: 'vi', flag: '🇻🇳' },
];

const TEXT = {
  guess: {
    en: '⚠️ = best guess from the Growth Rate list, please check',
    zh: '⚠️ = 根据成长率名单推测，请核对',
    ja: '⚠️ = 成長率リストからの推測です。確認してください',
    th: '⚠️ = คาดเดาจากรายชื่อ Growth Rate โปรดตรวจสอบ',
    vi: '⚠️ = tên đoán theo danh sách Growth Rate, vui lòng kiểm tra',
  },
  notOnList: {
    en: '❓ = not on the Growth Rate list (new member, or misread)',
    zh: '❓ = 不在成长率名单中（新成员或识别错误）',
    ja: '❓ = 成長率リストにありません（新メンバーまたは読み取りミス）',
    th: '❓ = ไม่อยู่ในรายชื่อ Growth Rate (สมาชิกใหม่ หรืออ่านผิด)',
    vi: '❓ = không có trong danh sách Growth Rate (thành viên mới hoặc đọc sai)',
  },
  hardToRead: {
    en: '⚠️ = hard to read in the screenshot, please double-check the spelling',
    zh: '⚠️ = 截图中难以辨认，请核对拼写',
    ja: '⚠️ = スクショで読み取りにくい名前です。綴りを確認してください',
    th: '⚠️ = อ่านจากภาพยาก โปรดตรวจสอบตัวสะกด',
    vi: '⚠️ = khó đọc trong ảnh, vui lòng kiểm tra lại chính tả',
  },
  listInThread: {
    en: '📋 Attendee list is in the thread below.',
    zh: '📋 出席名单在下方讨论串中。',
    ja: '📋 出席者リストは下のスレッドにあります。',
    th: '📋 รายชื่อผู้เข้าร่วมอยู่ในเธรดด้านล่าง',
    vi: '📋 Danh sách tham gia nằm trong thread bên dưới.',
  },
  noNames: {
    en: 'No blue, green or light green names found in this screenshot.',
    zh: '截图中没有找到蓝色、绿色或浅绿色的名字。',
    ja: 'スクショに青・緑・薄緑の名前が見つかりませんでした。',
    th: 'ไม่พบชื่อสีน้ำเงิน สีเขียว หรือสีเขียวอ่อนในภาพนี้',
    vi: 'Không tìm thấy tên màu xanh dương, xanh lá hoặc xanh lá nhạt trong ảnh.',
  },
  downloadFailed: {
    en: '❌ Could not download the screenshot. Please try again.',
    zh: '❌ 无法下载截图，请重试。',
    ja: '❌ スクショをダウンロードできませんでした。もう一度お試しください。',
    th: '❌ ดาวน์โหลดภาพไม่ได้ โปรดลองอีกครั้ง',
    vi: '❌ Không tải được ảnh chụp màn hình. Vui lòng thử lại.',
  },
  readFailed: {
    en: '❌ Something went wrong reading the screenshots. Please try again or use /attendance.',
    zh: '❌ 读取截图时出错，请重试或使用 /attendance。',
    ja: '❌ スクショの読み取り中にエラーが発生しました。もう一度試すか /attendance を使ってください。',
    th: '❌ เกิดข้อผิดพลาดในการอ่านภาพ โปรดลองอีกครั้งหรือใช้ /attendance',
    vi: '❌ Đã xảy ra lỗi khi đọc ảnh. Vui lòng thử lại hoặc dùng /attendance.',
  },
  needScreenshots: {
    en: '❌ No screenshots: attach them, or paste the link of the Discord message that has them (link:).',
    zh: '❌ 没有截图：请附加截图，或在 link: 中粘贴包含截图的 Discord 消息链接。',
    ja: '❌ スクショがありません。添付するか、スクショのある Discord メッセージのリンクを link: に貼ってください。',
    th: '❌ ไม่มีภาพ: แนบภาพ หรือวางลิงก์ข้อความ Discord ที่มีภาพในช่อง link:',
    vi: '❌ Không có ảnh: hãy đính kèm, hoặc dán link tin nhắn Discord có ảnh vào link:.',
  },
  linkFailed: {
    en: "❌ Couldn't open that message link ({link}). The bot needs to see that channel, and the message needs images.",
    zh: '❌ 无法打开该消息链接（{link}）。机器人需要能看到该频道，且消息中要有图片。',
    ja: '❌ そのメッセージリンク（{link}）を開けませんでした。ボットがそのチャンネルを見られること、メッセージに画像があることが必要です。',
    th: '❌ เปิดลิงก์ข้อความนั้นไม่ได้ ({link}) บอทต้องเห็นช่องนั้น และข้อความต้องมีรูปภาพ',
    vi: '❌ Không mở được link tin nhắn ({link}). Bot cần xem được kênh đó và tin nhắn phải có ảnh.',
  },
  invalidAttachment: {
    en: '❌ Every screenshot has to be an image.',
    zh: '❌ 每个截图都必须是图片。',
    ja: '❌ スクショは画像ファイルにしてください。',
    th: '❌ ไฟล์แนบทุกไฟล์ต้องเป็นรูปภาพ',
    vi: '❌ Mỗi ảnh chụp màn hình phải là tệp hình ảnh.',
  },
  savedNew: {
    en: '💾 Saved to the {page} page as a new record ({count} attendees). Set Win/Lose there.',
    zh: '💾 已作为新记录保存到 {page} 页面（{count} 人出席）。请在网站上设置胜/负。',
    ja: '💾 {page} ページに新しい記録として保存しました（出席 {count} 人）。勝敗はサイトで設定してください。',
    th: '💾 บันทึกลงหน้า {page} เป็นรายการใหม่แล้ว (ผู้เข้าร่วม {count} คน) ตั้งค่าชนะ/แพ้ได้ที่เว็บไซต์',
    vi: '💾 Đã lưu vào trang {page} thành bản ghi mới ({count} người tham gia). Đặt Thắng/Thua trên trang web.',
  },
  savedMerged: {
    en: '💾 Same fight as the {time} record: added {added} new name(s), now {total} attendees.',
    zh: '💾 与 {time} 的记录是同一场：新增 {added} 人，现共 {total} 人出席。',
    ja: '💾 {time} の記録と同じ戦闘です：{added} 人を追加、合計 {total} 人になりました。',
    th: '💾 เป็นการต่อสู้เดียวกับรายการเวลา {time}: เพิ่มชื่อใหม่ {added} คน รวมเป็น {total} คน',
    vi: '💾 Cùng trận với bản ghi lúc {time}: đã thêm {added} tên mới, tổng cộng {total} người.',
  },
  unknownNotSaved: {
    en: 'Names marked ❓ were not saved. If they were there, add them on the site.',
    zh: '标有 ❓ 的名字没有保存。如果他们有出席，请在网站上手动添加。',
    ja: '❓ が付いた名前は保存されていません。出席していた場合はサイトで追加してください。',
    th: 'ชื่อที่มี ❓ ไม่ได้ถูกบันทึก ถ้าเขาเข้าร่วมจริง โปรดเพิ่มที่เว็บไซต์',
    vi: 'Các tên có ❓ chưa được lưu. Nếu họ có tham gia, hãy thêm trên trang web.',
  },
  saveFailed: {
    en: '⚠️ Could not save this to the website. An admin can log it on the site by hand.',
    zh: '⚠️ 无法保存到网站，请管理员在网站上手动记录。',
    ja: '⚠️ サイトに保存できませんでした。管理者がサイトで手動で記録してください。',
    th: '⚠️ บันทึกลงเว็บไซต์ไม่ได้ แอดมินสามารถบันทึกเองที่เว็บไซต์',
    vi: '⚠️ Không lưu được lên trang web. Admin có thể ghi thủ công trên trang web.',
  },
  unknownBoss: {
    en: '❌ "{boss}" is not one of our bosses. Pick one from the list: {list}',
    zh: '❌ “{boss}” 不在 Boss 列表中。请从列表中选择：{list}',
    ja: '❌ 「{boss}」はボス一覧にありません。一覧から選んでください：{list}',
    th: '❌ "{boss}" ไม่อยู่ในรายชื่อบอส โปรดเลือกจากรายการ: {list}',
    vi: '❌ "{boss}" không có trong danh sách boss. Hãy chọn trong danh sách: {list}',
  },
  needLootList: {
    en: '❌ Please also attach the loot list screenshot — the Time of Death is read from it. Nothing was saved.',
    zh: '❌ 请同时附上战利品列表截图——击杀时间从中读取。本次未保存任何内容。',
    ja: '❌ 戦利品リストのスクショも添付してください。討伐時刻はそこから読み取ります。何も保存されていません。',
    th: '❌ โปรดแนบภาพรายการของดรอปด้วย — เวลาที่บอสตายอ่านจากภาพนั้น ยังไม่ได้บันทึกอะไร',
    vi: '❌ Vui lòng đính kèm cả ảnh danh sách vật phẩm rơi — thời điểm hạ boss được đọc từ ảnh đó. Chưa lưu gì cả.',
  },
  lootBossMismatch: {
    en: '❌ The loot list is for {lootBoss}, not {boss}. Pick the right boss or attach that boss\'s loot list. Nothing was saved.',
    zh: '❌ 这份战利品列表属于 {lootBoss}，不是 {boss}。请选择正确的 Boss 或附上该 Boss 的战利品列表。本次未保存任何内容。',
    ja: '❌ この戦利品リストは {boss} ではなく {lootBoss} のものです。正しいボスを選ぶか、そのボスの戦利品リストを添付してください。何も保存されていません。',
    th: '❌ รายการของดรอปนี้เป็นของ {lootBoss} ไม่ใช่ {boss} โปรดเลือกบอสให้ถูก หรือแนบรายการของดรอปของบอสนั้น ยังไม่ได้บันทึกอะไร',
    vi: '❌ Danh sách vật phẩm này là của {lootBoss}, không phải {boss}. Hãy chọn đúng boss hoặc đính kèm danh sách vật phẩm của boss đó. Chưa lưu gì cả.',
  },
  lootAdded: {
    en: '🎁 Loot added to the {boss} record at {time}: {count} item(s).',
    zh: '🎁 战利品已加入 {time} 的 {boss} 记录：{count} 件。',
    ja: '🎁 {time} の {boss} の記録に戦利品を追加しました：{count} 個。',
    th: '🎁 เพิ่มของดรอปลงรายการ {boss} เวลา {time} แล้ว: {count} ชิ้น',
    vi: '🎁 Đã thêm vật phẩm rơi vào bản ghi {boss} lúc {time}: {count} món.',
  },
  lootNewRecord: {
    en: '🎁 Loot saved as a new {boss} record at {time}: {count} item(s). Run /attendance with the fight screenshot to add who was there.',
    zh: '🎁 战利品已保存为 {time} 的新 {boss} 记录：{count} 件。请用战斗截图执行 /attendance 来加入出席者。',
    ja: '🎁 {time} の {boss} の新しい記録として戦利品を保存しました：{count} 個。戦闘のスクショで /attendance を実行すると出席者が追加されます。',
    th: '🎁 บันทึกของดรอปเป็นรายการ {boss} ใหม่ เวลา {time}: {count} ชิ้น ใช้ /attendance กับภาพการต่อสู้เพื่อเพิ่มผู้เข้าร่วม',
    vi: '🎁 Đã lưu vật phẩm rơi thành bản ghi {boss} mới lúc {time}: {count} món. Dùng /attendance với ảnh trận đánh để thêm người tham gia.',
  },
  lootAlreadyThere: {
    en: '🎁 The {boss} record at {time} already has loot, so nothing was added (so it isn\'t counted twice). Fix it on the site if needed.',
    zh: '🎁 {time} 的 {boss} 记录已有战利品，因此没有重复加入（避免重复计算）。如需修改请在网站上处理。',
    ja: '🎁 {time} の {boss} の記録にはすでに戦利品があるため、追加していません（二重計上防止）。必要ならサイトで修正してください。',
    th: '🎁 รายการ {boss} เวลา {time} มีของดรอปอยู่แล้ว จึงไม่ได้เพิ่มซ้ำ (กันนับซ้ำ) แก้ไขได้ที่เว็บไซต์',
    vi: '🎁 Bản ghi {boss} lúc {time} đã có vật phẩm, nên không thêm nữa (tránh tính trùng). Sửa trên trang web nếu cần.',
  },
  lootGuess: {
    en: '⚠️ = item name completed from a cut-off name, please check',
    zh: '⚠️ = 根据被截断的名称补全的物品名，请核对',
    ja: '⚠️ = 途切れた名前から補完したアイテム名です。確認してください',
    th: '⚠️ = ชื่อไอเทมที่เติมจากชื่อที่ถูกตัด โปรดตรวจสอบ',
    vi: '⚠️ = tên vật phẩm được đoán từ tên bị cắt, vui lòng kiểm tra',
  },
  lootUnknown: {
    en: 'Items marked ❓ are not in the site\'s item list and were not saved. Add them on the site.',
    zh: '标有 ❓ 的物品不在网站的物品列表中，未保存。请在网站上手动添加。',
    ja: '❓ が付いたアイテムはサイトのアイテム一覧になく、保存されていません。サイトで追加してください。',
    th: 'ไอเทมที่มี ❓ ไม่อยู่ในรายการไอเทมของเว็บไซต์ จึงไม่ได้บันทึก โปรดเพิ่มที่เว็บไซต์',
    vi: 'Các vật phẩm có ❓ không có trong danh sách của trang web nên chưa được lưu. Hãy thêm trên trang web.',
  },
  lootSaveFailed: {
    en: '⚠️ Could not save the loot to the website. An admin can add it on the site by hand.',
    zh: '⚠️ 无法将战利品保存到网站，请管理员在网站上手动添加。',
    ja: '⚠️ 戦利品をサイトに保存できませんでした。管理者がサイトで手動で追加してください。',
    th: '⚠️ บันทึกของดรอปลงเว็บไซต์ไม่ได้ แอดมินสามารถเพิ่มเองที่เว็บไซต์',
    vi: '⚠️ Không lưu được vật phẩm lên trang web. Admin có thể thêm thủ công trên trang web.',
  },
  wrongChannel: {
    en: 'Use /attendance in {channel}.',
    zh: '请在 {channel} 使用 /attendance。',
    ja: '/attendance は {channel} で使ってください。',
    th: 'โปรดใช้ /attendance ใน {channel}',
    vi: 'Hãy dùng /attendance trong {channel}.',
  },
};

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? '');

// For posts everyone sees: English, then the other four on one line of
// Discord's small "-#" subtext so the English stays easy to scan.
// The marker the English line starts with ("⚠️ = ", "❌ ") isn't repeated
// for every language on the subtext line.
function multi(key, vars) {
  const t = TEXT[key];
  const en = fill(t.en, vars);
  const marker = (en.match(/^[^\p{L}\p{N}/]+/u) || [''])[0];
  const others = LANGS.map((l) => {
    const text = fill(t[l.code], vars);
    return `${l.flag} ${marker && text.startsWith(marker) ? text.slice(marker.length) : text}`;
  });
  return `${en}\n-# ${others.join(' · ')}`;
}

// For a private reply: just the member's own Discord language (their
// client's locale, e.g. "zh-CN", "ja", "th", "vi"), English otherwise.
function forLocale(key, locale, vars) {
  const t = TEXT[key];
  const code = String(locale || '').split('-')[0].toLowerCase();
  return fill(t[code] || t.en, vars);
}

module.exports = { multi, forLocale };
