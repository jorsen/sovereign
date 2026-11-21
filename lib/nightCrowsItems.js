// Night Crows item names, spelled as the game shows them -- seeded so the
// loot reader can complete cut-off names ("...vonia Knights Gloves") even
// for items no record on the site has yet. Source: the drop lists of
// Balthazard, Tandallon, Hotura and Kafka on https://nightcrows.th.gl/db
// (the game's own English text), read 2026-11-21. Other bosses' drops
// weren't listed there; add their items here (or in extraItems.js) as they
// turn up. A name the site's records already use with other spacing or
// punctuation is skipped in favor of the records' spelling (loadKnownItems).
const NIGHT_CROWS_ITEMS = [
  // Insignia
  'Golden Inner Armor Insignia Fragment', 'Golden Inner Armor Insignia',
  'Red Cross Insignia Fragment', 'Red Cross Insignia',
  // Remnants
  "Forgotten Ruler's Remnant", "Forgotten Immortal's Remnant", "Forgotten Transcendent's Remnant", "Forgotten Arbiter's Remnant",
  // Arcane scrolls
  ...['Discipline', 'Escalation', 'Wisdom', 'Prosperity'].flatMap((k) => [`Arcane Scroll of ${k}`, `Higher Arcane Scroll of ${k}`, `Superior Arcane Scroll of ${k}`]),
  'Higher Seal of Advancement',
  // Enhancement scrolls and refinement stones
  ...['Weapon', 'Armor', 'Accessory', 'Artifact'].flatMap((k) => [`Brilliant ${k} Enhancement Scroll`, `Pitch-black ${k} Enhancement Scroll`]),
  'Brilliant Weapon Refinement Stone', 'Brilliant Armor Refinement Stone', 'Brilliant Accessory Refinement Stone',
  // Blessing stones and other materials
  'Blessing Stone', 'Brilliant Blessing Stone', 'Blessing Stone of Dawn', 'Blessing Stone of the Sun',
  'Frozen Tear', 'Piece of the Sky', "Star's Soul", "Star's Soul Fragment",
  'Aura of Intense Manifestation', 'Aura of Silent Manifestation', 'Aura of Circulating Manifestation',
  "Ancient Master's Alloy", 'Source of Wisdom', 'Magical Rune Slate', 'Meticulous Aircraft Component', 'Essence of Curses',
  "Rootless Tree's Justice", "Night Crows Captain's Freedom", 'Initiative of Undaunted Sea Breeze', 'Faith of the Immutable Bond',
  'Time Recharger - Masarta Special Dungeon',
  // Star stones (Balthazard)
  "Aldebaran's Escalation", "Toliman's Flash", "Regulus' Justice", "Kraz's Courage", "Polis' Wit", "Altair's Combat Spirit",
  "Antares' Perseverance", "Deneb's Authority", "Spica's Wish", "Capella's Serenity", "Canopus' Scrutiny", "Aldebaran's Perseverance",
  "Toliman's Dispassion", "Regulus' Resolution", "Kraz's Intention", "Polis' Resolve", "Altair's Prayer", "Antares' Sagacity",
  "Deneb's Truth", "Spica's Sincerity", "Capella's Principle", "Canopus' Tuning", "Sirius' Prayer", "Alioth's Endurance",
  "Procyon's Conviction", "Polaris' Honesty", "Castor's Progress", "Markab's Honor", "Bellatrix's Heart", "Bellatrix's Faith",
  "Bellatrix's Oath", "Bellatrix's Blessing", "Betelgeuse's Promise", "Betelgeuse's Veneration", "Arcturus' Fortitude", "Arcturus' Humility",
  // Skill books (I) and appendices (II)
  ...['Frenzy: Gush of Blades', 'Spiral Strike', 'Judgment of Protection', 'Double Slash', 'Piercing Arrow', 'Blade Surge', 'Frost Crystal',
    'Fetters of Stigma', 'Piercing Barrage', 'Moonlight: Flip Side', 'Siphon', 'Erosion', 'Frenzy: Rupture', 'Mark of Pain'].map((s) => `Skill Book - ${s} I`),
  ...['Frenzy: Rupture', 'Mark of Pain', 'Frenzy: Gush of Blades', 'Spiral Strike', 'Judgment of Protection', 'Double Slash', 'Piercing Arrow',
    'Blade Surge', 'Piercing Barrage', 'Frost Crystal', 'Fetters of Stigma', 'Moonlight: Flip Side', 'Wave of Flames', 'Siphon'].map((s) => `Skill Book Appendix - ${s} II`),
  // Boss gear
  'Necklace of Honor', 'Necklace of Exaltation', 'Necklace of Acclaim', 'Belt of Honor', 'Belt of Exaltation', 'Belt of Glory',
  "House of Avis' Chest Armor", "House of Avis' Gloves", 'Avis Insignia Cape', "House of Burgundy's Gaiters", "House of Burgundy's Boots",
  "House of Burgundy's Gloves", "House of Merowinger's Boots", "House of Merowinger's Gloves", "House of Merowinger's Gaiters",
  "House of Babenberg's Decor Knot", "House of Babenberg's Scabbard", "House of Grimaldi's Wand", "House of Grimaldi's Rosary",
  "House of Grimaldi's Chest Armor", "House of Grimaldi's Gaiters", "House of Grimaldi's Gloves", "House of Nemanji's Gloves",
  "House of Nemanji's Shoes", "House of Capet's Gloves", "House of Capet's Boots", 'Capet Insignia Cape', "House of Arpad's Gloves",
  "House of Alpin's Gloves", "House of Alpin's Chest Armor",
  'Komo Longspear', 'Irletta Longbow', 'Sancona Staff', 'Fossa Rosary', 'Fossa Twin Sword', 'Fossa Wand', 'Alaine Sword',
  'Nervad Longbow', 'Colia Longspear', 'Kildebat Wand', 'Skanina Sword', 'Monteno Greatsword', 'Monteno Bow', 'Silvain Dagger',
  'Silvain Spear', 'Tronetel Rosary', 'Tronetel Twin Sword', 'Tronetel Wand', 'Celano Grimoire', 'Celano Staff', 'Daniphel Espada',
  "Endaimon's Twin Sword", "Hotura's Twin Sword", "Hotura's Dagger", "Maltanis' Two-handed Sword", "Kafka's Hook Staff",
  "Kafka's Hook Wand", "Kafka's Gauntlet",
  "Protector's Ring", "Protector's Necklace", "Protector's Belt", "Protector's Earrings", "Seeker's Necklace", "Watcher's Necklace",
  "Adventurer's Necklace",
  'Trieste Knights Vest', 'Trieste Knights Gloves', 'Malta Knights Chest Armor', 'Livonia Knights Gloves', 'Holy See Knights Boots',
  'Santiago Knights Gloves', 'Avitz Knights Gloves',
  'Night Crows Heavy Armored Helmet', 'Night Crows Iron Wall Cape', 'Night Crows Shield', 'Night Crows Heavy Armored Shoes',
  'Night Crows Dagger', 'Night Crows Rosary',
];

module.exports = { NIGHT_CROWS_ITEMS };
