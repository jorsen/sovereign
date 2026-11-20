// Item names the loot reader should know even before any record on the site
// has them. The loot list cuts long names off ("x - Wave of Flames Il"), so a
// new item can only be completed and saved once its full name is known --
// normally from the site's own records (loadKnownItems). Add full names here
// as they appear in game, spelled exactly as the game shows them.
const EXTRA_ITEM_NAMES = [
  'Skill Book Appendix - Wave of Flames II',
  'Monteno Vambrace',
];

module.exports = { EXTRA_ITEM_NAMES };
