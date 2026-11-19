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
