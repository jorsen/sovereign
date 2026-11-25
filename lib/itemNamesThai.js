// Night Crows item names as a Thai-language game shows them, under the
// English name the site saves. The loot reader turns a Thai loot list into
// these English names (lootMatch.js); a Thai name that isn't here is still
// named by its icon, and once saved, the trainer remembers that Thai text
// for next time -- so this list only needs the common items.
//
// Read off Thai loot lists. Spell them exactly as the game does (tone marks
// don't matter when matching). Several Thai names for one item are fine.
const THAI_ITEM_NAMES = {
  "Alioth's Endurance": ['ความอดทนของอัลลิออท'],
  'Piece of the Sky': ['ชิ้นส่วนท้องฟ้าคราม'],
  'Frozen Tear': ['น้ำตาเยือกแข็ง'],
  'Higher Seal of Advancement': ['ตราเปลี่ยนอาชีพชั้นสูง'],
  'Brilliant Blessing Stone': ['หินพรแห่งส่องสว่าง'],
  'Blessing Stone': ['หินพร'],
  'Essence of Curses': ['แก่นพลังแห่งคำสาป'],
  "Forgotten Immortal's Remnant": ['เศษซากของผู้เป็นอมตะ'],
};

module.exports = { THAI_ITEM_NAMES };
