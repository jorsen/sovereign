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
  badDate: {
    en: '❌ Could not read the date "{value}". Use 2026-11-20 or 11/20.',
    zh: '❌ 无法识别日期 “{value}”。请使用 2026-11-20 或 11/20 格式。',
    ja: '❌ 日付「{value}」を読み取れません。2026-11-20 または 11/20 の形式で入力してください。',
    th: '❌ อ่านวันที่ "{value}" ไม่ได้ ใช้รูปแบบ 2026-11-20 หรือ 11/20',
    vi: '❌ Không đọc được ngày "{value}". Dùng dạng 2026-11-20 hoặc 11/20.',
  },
  badTime: {
    en: '❌ Could not read the time "{value}". Use 21:30 or 9:30pm (Philippines time).',
    zh: '❌ 无法识别时间 “{value}”。请使用 21:30 或 9:30pm（菲律宾时间）。',
    ja: '❌ 時刻「{value}」を読み取れません。21:30 または 9:30pm（フィリピン時間）で入力してください。',
    th: '❌ อ่านเวลา "{value}" ไม่ได้ ใช้รูปแบบ 21:30 หรือ 9:30pm (เวลาฟิลิปปินส์)',
    vi: '❌ Không đọc được giờ "{value}". Dùng dạng 21:30 hoặc 9:30pm (giờ Philippines).',
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
