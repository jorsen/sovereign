// The "how to use /uniongr" guide shown in the growth-rate channel. Used by
// discord-bot/post-guide.js (the pinned copy) and by restickGrowthGuide in
// lib/discordInteractions.js (the copy kept at the bottom of the channel).
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
            '• **ign** — your in-game name, spelled exactly as in game\n' +
            '• **class** — pick your 4th-advancement class\n' +
            '• **guild** — pick your guild\n' +
            '• **lamp** — Volcano Lamp enhancement level (the **+** number, 1–25)\n' +
            '• **growthrate** — the Growth Rate number at the top of Character Details\n' +
            '• **screenshot** — attach your screenshot (see below)\n' +
            'It\'s saved right away ✅',
        },
        {
          name: '2️⃣  `/uniongr changed-ign` — I Changed My IGN',
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
            '• Updating your Growth Rate? Just run `/uniongr same-ign` again — it replaces your old entry.\n' +
            '• Made a mistake? Submit again with the right values.\n' +
            '• The bot replies only to you (✅ or what went wrong). If `/uniongr` doesn\'t show up, ask an admin.',
        },
      ],
    },
  ],
};

module.exports = { GROWTH_GUIDE, GROWTH_GUIDE_TITLE, GROWTH_GUIDE_CHANNEL_ID };
