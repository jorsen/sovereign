// Item names the loot reader should know even before any record on the site
// has them. The loot list cuts long names off ("x - Wave of Flames Il"), so a
// new item can only be completed and saved once its full name is known --
// normally from the site's own records (loadKnownItems). Add full names here
// as they appear in game, spelled exactly as the game shows them.
const EXTRA_ITEM_NAMES = [
  'Skill Book Appendix - Wave of Flames II',
  'Monteno Vambrace',
  'Livonia Knights Gloves', // Tandallon; cut to "...vonia Knights Gloves" on the loot list
  'Skill Book Appendix - Blade Surge II', // Balthazard; not the plain "Skill Book Blade Surge II"
  'Belt of Honor', // Balthazard
  'Black Hawk Insignia', // Stormid of Onrush
  // The 8 enhancement scrolls (lib/itemIcons.json has their icons); the
  // site already had the other four.
  'Brilliant Accessory Enhancement Scroll',
  'Brilliant Artifact Enhancement Scroll',
  'Pitch Black Weapon Enhancement Scroll',
  'Pitch Black Artifact Enhancement Scroll',
  // Plus the seeded game item list (lib/nightCrowsItems.js).
  ...require('./nightCrowsItems').NIGHT_CROWS_ITEMS,
];

module.exports = { EXTRA_ITEM_NAMES };
