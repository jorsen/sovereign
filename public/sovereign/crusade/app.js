// Standalone Sovereign / Crusade page — no shared app shell, no hash router
// from router.js. Bare '/' shows the crusade list; #<crusadeId> shows
// that crusade's roster + distribution. common.js still supplies
// api()/toast()/escapeHtml()/session handling, which is why it's loaded here.

// A crusade is just the shared date/event container (name + date); every
// team on it is its own independent battle with its own war type, stance,
// result, diamond reward, attendance %, notes, items and fees -- so two
// teams sharing a crusade's date can have completely different outcomes.
// mode tracks which crusade-scoped page is active: 'overview' | 'team' | 'guildSalary'.
const sovereignState = { crusades: [], guilds: [], crusadeId: null, crusade: null, participants: [], teams: [], memberList: [], defaultFees: [], raffleWinners: [], raffleActivity: [], growthSubmissions: [], worldBossEvents: [], activityLog: [], users: [], activeTeam: null, mode: null };

function crusadeFormatDiamonds(amount) {
  return `${Math.round(amount || 0).toLocaleString()} 💎`;
}

function crusadeFormatGold(amount) {
  return (amount || 0).toLocaleString();
}

// Ticking a roster row's Max Bid box sets their gold bid to this; unticking
// sets it back to 0. (Other amounts can still be typed in the edit form.)
const CRUSADE_MAX_BID = 30000000;

// 30000000 -> "30M", 1500000 -> "1.5M"; smaller amounts as plain numbers.
function crusadeFormatBidShort(amount) {
  const n = Number(amount) || 0;
  return n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M` : n.toLocaleString();
}

function crusadeFormatItemQty(amount) {
  return `${Math.round(amount || 0).toLocaleString()} pcs`;
}

// Growth Rate submissions are the roster of record across the app (Crusade
// participant/fee autocomplete, World Boss/BF4 attendance) -- there's no
// separately-maintained "Member List" anymore, since that table drifted out
// of sync with who's actually in each guild (missing/renamed guilds).
// Deduped by IGN, case-insensitive; whichever submission is seen first wins.
// Whether Auto Pick / the class picker may put this member on that team:
// inactive members never, DEF-only members only on a Defense team.
function crusadeMemberDeployable(m, teamNumber) {
  if (!m.active || crusadeIsMercenary(m.name)) return false;
  return !m.defenseOnly || getTeamData(teamNumber)?.stance === 'Defense';
}

// Mercenaries are a separate set per crusade (crusade page), kept out of
// every team's line-up on that crusade.
function crusadeIsMercenary(name) {
  const key = String(name || '').trim().toLowerCase();
  return (sovereignState.mercenaries || []).some((m) => m.name.trim().toLowerCase() === key);
}

function deriveMembersFromGrowthSubmissions(submissions) {
  const byName = new Map();
  (submissions || []).forEach((s) => {
    const key = s.ign.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: s.ign, guildName: s.guildName, className: s.class || null, lampLevel: s.lampLevel, growthRate: s.growthRate, active: s.active !== false, defenseOnly: !!s.defenseOnly });
  });
  return Array.from(byName.values());
}

function crusadeGuildColor(guildName) {
  const guild = sovereignState.guilds.find((g) => g.name === guildName);
  return guild ? guild.color : null;
}

// Kept in sync with CRUSADE_PARTY_MAX_MEMBERS server-side (lib/app.js) — this
// copy only drives the UI hint (disabling a full party's "+" button); the
// server is what actually enforces the cap.
const CRUSADE_PARTY_MAX_MEMBERS = 5;

// A party slot no real party will ever use -- a scratch parking spot for one
// half of a drag-and-drop swap between two full parties (see
// wireCrusadeRosterDragAndDrop) so the two writes never collide mid-swap.
const CRUSADE_PARTY_SWAP_SCRATCH_SLOT = 999999;

// Kept in sync with the Item Name dropdown in the Add Item form (index.html)
// -- the fixed set of items the Crusade Salary summary always shows one
// column for, regardless of which of them any given team actually used.
const CRUSADE_SUMMARY_ITEM_NAMES = ['Morions', 'Guild Coins', 'Alluvial Gold Pouch'];

// Item names are stored/keyed in English (matching the DB and the Add Item
// dropdown's option values) but displayed translated -- this maps the raw
// name to its translation key without changing the underlying data key.
const CRUSADE_ITEM_I18N_KEYS = { Morions: 'sovereign.item.morions', 'Guild Coins': 'sovereign.item.guildCoins', 'Alluvial Gold Pouch': 'sovereign.item.alluvialGoldPouch' };
function crusadeItemLabel(name) {
  const key = CRUSADE_ITEM_I18N_KEYS[name];
  return key ? t(key) : name;
}

// pending/win/lose/draw -> a small colored pill, reused on the Team List
// overview (one per row) and each team's own page (next to its heading), so
// the outcome is visible at a glance without opening Team Details.
function crusadeStatusLabel(result) {
  const value = result || 'pending';
  return { value, label: t(`sovereign.result.${value}`) };
}

function crusadeStatusBadge(result) {
  const { value, label } = crusadeStatusLabel(result);
  return `<span class="crusade-status-badge ${escapeHtml(value)}">${escapeHtml(label)}</span>`;
}

function crusadeGuildBadge(guildName) {
  if (!guildName) return '–';
  const color = crusadeGuildColor(guildName) || 'var(--text-muted)';
  return `<span class="crusade-guild-badge" style="color:${color}; border-color:${color};">${escapeHtml(guildName)}</span>`;
}

// A team that's never been saved doesn't have a row on the server yet --
// this fills in the same defaults the backend would apply once it's first
// saved, so opening a brand-new team shows a sensible blank slate instead of
// an error.
function defaultTeamData(teamNumber) {
  return {
    id: null,
    teamNumber,
    warType: '',
    stance: '',
    area: '',
    leader: '',
    result: 'pending',
    diamondReward: 0,
    attendancePct: 50,
    notes: '',
    items: [],
    fees: [],
    lastTeam: null,
    lastTeamBidders: [],
  };
}

function getTeamData(teamNumber) {
  return sovereignState.teams.find((t) => t.teamNumber === teamNumber) || defaultTeamData(teamNumber);
}

// ---------- Routing between the four panels ----------
// '' -> crusade list, '#members' -> master member list, '#crusade/<id>' ->
// crusade overview (details + team list), '#crusade/<id>/team/<n>' -> one
// team's full records.
//
// The '<id>' segment is really 'slug--<uuid>' (see crusadeSlugSegment) --
// a readable name/date prefix for anyone glancing at or sharing the URL,
// with the real UUID always the part after the last '--' so the route
// still resolves correctly. A bare UUID (no '--') works too, so every link
// shared before this existed keeps working unchanged.

// A readable stand-in for a crusade's UUID in the URL -- name and date
// slugified, with the real id appended after '--' so the link still
// resolves (and stays unique even if two crusades slugify to the same
// text). Falls back to the bare id if there's nothing to slugify.
function crusadeSlugSegment(crusade) {
  if (!crusade || !crusade.id) return '';
  const label = [crusade.name, crusade.eventDate ? String(crusade.eventDate).slice(0, 10) : null].filter(Boolean).join('-');
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}--${crusade.id}` : crusade.id;
}

// Reverses crusadeSlugSegment -- everything after the last '--' is the
// real id; a segment with no '--' (an old bare-UUID link) is used as-is.
function crusadeIdFromHashSegment(segment) {
  const idx = segment.lastIndexOf('--');
  return idx === -1 ? segment : segment.slice(idx + 2);
}

// Logged-out visitors only get the boss pages (and the Points/Salary pages
// linked from them) -- everything else sends them to World Boss.
const GUEST_HASHES = ['worldboss', 'balthazard', 'points', 'salary'];

function route() {
  const hash = window.location.hash.slice(1);
  if (!appSession.username && !GUEST_HASHES.includes(hash)) {
    window.location.replace('#worldboss');
    return;
  }
  const teamMatch = hash.match(/^crusade\/([^/]+)\/team\/(\d+)$/);
  const guildSalaryMatch = hash.match(/^crusade\/([^/]+)\/guild-salary$/);
  const mercenaryMatch = hash.match(/^crusade\/([^/]+)\/mercenaries$/);
  const crusadeMatch = hash.match(/^crusade\/([^/]+)$/);

  if (hash === 'raffle') {
    sovereignState.mode = null;
    showPanel('raffle');
    loadRaffle().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'growth') {
    sovereignState.mode = null;
    showPanel('growth');
    loadGrowthSubmissions().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'worldboss' || hash === 'bf4boss' || hash === 'balthazard') {
    sovereignState.mode = null;
    const nextSchedule = hash === 'bf4boss' ? 'bf4' : hash === 'balthazard' ? 'balthazard' : 'world_boss';
    if (nextSchedule !== worldBossActiveSchedule) worldBossCalendarMonth = null; // re-anchor to this schedule's own most recent event
    worldBossActiveSchedule = nextSchedule;
    showPanel(hash);
    loadWorldBossAttendance().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'points') {
    sovereignState.mode = null;
    showPanel('points');
    loadPointsLeaderboard().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'salary') {
    sovereignState.mode = null;
    showPanel('salary');
    loadSalaryComputation().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'activitylog') {
    sovereignState.mode = null;
    showPanel('activitylog');
    loadActivityLog().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'users') {
    sovereignState.mode = null;
    showPanel('users');
    loadUsers().catch((err) => toast(err.message));
    return;
  }
  if (teamMatch) {
    sovereignState.crusadeId = crusadeIdFromHashSegment(teamMatch[1]);
    sovereignState.activeTeam = Number(teamMatch[2]);
    sovereignState.mode = 'team';
  } else if (mercenaryMatch) {
    sovereignState.crusadeId = crusadeIdFromHashSegment(mercenaryMatch[1]);
    sovereignState.activeTeam = null;
    sovereignState.mode = 'mercenaries';
  } else if (guildSalaryMatch) {
    sovereignState.crusadeId = crusadeIdFromHashSegment(guildSalaryMatch[1]);
    sovereignState.activeTeam = null;
    sovereignState.mode = 'guildSalary';
  } else if (crusadeMatch) {
    sovereignState.crusadeId = crusadeIdFromHashSegment(crusadeMatch[1]);
    sovereignState.activeTeam = null;
    sovereignState.mode = 'overview';
  } else {
    sovereignState.mode = null;
    showPanel('list');
    loadCrusadeList().catch((err) => toast(err.message));
    return;
  }
  showPanel(sovereignState.mode === 'overview' ? 'detail' : sovereignState.mode === 'guildSalary' ? 'guildSalary' : sovereignState.mode === 'mercenaries' ? 'mercenaries' : 'team');
  loadCrusadeDetail(sovereignState.crusadeId).catch((err) => toast(err.message));
}

function showPanel(name) {
  document.getElementById('sovereignListPanel').classList.toggle('hidden', name !== 'list');
  document.getElementById('sovereignDetailPanel').classList.toggle('hidden', name !== 'detail');
  document.getElementById('sovereignGuildSalaryPanel').classList.toggle('hidden', name !== 'guildSalary');
  document.getElementById('sovereignTeamPanel').classList.toggle('hidden', name !== 'team');
  document.getElementById('sovereignMercenaryPanel').classList.toggle('hidden', name !== 'mercenaries');
  document.getElementById('sovereignRafflePanel').classList.toggle('hidden', name !== 'raffle');
  document.getElementById('sovereignGrowthPanel').classList.toggle('hidden', name !== 'growth');
  // BF4 Boss and Balthazard reuse the same World Boss Attendance panel/markup
  // (see worldBossActiveSchedule) -- each is a separate nav entry, not a
  // separate set of DOM elements, so all three hashes show this one panel.
  document.getElementById('sovereignWorldBossPanel').classList.toggle('hidden', name !== 'worldboss' && name !== 'bf4boss' && name !== 'balthazard');
  document.getElementById('sovereignPointsPanel').classList.toggle('hidden', name !== 'points');
  document.getElementById('sovereignSalaryPanel').classList.toggle('hidden', name !== 'salary');
  document.getElementById('sovereignActivityLogPanel').classList.toggle('hidden', name !== 'activitylog');
  document.getElementById('sovereignUsersPanel').classList.toggle('hidden', name !== 'users');
  document.querySelectorAll('#pageNav .nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('data-panel') === name));
  // Crusade-only accounts get edit controls on the crusade screens, and are
  // view-only everywhere else (the server enforces the same split).
  if (isCrusadeEditor()) document.body.classList.toggle('view-only', !['list', 'detail', 'guildSalary', 'team', 'mercenaries'].includes(name));
  // 'detail', 'guildSalary' and 'team' set their own title once their data loads.
  if (['list', 'raffle', 'growth', 'worldboss', 'bf4boss', 'balthazard', 'points', 'salary', 'activitylog', 'users'].includes(name)) document.title = 'Sovereign — Crusade';
}

document.getElementById('sovereignBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = '';
});

document.getElementById('viewGuildSalaryLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}/guild-salary`;
});

document.getElementById('sovereignGuildSalaryBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}`;
});

document.getElementById('sovereignTeamBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}`;
});

window.addEventListener('hashchange', route);
sessionReady.then(() => {
  document.getElementById('sovereignLoginLink').classList.toggle('hidden', !!appSession.username);
  document.getElementById('sovereignLogoutBtn').classList.toggle('hidden', !appSession.username);
  route();
});

document.getElementById('sovereignLogoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
});

// ---------- Crusade list ----------

async function loadCrusadeList() {
  const [crusades, guilds] = await Promise.all([api('/api/crusades'), api('/api/crusade-guilds')]);
  sovereignState.crusades = crusades;
  sovereignState.guilds = guilds;
  renderCrusadeList();
}

function renderCrusadeList() {
  const body = document.getElementById('sovereignCrusadesBody');
  const empty = document.getElementById('sovereignCrusadesEmptyState');
  const crusades = sovereignState.crusades;
  empty.classList.toggle('hidden', crusades.length !== 0);

  const rows = crusades.map(
    (c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><a href="#crusade/${crusadeSlugSegment(c)}" style="font-weight:600;">${c.eventDate ? escapeHtml(formatLongDate(String(c.eventDate).slice(0, 10))) : t('sovereign.common.noDateSet')}</a></td>
      <td>${c.participantCount}</td>
      <td>${crusadeFormatDiamonds(c.feeDiamonds)}</td>
      <td>${crusadeFormatDiamonds(c.netDiamondReward)}</td>
      <td class="admin-only"><button type="button" class="icon-btn" data-delete-crusade="${c.id}" title="Delete crusade">✕</button></td>
    </tr>`
  );

  // Grand total across every crusade -- same columns, no per-row actions.
  const totalRow = crusades.length
    ? `<tr class="crusade-table-total-row"><td></td><td>${t('sovereign.common.total')}</td><td>${crusades.reduce(
        (sum, c) => sum + c.participantCount,
        0
      )}</td><td>${crusadeFormatDiamonds(crusades.reduce((sum, c) => sum + c.feeDiamonds, 0))}</td><td>${crusadeFormatDiamonds(
        crusades.reduce((sum, c) => sum + c.netDiamondReward, 0)
      )}</td><td class="admin-only"></td></tr>`
    : '';

  body.innerHTML = rows.join('') + totalRow;

  body.querySelectorAll('[data-delete-crusade]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-crusade');
      const crusade = sovereignState.crusades.find((c) => c.id === id);
      if (!confirm(`Delete crusade "${crusade?.name}"? This also removes its entire roster.`)) return;
      try {
        await api(`/api/crusades/${id}`, { method: 'DELETE' });
        sovereignState.crusades = sovereignState.crusades.filter((c) => c.id !== id);
        renderCrusadeList();
        toast('Crusade deleted');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeBtn').addEventListener('click', () => {
  document.getElementById('addCrusadeForm').reset();
  document.getElementById('addCrusadeModal').classList.remove('hidden');
});

document.getElementById('addCrusadeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const crusade = await api('/api/crusades', {
      method: 'POST',
      body: JSON.stringify({
        // No name field on the New Crusade form -- crusades are told apart by
        // their date; it can still be renamed later under Crusade Info.
        name: 'Crusade',
        eventDate: fd.get('eventDate') || null,
      }),
    });
    document.getElementById('addCrusadeModal').classList.add('hidden');
    window.location.hash = `crusade/${crusadeSlugSegment(crusade)}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Manage Guilds modal ----------

function renderCrusadeGuildList() {
  const list = document.getElementById('crusadeGuildList');
  list.innerHTML = sovereignState.guilds
    .map(
      (g) => `
      <li style="display:flex; gap:8px; align-items:center;" data-guild-id="${g.id}">
        <span class="schedule-dot" style="background:${g.color}"></span>
        <span style="flex:1;">${escapeHtml(g.name)}</span>
        <button type="button" class="icon-btn" data-delete-guild="${g.id}" title="Delete guild">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-guild]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-guild');
      const guild = sovereignState.guilds.find((g) => g.id === id);
      if (!confirm(`Remove guild "${guild.name}"? Participants already assigned to it keep showing it.`)) return;
      try {
        await api(`/api/crusade-guilds/${id}`, { method: 'DELETE' });
        sovereignState.guilds = sovereignState.guilds.filter((g) => g.id !== id);
        renderCrusadeGuildList();
        toast('Guild removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageCrusadeGuildsBtn').addEventListener('click', () => {
  renderCrusadeGuildList();
  document.getElementById('manageCrusadeGuildsModal').classList.remove('hidden');
});

document.getElementById('addCrusadeGuildForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const guild = await api('/api/crusade-guilds', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), color: fd.get('color') }) });
    sovereignState.guilds.push(guild);
    renderCrusadeGuildList();
    e.target.reset();
    e.target.querySelector('input[name="color"]').value = '#3b82f6';
    toast(`${guild.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Manage Default Fees modal ----------
// A standing list of fee recipients (independent of any one crusade/team)
// that gets copied onto crusade_fees automatically the first time a brand
// new team is saved (see ensureCrusadeTeam server-side) -- editing this list
// only ever affects teams created afterward.

function renderCrusadeDefaultFeeList() {
  const list = document.getElementById('crusadeDefaultFeeList');
  const fees = sovereignState.defaultFees;
  document.getElementById('crusadeDefaultFeeListEmptyState').classList.toggle('hidden', fees.length !== 0);

  list.innerHTML = fees
    .map(
      (fee) => `
      <li style="display:flex; gap:8px; align-items:center;" data-default-fee-id="${fee.id}">
        <span style="flex:1; font-weight:600;" class="crusade-roster-name-click" data-rename-default-fee="${fee.id}" title="Click to rename">${escapeHtml(fee.name)}</span>
        ${crusadeGuildBadge(fee.guildName)}
        <span style="color:var(--text-muted);">${fee.percent}%</span>
        <button type="button" class="icon-btn" data-delete-default-fee="${fee.id}" title="Remove default fee">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-default-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-default-fee');
      const fee = fees.find((f) => f.id === id);
      if (!confirm(`Remove the standing ${fee?.percent}% default fee for "${fee?.name}"? New teams created from now on won't include it.`)) return;
      try {
        await api(`/api/crusade-default-fees/${id}`, { method: 'DELETE' });
        sovereignState.defaultFees = sovereignState.defaultFees.filter((f) => f.id !== id);
        renderCrusadeDefaultFeeList();
        toast('Default fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
  list.querySelectorAll('[data-rename-default-fee]').forEach((span) => {
    span.addEventListener('click', async () => {
      const id = span.getAttribute('data-rename-default-fee');
      const fee = fees.find((f) => f.id === id);
      if (!fee) return;
      const nextName = prompt('Rename this default fee\'s IGN:', fee.name);
      if (nextName === null) return; // cancelled
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === fee.name) return;
      try {
        const updated = await api(`/api/crusade-default-fees/${id}`, { method: 'PUT', body: JSON.stringify({ name: trimmed }) });
        const idx = sovereignState.defaultFees.findIndex((f) => f.id === id);
        if (idx !== -1) sovereignState.defaultFees[idx] = updated;
        renderCrusadeDefaultFeeList();
        toast('Default fee renamed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageCrusadeDefaultFeesBtn').addEventListener('click', () => {
  renderCrusadeDefaultFeeList();
  document.getElementById('manageCrusadeDefaultFeesModal').classList.remove('hidden');
});

document.querySelector('#addCrusadeDefaultFeeForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeDefaultFeeGuildSelect');
  if (guildSelect.value) return;
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (match && match.guildName) guildSelect.value = match.guildName;
});

document.getElementById('addCrusadeDefaultFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const fee = await api('/api/crusade-default-fees', {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        guildName: form.elements.guildName.value || null,
        percent: Number(form.elements.percent.value) || 0,
      }),
    });
    sovereignState.defaultFees.push(fee);
    renderCrusadeDefaultFeeList();
    form.reset();
    toast(`${fee.name}'s default fee added`);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Crusade detail ----------

async function loadCrusadeDetail(id) {
  const [crusade, guilds, growthSubmissions, defaultFees, standing] = await Promise.all([
    api(`/api/crusades/${id}`),
    api('/api/crusade-guilds'),
    api('/api/growth-submissions'),
    api('/api/crusade-default-fees'),
    api(`/api/crusades/${id}/member-standing`).catch(() => []),
  ]);
  sovereignState.memberStanding = new Map(standing.map((x) => [String(x.name).trim().toLowerCase(), x]));
  sovereignState.crusade = crusade;
  sovereignState.participants = crusade.participants;
  sovereignState.teams = crusade.teams;
  sovereignState.crusadeFees = crusade.crusadeFees || [];
  sovereignState.mercenaries = crusade.mercenaries || [];
  sovereignState.guilds = guilds;
  sovereignState.memberList = deriveMembersFromGrowthSubmissions(growthSubmissions);
  sovereignState.defaultFees = defaultFees;
  populateCrusadeGuildSelect(); // shared by the add/edit-participant modal regardless of which page opened it
  populateSovereignMemberSuggestions(); // lets the participant modal's Name field search Growth Rate's roster
  populateCrusadeInfoForm();

  if (sovereignState.mode === 'team') {
    populateTeamDetailsForm(sovereignState.activeTeam);
    renderTeamDetail(sovereignState.activeTeam); // sets its own title
  } else if (sovereignState.mode === 'mercenaries') {
    document.title = `Sovereign — ${crusade.name} — Mercenaries`;
    renderMercenaryPage();
  } else if (sovereignState.mode === 'guildSalary') {
    document.title = `Sovereign — ${crusade.name} — Crusade Salary`;
    renderCrusadeGuildSalary();
  } else {
    document.title = `Sovereign — ${crusade.name}`;
    renderTeamList();
    renderCrusadeMercenaries();
    renderCrusadeWideFees();
  }
}

// Called after any roster change (add/edit/delete participant, or toggling
// attended/paid) so every place that reflects the roster — the team list's
// per-team totals and the currently open team's full records — stays in
// sync, without needing to re-render pages that aren't currently visible.
function refreshAfterRosterChange() {
  if (sovereignState.mode === 'team') renderTeamDetail(sovereignState.activeTeam);
  else if (sovereignState.mode === 'guildSalary') renderCrusadeGuildSalary();
  else renderTeamList();
}

function nextTeamNumber() {
  return sovereignState.participants.reduce((max, p) => Math.max(max, p.partyNumber), 0) + 1;
}

// First party slot (starting at 1) within the given team that isn't already
// at the 5-member cap — used to default the Party field when adding someone
// new, so admins don't have to hunt for room manually.
function nextAvailablePartySlot(teamNumber) {
  const counts = new Map();
  sovereignState.participants
    .filter((p) => p.partyNumber === teamNumber)
    .forEach((p) => counts.set(p.partySlot, (counts.get(p.partySlot) || 0) + 1));
  let slot = 1;
  while ((counts.get(slot) || 0) >= CRUSADE_PARTY_MAX_MEMBERS) slot++;
  return slot;
}

// Name + Date only -- shared by every team on this crusade.
function populateCrusadeInfoForm() {
  const form = document.getElementById('crusadeInfoForm');
  const c = sovereignState.crusade;
  form.elements.name.value = c.name || '';
  form.elements.eventDate.value = c.eventDate ? String(c.eventDate).slice(0, 10) : '';
}

// Everything else -- war type, stance, result, diamond reward, attendance %,
// notes -- lives on the active team, independent of every other team.
function populateTeamDetailsForm(teamNumber) {
  const form = document.getElementById('teamDetailsForm');
  const t = getTeamData(teamNumber);
  form.elements.warType.value = t.warType || '';
  form.elements.stance.value = t.stance || '';
  form.elements.area.value = t.area || '';
  form.elements.result.value = t.result || 'pending';
  form.elements.diamondReward.value = t.diamondReward || 0;
  form.elements.attendancePct.value = t.attendancePct ?? 50;
  form.elements.notes.value = t.notes || '';
  updateTeamDetailsStanceUI(form.elements.stance.value);
}

// No bidding while defending, so a Defense team's own-roster pool is
// always 100% attendance -- fix the field at 60% (this crusade's standard
// Defense-win split) and lock it rather than leave a stale/editable value
// that doesn't actually apply.
function updateTeamDetailsStanceUI(stance) {
  const input = document.querySelector('#teamDetailsForm [name="attendancePct"]');
  if (stance === 'Defense') {
    input.value = 60;
    input.disabled = true;
  } else {
    input.disabled = false;
  }
}

document.querySelector('#teamDetailsForm select[name="stance"]').addEventListener('change', (e) => {
  updateTeamDetailsStanceUI(e.target.value);
});

function populateCrusadeGuildSelect() {
  const options = '<option value="">—</option>' + sovereignState.guilds.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
  ['crusadeParticipantGuildSelect', 'crusadeFeeGuildSelect', 'crusadeDefaultFeeGuildSelect', 'crusadeWideFeeGuildSelect'].forEach((id) => {
    const select = document.getElementById(id);
    const current = select.value;
    select.innerHTML = options;
    select.value = current;
  });
}

// Lets the Add/Edit Participant modal's Name field search everyone ever
// saved into a crusade roster (the master Member List), instead of typing a
// fresh name every time.
function populateSovereignMemberSuggestions() {
  document.getElementById('sovereignMemberSuggestions').innerHTML = sovereignState.memberList
    .map((m) => `<option value="${escapeHtml(m.name)}">`)
    .join('');
}

// Picking (or typing) a name that matches a known member auto-fills their
// last-known guild and position -- only when each field is still blank, so
// it never clobbers a guild/position the admin already chose on purpose.
document.querySelector('#crusadeParticipantForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeParticipantGuildSelect');
  const positionInput = document.querySelector('#crusadeParticipantForm input[name="position"]');
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (!match) return;
  if (!guildSelect.value && match.guildName) guildSelect.value = match.guildName;
  if (!positionInput.value && match.position) positionInput.value = match.position;
});

// Same search-and-auto-fill-guild behavior for the Management Fee IGN field.
document.querySelector('#addCrusadeFeeForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeFeeGuildSelect');
  if (guildSelect.value) return;
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (match && match.guildName) guildSelect.value = match.guildName;
});

document.getElementById('crusadeInfoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: form.elements.name.value,
        eventDate: form.elements.eventDate.value || null,
      }),
    });
    sovereignState.crusade = { ...sovereignState.crusade, ...updated };
    document.title = sovereignState.mode === 'team' ? `Sovereign — ${updated.name} — Team ${sovereignState.activeTeam}` : `Sovereign — ${updated.name}`;
    toast('Crusade info saved');
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('teamDetailsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const teamNumber = sovereignState.activeTeam;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${teamNumber}`, {
      method: 'PUT',
      body: JSON.stringify({
        warType: form.elements.warType.value || null,
        stance: form.elements.stance.value || null,
        area: form.elements.area.value || null,
        result: form.elements.result.value,
        diamondReward: Number(form.elements.diamondReward.value) || 0,
        attendancePct: Number(form.elements.attendancePct.value),
      }),
    });
    // The team may not have existed server-side until this save -- refetch
    // its full detail (items/fees/lastTeam) rather than patching in place.
    const crusade = await api(`/api/crusades/${sovereignState.crusadeId}`);
    sovereignState.teams = crusade.teams;
    renderTeamDetail(teamNumber); // diamond math depends on reward/attendance %, so recompute
    toast('Team details saved');
  } catch (err) {
    toast(err.message);
  }
});

// Moves diamonds between two teams' reward pools (e.g. paying someone out of
// a different team's pot) -- unlike manual diamonds, which only carve a
// guaranteed share off a team's *own* pool, this actually debits the source
// team's Diamond Reward and credits the destination's, so the crusade-wide
// total stays conserved.
document.getElementById('transferDiamondsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fromTeamNumber = sovereignState.activeTeam;
  const toTeamNumber = Number(form.elements.toTeamNumber.value);
  const amount = Number(form.elements.amount.value);
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/teams/${fromTeamNumber}/transfer-diamonds`, {
      method: 'POST',
      body: JSON.stringify({ toTeamNumber, amount }),
    });
    const crusade = await api(`/api/crusades/${sovereignState.crusadeId}`);
    sovereignState.teams = crusade.teams;
    form.reset();
    renderTeamDetail(fromTeamNumber);
    toast(`Transferred ${amount} diamonds to Team ${toTeamNumber}`);
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('deleteCrusadeBtn').addEventListener('click', async () => {
  const c = sovereignState.crusade;
  if (!confirm(`Delete crusade "${c.name}"? This also removes its entire roster.`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}`, { method: 'DELETE' });
    toast('Crusade deleted');
    window.location.hash = '';
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('deleteTeamBtn').addEventListener('click', async () => {
  const n = sovereignState.activeTeam;
  const count = sovereignState.participants.filter((p) => p.partyNumber === n).length;
  if (!confirm(`Delete Team ${n}? This removes its ${count} participant${count === 1 ? '' : 's'} and all of its items, fees, and details.`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}`, { method: 'DELETE' });
    sovereignState.participants = sovereignState.participants.filter((p) => p.partyNumber !== n);
    sovereignState.teams = sovereignState.teams.filter((t) => t.teamNumber !== n);
    toast(`Team ${n} deleted`);
    window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Team list (crusade-level) and single-team roster ----------

// Only team numbers that actually have a participant or a saved Team
// Details/items/fees row show up -- so deleting a team makes it disappear
// entirely instead of reverting to an empty "Pending" placeholder. A
// brand-new crusade with nothing on it yet still shows "Team 1" so there's
// always somewhere to start.
function visibleTeamNumbers() {
  const numbers = new Set(sovereignState.participants.map((p) => p.partyNumber));
  sovereignState.teams.forEach((t) => numbers.add(t.teamNumber));
  const sorted = Array.from(numbers).sort((a, b) => a - b);
  return sorted.length ? sorted : [1];
}

function renderTeamList() {
  const body = document.getElementById('crusadeTeamListBody');

  body.innerHTML = visibleTeamNumbers()
    .map((n, i) => {
      const team = getTeamData(n);
      const rows = computeTeamDistribution(n);
      const count = sovereignState.participants.filter((p) => p.partyNumber === n).length;
      const diamonds = rows.reduce((sum, r) => sum + r.total, 0);
      return `
      <tr>
        <td>${i + 1}</td>
        <td><a href="#crusade/${crusadeSlugSegment(sovereignState.crusade)}/team/${n}" style="font-weight:600;">${t('sovereign.common.team')} ${n}</a></td>
        <td>${crusadeStatusBadge(team.result)}</td>
        <td>${team.stance ? t(`sovereign.stance.${team.stance.toLowerCase()}`) : '–'}</td>
        <td>${count}</td>
        <td>${crusadeFormatDiamonds(diamonds)}</td>
      </tr>`;
    })
    .join('');
}

// Every team number known on this crusade, whether it already has a saved
// Team Details row or is still just a baseline/participant-only number.
function allKnownTeamNumbers() {
  return visibleTeamNumbers();
}

// Every player's accumulated totals across EVERY team on this crusade,
// categorized by guild -- one row per player (matched case-insensitively by
// name), not one row per team, so someone who fought on three teams shows
// up once with everything summed instead of three near-identical rows.
function computeCrusadeGuildSalaryDetail() {
  const byGuild = new Map(); // guildName -> Map(nameKey -> entry)

  function ensureEntry(guildKey, nameKey, displayName) {
    if (!byGuild.has(guildKey)) byGuild.set(guildKey, new Map());
    const players = byGuild.get(guildKey);
    if (!players.has(nameKey)) {
      players.set(nameKey, {
        name: displayName,
        isParticipant: false, // true once seen on an actual roster (controls Max Bid/Present display)
        onlyLostTeams: true, // stays true only if every team this player's on lost -- hides the row entirely (see below)
        maxBid: 0,
        hasAttackTeam: false, // true once seen on a non-Defense team -- distinguishes "never bid" (0) from "never had the option" (all Defense)
        present: 0,
        teamsCount: 0,
        teamNumbers: new Set(), // every team number this player actually rostered on this crusade (for linking to their team page)
        salary: 0,
        feePercent: 0,
        feeAmount: 0,
        bonusShare: 0,
        bonusSources: [], // crusade names this player's bonusShare was paid out from (see below)
        itemTotals: Object.fromEntries(CRUSADE_SUMMARY_ITEM_NAMES.map((name) => [name, 0])),
      });
    }
    return players.get(nameKey);
  }

  // A name that already has a roster entry in SOME guild (found by name
  // alone, ignoring which guild) -- used so a bonus bidder whose guild was
  // recorded differently back on the crusade they bid on (switched guilds
  // since, or it was left blank) still merges into their one real row
  // instead of spawning an orphaned duplicate under a different guild.
  function findEntryByNameKey(nameKey) {
    for (const players of byGuild.values()) {
      if (players.has(nameKey)) return players.get(nameKey);
    }
    return null;
  }

  // Pass 1: every team's own roster/items/fees, across ALL teams, before any
  // bonus is credited -- so pass 2's name lookup always sees a player's real
  // roster entry (on whichever team it lives on) already in place.
  allKnownTeamNumbers().forEach((n) => {
    const team = getTeamData(n);
    const isDefense = isDefenseStance(team);
    const isLostTeam = crusadeWasLost(team);

    computeTeamDistribution(n).forEach(({ participant: p, total }) => {
      const entry = ensureEntry(p.guildName || 'Unassigned', p.name.trim().toLowerCase(), p.name);
      entry.isParticipant = true;
      entry.teamsCount += 1;
      entry.teamNumbers.add(n);
      entry.present += p.attended ? 1 : 0;
      if (!isLostTeam) entry.onlyLostTeams = false;
      if (!isDefense) {
        entry.hasAttackTeam = true;
        if (p.goldBid > 0) entry.maxBid = Math.max(entry.maxBid, p.goldBid);
      }
      entry.salary += total;
    });

    (team.items || []).forEach((item) => {
      if (!CRUSADE_SUMMARY_ITEM_NAMES.includes(item.name)) return; // custom/unknown item name -- no fixed column for it
      computeTeamItemShares(n, item).forEach(({ participant: p, total }) => {
        const entry = ensureEntry(p.guildName || 'Unassigned', p.name.trim().toLowerCase(), p.name);
        entry.itemTotals[item.name] += total;
      });
    });

    // Management fees fold into a matching roster row by name (case-
    // insensitive), kept in their own Fee %/Fee Amount fields rather than
    // mixed into Salary -- a recurring 2.5% fee applied across 3 fights
    // this crusade shows as a combined 7.5% and its total diamond amount,
    // not three separate numbers. A fee with no guild picked falls back to
    // "Unassigned" (same as participants/bonus bidders below) instead of
    // being silently dropped from the total. If there's no matching roster
    // row (on any team), the fee just gets its own fee-only entry
    // (isParticipant stays false, decided once every team has been
    // processed).
    // A lost team pays out nothing (crusadeFeeAmount already zeroes the
    // diamond amount for it), so skip creating/updating an entry for its
    // fees entirely -- otherwise a fee-only row (e.g. a guild leader who
    // isn't on any roster) would still show up as a spurious 0-diamond row,
    // or even a whole empty guild card, for a fight that earned nothing.
    if (!isLostTeam) {
      teamFeesInEffect(team).forEach((fee) => {
        const entry = ensureEntry(fee.guildName || 'Unassigned', fee.name.trim().toLowerCase(), fee.name);
        entry.feePercent += Number(fee.percent) || 0;
        entry.feeAmount += crusadeFeeAmount(fee, team);
        // A fee earned from a winning team is a real payout -- even if this
        // same person's only roster spot happens to be on a team that lost,
        // don't let the lost-team filter below hide the row and bury the fee
        // they're actually owed.
        entry.onlyLostTeams = false;
      });
    }
  });

  // Crusade-wide fees: the % counts once (10% of the whole crusade, not
  // 10% × number of teams), the amount is that % of every winning team.
  (sovereignState.crusadeFees || []).forEach((fee) => {
    const amount = allKnownTeamNumbers().reduce((sum, n) => sum + crusadeFeeAmount(fee, getTeamData(n)), 0);
    if (amount <= 0) return;
    const entry = ensureEntry(fee.guildName || 'Unassigned', fee.name.trim().toLowerCase(), fee.name);
    entry.feePercent += Number(fee.percent) || 0;
    entry.feeAmount += amount;
    entry.onlyLostTeams = false;
  });

  // Pass 2: Defense-win bonus, credited by name to whoever bid gold on the
  // team this one inherited its bonus from -- regardless of whether
  // they're on THIS team's (or any team's) roster at all. Matched by name
  // only (see findEntryByNameKey) so it lands on a bidder's real roster
  // row even if their guild changed since the crusade they bid on.
  allKnownTeamNumbers().forEach((n) => {
    const team = getTeamData(n);
    const { perBidder } = computeTeamBonusShares(n);
    if (perBidder <= 0) return;
    (team.lastTeamBidders || []).forEach((bidder) => {
      const nameKey = bidder.name.trim().toLowerCase();
      const entry = findEntryByNameKey(nameKey) || ensureEntry(bidder.guildName || 'Unassigned', nameKey, bidder.name);
      entry.bonusShare += perBidder;
      // A Defense-win bonus is a real payout regardless of how this same
      // person's OWN roster spot fared -- without this, someone who bid on
      // the capture team but is rostered on a team that lost this crusade
      // gets their bonus computed correctly and then thrown away by the
      // lost-team filter below (same class of bug the fee loop above had).
      entry.onlyLostTeams = false;
      // Keyed on the exact source team (crusade + team number), not just the
      // crusade name -- one crusade can be the capture source for more than
      // one area/team, and each is a distinct source worth its own entry.
      const sourceKey = `${team.lastTeam?.crusadeId}:${team.lastTeam?.teamNumber}`;
      if (team.lastTeam && !entry.bonusSources.some((s) => s.key === sourceKey)) {
        entry.bonusSources.push({ key: sourceKey, crusadeName: team.lastTeam.crusadeName, eventDate: team.lastTeam.eventDate });
      }
    });
  });

  return Array.from(byGuild.entries())
    .map(([name, players]) => {
      // A player who only ever showed up on a team that lost the crusade
      // earns nothing no matter what they bid or attended -- that's not a
      // real payout record, just noise, so it's left off the list entirely
      // rather than shown as a row of zeroes.
      const entries = Array.from(players.values())
        .filter((e) => !(e.isParticipant && e.onlyLostTeams))
        .map((e) => ({ ...e, total: e.salary + e.feeAmount + e.bonusShare }))
        .sort((a, b) => b.total - a.total);
      return {
        name,
        entries,
        memberCount: entries.filter((e) => e.isParticipant).length,
        total: entries.reduce((sum, e) => sum + e.total, 0),
      };
    })
    .filter((g) => g.entries.length) // a guild left with nothing after the lost-team filter has no card to show
    .sort((a, b) => b.total - a.total);
}

// One row per player: IGN / Max Bid / Present / Salary / Fee % / Fee Amount /
// Bonus Share / Total Salary / one column per known item (see
// CRUSADE_SUMMARY_ITEM_NAMES). Fee % and Fee Amount are each summed across
// every fee applied to that player on any team this crusade -- a recurring
// 2.5% fee applied to 3 fights shows as a combined 7.5% and its total
// diamond amount, not three separate numbers.
function renderPlayerSalaryCard(g) {
  const rows = g.entries
    .map((e, i) => {
      const itemCells = CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<td>${crusadeFormatItemQty(e.itemTotals[name])}</td>`).join('');
      // The lost-team filter already drops anyone whose only appearance was
      // on a losing team, so zero-present left here means they simply
      // skipped a crusade their team actually won -- worth flagging plainly
      // as Absent instead of a "0/1" that reads like a rendering glitch.
      const presentCell = !e.isParticipant ? '–' : e.present === 0 ? t('sovereign.common.absent') : `${e.present}/${e.teamsCount}`;
      const maxBidCell = !e.isParticipant ? '–' : !e.hasAttackTeam ? t('sovereign.common.def') : crusadeFormatGold(e.maxBid);
      const feePercentCell = e.feePercent > 0 ? `${e.feePercent}%` : '–';
      const bonusSourceText = e.bonusSources
        .map((s) => `${s.crusadeName}${s.eventDate ? ` (${formatLongDate(String(s.eventDate).slice(0, 10))})` : ''}`)
        .join('; ');
      const bonusShareCell = e.bonusSources.length
        ? `<span title="${escapeHtml(`${t('sovereign.salary.sourceCrusade')}: ${bonusSourceText}`)}" style="border-bottom:1px dotted var(--text-muted); cursor:help;">${crusadeFormatDiamonds(e.bonusShare)}</span>`
        : crusadeFormatDiamonds(e.bonusShare);
      // Links straight to whichever team this player actually rostered on
      // (their lowest team number, if on more than one) -- a fee/bonus-only
      // entry with no roster appearance at all has nowhere to link to.
      const primaryTeam = e.teamNumbers.size ? Math.min(...e.teamNumbers) : null;
      const nameCell =
        primaryTeam !== null
          ? `<a href="#crusade/${crusadeSlugSegment(sovereignState.crusade)}/team/${primaryTeam}" class="crusade-player-link" style="white-space:nowrap;">${escapeHtml(e.name)}</a>`
          : `<span style="white-space:nowrap;">${escapeHtml(e.name)}</span>`;
      const rowClass = e.isParticipant && e.present === 0 ? ' class="crusade-row-absent"' : '';
      return `
    <tr${rowClass}>
      <td>${i + 1}</td>
      <td style="font-weight:600;">${nameCell}</td>
      <td>${maxBidCell}</td>
      <td>${presentCell}</td>
      <td>${crusadeFormatDiamonds(e.salary)}</td>
      <td>${feePercentCell}</td>
      <td>${crusadeFormatDiamonds(e.feeAmount)}</td>
      <td>${bonusShareCell}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(e.total)}</td>
      ${itemCells}
    </tr>`;
    })
    .join('');
  const totalRow = `<tr class="crusade-table-total-row"><td></td><td>${t('sovereign.common.total')}</td><td></td><td></td><td>${crusadeFormatDiamonds(
    g.entries.reduce((sum, e) => sum + e.salary, 0)
  )}</td><td></td><td>${crusadeFormatDiamonds(g.entries.reduce((sum, e) => sum + e.feeAmount, 0))}</td><td>${crusadeFormatDiamonds(
    g.entries.reduce((sum, e) => sum + e.bonusShare, 0)
  )}</td><td>${crusadeFormatDiamonds(g.total)}</td>${CRUSADE_SUMMARY_ITEM_NAMES.map(
    (name) => `<td>${crusadeFormatItemQty(g.entries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`
  ).join('')}</tr>`;
  return `
  <div class="crusade-party-card">
    <div class="crusade-party-card-header">
      <h3>${g.name === 'Unassigned' ? t('sovereign.common.unassigned') : escapeHtml(g.name)} — ${crusadeFormatDiamonds(g.total)} (${g.memberCount} ${g.memberCount === 1 ? t('sovereign.common.member') : t('sovereign.common.members')})</h3>
    </div>
    <div class="table-scroll">
      <table class="members-table">
        <thead><tr><th>#</th><th>${t('sovereign.common.ign')}</th><th>${t('sovereign.salary.thMaxBid')}</th><th>${t('sovereign.salary.thPresent')}</th><th>${t('sovereign.common.salary')}</th><th>${t('sovereign.salary.thFeePercent')}</th><th>${t('sovereign.common.feeAmount')}</th><th>${t('sovereign.common.bonusShare')}</th><th>${t('sovereign.salary.thTotalSalary')}</th>${CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<th>${escapeHtml(crusadeItemLabel(name))}</th>`).join('')}</tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>
  </div>`;
}

// Every player's accumulated totals across every team on this crusade,
// grouped by guild -- one card per guild instead of one section per team,
// so the same player fighting on multiple teams shows up once, not
// repeated once per team.
function renderCrusadeGuildSalary() {
  const c = sovereignState.crusade;
  const dateText = c && c.eventDate ? formatLongDate(String(c.eventDate).slice(0, 10)) : t('sovereign.common.noDateSet');
  document.getElementById('crusadeGuildSalaryMeta').textContent = `${c ? c.name : ''} — ${dateText}`;

  const guilds = computeCrusadeGuildSalaryDetail();
  const el = document.getElementById('crusadeGuildSalaryDetail');
  el.innerHTML = guilds.length
    ? `<div class="crusade-salary-list">${guilds.map((g) => renderPlayerSalaryCard(g)).join('')}</div>`
    : '<p class="empty-state">No participants on this crusade yet.</p>';

  renderCrusadeGuildTotals(guilds);
  renderLastCrusadeBidders();
}

// One row per guild: its grand total (diamonds) plus each known item,
// summed across every one of that guild's players -- a quick top-level
// overview above the full player-by-player breakdown.
function renderCrusadeGuildTotals(guilds) {
  document.getElementById('crusadeGuildTotalsEmptyState').classList.toggle('hidden', guilds.length !== 0);

  const rows = guilds.map((g, i) => {
    const salary = g.entries.reduce((sum, e) => sum + e.salary, 0);
    const feeAmount = g.entries.reduce((sum, e) => sum + e.feeAmount, 0);
    const bonusShare = g.entries.reduce((sum, e) => sum + e.bonusShare, 0);
    return `
    <tr>
      <td>${i + 1}</td>
      <td style="font-weight:600;">${g.name === 'Unassigned' ? t('sovereign.common.unassigned') : crusadeGuildBadge(g.name)}</td>
      <td>${crusadeFormatDiamonds(salary)}</td>
      <td>${crusadeFormatDiamonds(feeAmount)}</td>
      <td>${crusadeFormatDiamonds(bonusShare)}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(g.total)}</td>
      ${CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<td>${crusadeFormatItemQty(g.entries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`).join('')}
    </tr>`;
  });

  // Grand total across every guild -- same columns, no guild badge.
  const allEntries = guilds.flatMap((g) => g.entries);
  const grandSalary = allEntries.reduce((sum, e) => sum + e.salary, 0);
  const grandFeeAmount = allEntries.reduce((sum, e) => sum + e.feeAmount, 0);
  const grandBonusShare = allEntries.reduce((sum, e) => sum + e.bonusShare, 0);
  const grandTotal = guilds.reduce((sum, g) => sum + g.total, 0);
  const totalRow = guilds.length
    ? `<tr class="crusade-table-total-row"><td></td><td>${t('sovereign.common.total')}</td><td>${crusadeFormatDiamonds(grandSalary)}</td><td>${crusadeFormatDiamonds(
        grandFeeAmount
      )}</td><td>${crusadeFormatDiamonds(grandBonusShare)}</td><td>${crusadeFormatDiamonds(grandTotal)}</td>${CRUSADE_SUMMARY_ITEM_NAMES.map(
        (name) => `<td>${crusadeFormatItemQty(allEntries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`
      ).join('')}</tr>`
    : '';

  document.getElementById('crusadeGuildTotalsBody').innerHTML = rows.join('') + totalRow;
}

// Each Defense-win team traces its own area's capture history (see
// getAreaCaptureBidders in lib/app.js), so two Defense-win teams on this
// crusade can be paying bonus back to two entirely different areas/source
// teams. Group contributing teams by their actual source (crusade + team
// number) rather than assuming they all share one -- teams that DO share a
// source (they defended the same area, or the source captured more than
// one thing at once) still combine into a single card, same as before.
function renderLastCrusadeBidders() {
  const emptyState = document.getElementById('crusadeLastBiddersEmptyState');
  const container = document.getElementById('crusadeLastBiddersDetail');

  // No bonus share at all (this team isn't a Defense win, or it lost, or
  // its area has no traceable capture) means there's nothing to actually
  // pay out -- skip it entirely rather than counting it toward the total.
  const contributingTeams = allKnownTeamNumbers().filter((n) => {
    const team = getTeamData(n);
    const { perBidder } = computeTeamBonusShares(n);
    return (team.lastTeamBidders || []).length && perBidder > 0;
  });

  if (!contributingTeams.length) {
    emptyState.classList.remove('hidden');
    container.innerHTML = '';
    return;
  }
  emptyState.classList.add('hidden');

  const groups = new Map();
  contributingTeams.forEach((n) => {
    const team = getTeamData(n);
    const key = `${team.lastTeam.crusadeId}:${team.lastTeam.teamNumber}`;
    if (!groups.has(key)) groups.set(key, { lastTeam: team.lastTeam, bidders: team.lastTeamBidders || [], teamNumbers: [] });
    groups.get(key).teamNumbers.push(n);
  });

  container.innerHTML = Array.from(groups.values())
    .map(({ lastTeam, bidders, teamNumbers }) => {
      const sourceDateText = lastTeam?.eventDate ? formatLongDate(String(lastTeam.eventDate).slice(0, 10)) : t('sovereign.common.noDateSet');
      const combinedPerBidder = teamNumbers.reduce((sum, n) => sum + computeTeamBonusShares(n).perBidder, 0);
      const teamListText = teamNumbers.join(' & ');
      const areaText = lastTeam?.area ? ` (${escapeHtml(lastTeam.area)})` : '';
      // Links straight to the capture team's own page (a different crusade
      // than the one being viewed here), so you can jump to exactly who
      // this bonus is being paid to.
      const sourceSlug = lastTeam ? crusadeSlugSegment({ id: lastTeam.crusadeId, name: lastTeam.crusadeName, eventDate: lastTeam.eventDate }) : '';
      const sourceCrusadeLink = sourceSlug
        ? `<a class="crusade-inline-link" href="#crusade/${sourceSlug}/team/${lastTeam.teamNumber}">${escapeHtml(lastTeam.crusadeName)} — ${t('sovereign.common.team')} ${lastTeam.teamNumber}</a>`
        : escapeHtml(lastTeam?.crusadeName || '');

      // A single source's bidder list can run long with only one card ever
      // showing, leaving the second grid slot empty -- split it into two
      // side-by-side mini-tables within this one card instead, numbered
      // continuously across both halves.
      const buildRows = (list, offset) =>
        list
          .map(
            (b, i) => `
        <tr>
          <td>${offset + i + 1}</td>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(b.name)}</td>
          <td>${crusadeGuildBadge(b.guildName)}</td>
          <td>${crusadeFormatGold(b.goldBid)}</td>
          <td>${crusadeFormatDiamonds(combinedPerBidder)}</td>
        </tr>`
          )
          .join('');
      const buildTable = (list, offset) => `
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr><th>#</th><th>${t('sovereign.common.ign')}</th><th>${t('sovereign.common.guild')}</th><th>${t('sovereign.modal.goldBidLabel')}</th><th>${t('sovereign.common.bonusShare')}</th></tr></thead>
            <tbody>${buildRows(list, offset)}</tbody>
          </table>
        </div>`;

      const half = Math.ceil(bidders.length / 2);
      const firstHalf = bidders.slice(0, half);
      const secondHalf = bidders.slice(half);

      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>${t('sovereign.salary.teamBonusHeading').replace('{n}', teamListText)}</h3>
        </div>
        <p style="color:var(--text-muted); font-size:12px; margin:-4px 0 10px;">${t('sovereign.salary.sourceCrusade')}${areaText}: ${sourceCrusadeLink} — <strong style="color:var(--text);">${sourceDateText}</strong></p>
        <div class="crusade-bidders-columns">
          ${buildTable(firstHalf, 0)}
          ${secondHalf.length ? buildTable(secondHalf, half) : ''}
        </div>
        <div class="crusade-table-total-row" style="text-align:right; padding:8px 4px 0;">${t('sovereign.common.total')} — ${crusadeFormatDiamonds(combinedPerBidder * bidders.length)}</div>
      </div>`;
    })
    .join('');
}

// The team's own page shows *all* of its records in one place: roster
// fields plus each person's diamond earnings (computed from this team's own
// attendance/bid pool) and a guild breakdown scoped to this team.
document.getElementById('teamDetailsForm').elements.warType.addEventListener('change', () => {
  if (sovereignState.mode === 'team') renderTeamDetail(sovereignState.activeTeam);
});
document.getElementById('teamDetailsForm').elements.stance.addEventListener('change', () => {
  if (sovereignState.mode === 'team') renderTeamDetail(sovereignState.activeTeam);
});

// Adds `member` to a FULL party by pushing that party's lowest Growth Rate
// member down to the next party; if that one is full too, its lowest moves
// on, and so on until a party has room. With no room left in any of the
// team's parties (per its War Type), the last one pushed goes back to the
// Members panel. Moves run from the far end backwards so every party has
// room at the moment someone enters it (the server checks the 5-cap on each
// move). Asks first, listing every move.
async function addMemberWithBump(member, teamNumber, slot) {
  if (!crusadeRequireWarType(teamNumber)) return;
  const grOf = (name) => Number(sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name))?.growthRate) || 0;
  const warTypeSelect = document.getElementById('teamDetailsForm').elements.warType;
  const partyCount = crusadePartyCountForWarType(warTypeSelect ? warTypeSelect.value : getTeamData(teamNumber).warType);
  const inParty = (s2) => sovereignState.participants.filter((x) => x.partyNumber === teamNumber && x.partySlot === s2);

  // plan: who leaves each full party, starting with the one picked into
  const moves = []; // { participant, from, to } -- to === null means off the team
  let current = slot;
  for (;;) {
    const members = inParty(current).filter((x) => !moves.some((m) => m.participant.id === x.id));
    if (members.length + 1 <= CRUSADE_PARTY_MAX_MEMBERS) break; // room for the one arriving
    const lowest = members.slice().sort((a, b) => grOf(a.name) - grOf(b.name) || b.name.localeCompare(a.name))[0];
    const next = current + 1;
    const to = next <= Math.max(partyCount, current) ? next : null;
    moves.push({ participant: lowest, from: current, to });
    if (to === null) break;
    current = next;
  }

  const lines = [`${member.name} (${member.className}, GR ${(member.growthRate || 0).toLocaleString()}) joins Party ${slot}`];
  moves.forEach((m) => lines.push(m.to === null ? `${m.participant.name} (GR ${grOf(m.participant.name).toLocaleString()}) leaves the team — no room in Parties 1-${partyCount}` : `${m.participant.name} (GR ${grOf(m.participant.name).toLocaleString()}) moves Party ${m.from} → Party ${m.to}`));
  if (!confirm(`Party ${slot} is full:\n\n${lines.join('\n')}\n\nContinue?`)) return;

  try {
    for (const m of moves.slice().reverse()) {
      if (m.to === null) {
        await api(`/api/crusades/${sovereignState.crusadeId}/participants/${m.participant.id}`, { method: 'DELETE' });
        sovereignState.participants = sovereignState.participants.filter((x) => x.id !== m.participant.id);
      } else {
        const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${m.participant.id}`, { method: 'PUT', body: JSON.stringify({ partySlot: m.to }) });
        const idx = sovereignState.participants.findIndex((x) => x.id === m.participant.id);
        if (idx !== -1) sovereignState.participants[idx] = updated;
      }
    }
    const created = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ name: member.name, guildName: member.guildName || null, partyNumber: teamNumber, partySlot: slot, attended: false }),
    });
    sovereignState.participants.push(created);
    toast(`${member.name} added to Party ${slot}${moves.length ? ` — ${moves.length} member${moves.length === 1 ? '' : 's'} moved down` : ''}`);
  } catch (err) {
    toast(err.message);
  }
  refreshAfterRosterChange();
}

// A participant's class, from their Growth Rate submission (same name match
// as the Members panel).
// A member's current guild from Growth Rate (exact name, then look-alike
// spelling) -- the roster shows this so a guild change there shows up
// everywhere at once; the server also writes it back (syncGuildsFromGrowth).
function guildOfMember(name) {
  const key = String(name || '').trim().toLowerCase();
  const exact = sovereignState.memberList.find((m) => String(m.name).trim().toLowerCase() === key);
  if (exact) return exact.guildName || null;
  const loose = normalizeNameForDupeCheck(name);
  return (loose && sovereignState.memberList.find((m) => normalizeNameForDupeCheck(m.name) === loose)?.guildName) || null;
}

function classOfMember(name) {
  const key = String(name || '').trim().toLowerCase();
  const exact = sovereignState.memberList.find((m) => String(m.name).trim().toLowerCase() === key);
  if (exact) return exact.className || null;
  const loose = normalizeNameForDupeCheck(name);
  return (loose && sovereignState.memberList.find((m) => normalizeNameForDupeCheck(m.name) === loose)?.className) || null;
}

// A team's War Type (20vs20 / 50vs50) decides how many parties it has, so
// it has to be picked before anyone goes on the roster. Uses the Team
// Details dropdown's current pick for the open team (same as the party
// count does). Returns false -- with a prompt pointing at the dropdown --
// when it's still blank.
function crusadeRequireWarType(teamNumber) {
  const select = document.getElementById('teamDetailsForm').elements.warType;
  const isOpenTeam = sovereignState.mode === 'team' && (teamNumber == null || teamNumber === sovereignState.activeTeam);
  if (!isOpenTeam && teamNumber == null) return true; // not adding to a specific team
  const warType = isOpenTeam && select ? select.value : getTeamData(teamNumber).warType;
  if (warType) return true;
  toast('Select a War Type first (20vs20 or 50vs50) before adding members');
  if (isOpenTeam && select) {
    select.focus();
    select.classList.add('crusade-needs-value');
    setTimeout(() => select.classList.remove('crusade-needs-value'), 2500);
  }
  return false;
}

function crusadePartyCountForWarType(warType) {
  if (warType === '20vs20') return 4;
  if (warType === '50vs50') return 10;
  return 5;
}

function renderTeamDetail(n) {
  document.getElementById('crusadeTeamHeading').textContent = `${t('sovereign.common.team')} ${n}`;
  document.title = `Sovereign — ${sovereignState.crusade.name} — Team ${n}`;

  const team = getTeamData(n);
  const isDefense = isDefenseStance(team); // no bidding while defending, so the roster skips Bid/Share entirely
  const { value: statusValue, label: statusLabel } = crusadeStatusLabel(team.result);
  const statusBadge = document.getElementById('crusadeTeamStatusBadge');
  statusBadge.className = `crusade-status-badge ${statusValue}`;
  statusBadge.textContent = statusLabel;
  document.getElementById('crusadeTeamRosterDate').textContent = sovereignState.crusade.eventDate
    ? formatLongDate(String(sovereignState.crusade.eventDate).slice(0, 10))
    : t('sovereign.common.noDateSet');
  const teamRows = computeTeamDistribution(n);
  document.getElementById('crusadeTeamRosterEmptyState').classList.toggle('hidden', teamRows.length !== 0);

  // Split into parties of up to 5. How many party cards show depends on the
  // team's war type -- 20vs20 is 4 parties (20 people), 50vs50 is 10 (50);
  // with no war type set, 5. They show even when empty so there's always
  // somewhere to drag members into; a party beyond that count still shows
  // if someone is in it (e.g. after the war type was changed).
  const byParty = new Map();
  teamRows.forEach((row) => {
    const slot = row.participant.partySlot;
    if (!byParty.has(slot)) byParty.set(slot, []);
    byParty.get(slot).push(row);
  });
  // The War Type dropdown's current pick wins over the saved value, so the
  // party cards follow it as soon as it's changed rather than only after Save.
  const warTypeSelect = document.getElementById('teamDetailsForm').elements.warType;
  const memberClasses = Array.from(new Set(sovereignState.memberList.map((m) => m.className).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const availableByClass = new Map();
  sovereignState.memberList.forEach((m) => {
    if (m.className && crusadeTeamOfName(m.name) === null) availableByClass.set(m.className, (availableByClass.get(m.className) || 0) + 1);
  });
  const partyCount = crusadePartyCountForWarType(warTypeSelect ? warTypeSelect.value : team.warType);
  const partySlots = Array.from(new Set([...Array.from({ length: partyCount }, (_, i) => i + 1), ...byParty.keys()])).sort((a, b) => a - b);

  // Each party is its own card/table side by side (grid wraps as needed) —
  // reads all as columns instead of one long table, so a 4-party team
  // doesn't turn into a long vertical scroll.
  const body = document.getElementById('crusadeTeamRosterBody');
  body.innerHTML = partySlots
    .map((slot) => {
      // Highest Growth Rate first within each party (GR from the member's
      // Growth Rate submission; anyone without one sorts last, by name).
      const grOf = (name) => Number(sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name))?.growthRate) || 0;
      const rowsInParty = (byParty.get(slot) || []).slice().sort((a, b) => grOf(b.participant.name) - grOf(a.participant.name) || a.participant.name.localeCompare(b.participant.name));
      const full = rowsInParty.length >= CRUSADE_PARTY_MAX_MEMBERS;
      const memberRows = rowsInParty
        .map(
          ({ participant: p, attendanceAmount, bidShare, total }, i) => `
      <tr class="crusade-roster-row admin-disable" draggable="true" data-drag-participant="${p.id}">
        <td>${i + 1}</td>
        <td class="crusade-roster-name-cell" style="font-weight:600;"><span class="crusade-roster-name-click" data-copy-name="${escapeHtml(p.name)}" title="${escapeHtml(p.name)} — click to copy">${escapeHtml(p.name)}</span>${crusadeStandingIssue(p.name, n) ? `<span class="crusade-standing-warn" title="${escapeHtml(crusadeStandingIssue(p.name, n))}">⚠</span>` : ''}</td>
        <td class="crusade-roster-class-cell" title="${escapeHtml(classOfMember(p.name) || '')}">${classOfMember(p.name) ? escapeHtml(classOfMember(p.name)) : '–'}</td>
        <td class="crusade-roster-guild-cell">${crusadeGuildBadge(p.paid ? p.guildName : guildOfMember(p.name) || p.guildName)}</td>
        <td class="crusade-roster-position-col">${p.position ? escapeHtml(p.position) : '–'}</td>
        <td>${isDefense ? t('sovereign.common.def') : `<label class="crusade-maxbid-cell"><input type="checkbox" class="crusade-maxbid-check admin-disable" data-participant-id="${p.id}" ${p.goldBid > 0 ? 'checked' : ''}><span>${crusadeFormatBidShort(p.goldBid)}</span></label>`}</td>
        <td><input type="checkbox" class="crusade-attended-check admin-disable" data-participant-id="${p.id}" ${p.attended ? 'checked' : ''}></td>
        <td>${crusadeFormatDiamonds(attendanceAmount)}</td>
        ${isDefense ? '' : `<td>${crusadeFormatDiamonds(bidShare)}</td>`}
        <td style="font-weight:600;">${crusadeFormatDiamonds(total)}</td>
        <td class="admin-only"><input type="checkbox" class="crusade-paid-check admin-disable" data-participant-id="${p.id}" ${p.paid ? 'checked' : ''}></td>
        <td class="admin-only crusade-roster-actions-cell">
          <button type="button" class="icon-btn" data-edit-participant="${p.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn" data-delete-participant="${p.id}" title="Remove">✕</button>
        </td>
      </tr>`
        )
        .join('');
      return `
      <div class="crusade-party-card" data-drop-party-slot="${slot}">
        <div class="crusade-party-card-header">
          <h3>${t('sovereign.common.party')} ${slot} — ${rowsInParty.length}/${CRUSADE_PARTY_MAX_MEMBERS}</h3>
          <div class="crusade-party-card-actions">
            <select class="crusade-party-class-pick admin-only admin-disable" data-party-class-pick="${slot}" title="Add the highest Growth Rate available member of a class to Party ${slot} (if it's full, its lowest Growth Rate member moves to the next party)">
              <option value="">+ ${t('sovereign.common.class')}…</option>
              ${memberClasses.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${availableByClass.get(c) || 0})</option>`).join('')}
            </select>
            <button type="button" class="icon-btn admin-only" data-add-to-party-slot="${slot}" title="Add to Party ${slot}" ${full ? 'disabled' : ''}>+</button>
            <button type="button" class="icon-btn" data-copy-party-slot="${slot}" title="Copy Party ${slot} (IGN, class)">📋</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="members-table crusade-roster-table">
            <thead>
              <tr>
                <th>#</th><th>${t('sovereign.common.name')}</th><th>${t('sovereign.common.class')}</th><th>${t('sovereign.common.guild')}</th><th class="crusade-roster-position-col">${t('sovereign.modal.positionLabel')}</th>
                <th title="${t('sovereign.roster.thBid')}">${t('sovereign.roster.thBid')}</th>
                <th title="${t('sovereign.roster.thEnter')}">${t('sovereign.roster.thEnter')}</th>
                <th title="${t('sovereign.roster.thAttend')}">${t('sovereign.roster.thAttend')}</th>
                ${isDefense ? '' : `<th title="${t('sovereign.roster.thShare')}">${t('sovereign.roster.thShare')}</th>`}
                <th>${t('sovereign.common.total')}</th>
                <th class="admin-only" title="${t('sovereign.roster.thPaid')}">${t('sovereign.roster.thPaid')}</th><th class="admin-only"></th>
              </tr>
            </thead>
            <tbody>${memberRows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join('');

  body.querySelectorAll('.crusade-attended-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'attended'));
  });
  body.querySelectorAll('.crusade-maxbid-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'goldBid', cb.checked ? CRUSADE_MAX_BID : 0));
  });
  body.querySelectorAll('.crusade-paid-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'paid'));
  });
  body.querySelectorAll('[data-edit-participant]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(btn.getAttribute('data-edit-participant')));
  });
  body.querySelectorAll('[data-delete-participant]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCrusadeParticipant(btn.getAttribute('data-delete-participant')));
  });
  body.querySelectorAll('[data-copy-name]').forEach((el) => {
    el.addEventListener('click', () => copyTextToClipboard(el.getAttribute('data-copy-name')));
  });
  // Picking a class adds that class's highest Growth Rate member who isn't on
  // any team of this crusade yet (see addMemberToParty for the checks).
  body.querySelectorAll('[data-party-class-pick]').forEach((select) => {
    select.addEventListener('change', async () => {
      const className = select.value;
      const slot = Number(select.getAttribute('data-party-class-pick'));
      select.value = '';
      if (!className) return;
      const best = sovereignState.memberList
        .filter((m) => crusadeMemberDeployable(m, n) && m.className === className && crusadeTeamOfName(m.name) === null && !crusadeStandingIssue(m.name, n))
        .sort((a, b) => (b.growthRate || 0) - (a.growthRate || 0) || a.name.localeCompare(b.name))[0];
      if (!best) {
        toast(`No available ${className} left — everyone with that class is already on a team or blocked by a lineup rule`);
        return;
      }
      const full = sovereignState.participants.filter((x) => x.partyNumber === n && x.partySlot === slot).length >= CRUSADE_PARTY_MAX_MEMBERS;
      if (full) await addMemberWithBump(best, n, slot);
      else await addMemberToParty(best.name, n, slot);
    });
  });

  body.querySelectorAll('[data-copy-party-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.getAttribute('data-copy-party-slot'));
      const people = sovereignState.participants.filter((p) => p.partyNumber === n && (p.partySlot || 1) === slot);
      copyPartySet(people.map((p) => p.name), `Team ${n} Party ${slot}`);
    });
  });

  body.querySelectorAll('[data-add-to-party-slot]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(null, n, Number(btn.getAttribute('data-add-to-party-slot'))));
  });

  wireCrusadeRosterDragAndDrop(body, n);
  renderCrusadeMemberPanel(n);

  const feeCreditsByGuild = new Map();
  [...teamFeesInEffect(team), ...(sovereignState.crusadeFees || [])].forEach((fee) => {
    const guildKey = fee.guildName || 'Unassigned';
    feeCreditsByGuild.set(guildKey, (feeCreditsByGuild.get(guildKey) || 0) + crusadeFeeAmount(fee, team));
  });
  renderCrusadeGuildSummary(teamRows, 'crusadeTeamGuildSummary', undefined, feeCreditsByGuild);
  renderTeamItemTable(n);
  renderCrusadeItemList(n);
  renderCrusadeFeeList(n);
}

// Lineup rules (computed server-side from earlier crusades, see
// computeCrusadeMemberStanding): "no bid twice" keeps someone off Attack
// teams, absent in their last 2 crusades bans them for the rest of the month. Returns
// the reason this name can't go on this team, or null. The team's stance is
// the Team Details dropdown's current pick for the open team.
function crusadeStandingIssue(name, teamNumber) {
  const st = sovereignState.memberStanding?.get(String(name || '').trim().toLowerCase());
  if (!st) return null;
  if (st.bannedThisMonth) return st.bannedReason;
  if (st.noBidTwice) {
    const form = document.getElementById('teamDetailsForm');
    const stance = teamNumber === sovereignState.activeTeam && form ? form.elements.stance.value : getTeamData(teamNumber).stance;
    if (stance === 'Attack') return st.noBidReason;
  }
  return null;
}
// Roster picker chips for this month's misses only -- "Absent 2/5" (lined up
// but didn't enter, decided wars only) and "No bid 1/3" (0 gold bid on an
// Attack team). Members who bid and attended get no chip at all.
function crusadeAbsenceTag(name) {
  const st = sovereignState.memberStanding?.get(String(name || '').trim().toLowerCase());
  if (!st) return '';
  const more = (n, list) => (n > list.length ? ', …' : '');
  let html = '';
  if (st.absences) {
    const title = `Didn't attend ${st.absences} of ${st.played} crusades this month: ${st.absentIn.join(', ')}${more(st.absences, st.absentIn)}`;
    html += `<span class="crusade-absence-chip has-absences" title="${escapeHtml(title)}">Absent ${st.absences}/${st.played}</span>`;
  }
  if (st.noBids) {
    const title = `Didn't bid in ${st.noBids} of ${st.bidChances} attack crusades this month: ${st.noBidIn.join(', ')}${more(st.noBids, st.noBidIn)}`;
    html += `<span class="crusade-absence-chip has-nobids" title="${escapeHtml(title)}">No bid ${st.noBids}/${st.bidChances}</span>`;
  }
  return html;
}

function crusadeStandingTag(name) {
  const st = sovereignState.memberStanding?.get(String(name || '').trim().toLowerCase());
  if (!st || (!st.bannedThisMonth && !st.noBidTwice)) return null;
  return st.bannedThisMonth ? { label: 'Banned', reason: st.bannedReason } : { label: 'No bid ×2', reason: st.noBidReason };
}

// Adds or updates a participant; when the server refuses because of a lineup
// rule (code 'standing'), shows why and, if the admin confirms, retries with
// override -- e.g. for an excused absence.
async function participantApi(url, opts) {
  try {
    return await api(url, opts);
  } catch (err) {
    if (err.code !== 'standing') throw err;
    if (!confirm(`⚠ ${err.message}\n\nAdd anyway?`)) throw new Error('Not added');
    const body = JSON.parse(opts.body || '{}');
    return api(url, { ...opts, body: JSON.stringify({ ...body, override: true }) });
  }
}

// What's being dragged right now on the team page: a roster row (a
// participant already in a party) or a name from the Members panel. Shared
// between the party cards and the panel so each knows what it's receiving.
const crusadeDrag = { participantId: null, memberName: null };
const crusadeNameKey = (name) => String(name || '').trim().toLowerCase();

// Which team (if any) already has this name in the current crusade -- a
// member can only be on one team's roster per crusade.
function crusadeTeamOfName(name) {
  const key = crusadeNameKey(name);
  const p = sovereignState.participants.find((x) => crusadeNameKey(x.name) === key);
  return p ? p.partyNumber : null;
}

async function addMemberToParty(name, teamNumber, partySlot) {
  if (!crusadeRequireWarType(teamNumber)) return;
  const onTeam = crusadeTeamOfName(name);
  if (onTeam !== null) {
    toast(onTeam === teamNumber ? `${name} is already on this team` : `${name} is already on Team ${onTeam}`);
    return;
  }
  const count = sovereignState.participants.filter((p) => p.partyNumber === teamNumber && p.partySlot === partySlot).length;
  if (count >= CRUSADE_PARTY_MAX_MEMBERS) {
    toast(`Party ${partySlot} is already full`);
    return;
  }
  const member = sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name));
  if (member?.defenseOnly && getTeamData(teamNumber)?.stance !== 'Defense' && !confirm(`${name} is DEF only, but Team ${teamNumber} isn't a Defense team. Add them anyway?`)) return;
  try {
    const created = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ name, guildName: member?.guildName || null, partyNumber: teamNumber, partySlot, attended: false }),
    });
    sovereignState.participants.push(created);
    refreshAfterRosterChange();
  } catch (err) {
    toast(err.message);
  }
}

// Drag a roster row from one Party card and drop it on another to move that
// participant into the target party slot (or onto a member to swap them) --
// an alternative to opening the edit modal just to change the Party field.
// Names dragged in from the Members panel are added to the party they're
// dropped on. Blocked the same way every other roster edit is for a
// view-only session (see the `admin-disable` class on the row: CSS drops its
// pointer-events, so dragstart never fires).
function wireCrusadeRosterDragAndDrop(body, teamNumber) {
  body.querySelectorAll('[data-drag-participant]').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      crusadeDrag.participantId = row.getAttribute('data-drag-participant');
      crusadeDrag.memberName = null;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', crusadeDrag.participantId);
      row.classList.add('crusade-roster-row-dragging');
      document.getElementById('crusadeMemberPanel').classList.add('crusade-member-panel-droppable');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('crusade-roster-row-dragging');
      crusadeDrag.participantId = null;
      document.getElementById('crusadeMemberPanel').classList.remove('crusade-member-panel-droppable', 'crusade-member-panel-drop-active');
    });
  });

  async function moveParticipant(participantId, targetSlot) {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${participantId}`, {
      method: 'PUT',
      body: JSON.stringify({ partySlot: targetSlot }),
    });
    const idx = sovereignState.participants.findIndex((p) => p.id === participantId);
    if (idx !== -1) sovereignState.participants[idx] = updated;
  }

  // Dropping directly on another row swaps the two -- this is what makes a
  // full (5/5) party draggable at all, since there's never a free slot to
  // just move into. The dragged participant is parked on a scratch slot no
  // real party uses in between the two writes so the backend's per-party cap
  // check (each move is validated independently) never sees both members
  // occupying the same slot at once and rejects the swap. A name from the
  // Members panel dropped on a row just joins that row's party.
  body.querySelectorAll('[data-drag-participant]').forEach((row) => {
    row.addEventListener('dragover', (e) => {
      const fromPanel = !!crusadeDrag.memberName;
      if (!fromPanel && (!crusadeDrag.participantId || crusadeDrag.participantId === row.getAttribute('data-drag-participant'))) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('crusade-roster-row-drop-target');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('crusade-roster-row-drop-target');
    });
    row.addEventListener('drop', async (e) => {
      const targetId = row.getAttribute('data-drag-participant');
      row.classList.remove('crusade-roster-row-drop-target');
      const target = sovereignState.participants.find((p) => p.id === targetId);
      if (crusadeDrag.memberName) {
        e.preventDefault();
        e.stopPropagation();
        if (target) await addMemberToParty(crusadeDrag.memberName, teamNumber, target.partySlot);
        return;
      }
      const draggedId = crusadeDrag.participantId;
      if (!draggedId || draggedId === targetId) return;
      e.preventDefault();
      e.stopPropagation();

      const dragged = sovereignState.participants.find((p) => p.id === draggedId);
      if (!dragged || !target) return;
      const draggedSlot = dragged.partySlot;
      const targetSlot = target.partySlot;
      if (draggedSlot === targetSlot) return;

      try {
        await moveParticipant(draggedId, CRUSADE_PARTY_SWAP_SCRATCH_SLOT);
        await moveParticipant(targetId, draggedSlot);
        await moveParticipant(draggedId, targetSlot);
        refreshAfterRosterChange();
      } catch (err) {
        toast(err.message);
      }
    });
  });

  body.querySelectorAll('[data-drop-party-slot]').forEach((card) => {
    card.addEventListener('dragover', (e) => {
      if (!crusadeDrag.participantId && !crusadeDrag.memberName) return;
      e.preventDefault();
      card.classList.add('crusade-party-dropzone-active');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('crusade-party-dropzone-active');
    });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('crusade-party-dropzone-active');
      const targetSlot = Number(card.getAttribute('data-drop-party-slot'));
      if (crusadeDrag.memberName) {
        await addMemberToParty(crusadeDrag.memberName, teamNumber, targetSlot);
        return;
      }
      const participantId = crusadeDrag.participantId;
      const participant = sovereignState.participants.find((p) => p.id === participantId);
      if (!participant || participant.partySlot === targetSlot) return;

      // Dropped on empty room in the card rather than on a specific row --
      // just move in, same cap check the backend also enforces.
      const targetCount = sovereignState.participants.filter((p) => p.partyNumber === teamNumber && p.partySlot === targetSlot).length;
      if (targetCount >= CRUSADE_PARTY_MAX_MEMBERS) {
        toast(`Party ${targetSlot} is already full — drop it directly on a member to swap instead`);
        return;
      }

      try {
        await moveParticipant(participantId, targetSlot);
        refreshAfterRosterChange();
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// The Members panel beside the parties: everyone on the Growth Rate roster,
// highest Growth Rate first, filterable by name. Names already on this team
// are left out; names on another team of this crusade show greyed out with
// that team's number and can't be dragged (one team per member per crusade).
// Dropping a party member back onto the panel removes them from the team.
function renderCrusadeMemberPanel(teamNumber) {
  const list = document.getElementById('crusadeMemberPanelList');
  const query = crusadeNameKey(document.getElementById('crusadeMemberPanelSearch').value);
  // class filter: options rebuilt from whoever's on the roster, keeping the current pick
  const classSelect = document.getElementById('crusadeMemberPanelClass');
  const picked = classSelect.value;
  const classes = Array.from(new Set(sovereignState.memberList.map((m) => m.className).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  classSelect.innerHTML = `<option value="">All classes</option>${classes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}`;
  classSelect.value = classes.includes(picked) ? picked : '';
  const classFilter = classSelect.value;
  const members = sovereignState.memberList
    .filter((m) => crusadeTeamOfName(m.name) !== teamNumber)
    .filter((m) => !crusadeIsMercenary(m.name))
    .filter((m) => !query || crusadeNameKey(m.name).includes(query))
    .filter((m) => !classFilter || m.className === classFilter)
    .sort((a, b) => (crusadeTeamOfName(a.name) === null ? 0 : 1) - (crusadeTeamOfName(b.name) === null ? 0 : 1) || (crusadeMemberDeployable(a, teamNumber) ? 0 : 1) - (crusadeMemberDeployable(b, teamNumber) ? 0 : 1) || (b.growthRate || 0) - (a.growthRate || 0) || a.name.localeCompare(b.name));
  const available = sovereignState.memberList.filter((m) => crusadeTeamOfName(m.name) === null && !crusadeIsMercenary(m.name)).length;
  document.getElementById('crusadeMemberPanelCount').textContent = `${available} available`;
  list.innerHTML = members.length
    ? members
        .map((m) => {
          const onTeam = crusadeTeamOfName(m.name);
          const color = m.guildName ? crusadeGuildColor(m.guildName) : null;
          const flag = onTeam === null ? crusadeStandingTag(m.name) : null;
          const issue = onTeam === null ? crusadeStandingIssue(m.name, teamNumber) : null;
          return `
      <li class="crusade-member-chip${onTeam !== null ? ' is-taken' : ' admin-disable'}" ${onTeam === null ? `draggable="true" data-drag-member="${escapeHtml(m.name)}"` : ''} title="${onTeam !== null ? `Already on Team ${onTeam}` : flag ? escapeHtml(flag.reason) : 'Drag onto a party'}">
        <div class="crusade-member-chip-row">
          <span class="crusade-member-chip-dot" style="background:${color || 'var(--text-muted)'}"></span>
          <span class="crusade-member-chip-name">${escapeHtml(m.name)}</span>
          ${onTeam !== null ? `<span class="crusade-member-chip-tag">Team ${onTeam}</span>` : `<span class="crusade-member-chip-gr">${m.growthRate ? Number(m.growthRate).toLocaleString() : ''}</span>`}
        </div>
        <div class="crusade-member-chip-row crusade-member-chip-meta">
          ${m.className ? `<span class="crusade-member-chip-class">${escapeHtml(m.className)}</span>` : ''}
          ${!m.active ? '<span class="crusade-member-chip-flag is-inactive" title="Marked inactive on the Growth Rate page — skipped by Auto Pick">Inactive</span>' : m.defenseOnly ? '<span class="crusade-member-chip-flag is-defense" title="DEF only — deployed on Defense teams only; Auto Pick skips them on Attack teams">DEF only</span>' : ''}
          ${flag ? `<span class="crusade-member-chip-flag${issue ? ' is-blocking' : ''}">${flag.label}</span>` : ''}
          ${crusadeAbsenceTag(m.name)}
        </div>
      </li>`;
        })
        .join('')
    : `<li class="crusade-member-panel-empty">${query || classFilter ? 'No matching members' : 'Everyone is already on a team'}</li>`;

  list.querySelectorAll('[data-drag-member]').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      crusadeDrag.memberName = chip.getAttribute('data-drag-member');
      crusadeDrag.participantId = null;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', crusadeDrag.memberName);
      chip.classList.add('is-dragging');
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('is-dragging');
      crusadeDrag.memberName = null;
    });
  });
}

document.getElementById('crusadeMemberPanelSearch').addEventListener('input', () => {
  if (sovereignState.mode === 'team') renderCrusadeMemberPanel(sovereignState.activeTeam);
});
document.getElementById('crusadeMemberPanelClass').addEventListener('change', () => {
  if (sovereignState.mode === 'team') renderCrusadeMemberPanel(sovereignState.activeTeam);
});

// Dropping a party member onto the panel takes them off this team.
{
  const panel = document.getElementById('crusadeMemberPanel');
  panel.addEventListener('dragover', (e) => {
    if (!crusadeDrag.participantId) return;
    e.preventDefault();
    panel.classList.add('crusade-member-panel-drop-active');
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('crusade-member-panel-drop-active');
  });
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    panel.classList.remove('crusade-member-panel-drop-active', 'crusade-member-panel-droppable');
    const id = crusadeDrag.participantId;
    if (!id) return;
    const participant = sovereignState.participants.find((p) => p.id === id);
    try {
      await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, { method: 'DELETE' });
      sovereignState.participants = sovereignState.participants.filter((p) => p.id !== id);
      refreshAfterRosterChange();
      toast(`${participant?.name || 'Member'} removed from this team`);
    } catch (err) {
      toast(err.message);
    }
  });
}

// Copies a name (e.g. a roster IGN to paste into the game) and says so.
// Falls back to a hidden textarea where the async Clipboard API isn't
// available (plain http, older browsers).
// Copies one party: a header line, then IGN + class per member (tab-
// separated, highest Growth Rate first) -- for Discord or a spreadsheet.
function copyPartySet(names, label) {
  if (!names.length) {
    toast(`${label} is empty`);
    return;
  }
  const memberOf = (name) => sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name));
  const lines = names
    .slice()
    .sort((a, b) => (memberOf(b)?.growthRate || 0) - (memberOf(a)?.growthRate || 0) || a.localeCompare(b))
    .map((name) => [name, memberOf(name)?.className || ''].join('\t'));
  copyTextToClipboard([label, ...lines].join('\n'), `Copied ${label} (${lines.length})`);
}

async function copyTextToClipboard(text, message) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(message || `Copied "${text}"`);
  } catch (err) {
    toast('Could not copy — select the name and copy it manually');
  }
}

async function toggleCrusadeParticipantFlag(checkbox, field, value = checkbox.checked) {
  const id = checkbox.getAttribute('data-participant-id');
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: value }),
    });
    const idx = sovereignState.participants.findIndex((p) => p.id === id);
    if (idx !== -1) sovereignState.participants[idx] = updated;
    refreshAfterRosterChange();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    toast(err.message);
  }
}

async function deleteCrusadeParticipant(id) {
  const participant = sovereignState.participants.find((p) => p.id === id);
  if (!confirm(`Remove "${participant?.name}" from the roster?`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, { method: 'DELETE' });
    sovereignState.participants = sovereignState.participants.filter((p) => p.id !== id);
    refreshAfterRosterChange();
    toast('Participant removed');
  } catch (err) {
    toast(err.message);
  }
}

function openCrusadeParticipantModal(participantId, presetPartyNumber, presetPartySlot) {
  if (!participantId && !crusadeRequireWarType(presetPartyNumber)) return;
  const form = document.getElementById('crusadeParticipantForm');
  form.reset();
  const participant = participantId ? sovereignState.participants.find((p) => p.id === participantId) : null;
  document.getElementById('crusadeParticipantModalTitle').textContent = participant ? t('sovereign.modal.editParticipantHeading') : t('sovereign.modal.addParticipantHeading');
  form.elements.participantId.value = participant ? participant.id : '';
  form.elements.name.value = participant ? participant.name : '';
  form.elements.guildName.value = participant ? participant.guildName || '' : '';
  form.elements.position.value = participant ? participant.position || '' : '';
  const teamNumber = participant ? participant.partyNumber : presetPartyNumber || nextTeamNumber();
  form.elements.partyNumber.value = teamNumber;
  form.elements.partySlot.value = participant ? participant.partySlot : presetPartySlot || nextAvailablePartySlot(teamNumber);
  const noBidding = isDefenseStance(getTeamData(teamNumber));
  // Defaults to 0, not a placeholder bid amount -- only someone who actually
  // bid gold should end up with a nonzero value, since that's what marks
  // them as a bidder everywhere else (Last Crusade's Bidders, Max Bid, etc).
  form.elements.goldBid.value = noBidding ? 0 : participant ? participant.goldBid : 0;
  form.querySelector('.crusade-goldbid-field').classList.toggle('hidden', noBidding);
  form.elements.manualDiamonds.value = participant ? participant.manualDiamonds : 0;
  form.elements.attended.checked = participant ? participant.attended : false;
  document.getElementById('crusadeParticipantModal').classList.remove('hidden');
}

document.getElementById('addCrusadeParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null));
document.getElementById('addTeamParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null, sovereignState.activeTeam));

// ---------- Add Multiple Participants (search the Member List, click many) ----------

const crusadeBulkAddState = { selectedNames: [], unmatchedNames: [] };

// Exact match against the Member List, ignoring case and surrounding
// whitespace only — the game's names can contain any mix of scripts/symbols
// (e.g. "Serpenta蛇OH", "・ツ・"), so anything looser risks silently matching
// the wrong member.
function findMemberByPastedName(rawName) {
  const needle = rawName.trim().toLowerCase();
  return sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === needle);
}

function renderCrusadeBulkUnmatched() {
  const names = crusadeBulkAddState.unmatchedNames;
  document.getElementById('crusadeBulkUnmatchedWrap').classList.toggle('hidden', names.length === 0);
  document.getElementById('crusadeBulkUnmatchedList').innerHTML = names.map((n) => `<div>${escapeHtml(n)}</div>`).join('');
}

// Splits pasted text into one name per line and matches each against the
// Member List exactly, so a bulk paste can't silently add the wrong person
// or skip someone over a typo — anything that doesn't match exactly is
// surfaced for the user to verify rather than added or guessed at.
function handleCrusadeBulkPaste(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;

  const unmatched = [];
  lines.forEach((line) => {
    const member = findMemberByPastedName(line);
    if (!member) {
      unmatched.push(line);
      return;
    }
    if (!crusadeBulkAddState.selectedNames.includes(member.name)) {
      crusadeBulkAddState.selectedNames.push(member.name);
    }
  });
  crusadeBulkAddState.unmatchedNames = unmatched;
  return true;
}

function renderCrusadeBulkResults() {
  const query = document.getElementById('crusadeBulkSearchInput').value.trim().toLowerCase();
  const results = query ? sovereignState.memberList.filter((m) => m.name.toLowerCase().includes(query)) : sovereignState.memberList;

  document.getElementById('crusadeBulkResultsList').innerHTML = results
    .map((m) => {
      const selected = crusadeBulkAddState.selectedNames.includes(m.name);
      return `
      <div class="crusade-bulk-result-row ${selected ? 'selected' : ''}" data-name="${escapeHtml(m.name)}">
        <span class="crusade-bulk-result-check">${selected ? '✓' : ''}</span>
        <span style="flex:1;">${escapeHtml(m.name)}</span>
        ${crusadeGuildBadge(m.guildName)}
      </div>`;
    })
    .join('');

  document.querySelectorAll('.crusade-bulk-result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const name = row.getAttribute('data-name');
      const idx = crusadeBulkAddState.selectedNames.indexOf(name);
      if (idx === -1) crusadeBulkAddState.selectedNames.push(name);
      else crusadeBulkAddState.selectedNames.splice(idx, 1);
      renderCrusadeBulkResults();
      renderCrusadeBulkSelected();
    });
  });
}

function renderCrusadeBulkSelected() {
  document.getElementById('crusadeBulkSelectedCount').textContent = crusadeBulkAddState.selectedNames.length;
  document.getElementById('crusadeBulkSelectedList').innerHTML = crusadeBulkAddState.selectedNames
    .map((name) => `<span class="crusade-bulk-chip">${escapeHtml(name)} <button type="button" data-remove-chip="${escapeHtml(name)}">✕</button></span>`)
    .join('');

  document.querySelectorAll('[data-remove-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-remove-chip');
      crusadeBulkAddState.selectedNames = crusadeBulkAddState.selectedNames.filter((n) => n !== name);
      renderCrusadeBulkResults();
      renderCrusadeBulkSelected();
    });
  });
}

function openCrusadeBulkAddModal(presetPartyNumber) {
  if (!crusadeRequireWarType(presetPartyNumber)) return;
  crusadeBulkAddState.selectedNames = [];
  crusadeBulkAddState.unmatchedNames = [];
  document.getElementById('crusadeBulkSearchInput').value = '';
  const form = document.getElementById('crusadeBulkAddForm');
  form.reset();
  const teamNumber = presetPartyNumber || nextTeamNumber();
  form.elements.partyNumber.value = teamNumber;
  form.elements.partySlot.value = nextAvailablePartySlot(teamNumber);
  const noBidding = isDefenseStance(getTeamData(teamNumber));
  // Defaults to 0 -- a shared bulk-add batch usually mixes bidders and
  // non-bidders, so presuming everyone bid would misrepresent whoever
  // didn't as a bidder (see the single-add modal for the same reasoning).
  form.elements.goldBid.value = 0;
  form.elements.attended.checked = false;
  form.querySelector('.crusade-goldbid-field').classList.toggle('hidden', noBidding);
  renderCrusadeBulkResults();
  renderCrusadeBulkSelected();
  renderCrusadeBulkUnmatched();
  document.getElementById('crusadeBulkAddModal').classList.remove('hidden');
}

document.getElementById('addCrusadeBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(null));
document.getElementById('addTeamBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(sovereignState.activeTeam));
document.getElementById('autoPickTeamBtn').addEventListener('click', () => autoPickCrusadeRoster(sovereignState.activeTeam));
// A printable sheet of just this team's roster -- War Type / Stance / Team
// banner, then every party (two per row) with Name,
// Guild, Position, Gold and an Enter box. Goes straight to the browser's
// print preview (rendered in a hidden frame, no new tab); uses the Team
// Details form's current values, same as the party cards on screen.
const CRUSADE_PRINT_CLASS_COLORS = ['#7c3aed', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#2563eb', '#ca8a04', '#475569', '#dc2626', '#0d9488'];
function crusadePrintClassColor(label) {
  const classes = Array.from(new Set(sovereignState.memberList.map((m) => m.className).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  let idx = classes.indexOf(label);
  if (idx === -1) idx = Array.from(String(label)).reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);
  return CRUSADE_PRINT_CLASS_COLORS[idx % CRUSADE_PRINT_CLASS_COLORS.length];
}

// Sheet colours per team (banner/borders, header row, party title, rows),
// so printed sheets for different teams are easy to tell apart.
const CRUSADE_PRINT_TEAM_THEMES = [
  { dark: '#b45309', mid: '#fdba74', light: '#fed7aa', row: '#fde7cf', line: '#c2410c' }, // 1 orange
  { dark: '#1d4ed8', mid: '#93c5fd', light: '#bfdbfe', row: '#e0edff', line: '#1e40af' }, // 2 blue
  { dark: '#15803d', mid: '#86efac', light: '#bbf7d0', row: '#e3fbe9', line: '#166534' }, // 3 green
  { dark: '#7e22ce', mid: '#d8b4fe', light: '#e9d5ff', row: '#f4ebff', line: '#6b21a8' }, // 4 purple
  { dark: '#be123c', mid: '#fda4af', light: '#fecdd3', row: '#ffe8eb', line: '#9f1239' }, // 5 red
  { dark: '#0f766e', mid: '#5eead4', light: '#99f6e4', row: '#dcfbf5', line: '#115e59' }, // 6 teal
  { dark: '#a16207', mid: '#fde047', light: '#fef08a', row: '#fef9d7', line: '#854d0e' }, // 7 gold
  { dark: '#334155', mid: '#cbd5e1', light: '#e2e8f0', row: '#f1f5f9', line: '#1e293b' }, // 8 slate
];

// One team's sheet (banner + party tables). Colours come from CSS variables
// set on the sheet, so several teams can share one printout. useForm: read
// War Type / Stance from the open team's Team Details form (unsaved picks
// included) instead of the saved team.
function crusadeTeamPrintSheet(teamNumber, useForm) {
  const theme = CRUSADE_PRINT_TEAM_THEMES[(Math.max(1, teamNumber) - 1) % CRUSADE_PRINT_TEAM_THEMES.length];
  const form = useForm ? document.getElementById('teamDetailsForm') : null;
  const team = getTeamData(teamNumber);
  const val = (field) => (form && form.elements[field] ? form.elements[field].value : team[field]) || '';
  const warType = val('warType');
  const stance = val('stance');
  const isDefense = stance === 'Defense';
  const grOf = (name) => Number(sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name))?.growthRate) || 0;
  const members = sovereignState.participants.filter((x) => x.partyNumber === teamNumber);
  const partyCount = crusadePartyCountForWarType(warType);
  const slots = Array.from(new Set([...Array.from({ length: partyCount }, (_, i) => i + 1), ...members.map((x) => x.partySlot)])).sort((a, b) => a - b);
  const esc = escapeHtml;

  const partyTable = (slot) => {
    const rows = members
      .filter((x) => x.partySlot === slot)
      .sort((a, b) => grOf(b.name) - grOf(a.name) || a.name.localeCompare(b.name));
    const cells = Array.from({ length: CRUSADE_PARTY_MAX_MEMBERS }, (_, i) => {
      const m = rows[i];
      if (!m) return '<tr><td class="name"></td><td></td><td></td><td></td><td class="enter"><span class="box"></span></td></tr>';
      const guild = m.paid ? m.guildName : guildOfMember(m.name) || m.guildName;
      const guildColor = crusadeGuildColor(guild) || '#64748b';
      const position = m.position || classOfMember(m.name) || '';
      const gold = isDefense ? '' : m.goldBid > 0 ? crusadeFormatBidShort(m.goldBid) : '';
      return `<tr>
        <td class="name${i === 0 ? ' lead' : ''}">${esc(m.name)}</td>
        <td>${guild ? `<span class="pill" style="background:${guildColor}">${esc(guild)}</span>` : ''}</td>
        <td>${position ? `<span class="pill" style="background:${crusadePrintClassColor(position)}">${esc(position)}</span>` : ''}</td>
        <td class="gold">${gold}</td>
        <td class="enter"><span class="box${m.attended ? ' on' : ''}"></span></td>
      </tr>`;
    }).join('');
    return `<table class="party">
      <thead><tr><th colspan="5" class="party-title">Party ${slot}</th></tr>
      <tr><th>Name</th><th>Guild</th><th>Position</th><th>Gold</th><th>Enter</th></tr></thead>
      <tbody>${cells}</tbody></table>`;
  };

  return `<section class="sheet" style="--dark:${theme.dark}; --mid:${theme.mid}; --light:${theme.light}; --row:${theme.row}; --line:${theme.line}; --stance:${isDefense ? '#1d4ed8' : '#b91c1c'};">
  <div class="banner"><div>${esc(warType || '—')}</div><div class="stance">${esc(stance || '—')}</div><div>Team ${teamNumber}</div></div>
  <div class="grid">${slots.map(partyTable).join('')}</div>
</section>`;
}

// Prints the given teams' sheets on ONE landscape page -- stacked, then
// shrunk to fit the page if they're taller than it -- straight to the
// browser's print preview (rendered in a hidden frame, no new tab).
function printCrusadeRosterSheets(teamNumbers, useForm) {
  const esc = escapeHtml;
  const crusadeName = sovereignState.crusade?.name || 'Crusade';
  const title = teamNumbers.length === 1 ? `${crusadeName} — Team ${teamNumbers[0]} Roster` : `${crusadeName} — All Rosters`;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 16px; font-family: Arial, "Microsoft YaHei", "Malgun Gothic", sans-serif; font-size: 12px; color: #111; background: #fff; }
  .sheet { max-width: 1000px; }
  .sheet + .sheet { margin-top: 14px; padding-top: 12px; border-top: 2px dashed #999; }
  .multi .banner div { font-size: 14px; padding: 3px; }
  .multi .banner { margin-bottom: 8px; }
  .multi .grid { gap: 8px 16px; }
  .multi table.party th, .multi table.party td { height: 18px; padding: 1px 5px; font-size: 11px; }
  .banner { display: grid; gap: 4px; grid-template-columns: 1fr 1.4fr 1fr; margin-bottom: 14px; }
  .banner div { background: var(--dark); color: #fff; font-weight: 700; font-size: 18px; text-align: center; padding: 6px; border-radius: 3px; }
  .banner .stance { background: #fff; color: var(--stance); border: 2px solid var(--dark); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
  table.party { width: 100%; border-collapse: collapse; background: var(--row); break-inside: avoid; }
  table.party th, table.party td { border: 1px solid var(--line); padding: 3px 6px; height: 22px; white-space: nowrap; }
  table.party th { background: var(--mid); font-weight: 700; text-align: center; }
  table.party th.party-title { background: var(--light); }
  td.name { font-weight: 600; min-width: 120px; }
  td.name.lead { background: #fde047; }
  td.gold { text-align: right; min-width: 50px; }
  td.enter { text-align: center; width: 50px; }
  .pill { display: inline-block; color: #fff; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
  .box { display: inline-block; width: 13px; height: 13px; border: 1.5px solid #555; border-radius: 2px; background: #fff; vertical-align: middle; position: relative; }
  .box.on::after { content: "✓"; position: absolute; left: 1px; top: -3px; font-size: 13px; font-weight: 700; color: #15803d; }
  @media print { body { padding: 0; } @page { size: landscape; margin: 8mm; } }
</style></head><body class="${teamNumbers.length > 1 ? 'multi' : ''}">
${teamNumbers.map((n) => crusadeTeamPrintSheet(n, useForm && n === sovereignState.activeTeam)).join('\n')}
</body></html>`;
  document.getElementById('crusadePrintFrame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'crusadePrintFrame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden;';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  // let the fonts/layout settle, shrink everything to fit one landscape
  // page (Letter/A4 minus margins is about 1000 x 700 CSS px), then open
  // the browser's print preview
  setTimeout(() => {
    const body = doc.body;
    body.style.width = '1000px';
    const scale = Math.min(1, 700 / body.scrollHeight, 1000 / body.scrollWidth);
    if (scale < 1) body.style.zoom = String(Math.floor(scale * 100) / 100);
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, 250);
}

function printCrusadeTeamRoster(teamNumber) {
  printCrusadeRosterSheets([teamNumber], true);
}

// Every team of the open crusade (the crusade's date lineup), in team order.
function printAllCrusadeRosters() {
  const numbers = Array.from(new Set([...sovereignState.teams.map((t) => t.teamNumber), ...sovereignState.participants.map((x) => x.partyNumber)])).sort((a, b) => a - b);
  if (!numbers.length) {
    toast('This crusade has no teams to print yet');
    return;
  }
  printCrusadeRosterSheets(numbers, false);
}

document.getElementById('printAllRostersBtn').addEventListener('click', printAllCrusadeRosters);

// Copy Roster: one line per person -- IGN, class, team -- tab-separated so
// it pastes into Discord as a list or into a spreadsheet as 3 columns.
// Teams in order (party, then Growth Rate inside each), mercenaries last.
document.getElementById('copyCrusadeRosterBtn').addEventListener('click', () => {
  const memberOf = (name) => sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name));
  const gr = (name) => memberOf(name)?.growthRate || 0;
  const lines = [];
  visibleTeamNumbers().forEach((n) => {
    sovereignState.participants
      .filter((p) => p.partyNumber === n)
      .sort((a, b) => (a.partySlot || 1) - (b.partySlot || 1) || gr(b.name) - gr(a.name))
      .forEach((p) => lines.push([p.name, memberOf(p.name)?.className || '', `Team ${n}`].join('\t')));
  });
  (sovereignState.mercenaries || [])
    .slice()
    .sort((a, b) => (a.partySlot || 1) - (b.partySlot || 1) || gr(b.name) - gr(a.name))
    .forEach((m) => lines.push([m.name, memberOf(m.name)?.className || '', 'Mercenary'].join('\t')));
  if (!lines.length) {
    toast('Nobody is lined up on this crusade yet');
    return;
  }
  copyTextToClipboard(['IGN\tClass\tTeam', ...lines].join('\n'), `Copied ${lines.length} ${lines.length === 1 ? 'person' : 'people'} (IGN, class, team)`);
});
document.getElementById('printTeamRosterBtn').addEventListener('click', () => printCrusadeTeamRoster(sovereignState.activeTeam));

document.getElementById('clearTeamRosterBtn').addEventListener('click', async () => {
  const teamNumber = sovereignState.activeTeam;
  const count = sovereignState.participants.filter((p) => p.partyNumber === teamNumber).length;
  if (!count) {
    toast('This team has no members to clear');
    return;
  }
  if (!confirm(`Remove all ${count} member${count === 1 ? '' : 's'} from Team ${teamNumber}? The team's details (war type, reward, items, fees) are kept.`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/teams/${teamNumber}/participants`, { method: 'DELETE' });
    sovereignState.participants = sovereignState.participants.filter((p) => p.partyNumber !== teamNumber);
    refreshAfterRosterChange();
    toast(`Team ${teamNumber}'s roster cleared`);
  } catch (err) {
    toast(err.message);
  }
});

const isDivinePriest = (className) => /divine\s*priest/i.test(String(className || ''));

// Works out who Auto Pick would add where, without adding anyone: fills only
// the team's empty slots (its parties per the War Type, see
// crusadePartyCountForWarType) from members not already on any team of this
// crusade. Each party first gets one Divine Priest (highest Growth Rate
// first) unless it already has one; then everyone else goes in by Growth
// Rate in party order -- Party 1 gets the highest, then Party 2, and so on.
// Spare priests only fill slots nobody else is left for.
function planCrusadeAutoPick(teamNumber, partyCount) {
  const classOf = (name) => sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name))?.className;
  const parties = Array.from({ length: partyCount }, (_, i) => i + 1);
  const free = new Map(), hasPriest = new Map();
  parties.forEach((slot) => {
    const members = sovereignState.participants.filter((x) => x.partyNumber === teamNumber && x.partySlot === slot);
    free.set(slot, Math.max(0, CRUSADE_PARTY_MAX_MEMBERS - members.length));
    hasPriest.set(slot, members.some((x) => isDivinePriest(classOf(x.name))));
  });
  const pool = sovereignState.memberList
    .filter((m) => crusadeMemberDeployable(m, teamNumber) && crusadeTeamOfName(m.name) === null && !crusadeStandingIssue(m.name, teamNumber))
    .sort((a, b) => (b.growthRate || 0) - (a.growthRate || 0) || a.name.localeCompare(b.name));
  const priests = pool.filter((m) => isDivinePriest(m.className));
  const plan = [];
  parties.forEach((slot) => {
    if (hasPriest.get(slot) || free.get(slot) === 0 || !priests.length) return;
    plan.push({ member: priests.shift(), slot });
    free.set(slot, free.get(slot) - 1);
  });
  const taken = new Set(plan.map((x) => x.member.name));
  const rest = [...pool.filter((m) => !isDivinePriest(m.className) && !taken.has(m.name)), ...priests];
  let i = 0;
  for (const slot of parties) {
    while (free.get(slot) > 0 && i < rest.length) {
      plan.push({ member: rest[i++], slot });
      free.set(slot, free.get(slot) - 1);
    }
  }
  return plan;
}

async function autoPickCrusadeRoster(teamNumber) {
  if (!crusadeRequireWarType(teamNumber)) return;
  const partyCount = crusadePartyCountForWarType(document.getElementById('teamDetailsForm').elements.warType.value || getTeamData(teamNumber).warType);
  const plan = planCrusadeAutoPick(teamNumber, partyCount);
  if (!plan.length) {
    toast('Nothing to add — every party is full or nobody is left');
    return;
  }
  const priestsAdded = plan.filter((x) => isDivinePriest(x.member.className)).length;
  const lines = Array.from({ length: partyCount }, (_, i) => i + 1)
    .map((slot) => {
      const names = plan.filter((x) => x.slot === slot).map((x) => x.member.name);
      return names.length ? `Party ${slot}: ${names.join(', ')}` : null;
    })
    .filter(Boolean);
  if (!confirm(`Auto Pick will add ${plan.length} member${plan.length === 1 ? '' : 's'} (${priestsAdded} Divine Priest${priestsAdded === 1 ? '' : 's'}), highest Growth Rate in Party 1:\n\n${lines.join('\n')}\n\nAdd them?`)) return;
  let added = 0;
  for (const { member, slot } of plan) {
    try {
      const created = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ name: member.name, guildName: member.guildName || null, partyNumber: teamNumber, partySlot: slot, attended: false }),
      });
      sovereignState.participants.push(created);
      added++;
    } catch (err) {
      toast(`${member.name}: ${err.message}`);
    }
  }
  refreshAfterRosterChange();
  toast(`Auto Pick added ${added} member${added === 1 ? '' : 's'}`);
}
document.getElementById('crusadeBulkSearchInput').addEventListener('input', renderCrusadeBulkResults);
document.getElementById('crusadeBulkSearchInput').addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!handleCrusadeBulkPaste(text)) return; // single-line paste: let it fall through as a normal search
  e.preventDefault();
  e.target.value = '';
  renderCrusadeBulkResults();
  renderCrusadeBulkSelected();
  renderCrusadeBulkUnmatched();
});

document.getElementById('crusadeBulkAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const names = crusadeBulkAddState.selectedNames;
  if (!names.length) {
    toast('Select at least one member first');
    return;
  }

  const teamNumber = Number(form.elements.partyNumber.value) || 1;
  let partySlot = Number(form.elements.partySlot.value) || 1;
  const goldBid = Number(form.elements.goldBid.value) || 0;
  const attended = form.elements.attended.checked;

  let added = 0;
  for (const name of names) {
    const member = sovereignState.memberList.find((m) => m.name === name);
    // Respect the 5-per-party cap by advancing to the next slot whenever the
    // current one fills up (including from participants just added in this
    // same batch, since sovereignState.participants is updated as we go).
    while (
      sovereignState.participants.filter((p) => p.partyNumber === teamNumber && p.partySlot === partySlot).length >=
      CRUSADE_PARTY_MAX_MEMBERS
    ) {
      partySlot++;
    }
    try {
      const created = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          guildName: member?.guildName || null,
          position: member?.position || null,
          partyNumber: teamNumber,
          partySlot,
          goldBid,
          attended,
        }),
      });
      sovereignState.participants.push(created);
      added++;
    } catch (err) {
      toast(`${name}: ${err.message}`);
    }
  }

  document.getElementById('crusadeBulkAddModal').classList.add('hidden');
  refreshAfterRosterChange();
  toast(`${added} participant${added === 1 ? '' : 's'} added`);
});

// Jumps straight to the next team past whatever's already visible in the
// list (the 1-3 baseline, or higher if teams already exist beyond that) —
// landing on its (empty) roster page ready for "+ Add Participant".
document.getElementById('addCrusadeTeamBtn').addEventListener('click', () => {
  const nextTeam = Math.max(...visibleTeamNumbers()) + 1;
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}/team/${nextTeam}`;
});

document.getElementById('crusadeParticipantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const participantId = form.elements.participantId.value;
  const payload = {
    name: form.elements.name.value,
    guildName: form.elements.guildName.value || null,
    position: form.elements.position.value || null,
    partyNumber: Number(form.elements.partyNumber.value) || 1,
    partySlot: Number(form.elements.partySlot.value) || 1,
    goldBid: Number(form.elements.goldBid.value) || 0,
    manualDiamonds: Number(form.elements.manualDiamonds.value) || 0,
    attended: form.elements.attended.checked,
  };
  try {
    if (participantId) {
      const updated = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants/${participantId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignState.participants.findIndex((p) => p.id === participantId);
      if (idx !== -1) sovereignState.participants[idx] = updated;
    } else {
      const created = await participantApi(`/api/crusades/${sovereignState.crusadeId}/participants`, { method: 'POST', body: JSON.stringify(payload) });
      sovereignState.participants.push(created);
    }
    document.getElementById('crusadeParticipantModal').classList.add('hidden');
    refreshAfterRosterChange();
    toast('Roster saved');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Diamond distribution (per team) ----------

// A lost team pays out nothing at all — diamonds, items, and management fees
// all drop to 0 regardless of what's entered, rather than splitting a
// reward that was never actually earned.
function crusadeWasLost(team) {
  return !!(team && team.result === 'lose');
}

// Management fees take a percentage of a team's *own* diamond reward off the
// top (e.g. a guild leader's cut) before anything else is computed — so the
// pool that actually gets split by attendance/bid is that team's reward
// minus every one of its fees' amounts.
// Old per-team fees only count on a crusade with no crusade-wide fee -- once
// one is set it replaces them, so the fee is never taken twice.
function teamFeesInEffect(team) {
  return (sovereignState.crusadeFees || []).length ? [] : team.fees || [];
}

function totalTeamFeeAmount(team) {
  if (crusadeWasLost(team)) return 0;
  // Crusade-wide fees (set once on the crusade page) come off every team too.
  return [...teamFeesInEffect(team), ...(sovereignState.crusadeFees || [])].reduce((sum, f) => sum + team.diamondReward * (f.percent / 100), 0);
}

// Winning on Defense splits a team's (post-fee) reward 60/40 instead of
// paying it all to that team's own roster: 60% stays there, 40% goes to
// whoever bid gold on the team it inherited the bonus from (see
// computeTeamBonusShares). Any other stance/result keeps the full reward for
// that team's roster, same as before.
function isTeamDefenseWin(team) {
  return !!(team && team.stance === 'Defense' && team.result === 'win');
}

// Defending doesn't involve gold bids at all -- there's no attack roll to
// buy a spot on, so a Defense team's own-roster pool is 100% attendance,
// regardless of whatever Attendance Share % happens to be saved.
function isDefenseStance(team) {
  return !!(team && team.stance === 'Defense');
}

// Half a team's (post-fee, post-defense-split) reward splits evenly across
// everyone on that team who attended; the other half splits across that
// team's gold bidders in proportion to their bid — this collapses to an
// equal split when every bidder bids the same amount (the common case), and
// scales fairly when bids differ. Defense teams skip the bid split entirely
// (see isDefenseStance) since there's no bidding to divide.
function computeTeamDistribution(teamNumber) {
  const team = getTeamData(teamNumber);
  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  if (crusadeWasLost(team)) {
    return participants.map((p) => ({ participant: p, attendanceAmount: 0, bidShare: 0, total: 0 }));
  }

  // Manual diamonds are carved off the top and paid straight to whoever
  // they're set on, guaranteed -- what's left of the pool is what actually
  // gets split among attendance/bid the normal way, same as a fee.
  const totalManualDiamonds = participants.reduce((sum, p) => sum + (p.manualDiamonds || 0), 0);
  const netReward = Math.max(0, team.diamondReward - totalTeamFeeAmount(team) - totalManualDiamonds);
  const ownPool = isTeamDefenseWin(team) ? netReward * 0.6 : netReward;
  const noBidding = isDefenseStance(team);
  const attendancePool = noBidding ? ownPool : ownPool * (team.attendancePct / 100);
  const bidPool = noBidding ? 0 : ownPool - attendancePool;

  const attendees = participants.filter((p) => p.attended);
  const attendanceShare = attendees.length ? attendancePool / attendees.length : 0;
  const totalBid = participants.reduce((sum, p) => sum + (p.goldBid > 0 ? p.goldBid : 0), 0);

  return participants.map((p) => {
    const attendanceAmount = p.attended ? attendanceShare : 0;
    const bidShare = !noBidding && p.goldBid > 0 && totalBid > 0 ? bidPool * (p.goldBid / totalBid) : 0;
    return { participant: p, attendanceAmount, bidShare, total: attendanceAmount + bidShare + (p.manualDiamonds || 0) };
  });
}

// The other 40% of a Defense win's reward, split evenly across everyone who
// placed a gold bid on the team this one inherited its bonus from — paid out
// to them by name/guild, regardless of whether they're on this team's roster
// at all.
function computeTeamBonusShares(teamNumber) {
  const team = getTeamData(teamNumber);
  if (crusadeWasLost(team) || !isTeamDefenseWin(team)) return { pool: 0, perBidder: 0, bidders: [] };

  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  const totalManualDiamonds = participants.reduce((sum, p) => sum + (p.manualDiamonds || 0), 0);
  const netReward = Math.max(0, team.diamondReward - totalTeamFeeAmount(team) - totalManualDiamonds);
  const pool = netReward * 0.4;
  const bidders = team.lastTeamBidders || [];
  const perBidder = bidders.length ? pool / bidders.length : 0;
  return { pool, perBidder, bidders };
}

// Each named item (e.g. Morion) has its own total quantity, split evenly
// across that team's attendees only — no bid portion, unlike diamonds.
// Non-attendees get none, same "attended is a must" rule as the diamond
// attendance share.
function computeTeamItemShares(teamNumber, item) {
  const team = getTeamData(teamNumber);
  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  if (crusadeWasLost(team)) return participants.map((p) => ({ participant: p, total: 0 }));

  const quantity = item ? item.quantity || 0 : 0;
  const attendees = participants.filter((p) => p.attended);
  const share = attendees.length ? quantity / attendees.length : 0;
  return participants.map((p) => ({ participant: p, total: p.attended ? share : 0 }));
}

// Multiple items laid out as columns (one per item) with one row per guild
// present on this team, so several items can be compared at a glance instead
// of scrolling through a separate summary per item.
function renderTeamItemTable(n) {
  const heading = document.getElementById('crusadeTeamItemsHeading');
  const table = document.getElementById('crusadeTeamItemTable');
  const items = getTeamData(n).items || [];

  if (!items.length) {
    heading.classList.add('hidden');
    table.classList.add('hidden');
    return;
  }
  heading.classList.remove('hidden');
  table.classList.remove('hidden');

  const teamParticipants = sovereignState.participants.filter((p) => p.partyNumber === n);
  const guildNames = Array.from(new Set(teamParticipants.map((p) => p.guildName || 'Unassigned'))).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  const shareByGuildPerItem = items.map((item) => {
    const byGuild = new Map();
    computeTeamItemShares(n, item).forEach(({ participant: p, total }) => {
      const key = p.guildName || 'Unassigned';
      byGuild.set(key, (byGuild.get(key) || 0) + total);
    });
    return byGuild;
  });

  document.getElementById('crusadeTeamItemTableHead').innerHTML =
    `<th>#</th><th>${t('sovereign.common.guild')}</th>${items.map((it) => `<th>${escapeHtml(crusadeItemLabel(it.name))}</th>`).join('')}<th>${t('sovereign.itemTable.members')}</th>`;

  const memberCountByGuild = new Map();
  teamParticipants.forEach((p) => {
    const key = p.guildName || 'Unassigned';
    memberCountByGuild.set(key, (memberCountByGuild.get(key) || 0) + 1);
  });

  const rows = guildNames.map((guildName, i) => {
    const color = guildName === 'Unassigned' ? null : crusadeGuildColor(guildName);
    const cells = shareByGuildPerItem.map((byGuild) => `<td>${crusadeFormatItemQty(byGuild.get(guildName) || 0)}</td>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td style="font-weight:600; ${color ? `color:${color};` : ''}">${guildName === 'Unassigned' ? t('sovereign.common.unassigned') : escapeHtml(guildName)}</td>
      ${cells}
      <td>${memberCountByGuild.get(guildName)}</td>
    </tr>`;
  });

  const totalCells = shareByGuildPerItem
    .map((byGuild) => `<td>${crusadeFormatItemQty(Array.from(byGuild.values()).reduce((sum, v) => sum + v, 0))}</td>`)
    .join('');
  rows.push(`<tr class="crusade-table-total-row"><td></td><td>${t('sovereign.common.total')}</td>${totalCells}<td>${teamParticipants.length}</td></tr>`);

  document.getElementById('crusadeTeamItemTableBody').innerHTML = rows.join('');
}

function renderCrusadeItemList(n) {
  const list = document.getElementById('crusadeItemList');
  const items = getTeamData(n).items || [];
  document.getElementById('crusadeItemListEmptyState').classList.toggle('hidden', items.length !== 0);

  list.innerHTML = items
    .map(
      (item) => `
    <li style="display:flex; gap:8px; align-items:center;" data-item-id="${item.id}">
      <span style="flex:1;">${escapeHtml(crusadeItemLabel(item.name))}</span>
      <span style="color:var(--text-muted);">${crusadeFormatItemQty(item.quantity)}</span>
      <button type="button" class="icon-btn admin-only" data-delete-item="${item.id}" title="Remove item">✕</button>
    </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemId = btn.getAttribute('data-delete-item');
      const item = items.find((i) => i.id === itemId);
      if (!confirm(`Remove item "${item?.name}" from this team?`)) return;
      try {
        await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/items/${itemId}`, { method: 'DELETE' });
        const team = sovereignState.teams.find((t) => t.teamNumber === n);
        if (team) team.items = team.items.filter((i) => i.id !== itemId);
        renderCrusadeItemList(n);
        renderTeamItemTable(n);
        toast('Item removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeItemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const n = sovereignState.activeTeam;
  try {
    const item = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/items`, {
      method: 'POST',
      body: JSON.stringify({ name: form.elements.name.value, quantity: Number(form.elements.quantity.value) || 0 }),
    });
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: item.teamId };
      sovereignState.teams.push(team);
    }
    team.items.push(item);
    renderCrusadeItemList(n);
    renderTeamItemTable(n);
    form.reset();
    toast(`${item.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

function crusadeFeeAmount(fee, team) {
  if (crusadeWasLost(team)) return 0;
  return (team ? team.diamondReward || 0 : 0) * (fee.percent / 100);
}

function renderCrusadeFeeList(n) {
  const list = document.getElementById('crusadeFeeList');
  const team = getTeamData(n);
  const fees = teamFeesInEffect(team);
  // Management fees are set once per crusade now (crusade page); only a team
  // still carrying old per-team fees shows this panel, to see/remove them.
  document.getElementById('crusadeTeamFeesPanel').classList.toggle('hidden', fees.length === 0);
  document.getElementById('crusadeFeeListEmptyState').classList.toggle('hidden', fees.length !== 0);

  list.innerHTML = fees
    .map(
      (fee) => `
    <li style="display:flex; gap:8px; align-items:center;" data-fee-id="${fee.id}">
      <span style="flex:1; font-weight:600;" class="crusade-roster-name-click admin-disable" data-rename-fee="${fee.id}" title="Click to rename">${escapeHtml(fee.name)}</span>
      ${crusadeGuildBadge(fee.guildName)}
      <span style="color:var(--text-muted);">${fee.percent}% → ${crusadeFormatDiamonds(crusadeFeeAmount(fee, team))}</span>
      <button type="button" class="icon-btn admin-only" data-delete-fee="${fee.id}" title="Remove fee">✕</button>
    </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const feeId = btn.getAttribute('data-delete-fee');
      const fee = fees.find((f) => f.id === feeId);
      if (!confirm(`Remove the ${fee?.percent}% management fee for "${fee?.name}"?`)) return;
      try {
        await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/fees/${feeId}`, { method: 'DELETE' });
        const teamState = sovereignState.teams.find((t) => t.teamNumber === n);
        if (teamState) teamState.fees = teamState.fees.filter((f) => f.id !== feeId);
        renderTeamDetail(n); // fee removal changes this team's pool, so recompute (also re-renders this list)
        toast('Fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
  list.querySelectorAll('[data-rename-fee]').forEach((span) => {
    span.addEventListener('click', async () => {
      const feeId = span.getAttribute('data-rename-fee');
      const fee = fees.find((f) => f.id === feeId);
      if (!fee) return;
      const nextName = prompt('Rename this fee\'s IGN:', fee.name);
      if (nextName === null) return; // cancelled
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === fee.name) return;
      try {
        const updated = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/fees/${feeId}`, { method: 'PUT', body: JSON.stringify({ name: trimmed }) });
        const teamState = sovereignState.teams.find((t) => t.teamNumber === n);
        if (teamState) {
          const idx = teamState.fees.findIndex((f) => f.id === feeId);
          if (idx !== -1) teamState.fees[idx] = updated;
        }
        renderTeamDetail(n);
        toast('Fee renamed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const n = sovereignState.activeTeam;
  try {
    const fee = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/fees`, {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        guildName: form.elements.guildName.value || null,
        percent: Number(form.elements.percent.value) || 0,
      }),
    });
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: fee.teamId };
      sovereignState.teams.push(team);
    }
    team.fees.push(fee);
    renderTeamDetail(n); // new fee changes this team's pool, so recompute (also re-renders this list)
    form.reset();
    toast(`${fee.name}'s fee added`);
  } catch (err) {
    toast(err.message);
  }
});

// Mercenaries summary on the crusade page; the set itself is edited on its
// own page (#crusade/<slug>/mercenaries), laid out like a team.
function renderCrusadeMercenaries() {
  const mercs = sovereignState.mercenaries || [];
  document.getElementById('crusadeMercenaryCount').textContent = mercs.length ? `(${mercs.length})` : '';
  document.getElementById('crusadeMercenarySummary').textContent = mercs.length
    ? mercs.map((m) => m.name).join(', ')
    : "A separate set for this crusade, kept out of every team's line-up.";
}

document.getElementById('viewMercenariesLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}/mercenaries`;
});
document.getElementById('sovereignMercenaryBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${crusadeSlugSegment(sovereignState.crusade)}`;
});

const MERCENARY_MIN_PARTIES = 5;
const mercDrag = { mercId: null, memberName: null };
// How many party cards + Add Party asked for, per crusade. A party only
// needs saving once someone's in it (their party_slot), so an empty one
// just lives here until then.
const mercPartyTarget = new Map();

document.getElementById('addMercenaryPartyBtn').addEventListener('click', () => {
  const shown = document.querySelectorAll('#mercenaryPartyGrid [data-merc-drop-slot]').length;
  mercPartyTarget.set(sovereignState.crusadeId, shown + 1);
  renderMercenaryPage();
  const cards = document.querySelectorAll('#mercenaryPartyGrid [data-merc-drop-slot]');
  cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function renderMercenaryPage() {
  const c = sovereignState.crusade;
  document.getElementById('mercenaryPageDate').textContent = c?.eventDate ? formatLongDate(String(c.eventDate).slice(0, 10)) : '';
  const mercs = sovereignState.mercenaries || [];
  const memberOf = (name) => sovereignState.memberList.find((x) => crusadeNameKey(x.name) === crusadeNameKey(name));
  // 5 parties to start; after + Add Party / Remove Party, whatever count
  // was chosen -- never fewer than the highest party someone is in, or 1.
  const target = mercPartyTarget.has(sovereignState.crusadeId) ? mercPartyTarget.get(sovereignState.crusadeId) : MERCENARY_MIN_PARTIES;
  const partyCount = Math.max(1, target, ...mercs.map((m) => m.partySlot || 1));
  const grid = document.getElementById('mercenaryPartyGrid');
  grid.innerHTML = Array.from({ length: partyCount }, (_, i) => i + 1)
    .map((slot) => {
      const members = mercs
        .filter((m) => (m.partySlot || 1) === slot)
        .map((m) => ({ ...m, member: memberOf(m.name) }))
        .sort((x, y) => (y.member?.growthRate || 0) - (x.member?.growthRate || 0) || x.name.localeCompare(y.name));
      const rows = members
        .map(
          (m, i) => `
        <tr class="crusade-roster-row" draggable="true" data-drag-merc="${m.id}">
          <td>${i + 1}</td>
          <td style="font-weight:600;">${escapeHtml(m.name)}</td>
          <td>${escapeHtml(m.member?.className || '–')}</td>
          <td>${crusadeGuildBadge(m.member?.guildName || m.guildName)}</td>
          <td>${m.member?.growthRate ? Number(m.member.growthRate).toLocaleString() : '–'}</td>
          <td class="admin-only"><button type="button" class="icon-btn" data-remove-merc="${m.id}" title="Remove from Mercenaries">✕</button></td>
        </tr>`
        )
        .join('');
      return `
      <div class="crusade-party-card" data-merc-drop-slot="${slot}">
        <div class="crusade-party-card-header">
          <h3>Party ${slot} — ${members.length}/${CRUSADE_PARTY_MAX_MEMBERS}</h3>
          <div class="crusade-party-card-actions">
            <button type="button" class="icon-btn" data-copy-merc-party="${slot}" title="Copy Party ${slot} (IGN, class)">📋</button>
            <button type="button" class="icon-btn admin-only" data-remove-merc-party="${slot}" title="Remove Party ${slot}">🗑</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr><th>#</th><th>${t('sovereign.common.ign')}</th><th>Class</th><th>${t('sovereign.common.guild')}</th><th>Growth Rate</th><th class="admin-only"></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join('');

  grid.querySelectorAll('[data-copy-merc-party]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = Number(btn.getAttribute('data-copy-merc-party'));
      copyPartySet(mercs.filter((m) => (m.partySlot || 1) === slot).map((m) => m.name), `Mercenaries Party ${slot}`);
    });
  });
  grid.querySelectorAll('[data-remove-merc-party]').forEach((btn) => {
    btn.addEventListener('click', () => removeMercenaryParty(Number(btn.getAttribute('data-remove-merc-party')), partyCount));
  });

  grid.querySelectorAll('[data-remove-merc]').forEach((btn) => {
    btn.addEventListener('click', () => removeMercenary(btn.getAttribute('data-remove-merc')));
  });
  grid.querySelectorAll('[data-drag-merc]').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      mercDrag.mercId = row.getAttribute('data-drag-merc');
      mercDrag.memberName = null;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', mercDrag.mercId);
      row.classList.add('crusade-roster-row-dragging');
      document.getElementById('mercenaryMemberPanel').classList.add('crusade-member-panel-droppable');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('crusade-roster-row-dragging');
      mercDrag.mercId = null;
      document.getElementById('mercenaryMemberPanel').classList.remove('crusade-member-panel-droppable', 'crusade-member-panel-drop-active');
    });
  });
  grid.querySelectorAll('[data-merc-drop-slot]').forEach((card) => {
    card.addEventListener('dragover', (e) => {
      if (!mercDrag.mercId && !mercDrag.memberName) return;
      e.preventDefault();
      card.classList.add('crusade-party-dropzone-active');
    });
    card.addEventListener('dragleave', () => card.classList.remove('crusade-party-dropzone-active'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('crusade-party-dropzone-active');
      const slot = Number(card.getAttribute('data-merc-drop-slot'));
      if (mercDrag.memberName) await addMercenary(mercDrag.memberName, slot);
      else if (mercDrag.mercId) await moveMercenary(mercDrag.mercId, slot);
    });
  });
  renderMercenaryMemberPanel();
}

// Same chips as a team's Members panel: everyone not on a team of this
// crusade and not already a mercenary, highest Growth Rate first.
function renderMercenaryMemberPanel() {
  const query = crusadeNameKey(document.getElementById('mercenaryMemberPanelSearch').value);
  const classSelect = document.getElementById('mercenaryMemberPanelClass');
  const picked = classSelect.value;
  const classes = Array.from(new Set(sovereignState.memberList.map((m) => m.className).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  classSelect.innerHTML = '<option value="">All classes</option>' + classes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  classSelect.value = classes.includes(picked) ? picked : '';
  const pool = sovereignState.memberList.filter((m) => crusadeTeamOfName(m.name) === null && !crusadeIsMercenary(m.name));
  document.getElementById('mercenaryMemberPanelCount').textContent = `${pool.length} available`;
  const members = pool
    .filter((m) => !query || crusadeNameKey(m.name).includes(query))
    .filter((m) => !classSelect.value || m.className === classSelect.value)
    .sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1) || (b.growthRate || 0) - (a.growthRate || 0) || a.name.localeCompare(b.name));
  const list = document.getElementById('mercenaryMemberPanelList');
  list.innerHTML = members.length
    ? members
        .map((m) => {
          const color = m.guildName ? crusadeGuildColor(m.guildName) : null;
          return `
      <li class="crusade-member-chip admin-disable" draggable="true" data-merc-drag-member="${escapeHtml(m.name)}" title="Drag onto a party">
        <div class="crusade-member-chip-row">
          <span class="crusade-member-chip-dot" style="background:${color || 'var(--text-muted)'}"></span>
          <span class="crusade-member-chip-name">${escapeHtml(m.name)}</span>
          <span class="crusade-member-chip-gr">${m.growthRate ? Number(m.growthRate).toLocaleString() : ''}</span>
        </div>
        <div class="crusade-member-chip-row crusade-member-chip-meta">
          ${m.className ? `<span class="crusade-member-chip-class">${escapeHtml(m.className)}</span>` : ''}
          ${!m.active ? '<span class="crusade-member-chip-flag is-inactive">Inactive</span>' : m.defenseOnly ? '<span class="crusade-member-chip-flag is-defense">DEF only</span>' : ''}
          ${crusadeAbsenceTag(m.name)}
        </div>
      </li>`;
        })
        .join('')
    : `<li class="crusade-member-panel-empty">${query || classSelect.value ? 'No matching members' : 'Everyone is already on a team or a mercenary'}</li>`;
  list.querySelectorAll('[data-merc-drag-member]').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      mercDrag.memberName = chip.getAttribute('data-merc-drag-member');
      mercDrag.mercId = null;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', mercDrag.memberName);
      chip.classList.add('is-dragging');
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('is-dragging');
      mercDrag.memberName = null;
    });
  });
}

async function addMercenary(name, partySlot) {
  const member = sovereignState.memberList.find((m) => crusadeNameKey(m.name) === crusadeNameKey(name));
  try {
    const merc = await api(`/api/crusades/${sovereignState.crusadeId}/mercenaries`, {
      method: 'POST',
      body: JSON.stringify({ name: member?.name || name, guildName: member?.guildName || null, partySlot }),
    });
    sovereignState.mercenaries = [...(sovereignState.mercenaries || []), merc];
    renderMercenaryPage();
  } catch (err) {
    toast(err.message);
  }
}

async function moveMercenary(mercId, partySlot) {
  const merc = sovereignState.mercenaries.find((m) => m.id === mercId);
  if (!merc || (merc.partySlot || 1) === partySlot) return;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/mercenaries/${mercId}`, { method: 'PUT', body: JSON.stringify({ partySlot }) });
    sovereignState.mercenaries = sovereignState.mercenaries.map((m) => (m.id === mercId ? updated : m));
    renderMercenaryPage();
  } catch (err) {
    toast(err.message);
  }
}

// Removes a whole party: its mercenaries are taken off (after a confirm),
// and every later party moves up one so the numbering has no gap.
async function removeMercenaryParty(slot, partyCount) {
  const inParty = sovereignState.mercenaries.filter((m) => (m.partySlot || 1) === slot);
  if (inParty.length && !confirm(`Remove Party ${slot} and its ${inParty.length} mercenar${inParty.length === 1 ? 'y' : 'ies'} (${inParty.map((m) => m.name).join(', ')})?`)) return;
  try {
    for (const m of inParty) {
      await api(`/api/crusades/${sovereignState.crusadeId}/mercenaries/${m.id}`, { method: 'DELETE' });
    }
    let mercs = sovereignState.mercenaries.filter((m) => (m.partySlot || 1) !== slot);
    for (const m of mercs.filter((x) => (x.partySlot || 1) > slot).sort((a, b) => a.partySlot - b.partySlot)) {
      const updated = await api(`/api/crusades/${sovereignState.crusadeId}/mercenaries/${m.id}`, { method: 'PUT', body: JSON.stringify({ partySlot: m.partySlot - 1 }) });
      mercs = mercs.map((x) => (x.id === m.id ? updated : x));
    }
    sovereignState.mercenaries = mercs;
    mercPartyTarget.set(sovereignState.crusadeId, partyCount - 1);
    renderMercenaryPage();
    toast(`Party ${slot} removed`);
  } catch (err) {
    toast(err.message);
    await loadCrusadeDetail(sovereignState.crusadeId);
  }
}

async function removeMercenary(mercId) {
  const merc = sovereignState.mercenaries.find((m) => m.id === mercId);
  if (!merc) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/mercenaries/${mercId}`, { method: 'DELETE' });
    sovereignState.mercenaries = sovereignState.mercenaries.filter((m) => m.id !== mercId);
    renderMercenaryPage();
    toast(`${merc.name} removed from Mercenaries`);
  } catch (err) {
    toast(err.message);
  }
}

// Dropping a mercenary row back on the Members panel removes them.
(() => {
  const panel = document.getElementById('mercenaryMemberPanel');
  panel.addEventListener('dragover', (e) => {
    if (!mercDrag.mercId) return;
    e.preventDefault();
    panel.classList.add('crusade-member-panel-drop-active');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('crusade-member-panel-drop-active'));
  panel.addEventListener('drop', async (e) => {
    if (!mercDrag.mercId) return;
    e.preventDefault();
    panel.classList.remove('crusade-member-panel-drop-active');
    await removeMercenary(mercDrag.mercId);
  });
  document.getElementById('mercenaryMemberPanelSearch').addEventListener('input', renderMercenaryMemberPanel);
  document.getElementById('mercenaryMemberPanelClass').addEventListener('change', renderMercenaryMemberPanel);
})();

// Crusade-wide fees (crusade page): each takes its % off every winning team,
// so the amount shown is that % of the whole crusade's diamonds.
function renderCrusadeWideFees() {
  const fees = sovereignState.crusadeFees || [];
  document.getElementById('crusadeWideFeeEmptyState').classList.toggle('hidden', fees.length !== 0);
  const list = document.getElementById('crusadeWideFeeList');
  list.innerHTML = fees
    .map((fee) => {
      const amount = allKnownTeamNumbers().reduce((sum, n) => sum + crusadeFeeAmount(fee, getTeamData(n)), 0);
      return `
    <li style="display:flex; gap:8px; align-items:center;">
      <span style="flex:1; font-weight:600;">${escapeHtml(fee.name)}</span>
      ${crusadeGuildBadge(fee.guildName)}
      <span style="color:var(--text-muted);">${fee.percent}% of all teams → ${crusadeFormatDiamonds(amount)}</span>
      <button type="button" class="icon-btn admin-only" data-delete-wide-fee="${fee.id}" title="Remove fee">✕</button>
    </li>`;
    })
    .join('');
  list.querySelectorAll('[data-delete-wide-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fee = fees.find((f) => f.id === btn.getAttribute('data-delete-wide-fee'));
      if (!fee || !confirm(`Remove the ${fee.percent}% crusade-wide fee for "${fee.name}"?`)) return;
      try {
        await api(`/api/crusades/${sovereignState.crusadeId}/fees/${fee.id}`, { method: 'DELETE' });
        sovereignState.crusadeFees = sovereignState.crusadeFees.filter((f) => f.id !== fee.id);
        renderTeamList();
        renderCrusadeWideFees();
        toast('Fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeWideFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const fee = await api(`/api/crusades/${sovereignState.crusadeId}/fees`, {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        guildName: form.elements.guildName.value || null,
        percent: Number(form.elements.percent.value) || 0,
      }),
    });
    sovereignState.crusadeFees = [...(sovereignState.crusadeFees || []), fee];
    renderTeamList();
    renderCrusadeWideFees();
    form.reset();
    toast(`${fee.name}'s crusade-wide fee added`);
  } catch (err) {
    toast(err.message);
  }
});

document.querySelector('#addCrusadeWideFeeForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeWideFeeGuildSelect');
  if (guildSelect.value) return;
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (match && match.guildName) guildSelect.value = match.guildName;
});

// Copies the standing default fees onto THIS team -- for teams that already
// existed before a default was added (ensureCrusadeTeam only auto-seeds
// brand-new teams). Skips any default already on this team's fee list.
document.getElementById('applyCrusadeDefaultFeesBtn').addEventListener('click', async () => {
  const n = sovereignState.activeTeam;
  try {
    const added = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/apply-default-fees`, { method: 'POST' });
    if (!added.length) {
      toast('Nothing to apply — this team already has every standing default fee');
      return;
    }
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: added[0].teamId };
      sovereignState.teams.push(team);
    }
    team.fees.push(...added);
    renderTeamDetail(n); // new fees change this team's pool, so recompute (also re-renders this list)
    toast(`Applied ${added.length} default fee${added.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message);
  }
});

// Same as Apply Defaults, but for every team on this crusade at once --
// makes sure no team gets left out just because it existed before a
// default fee was added. Each team is applied independently (skipping IGNs
// it already has), so it's safe to run again even if some teams already
// have everything.
document.getElementById('applyCrusadeDefaultFeesAllTeamsBtn').addEventListener('click', async () => {
  const teamNumbers = visibleTeamNumbers();
  if (!confirm(`Apply the standing default fees to all ${teamNumbers.length} team${teamNumbers.length === 1 ? '' : 's'} on this crusade?`)) return;

  let totalAdded = 0;
  let teamsChanged = 0;
  try {
    for (const n of teamNumbers) {
      const added = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/apply-default-fees`, { method: 'POST' });
      if (!added.length) continue;
      let team = sovereignState.teams.find((t) => t.teamNumber === n);
      if (!team) {
        team = { ...defaultTeamData(n), id: added[0].teamId };
        sovereignState.teams.push(team);
      }
      team.fees.push(...added);
      totalAdded += added.length;
      teamsChanged += 1;
    }
    refreshAfterRosterChange(); // fees change each affected team's pool, so recompute whatever's currently visible
    toast(
      totalAdded
        ? `Applied ${totalAdded} default fee${totalAdded === 1 ? '' : 's'} across ${teamsChanged} team${teamsChanged === 1 ? '' : 's'}`
        : 'Nothing to apply — every team already has every standing default fee'
    );
  } catch (err) {
    toast(err.message);
  }
});

// extraByGuild optionally adds a flat amount to a guild's total without
// counting as a member — used to fold management fees into the guild that
// the fee's IGN belongs to, even though the fee isn't itself a participant.
function renderCrusadeGuildSummary(rows, containerId, formatFn, extraByGuild) {
  const format = formatFn || crusadeFormatDiamonds;
  const el = document.getElementById(containerId);
  const byGuild = new Map();
  rows.forEach(({ participant: p, total }) => {
    const key = p.guildName || 'Unassigned';
    if (!byGuild.has(key)) byGuild.set(key, { total: 0, count: 0 });
    const g = byGuild.get(key);
    g.total += total;
    g.count += 1;
  });

  let extraTotal = 0;
  if (extraByGuild) {
    extraByGuild.forEach((amount, guildName) => {
      if (!byGuild.has(guildName)) byGuild.set(guildName, { total: 0, count: 0 });
      byGuild.get(guildName).total += amount;
      extraTotal += amount;
    });
  }

  if (!byGuild.size) {
    el.innerHTML = '';
    return;
  }

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0) + extraTotal;
  const items = Array.from(byGuild.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, g]) => {
      const color = crusadeGuildColor(name) || 'var(--text-muted)';
      const label = name === 'Unassigned' ? t('sovereign.common.unassigned') : escapeHtml(name);
      return `<div class="crusade-guild-summary-row">
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1;">${label}</span>
        <span>${format(g.total)}</span>
        <span style="color:var(--text-muted);">${g.count} ${g.count === 1 ? t('sovereign.common.member') : t('sovereign.common.members')}</span>
      </div>`;
    })
    .join('');

  el.innerHTML = `${items}<div class="crusade-guild-summary-row crusade-guild-summary-total"><span style="flex:1;">${t('sovereign.common.total')}</span><span>${format(grandTotal)}</span><span></span></div>`;
}

// ---------- Member list (master roster, grouped by guild column) ----------

// ---------- Growth Rate submissions (populated by the Discord bot) ----------
// Read-only from this page's point of view -- the bot in the growth-rate
// Discord channel is what actually creates/updates/deletes these; admins can
// only remove a bad one here (e.g. wrong IGN typed in the Discord message).

async function loadGrowthSubmissions() {
  const [submissions, guilds, unmatchedAttendeeNames] = await Promise.all([
    api('/api/growth-submissions'),
    api('/api/crusade-guilds'),
    api('/api/growth-submissions/unmatched-attendee-names'),
  ]);
  sovereignState.growthSubmissions = submissions;
  sovereignState.guilds = guilds;
  sovereignState.unmatchedAttendeeNames = unmatchedAttendeeNames;
  populateGrowthFilterOptions(submissions);
  renderGrowthSubmissions();
  loadIgnChangeRequests().catch((err) => toast(err.message));
}

// "I changed my IGN" posts from /uniongr waiting for an admin -- see
// /api/ign-change-requests. Each card puts the old name's entry next to
// the new post so the admin can tell it's the same character.
async function loadIgnChangeRequests() {
  const requests = await api('/api/ign-change-requests');
  document.getElementById('growthIgnChangePanel').classList.toggle('hidden', requests.length === 0);
  const compare = (label, before, after) => {
    const changed = before !== null && before !== undefined && String(before) !== String(after);
    return `<span class="crusade-loot-chip">${label}: ${before === null || before === undefined ? '' : `${escapeHtml(String(before))} → `}<strong${changed ? ' style="color:var(--gold);"' : ''}>${escapeHtml(String(after))}</strong></span>`;
  };
  document.getElementById('growthIgnChangeList').innerHTML = requests
    .map((r) => {
      const o = r.old;
      const accountChip = !o
        ? `<span class="crusade-loot-chip">"${escapeHtml(r.oldIgn)}" has no Growth Rate entry (${r.oldAttendance} attendance) — compare screenshots by hand</span>`
        : o.sameDiscordAccount
          ? '<span class="crusade-loot-chip" style="color:var(--green, #2ecc71);">✓ Same Discord account posted the old IGN</span>'
          : `<span class="crusade-loot-chip" style="color:var(--red, #e74c3c);">⚠ Different Discord account (old: ${escapeHtml(o.discordUsername || 'unknown')})</span>`;
      const shot = (src, caption) =>
        `<figure style="margin:0;"><a href="${src}" target="_blank" rel="noopener"><img class="crusade-growth-thumb" src="${src}" alt="${escapeHtml(caption)}" loading="lazy"></a><figcaption style="font-size:12px; color:var(--text-muted);">${escapeHtml(caption)}</figcaption></figure>`;
      return `
      <div style="border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px;">
        <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(r.oldIgn)} → ${escapeHtml(r.ign)}
          <span style="font-weight:400; color:var(--text-muted); font-size:12px;"> · by ${escapeHtml(r.discordUsername || 'unknown')} · ${escapeHtml(formatLongDate(String(r.createdAt).slice(0, 10)))}</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
          ${accountChip}
          ${compare('Growth Rate', o ? o.growthRate?.toLocaleString() : null, r.growthRate.toLocaleString())}
          ${compare('Class', o ? o.class : null, r.class)}
          ${compare('Guild', o ? o.guildName : null, r.guildName)}
          ${compare('Lamp', o ? `+${o.lampLevel}` : null, `+${r.lampLevel}`)}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-bottom:10px;">
          ${o && o.hasImage ? shot(`/api/growth-submissions/${o.id}/image`, `Old: ${r.oldIgn}`) : ''}
          ${shot(`/api/ign-change-requests/${r.id}/image`, `New: ${r.ign}`)}
        </div>
        <button type="button" class="btn small primary" data-ign-change-approve="${r.id}">Approve</button>
        <button type="button" class="btn small" data-ign-change-reject="${r.id}">Reject</button>
      </div>`;
    })
    .join('');
}

document.getElementById('growthIgnChangeList').addEventListener('click', async (e) => {
  const approveId = e.target.closest('[data-ign-change-approve]')?.getAttribute('data-ign-change-approve');
  const rejectId = e.target.closest('[data-ign-change-reject]')?.getAttribute('data-ign-change-reject');
  if (!approveId && !rejectId) return;
  try {
    if (approveId) {
      if (!confirm('Approve this IGN change? Every record under the old IGN (attendance, crusades, points, fees, history) is renamed to the new one.')) return;
      const result = await api(`/api/ign-change-requests/${approveId}/approve`, { method: 'POST' });
      toast(`Renamed "${result.oldIgn}" to "${result.ign}"`);
    } else {
      if (!confirm('Reject this IGN change? Nothing is renamed.')) return;
      await api(`/api/ign-change-requests/${rejectId}/reject`, { method: 'POST' });
      toast('IGN change rejected');
    }
    await loadGrowthSubmissions();
  } catch (err) {
    toast(err.message);
  }
});

// Options are derived from whatever's actually in the data (not a hardcoded
// list), so a class/guild that's since been renamed or retired doesn't leave
// a dead filter option, and a brand new one shows up automatically. Keeps
// whichever value was already selected if it's still valid.
function populateGrowthFilterOptions(submissions) {
  const guildSelect = document.getElementById('growthGuildFilter');
  const classSelect = document.getElementById('growthClassFilter');
  const currentGuild = guildSelect.value;
  const currentClass = classSelect.value;

  const guildNames = Array.from(new Set(submissions.map((s) => s.guildName).filter(Boolean))).sort();
  const classNames = Array.from(new Set(submissions.map((s) => s.class).filter(Boolean))).sort();

  guildSelect.innerHTML = `<option value="">${t('sovereign.growth.allGuilds')}</option>` + guildNames.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  classSelect.innerHTML = `<option value="">${t('sovereign.growth.allClasses')}</option>` + classNames.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  guildSelect.value = guildNames.includes(currentGuild) ? currentGuild : '';
  classSelect.value = classNames.includes(currentClass) ? currentClass : '';
}

// A player's Growth Rate over time: every post/change on file (bot posts,
// manual adds, edits), newest first, with the change from the one before.
// Spelling variants of the same name ("uncleken" / "unclekenツ") are shown
// together, same name folding as the salary tables. Loaded on first open,
// then reused until the page reloads.
let growthHistoryCache = null;
async function openGrowthHistoryModal(submission) {
  const modal = document.getElementById('growthHistoryModal');
  document.getElementById('growthHistoryModalTitle').textContent = `${submission.ign} — ${t('sovereign.growth.historyHeading')}`;
  const body = document.getElementById('growthHistoryBody');
  const empty = document.getElementById('growthHistoryEmptyState');
  body.innerHTML = '';
  empty.classList.add('hidden');
  modal.classList.remove('hidden');
  try {
    if (!growthHistoryCache) growthHistoryCache = await api('/api/growth-history');
  } catch (err) {
    toast(err.message);
    return;
  }
  const key = memberNameKey(submission.ign);
  const entries = growthHistoryCache.filter((h) => memberNameKey(h.ign) === key);
  // keep only entries where something worth showing changed (an edit that
  // only fixed the class still counts, and so does a post with its own
  // screenshot) -- drops exact repeats in a row
  const shown = entries.filter((h, i) => {
    const prev = entries[i - 1];
    return !prev || h.hasImage || prev.growthRate !== h.growthRate || prev.lampLevel !== h.lampLevel || prev.class !== h.class || prev.guildName !== h.guildName || prev.ign !== h.ign;
  });
  empty.classList.toggle('hidden', shown.length !== 0);
  body.innerHTML = shown
    .map((h, i) => {
      const prev = shown[i - 1];
      const diff = prev && h.growthRate !== null && prev.growthRate !== null ? h.growthRate - prev.growthRate : null;
      const diffText = diff === null ? '' : diff === 0 ? '±0' : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString()}`;
      return { h, diff, diffText };
    })
    .reverse()
    .map(
      ({ h, diff, diffText }) => `
      <tr>
        <td class="crusade-growth-updated">${formatGrowthTimestamp(h.recordedAt)}</td>
        <td style="font-weight:600;">${h.growthRate !== null ? h.growthRate.toLocaleString() : '–'}</td>
        <td class="${diff > 0 ? 'crusade-growth-up' : diff < 0 ? 'crusade-growth-down' : ''}">${diffText}</td>
        <td>${h.lampLevel !== null && h.lampLevel !== undefined ? `+${h.lampLevel}` : '–'}</td>
        <td>${escapeHtml(h.class || '–')}</td>
        <td>${crusadeGuildBadge(h.guildName)}</td>
        <td>${h.ign !== submission.ign ? escapeHtml(h.ign) + ' · ' : ''}${escapeHtml(h.recordedBy || '–')}</td>
        <td>${
          h.hasImage
            ? `<a href="/api/growth-history/${h.id}/image" target="_blank" rel="noopener" title="Open full size"><img class="crusade-growth-thumb" src="/api/growth-history/${h.id}/image" alt="${escapeHtml(h.ign)} screenshot" loading="lazy"></a>`
            : `<span style="color:var(--text-muted); font-size:12px;">${t('sovereign.growth.noScreenshot')}</span>`
        }</td>
      </tr>`
    )
    .join('');
}

// Growth Rate record timestamps (created_at = first posted; updated_at =
// last changed, stamped by bot resubmission, manual add and edit), in the
// viewer's own local time.
function formatGrowthTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Member status: Active (default), DEF only, or Inactive. Admins get a
// dropdown to change it; viewers just see a tag when it isn't Active.
function growthStatusChip(s) {
  const status = s.active === false ? 'inactive' : s.defenseOnly ? 'defense' : 'active';
  const tag = status === 'inactive' ? '<span class="crusade-status-chip is-inactive">Inactive</span>' : status === 'defense' ? '<span class="crusade-status-chip is-defense">DEF only</span>' : '';
  const select = `<select class="crusade-status-select is-${status} admin-only" data-member-status="${s.id}" title="Member status">
      <option value="active"${status === 'active' ? ' selected' : ''}>Active</option>
      <option value="defense"${status === 'defense' ? ' selected' : ''}>DEF only</option>
      <option value="inactive"${status === 'inactive' ? ' selected' : ''}>Inactive</option>
    </select>`;
  return `<span class="viewer-only-status">${tag}</span>${select}`;
}

function renderGrowthSubmissions() {
  const all = sovereignState.growthSubmissions || [];
  const search = document.getElementById('growthSearchInput').value.trim().toLowerCase();
  const guildFilter = document.getElementById('growthGuildFilter').value;
  const classFilter = document.getElementById('growthClassFilter').value;

  const submissions = all.filter((s) => {
    if (search && !s.ign.toLowerCase().includes(search)) return false;
    if (guildFilter && s.guildName !== guildFilter) return false;
    if (classFilter && s.class !== classFilter) return false;
    return true;
  });

  document.getElementById('sovereignGrowthEmptyState').classList.toggle('hidden', all.length !== 0);
  document.getElementById('sovereignGrowthNoMatchState').classList.toggle('hidden', all.length === 0 || submissions.length !== 0);

  const body = document.getElementById('sovereignGrowthBody');
  body.innerHTML = submissions
    .map(
      (s, i) => `
    <tr class="crusade-growth-row" data-growth-id="${s.id}" title="Click to see ${escapeHtml(s.ign)}'s Growth Rate history">
      <td>${i + 1}</td>
      <td style="font-weight:600;">${escapeHtml(s.ign)} ${growthStatusChip(s)} <button type="button" class="icon-btn crusade-growth-history-btn" data-growth-history="${s.id}" title="Growth Rate history">📈</button></td>
      <td style="font-weight:600;">${s.growthRate !== null && s.growthRate !== undefined ? s.growthRate.toLocaleString() : '–'}</td>
      <td>${escapeHtml(s.class)}</td>
      <td>${crusadeGuildBadge(s.guildName)}</td>
      <td>+${s.lampLevel ?? '?'}</td>
      <td>${
        s.imageContentType
          ? `<img class="crusade-growth-thumb" src="/api/growth-submissions/${s.id}/image?v=${encodeURIComponent(s.updatedAt || s.createdAt || '')}" alt="${escapeHtml(s.ign)}'s growth rate screenshot" loading="lazy" data-view-growth-image="${s.id}">`
          : `<span style="color:var(--text-muted); font-size:12px;">${t('sovereign.growth.noScreenshot')}</span>`
      }</td>
      <td>${s.discordUsername ? `@${escapeHtml(s.discordUsername)}` : '–'}</td>
      <td class="crusade-growth-updated">${formatGrowthTimestamp(s.createdAt) || '–'}</td>
      <td class="crusade-growth-updated">${formatGrowthTimestamp(s.updatedAt || s.createdAt) || '–'}</td>
      <td class="admin-only crusade-roster-actions-cell">
        <button type="button" class="icon-btn" data-edit-growth="${s.id}" title="Edit">✎</button>
        <button type="button" class="icon-btn" data-delete-growth="${s.id}" title="Remove submission">✕</button>
      </td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('[data-view-growth-image]').forEach((img) => {
    img.addEventListener('click', () => {
      const id = img.getAttribute('data-view-growth-image');
      const s = submissions.find((x) => x.id === id);
      document.getElementById('growthImageModalTitle').textContent = s
        ? `${s.ign} — Growth Rate ${s.growthRate?.toLocaleString() ?? '?'} — ${s.class} — Volcano Lamp +${s.lampLevel ?? '?'} (${s.guildName || 'Unassigned'})`
        : '';
      document.getElementById('growthImageModalImg').src = `/api/growth-submissions/${id}/image?v=${encodeURIComponent(s?.updatedAt || s?.createdAt || '')}`;
      document.getElementById('growthImageModal').classList.remove('hidden');
    });
  });

  // Clicking anywhere on a row opens that player's history -- except the
  // screenshot thumbnail and the edit/delete buttons, which keep their own
  // actions. (The 📈 button is just the visible hint for this.)
  body.querySelectorAll('tr[data-growth-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-view-growth-image], [data-edit-growth], [data-delete-growth], [data-member-status], a, input, select')) return;
      const s = submissions.find((x) => x.id === tr.getAttribute('data-growth-id'));
      if (s) openGrowthHistoryModal(s);
    });
  });

  body.querySelectorAll('[data-member-status]').forEach((select) => {
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', async () => {
      const sub = submissions.find((x) => x.id === select.getAttribute('data-member-status'));
      if (!sub) return;
      try {
        const updated = await api(`/api/growth-submissions/${sub.id}/status`, { method: 'PUT', body: JSON.stringify({ status: select.value }) });
        const idx = sovereignState.growthSubmissions.findIndex((x) => x.id === sub.id);
        if (idx !== -1) sovereignState.growthSubmissions[idx] = { ...sovereignState.growthSubmissions[idx], active: updated.active, defenseOnly: updated.defenseOnly };
        renderGrowthSubmissions();
        toast(`${sub.ign}: ${select.options[select.selectedIndex].text}`);
      } catch (err) {
        toast(err.message);
        renderGrowthSubmissions();
      }
    });
  });

  body.querySelectorAll('[data-edit-growth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-edit-growth');
      const s = submissions.find((x) => x.id === id);
      if (s) openGrowthEditModal(s);
    });
  });

  body.querySelectorAll('[data-delete-growth]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-growth');
      const s = submissions.find((x) => x.id === id);
      if (!confirm(`Remove the growth-rate submission for "${s?.ign}"? They're also taken out of the salary, including saved payouts -- their share goes to the management fee recipients.`)) return;
      try {
        await api(`/api/growth-submissions/${id}`, { method: 'DELETE' });
        sovereignState.growthSubmissions = sovereignState.growthSubmissions.filter((x) => x.id !== id);
        populateGrowthFilterOptions(sovereignState.growthSubmissions);
        renderGrowthSubmissions();
        toast('Submission removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// Look-alike letters used in stylised IGNs ("・Sкy・" with a Cyrillic к),
// mapped to the Latin letter they read as -- kept in sync with lib/app.js.
const NAME_LOOKALIKES = {"а":"a","в":"b","с":"c","ԁ":"d","е":"e","ё":"e","һ":"h","н":"h","і":"i","ї":"i","ј":"j","к":"k","ӏ":"l","м":"m","п":"n","о":"o","р":"p","ԛ":"q","г":"r","я":"r","ѕ":"s","т":"t","у":"y","ў":"y","х":"x","ь":"b","ч":"4","з":"3","л":"n","и":"n","ц":"u","ш":"w","щ":"w","д":"a","ф":"o","ж":"x","α":"a","β":"b","γ":"y","δ":"d","ε":"e","η":"n","ι":"i","κ":"k","μ":"u","ν":"v","ο":"o","ρ":"p","σ":"o","τ":"t","υ":"u","χ":"x","ω":"w","ʀ":"r","ɪ":"i","ʏ":"y","ᴀ":"a","ʙ":"b","ᴄ":"c","ᴅ":"d","ᴇ":"e","ɢ":"g","ʜ":"h","ᴊ":"j","ᴋ":"k","ʟ":"l","ᴍ":"m","ɴ":"n","ᴏ":"o","ᴘ":"p","ꜱ":"s","ᴛ":"t","ᴜ":"u","ᴠ":"v","ᴡ":"w","ᴢ":"z"};

// Ignores spacing, punctuation/symbols, case, accents, full-width forms and
// look-alike letters -- catches "•elijah•" vs "• ELIJAH •", "unclekenツ" vs
// "uncleken", or "・Sкy・" vs "• SKY •" as the same person, without needing
// an exact string match.
function normalizeNameForDupeCheck(name) {
  const s = String(name || '').normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of s) out += NAME_LOOKALIKES[ch] || ch;
  return out.normalize('NFD').replace(/[^a-z0-9]/g, '');
}

// Folds spelling variants of one person into one key for the attendance
// summary and Salary tables. normalizeNameForDupeCheck keeps only a-z/0-9,
// so a name written entirely in Chinese/Thai/etc. (冥冥之中) normalizes to
// "" -- falling back to the whole name (case/spacing-insensitive) keeps
// those people in instead of silently dropping them.
function memberNameKey(name) {
  const loose = normalizeNameForDupeCheck(name);
  if (loose) return loose;
  const raw = String(name || '').toLowerCase().replace(/\s+/g, '');
  return raw ? `raw:${raw}` : '';
}

// Groups submissions that normalize to the same key but weren't typed
// identically -- each returned group is 2+ submissions worth reviewing as
// possible duplicates of one real person. Also folds in attendance-only
// names (typed into World Boss attendance but never submitted as a Growth
// Rate entry themselves, e.g. "uncleken" attended but only "unclekenツ" was
// ever submitted) so those get caught and renamed too, even though there's
// no second submission id to merge -- a group needs at least one real
// submission to merge everything else into.
function findGrowthDuplicateGroups() {
  const byKey = new Map();
  (sovereignState.growthSubmissions || []).forEach((s) => {
    const key = normalizeNameForDupeCheck(s.ign);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id: s.id, ign: s.ign, growthRate: s.growthRate ?? null });
  });
  (sovereignState.unmatchedAttendeeNames || []).forEach((name) => {
    const key = normalizeNameForDupeCheck(name);
    if (!key || !byKey.has(key)) return;
    byKey.get(key).push({ id: null, ign: name, growthRate: null });
  });
  return Array.from(byKey.values()).filter((group) => {
    if (new Set(group.map((s) => s.ign)).size < 2) return false;
    return group.some((s) => s.id !== null);
  });
}

function renderGrowthDuplicateGroups() {
  const groups = findGrowthDuplicateGroups();
  document.getElementById('growthMergeEmptyState').classList.toggle('hidden', groups.length !== 0);
  const container = document.getElementById('growthMergeGroups');
  container.innerHTML = groups
    .map((group, gi) => {
      const sorted = [...group].sort((a, b) => (b.growthRate || 0) - (a.growthRate || 0));
      const keep = sorted[0];
      return `
      <div style="border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px;">
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
          ${sorted
            .map((s) => {
              const label = s.id === null ? 'attendance only, no GR submitted' : (s.growthRate?.toLocaleString() ?? '0');
              return `<span class="crusade-loot-chip">${escapeHtml(s.ign)} — ${label}${s.id === keep.id ? ' ★' : ''}</span>`;
            })
            .join('')}
        </div>
        <button type="button" class="btn small" data-merge-group="${gi}">Merge into "${escapeHtml(keep.ign)}" (highest GR)</button>
      </div>`;
    })
    .join('');
  container.querySelectorAll('[data-merge-group]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const group = groups[Number(btn.getAttribute('data-merge-group'))];
      const sorted = [...group].sort((a, b) => (b.growthRate || 0) - (a.growthRate || 0));
      const keep = sorted[0];
      const rest = sorted.slice(1);
      const mergeIds = rest.filter((s) => s.id !== null).map((s) => s.id);
      const extraNames = rest.filter((s) => s.id === null).map((s) => s.ign);
      if (!confirm(`Merge ${rest.length} entr${rest.length === 1 ? 'y' : 'ies'} into "${keep.ign}"? This also renames their attendance history to match.`)) return;
      try {
        const result = await api('/api/growth-submissions/merge', { method: 'POST', body: JSON.stringify({ keepId: keep.id, mergeIds, extraNames }) });
        sovereignState.growthSubmissions = sovereignState.growthSubmissions.filter((s) => !mergeIds.includes(s.id));
        sovereignState.unmatchedAttendeeNames = (sovereignState.unmatchedAttendeeNames || []).filter((n) => !extraNames.includes(n));
        populateGrowthFilterOptions(sovereignState.growthSubmissions);
        renderGrowthSubmissions();
        renderGrowthDuplicateGroups();
        toast(`Merged into "${result.keepIgn}" (updated ${Object.values(result.synced || {}).reduce((a, b) => a + b, 0)} record(s) across crusades, attendance, points and history)`);
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('growthFindDuplicatesBtn').addEventListener('click', () => {
  renderGrowthDuplicateGroups();
  document.getElementById('growthMergeModal').classList.remove('hidden');
});

document.getElementById('growthSearchInput').addEventListener('input', renderGrowthSubmissions);
document.getElementById('growthGuildFilter').addEventListener('change', renderGrowthSubmissions);
document.getElementById('growthClassFilter').addEventListener('change', renderGrowthSubmissions);

// Kept in sync with discord-bot/register-commands.js's /uniongr choices and
// the Sovereign app's own server-side check on the growth-submissions routes.
const GROWTH_GUILD_CHOICES = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL', 'BUBBLEGANG'];
const GROWTH_CLASS_CHOICES = [
  'Ultimate Martialist',
  'Soul Reaper',
  'Storm Hawkeye',
  'Divine Priest',
  'Mighty Demolisher',
  'Mystic Luminary',
  'Crusader',
  'Bloody Enforcer',
  'Fatal Lord',
  'Eternal Commander',
  'Prime Savior',
  'Grand Wizard',
];

function openGrowthEditModal(submission) {
  const form = document.getElementById('growthEditForm');
  form.reset();
  form.elements.submissionId.value = submission.id;
  form.elements.ign.value = submission.ign;
  form.elements.lampLevel.value = submission.lampLevel ?? 1;
  form.elements.growthRate.value = submission.growthRate ?? 0;

  const classSelect = document.getElementById('growthEditClassSelect');
  classSelect.innerHTML = GROWTH_CLASS_CHOICES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  classSelect.value = submission.class;

  const guildSelect = document.getElementById('growthEditGuildSelect');
  guildSelect.innerHTML = GROWTH_GUILD_CHOICES.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  guildSelect.value = submission.guildName;

  const imageUrl = `/api/growth-submissions/${submission.id}/image?v=${encodeURIComponent(submission.updatedAt || submission.createdAt || '')}`;
  const screenshot = document.getElementById('growthEditScreenshot');
  screenshot.classList.toggle('hidden', !submission.imageContentType);
  screenshot.src = imageUrl;
  screenshot.alt = `${submission.ign}'s growth rate screenshot`;
  screenshot.onclick = () => {
    document.getElementById('growthImageModalTitle').textContent =
      `${submission.ign} — Growth Rate ${submission.growthRate?.toLocaleString() ?? '?'} — ${submission.class} — Volcano Lamp +${submission.lampLevel ?? '?'} (${submission.guildName || 'Unassigned'})`;
    document.getElementById('growthImageModalImg').src = imageUrl;
    document.getElementById('growthImageModal').classList.remove('hidden');
  };

  document.getElementById('growthEditModal').classList.remove('hidden');
}

document.getElementById('growthEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.submissionId.value;
  try {
    const updated = await api(`/api/growth-submissions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ign: form.elements.ign.value,
        class: form.elements.class.value,
        guildName: form.elements.guildName.value,
        lampLevel: Number(form.elements.lampLevel.value),
        growthRate: Number(form.elements.growthRate.value),
      }),
    });
    growthHistoryCache = null;
    const idx = sovereignState.growthSubmissions.findIndex((s) => s.id === id);
    if (idx !== -1) sovereignState.growthSubmissions[idx] = updated;
    populateGrowthFilterOptions(sovereignState.growthSubmissions);
    renderGrowthSubmissions();
    document.getElementById('growthEditModal').classList.add('hidden');
    const syncedTotal = Object.values(updated.synced || {}).reduce((a, b) => a + b, 0);
    toast(syncedTotal ? `Submission updated — also updated ${syncedTotal} record${syncedTotal === 1 ? '' : 's'} (crusades, attendance, points, history…)` : 'Submission updated');
  } catch (err) {
    toast(err.message);
  }
});

// Reads a <input type="file">'s selected file as base64 (stripping the
// "data:image/png;base64," prefix) -- same imageBase64/imageContentType
// shape the bot's own submission payload uses, so the server-side handling
// is identical either way.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });
}

// Same reasoning as the Discord bot's own screenshot compression: a raw
// full-size PNG screenshot can blow past both Express's body-size limit and
// Vercel's own request-size cap once base64-inflated. Only resizes/re-encodes
// when the file is actually large -- most screenshots come back untouched.
const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024;
function compressImageFileIfNeeded(file) {
  if (file.size <= MAX_UPLOAD_IMAGE_BYTES) return Promise.resolve(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file),
        'image/jpeg',
        0.8
      );
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve(file); // fall back to the original rather than blocking the submission
    img.src = URL.createObjectURL(file);
  });
}

// Holds whatever image is currently staged for the Add Record form -- either
// the <input type="file">'s own selection, or a screenshot pasted straight
// from the clipboard (a file input's FileList can't be set programmatically
// from JS for security reasons, so a pasted image needs its own variable
// rather than trying to shove it into form.elements.screenshot).
let growthAddPastedImage = null;

function setGrowthAddPreview(file) {
  const pasteZone = document.getElementById('growthAddPasteZone');
  const preview = document.getElementById('growthAddPreview');
  if (!file) {
    preview.classList.add('hidden');
    preview.src = '';
    pasteZone.classList.remove('has-image');
    pasteZone.textContent = t('sovereign.growth.pasteZone');
    return;
  }
  preview.src = URL.createObjectURL(file);
  preview.classList.remove('hidden');
  pasteZone.classList.add('has-image');
  pasteZone.textContent = t('sovereign.growth.pasteZoneReplace');
}

function openGrowthAddModal() {
  const form = document.getElementById('growthAddForm');
  form.reset();
  growthAddPastedImage = null;
  setGrowthAddPreview(null);
  document.getElementById('growthAddExistingHint').classList.add('hidden');

  const leaveAsIs = `<option value="" data-i18n="sovereign.growth.keepExisting">${t('sovereign.growth.keepExisting')}</option>`;
  const classSelect = document.getElementById('growthAddClassSelect');
  classSelect.innerHTML = leaveAsIs + GROWTH_CLASS_CHOICES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  const guildSelect = document.getElementById('growthAddGuildSelect');
  guildSelect.innerHTML = leaveAsIs + GROWTH_GUILD_CHOICES.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

  document.getElementById('growthAddModal').classList.remove('hidden');
}

document.getElementById('growthAddBtn').addEventListener('click', openGrowthAddModal);

// Only IGN is required -- typing one that already has a submission (posted
// via /uniongr or a previous manual add) shows what's already on file and
// switches every other field to optional ("leave as-is" keeps that value),
// so nudging one field (e.g. a new lamp level) never risks duplicating the
// person's record or accidentally blanking out data they already have.
document.querySelector('#growthAddForm [name="ign"]').addEventListener('input', (e) => {
  const needle = e.target.value.trim().toLowerCase();
  const hint = document.getElementById('growthAddExistingHint');
  if (!needle) {
    hint.classList.add('hidden');
    return;
  }
  const match = (sovereignState.growthSubmissions || []).find((s) => s.ign.trim().toLowerCase() === needle);
  if (!match) {
    hint.classList.add('hidden');
    return;
  }
  hint.textContent = t('sovereign.growth.existingFound').replace('{ign}', match.ign);
  hint.classList.remove('hidden');
  document.getElementById('growthAddClassSelect').value = match.class;
  document.getElementById('growthAddGuildSelect').value = match.guildName;
  document.querySelector('#growthAddForm [name="lampLevel"]').placeholder = `${t('sovereign.growth.currentValue')}: ${match.lampLevel}`;
  document.querySelector('#growthAddForm [name="growthRate"]').placeholder = `${t('sovereign.growth.currentValue')}: ${match.growthRate.toLocaleString()}`;
});

// Choosing a file clears any pasted image (whichever the admin does last
// wins) and updates the preview.
document.querySelector('#growthAddForm [name="screenshot"]').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) growthAddPastedImage = null;
  setGrowthAddPreview(file || growthAddPastedImage);
});

document.getElementById('growthAddPasteZone').addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
  if (!item) {
    toast('No image found on the clipboard');
    return;
  }
  const file = item.getAsFile();
  growthAddPastedImage = file;
  document.querySelector('#growthAddForm [name="screenshot"]').value = '';
  setGrowthAddPreview(file);
});

document.getElementById('growthAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const ignValue = form.elements.ign.value.trim();
  const file = form.elements.screenshot.files[0] || growthAddPastedImage;
  try {
    const payload = {
      ign: ignValue,
      class: form.elements.class.value,
      guildName: form.elements.guildName.value,
      lampLevel: form.elements.lampLevel.value === '' ? '' : Number(form.elements.lampLevel.value),
      growthRate: form.elements.growthRate.value === '' ? '' : Number(form.elements.growthRate.value),
    };
    if (file) {
      const uploadFile = await compressImageFileIfNeeded(file);
      payload.imageBase64 = await readFileAsBase64(uploadFile);
      payload.imageContentType = uploadFile.type;
    }
    const created = await api('/api/growth-submissions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    growthHistoryCache = null;
    const idx = sovereignState.growthSubmissions.findIndex((s) => s.id === created.id);
    if (idx !== -1) sovereignState.growthSubmissions[idx] = created;
    else sovereignState.growthSubmissions.push(created);
    populateGrowthFilterOptions(sovereignState.growthSubmissions);
    renderGrowthSubmissions();
    growthAddPastedImage = null;
    document.getElementById('growthAddModal').classList.add('hidden');
    toast('Growth Rate record added');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- World Boss Attendance (standalone, independent of any crusade) ----------
// Kept in sync with the WORLD_BOSS_NAMES list in lib/app.js.
const WORLD_BOSS_NAMES = [
  'Ruined Knight',
  'Kafka',
  'Stormid of Onrush',
  'Hakir',
  'Awakened Panderre',
  'Damiross',
  'Tandallon',
  'Melville',
  'Ducas / Dergio',
];

// A "schedule" is an independent tracker (own calendar/log/loot) sharing
// this same module's code via a `schedule` tag on every row instead of a
// separate copy of it -- see WORLD_BOSS_SCHEDULES in lib/app.js. Kept in
// sync with that map.
const WORLD_BOSS_SCHEDULES = {
  world_boss: { label: 'World Boss', bossNames: WORLD_BOSS_NAMES },
  bf4: { label: 'BF4 Boss', bossNames: ['BF4 Boss'] },
  balthazard: { label: 'Balthazard', bossNames: ['Balthazard'] },
};
let worldBossActiveSchedule = 'world_boss';

// Every worldBossEvents entry belongs to a schedule; every view (calendar,
// day detail, monthly loot, summary, item-name suggestions) reads through
// this so switching schedules never mixes their data.
function getScheduleEvents() {
  return (sovereignState.worldBossEvents || []).filter((ev) => (ev.schedule || 'world_boss') === worldBossActiveSchedule);
}

let worldBossEditingId = null;

async function loadWorldBossAttendance() {
  const [events, growthSubmissions, guilds, lootItemSources, saleBatches] = await Promise.all([
    api('/api/world-boss-attendance'),
    api('/api/growth-submissions'),
    api('/api/crusade-guilds'),
    api('/api/loot-item-sources'),
    api('/api/loot-sale-batches'),
  ]);
  sovereignState.worldBossEvents = events;
  sovereignState.growthSubmissions = growthSubmissions;
  sovereignState.guilds = guilds;
  // Keyed by `${schedule}:${itemKey}` so the same item name under two
  // different schedules (e.g. 'world_boss' and 'bf4') can't collide.
  sovereignState.lootItemSources = new Map(lootItemSources.map((s) => [`${s.schedule || 'world_boss'}:${s.itemKey}`, s.bossName]));
  sovereignState.lootSaleBatches = saleBatches; // flat list; grouped by itemKey+schedule at render time
  // Points/Salary are a World Boss concept only.
  document.getElementById('worldBossRelatedLinks').classList.toggle('hidden', worldBossActiveSchedule === 'bf4');
  updateWorldBossBonusPointsVisibility();
  populateWorldBossNameSelect();
  renderWorldBossMemberGrid(new Set());
  renderWorldBossLog(); // also renders the (now month-scoped) attendance summary
  // Reconcile can silently correct a kill's Sold status/price in state (see
  // reconcileFifoSales) -- without a second render afterward, the page just
  // shown above would keep displaying whatever was true before that fix ran.
  await reconcileFifoSales();
  renderWorldBossLog();
}

// Opportunistic self-heal: FIFO-matching only ever ran right after a sale
// was added/removed, so any data computed by an older, buggier version of
// applyFifoSalesToItem (or left behind by new kills logged after the last
// sale for that item) would just sit wrong until someone happened to
// touch that item's sales again. Runs once per page load for every item
// that has any sale batch at all; each is a no-op unless something's
// actually out of sync (see the "changed" check inside
// applyFifoSalesToItem), so a converged item costs nothing beyond the
// initial FIFO-queue recomputation. Re-renders once at the end rather
// than after every item, since several could change.
//
// Also covers every item dropped in the month being viewed, even with no
// sale at all yet -- so a price on one of that month's kills that no sale
// backs (the log form used to auto-fill the last known price) is cleared
// rather than counted as money the month earned.
async function reconcileFifoSales() {
  const soldItemKeys = new Set((sovereignState.lootSaleBatches || []).filter((b) => (b.schedule || 'world_boss') === worldBossActiveSchedule).map((b) => b.itemKey));
  const itemKeys = new Set(soldItemKeys);
  const viewedMonth = worldBossViewedMonthKey();
  getScheduleEvents().forEach((ev) => {
    if (String(ev.eventDate).slice(0, 7) !== viewedMonth) return;
    (ev.lootItems || []).forEach((item) => itemKeys.add(canonicalizeItemName(item.itemName).toLowerCase()));
  });
  if (!itemKeys.size) return;
  for (const itemKey of itemKeys) {
    // an item with no sales at all only gets its viewed-month kills touched
    await applyFifoSalesToItem(itemKey, soldItemKeys.has(itemKey) ? null : viewedMonth);
  }
  renderWorldBossLog();
}

// Collapsed by default -- it's a reference table admins check
// occasionally, not something that needs to be visible on every visit.
document.getElementById('worldBossSummaryToggle').addEventListener('click', () => {
  const wrapper = document.getElementById('worldBossSummaryBody-wrapper');
  const isHidden = wrapper.classList.toggle('hidden');
  document.getElementById('worldBossSummaryChevron').textContent = isHidden ? '▸' : '▾';
});

// Re-resolves guild names for any attendee row saved before
// resolveAttendeeGuilds (server-side) pointed at Growth Rate submissions
// -- the attendance list already shows each IGN's live Growth Rate guild,
// but this still fills the stored fallback for names that match one now.
document.getElementById('worldBossBackfillGuildsBtn').addEventListener('click', async () => {
  try {
    const { updated } = await api('/api/world-boss-attendance/backfill-guilds', { method: 'POST' });
    toast(updated ? `Filled in ${updated} missing guild${updated === 1 ? '' : 's'}` : 'No missing guilds found');
    if (updated) await loadWorldBossAttendance();
  } catch (err) {
    toast(err.message);
  }
});

// BF4 Boss is a higher-gear event: only members with a +13 (or higher)
// Volcano Lamp can attend, unlike World Boss which is open to everyone
// who's posted a Growth Rate submission.
const BF4_BOSS_MIN_LAMP_LEVEL = 13;

function getWorldBossCandidates() {
  const members = deriveMembersFromGrowthSubmissions(sovereignState.growthSubmissions);
  if (worldBossActiveSchedule === 'bf4') return members.filter((m) => Number(m.lampLevel) >= BF4_BOSS_MIN_LAMP_LEVEL);
  return members;
}

// Manual exceptions to the +13 lamp filter, added via the "+ Add member
// without +13 lamp" button below -- reset whenever the form is reset or a
// different event is loaded for editing, since it only applies to the
// event currently being logged/edited.
let worldBossExtraAttendeeNames = new Set();

function populateWorldBossNameSelect() {
  const select = document.getElementById('worldBossNameSelect');
  const names = WORLD_BOSS_SCHEDULES[worldBossActiveSchedule].bossNames;
  // A blank placeholder first -- otherwise the select always has some real
  // boss selected by default, so "required" has nothing to actually catch
  // and an admin could save without ever deliberately picking one.
  select.innerHTML = `<option value="" disabled selected>${t('sovereign.worldBoss.selectBossPlaceholder')}</option>` + names.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
}

// Grouped by guild, same ordering convention as the Member List page, with a
// checkbox per person instead of a plain name -- `selectedNames` pre-checks
// whichever names are already part of the event being edited. Always
// includes `selectedNames` and any manually-added exceptions even if they
// don't meet the schedule's normal filter (e.g. BF4's +13 lamp requirement),
// so editing an event that already has an exception attendee, or adding one,
// never silently drops them from the checklist.
function renderWorldBossMemberGrid(selectedNames) {
  const grid = document.getElementById('worldBossMemberGrid');
  const bossSelect = document.getElementById('worldBossNameSelect');
  const bossChosen = !!bossSelect.value;
  // Visual confirmation that a real boss (not the blank placeholder) is
  // selected -- same lifecycle as the gates below, so it stays in sync
  // with them for free.
  bossSelect.classList.toggle('crusade-boss-select-active', bossChosen);
  // + Add Item is gated the same way as the attendee checklist below --
  // both need a boss picked first, and this function already re-runs
  // every time the boss selection changes.
  document.getElementById('worldBossAddLootRowBtn').disabled = !bossChosen;
  // Clear Roster only makes sense once a boss (and therefore a checklist)
  // exists -- same gate as + Add Item above.
  document.getElementById('worldBossClearRosterBtn').disabled = !bossChosen;
  // No attendees to check off until a boss is actually picked -- avoids an
  // admin checking off a roster before realizing the boss dropdown was
  // still on its blank placeholder.
  if (!bossChosen) {
    grid.innerHTML = `<p class="empty-state">${t('sovereign.worldBoss.selectBossFirst')}</p>`;
    document.getElementById('worldBossExtraAttendeeAdder').classList.add('hidden');
    return;
  }
  const allMembers = deriveMembersFromGrowthSubmissions(sovereignState.growthSubmissions);
  const allByLowerName = new Map(allMembers.map((m) => [m.name.toLowerCase(), m]));
  const includeKeys = new Set(getWorldBossCandidates().map((m) => m.name.toLowerCase()));
  selectedNames.forEach((n) => includeKeys.add(n.trim().toLowerCase()));
  worldBossExtraAttendeeNames.forEach((n) => includeKeys.add(n.trim().toLowerCase()));
  const members = Array.from(includeKeys)
    .map((key) => allByLowerName.get(key))
    .filter(Boolean);

  const adder = document.getElementById('worldBossExtraAttendeeAdder');
  adder.classList.toggle('hidden', worldBossActiveSchedule !== 'bf4');

  const groups = new Map();
  members.forEach((m) => {
    const key = m.guildName || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  // Highest growth rate first within each guild -- falls back to name for
  // anyone missing a growth rate (e.g. a manually-added exception attendee
  // with no Growth Rate submission on file), so they don't scatter randomly.
  groups.forEach((list) => list.sort((a, b) => (b.growthRate ?? -1) - (a.growthRate ?? -1) || a.name.localeCompare(b.name)));

  const knownOrder = sovereignState.guilds.map((g) => g.name);
  const guildKeys = Array.from(groups.keys()).filter((k) => k !== 'Unassigned');
  guildKeys.sort((a, b) => {
    const ai = knownOrder.indexOf(a);
    const bi = knownOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  if (groups.has('Unassigned')) guildKeys.push('Unassigned');

  grid.innerHTML = guildKeys
    .map((g) => {
      const color = g === 'Unassigned' ? null : crusadeGuildColor(g);
      const label = g === 'Unassigned' ? t('sovereign.common.unassigned') : escapeHtml(g);
      const rows = groups
        .get(g)
        .map(
          (m) => `
        <label class="crusade-attendee-check-row">
          <input type="checkbox" class="world-boss-attendee-check admin-disable" value="${escapeHtml(m.name)}" ${selectedNames.has(m.name) ? 'checked' : ''}>
          <span title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
        </label>`
        )
        .join('');
      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3 style="${color ? `color:${color};` : ''}">${label} (${groups.get(g).length})</h3>
        </div>
        <div class="crusade-attendee-grid">${rows}</div>
      </div>`;
    })
    .join('');

  // Suggestions exclude whoever's already shown above, so the exception
  // adder only ever offers someone actually missing from the checklist.
  worldBossExtraAttendeeCandidates = allMembers.filter((m) => !includeKeys.has(m.name.toLowerCase()));
}

let worldBossExtraAttendeeCandidates = [];

// Custom dropdown (not a native <datalist>) so it can be sized to exactly
// match the input's width, same reasoning as the loot item-name field's own
// suggestion list.
function showWorldBossExtraAttendeeSuggestions() {
  const input = document.getElementById('worldBossExtraAttendeeInput');
  const list = document.getElementById('worldBossExtraAttendeeSuggestList');
  const query = input.value.trim().toLowerCase();
  const matches = (query ? worldBossExtraAttendeeCandidates.filter((m) => m.name.toLowerCase().includes(query)) : worldBossExtraAttendeeCandidates).slice(0, 20);
  if (!matches.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  list.innerHTML = matches.map((m) => `<div class="crusade-loot-suggest-item" data-suggest-name="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>`).join('');
  list.classList.remove('hidden');
  list.querySelectorAll('[data-suggest-name]').forEach((el) => {
    // mousedown (not click) fires before the input's blur, so the
    // dropdown's own blur-hide handler below doesn't swallow the pick.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = el.getAttribute('data-suggest-name');
      list.classList.add('hidden');
    });
  });
}

const worldBossExtraAttendeeInput = document.getElementById('worldBossExtraAttendeeInput');
worldBossExtraAttendeeInput.addEventListener('input', showWorldBossExtraAttendeeSuggestions);
worldBossExtraAttendeeInput.addEventListener('focus', showWorldBossExtraAttendeeSuggestions);
worldBossExtraAttendeeInput.addEventListener('blur', () => setTimeout(() => document.getElementById('worldBossExtraAttendeeSuggestList').classList.add('hidden'), 150));

document.getElementById('worldBossExtraAttendeeAddBtn').addEventListener('click', () => {
  const input = document.getElementById('worldBossExtraAttendeeInput');
  const name = input.value.trim();
  if (!name) return;
  const match = deriveMembersFromGrowthSubmissions(sovereignState.growthSubmissions).find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    toast('No Growth Rate submission found for that IGN');
    return;
  }
  document.getElementById('worldBossExtraAttendeeSuggestList').classList.add('hidden');
  worldBossExtraAttendeeNames.add(match.name);
  input.value = '';
  const currentlyChecked = new Set(Array.from(document.querySelectorAll('.world-boss-attendee-check:checked')).map((cb) => cb.value));
  currentlyChecked.add(match.name);
  renderWorldBossMemberGrid(currentlyChecked);
});

// In-page clipboard for the attendee checklist -- lets an admin check off
// one boss's roster, copy it, then paste the same roster into the next
// boss killed by the same raid group instead of re-checking everyone.
// Kept in memory (not the real OS clipboard) since it only ever needs to
// survive within this page session.
let worldBossCopiedRosterNames = [];

document.getElementById('worldBossCopyRosterBtn').addEventListener('click', () => {
  worldBossCopiedRosterNames = Array.from(document.querySelectorAll('.world-boss-attendee-check:checked')).map((cb) => cb.value);
  if (!worldBossCopiedRosterNames.length) {
    toast('Check off some attendees first');
    return;
  }
  toast(`Copied ${worldBossCopiedRosterNames.length} attendee${worldBossCopiedRosterNames.length === 1 ? '' : 's'}`);
});

document.getElementById('worldBossClearRosterBtn').addEventListener('click', () => {
  const checkedCount = document.querySelectorAll('.world-boss-attendee-check:checked').length;
  if (!checkedCount) {
    toast('Nothing checked off yet');
    return;
  }
  renderWorldBossMemberGrid(new Set());
  toast('Roster cleared');
});

document.getElementById('worldBossPasteRosterBtn').addEventListener('click', () => {
  if (!worldBossCopiedRosterNames.length) {
    toast('Nothing copied yet');
    return;
  }
  // A pasted name that doesn't meet the current schedule's normal filter
  // (e.g. BF4's +13 lamp) becomes an exception, same as the manual adder --
  // pasting a World Boss roster into BF4 shouldn't silently drop people.
  const candidateKeys = new Set(getWorldBossCandidates().map((m) => m.name.toLowerCase()));
  worldBossCopiedRosterNames.forEach((name) => {
    if (!candidateKeys.has(name.toLowerCase())) worldBossExtraAttendeeNames.add(name);
  });
  renderWorldBossMemberGrid(new Set(worldBossCopiedRosterNames));
  toast(`Pasted ${worldBossCopiedRosterNames.length} attendee${worldBossCopiedRosterNames.length === 1 ? '' : 's'}`);
});

// One row per person who attended at least one event in the month the
// calendar is currently showing, ranked by attendance count within that
// month -- scoped to the visible month rather than all-time history, so
// switching months actually changes what this shows.
function computeWorldBossSummary() {
  const year = worldBossCalendarMonth.getFullYear();
  const month = worldBossCalendarMonth.getMonth();
  const events = getScheduleEvents().filter((ev) => {
    const d = new Date(`${String(ev.eventDate).slice(0, 10)}T00:00:00`);
    return d.getFullYear() === year && d.getMonth() === month;
  });
  const totalEvents = events.length;
  // Keyed by memberNameKey so spelling variants ("uncleken" / "unclekenツ")
  // count as one person, shown under their Growth Rate spelling if any.
  const growthNameByKey = new Map();
  (sovereignState.growthSubmissions || []).forEach((s) => {
    const key = memberNameKey(s.ign);
    if (key && !growthNameByKey.has(key)) growthNameByKey.set(key, s.ign);
  });
  const byName = new Map();
  events.forEach((ev) => {
    ev.attendees.forEach((a) => {
      const key = memberNameKey(a.name);
      if (!key) return;
      if (!byName.has(key)) byName.set(key, { name: growthNameByKey.get(key) || a.name.trim(), guildName: a.guildName, count: 0 });
      const entry = byName.get(key);
      entry.count += 1;
      entry.guildName = a.guildName || entry.guildName;
    });
  });
  return { totalEvents, rows: Array.from(byName.values()).sort((a, b) => b.count - a.count) };
}

function renderWorldBossSummary() {
  const { totalEvents, rows } = computeWorldBossSummary();
  document.getElementById('worldBossSummaryHint').textContent = `For ${worldBossCalendarMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })} only.`;
  document.getElementById('worldBossSummaryEmptyState').classList.toggle('hidden', rows.length !== 0);
  const body = document.getElementById('worldBossSummaryBody');
  body.innerHTML = rows
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td style="font-weight:600;">${escapeHtml(r.name)}</td>
      <td>${crusadeGuildBadge(r.guildName)}</td>
      <td>${r.count} / ${totalEvents}</td>
      <td>${totalEvents ? Math.round((r.count / totalEvents) * 100) : 0}%</td>
    </tr>`
    )
    .join('');
}

// Same static-table-then-print approach as the This Month's Loot print
// button -- computeWorldBossSummary() already reads through
// getScheduleEvents(), so this works correctly for World Boss, BF4, and
// Balthazard alike without any schedule-specific code here.
document.getElementById('worldBossSummaryPrintBtn').addEventListener('click', () => {
  const { totalEvents, rows } = computeWorldBossSummary();
  if (!rows.length) {
    toast('Nothing to print');
    return;
  }
  const scheduleLabel = WORLD_BOSS_SCHEDULES[worldBossActiveSchedule].label;
  const monthLabel = worldBossCalendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('worldBossSummaryPrintArea').innerHTML = `
    <h2>${escapeHtml(scheduleLabel)} — ${t('sovereign.worldBoss.summaryHeading')} — ${escapeHtml(monthLabel)}</h2>
    <table>
      <thead>
        <tr>
          <th>${t('sovereign.growth.thRank')}</th>
          <th>${t('sovereign.common.ign')}</th>
          <th>${t('sovereign.common.guild')}</th>
          <th>${t('sovereign.worldBoss.thAttended')}</th>
          <th>${t('sovereign.worldBoss.thRate')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.guildName || '—')}</td>
          <td>${r.count} / ${totalEvents}</td>
          <td>${totalEvents ? Math.round((r.count / totalEvents) * 100) : 0}%</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
  document.body.classList.add('is-printing-summary');
  window.print();
});

window.addEventListener('afterprint', () => {
  document.body.classList.remove('is-printing-summary');
});

// Persist across re-renders of this page (but not across navigating away and
// back, which is fine -- same idiom as worldBossEditingId below).
let worldBossCalendarMonth = null; // Date, always the 1st of whichever month is showing
let worldBossSelectedDate = null; // 'YYYY-MM-DD', or null if nothing's selected yet
let worldBossMonthlyLootRows = []; // last rendered This Month's Loot rows, incl. their source loot_items -- read by saveMonthlyLootEdit
let worldBossExpandedLootKey = null; // itemKey of whichever row's breakdown is open, or null -- kept outside the render so saving inside it doesn't collapse it

// world_boss_attendance.event_date is a naive "wall clock" timestamp (no
// timezone) -- the admin's own local input from a <input
// type="datetime-local">, stored and meant to display back exactly as
// typed, same "never convert timezones" idea formatLongDate already uses
// for plain dates. The API returns it JSON-serialized with a trailing "Z"
// (an artifact of the server representing it as a Date object), which would
// make the browser reinterpret it as UTC and shift it on display -- so that
// "Z" is stripped before handing it to `new Date(...)` here.
function parseWorldBossEventDate(isoString) {
  return new Date(String(isoString).replace(/Z$/, ''));
}

// "YYYY-MM-DDTHH:mm" -- what a <input type="datetime-local"> element's own
// value needs to be.
function toDatetimeLocalValue(isoString) {
  const d = parseWorldBossEventDate(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Long date plus a time-of-day, e.g. "September 11, 2026, 11:45 PM".
function formatWorldBossEventDateTime(isoString) {
  const d = parseWorldBossEventDate(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return `${formatLongDate(String(isoString).slice(0, 10))}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

// Unlike event_date (a literal wall-clock value, see parseWorldBossEventDate),
// a sale batch's sold_at is a real TIMESTAMPTZ instant -- parse it normally
// so it converts to the viewer's own local time instead of being misread as
// a literal.
function formatSaleBatchDate(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function worldBossEventsByDate() {
  const byDate = new Map();
  getScheduleEvents().forEach((ev) => {
    const dateKey = String(ev.eventDate).slice(0, 10);
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(ev);
  });
  return byDate;
}

function renderWorldBossLog() {
  const byDate = worldBossEventsByDate();
  document.getElementById('worldBossLogEmptyState').classList.toggle('hidden', byDate.size !== 0);

  if (!worldBossCalendarMonth) {
    // First render ever on this page visit -- default to whichever month has
    // the most recent logged event (today's, if there are none yet).
    const dateKeys = Array.from(byDate.keys()).sort();
    const anchor = dateKeys.length ? dateKeys[dateKeys.length - 1] : new Date().toISOString().slice(0, 10);
    const [y, m] = anchor.split('-').map(Number);
    worldBossCalendarMonth = new Date(y, m - 1, 1);
    worldBossSelectedDate = dateKeys.length ? anchor : null;
  }

  renderWorldBossCalendarGrid(byDate);
  renderWorldBossDayDetail(byDate);
  renderWorldBossMonthlyLoot();
  renderWorldBossSummary();
}

// Every loot item dropped by every boss logged in the month the calendar is
// currently showing -- merged into one row per distinct item name (summing
// quantity/Crows/Diamonds across every kill that dropped it), not one row
// per drop, so the same item from five different kills doesn't show up as
// five separate lines.
function renderWorldBossMonthlyLoot() {
  const year = worldBossCalendarMonth.getFullYear();
  const month = worldBossCalendarMonth.getMonth();
  document.getElementById('worldBossMonthlyLootLabel').textContent = worldBossCalendarMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const monthEvents = getScheduleEvents()
    .filter((ev) => {
      const d = new Date(`${String(ev.eventDate).slice(0, 10)}T00:00:00`);
      return d.getFullYear() === year && d.getMonth() === month;
    })
    // Stable order (earliest kill first) so "which source absorbs an edit"
    // below is deterministic instead of depending on object insertion order.
    .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.createdAt).localeCompare(String(b.createdAt)));

  // Merge key ignores case and collapses/trims whitespace -- catches typos
  // like "frozen tear", "Frozen  Tear", or " Frozen Tear " all landing as
  // the same item instead of splitting into separate rows. `sources` tracks
  // every individual loot_item row (by its event + item id) that feeds this
  // merged row, so editing Crows/Diamonds below still has somewhere real to
  // save to even though what's on screen is a sum.
  const byItem = new Map();
  monthEvents.forEach((ev) => {
    (ev.lootItems || []).forEach((item) => {
      const cleanName = canonicalizeItemName(item.itemName);
      const key = cleanName.toLowerCase();
      if (!byItem.has(key)) byItem.set(key, { itemName: cleanName, itemKey: key, quantity: 0, crowsValue: null, diamondsValue: null, sources: [], bossCounts: new Map() });
      const entry = byItem.get(key);
      entry.quantity += item.quantity || 0;
      if (item.crowsValue !== null) entry.crowsValue = (entry.crowsValue || 0) + item.crowsValue;
      if (item.diamondsValue !== null) entry.diamondsValue = (entry.diamondsValue || 0) + item.diamondsValue;
      entry.sources.push({
        eventId: ev.id,
        itemId: item.id,
        bossName: ev.bossName,
        eventDate: ev.eventDate,
        quantity: item.quantity,
        crowsValue: item.crowsValue,
        diamondsValue: item.diamondsValue,
        sold: item.sold,
        soldQuantity: item.soldQuantity ?? (item.sold ? item.quantity : 0),
      });
      entry.bossCounts.set(ev.bossName, (entry.bossCounts.get(ev.bossName) || 0) + 1);
    });
  });
  const rows = Array.from(byItem.values()).sort((a, b) => b.quantity - a.quantity);
  // No manually-set source yet? Fall back to whichever boss has actually
  // dropped this item the most so far, instead of defaulting cold to
  // "Unknown" when the kill history already answers the question.
  rows.forEach((r) => {
    r.guessedBoss = Array.from(r.bossCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  });

  // Each month is its own set of records: Total / Sold / Remaining count
  // only this month's kills, and the Sales list only shows sales that
  // actually went into this month's kills (or were recorded against this
  // month) -- see computeFifoAllocation for how sales are kept to a month.
  const viewedMonth = worldBossViewedMonthKey();
  rows.forEach((r) => {
    const { usageByBatch } = computeFifoAllocation(r.itemKey);
    r.saleBatches = (sovereignState.lootSaleBatches || [])
      .filter((b) => (b.schedule || 'world_boss') === worldBossActiveSchedule && b.itemKey === r.itemKey)
      .filter((b) => {
        const usage = usageByBatch.get(b.id);
        if (usage && usage.get(viewedMonth)) return true;
        if (b.month) return b.month === viewedMonth;
        // an older untagged sale that didn't land on any kill at all still
        // shows in the month it was sold, so it can be found and removed
        return !usage && saleMonthKey(b) === viewedMonth;
      })
      .map((b) => ({ ...b, usedThisMonth: usageByBatch.get(b.id)?.get(viewedMonth) || 0 }))
      .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)));
    // Summed from each kill's own soldQuantity (the same field driving its
    // individual Sold/Not Sold badge below) rather than independently
    // re-summing loot_sale_batches -- the two used to drift apart whenever a
    // batch existed without being fully reflected on the kills it covers
    // (a stray leftover batch, an un-sell that didn't fully clean up, etc),
    // showing e.g. "129/129 sold" while several kills still displayed Not
    // Sold. Deriving from the same source the badges use makes that
    // contradiction structurally impossible instead of just patching one
    // item's data.
    r.soldQuantity = r.sources.reduce((sum, s) => sum + (s.soldQuantity || 0), 0);
    r.remainingQuantity = Math.max(0, r.quantity - r.soldQuantity);
  });
  worldBossMonthlyLootRows = rows; // read by the change handler below via data-loot-row-index -- indices below are into this full (unfiltered) array

  const search = document.getElementById('worldBossMonthlyLootSearchInput').value.trim().toLowerCase();
  // Filters which rows are shown, but keeps each row's index into the full
  // `rows` array (not its position in the filtered list) so the save
  // handlers below -- which look items up via rows[i] -- keep working
  // correctly against whatever's actually displayed.
  const displayRows = sortMonthlyLootRows(rows.map((r, i) => ({ r, i })).filter(({ r }) => !search || r.itemName.toLowerCase().includes(search)), ({ r }) => r);

  document.getElementById('worldBossMonthlyLootEmptyState').classList.toggle('hidden', rows.length !== 0);
  document.getElementById('worldBossMonthlyLootNoMatchState').classList.toggle('hidden', rows.length === 0 || displayRows.length !== 0);
  const body = document.getElementById('worldBossMonthlyLootBody');
  body.innerHTML = displayRows
    .map(
      ({ r, i }) => {
        // A manually-set source always wins; otherwise fall back to the
        // guessed boss from kill history rather than defaulting to blank.
        const savedSource = sovereignState.lootItemSources?.get(`${worldBossActiveSchedule}:${r.itemKey}`);
        const selectedBoss = savedSource !== undefined ? savedSource : r.guessedBoss;
        const breakdownRows = r.sources
          .slice()
          .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)))
          .map(
            (s) => `
          <tr>
            <td class="crusade-loot-boss">⚔️ ${escapeHtml(s.bossName)}</td>
            <td class="crusade-loot-date">${formatWorldBossEventDateTime(s.eventDate)}</td>
            <td class="crusade-loot-num"><input type="number" min="1" step="1" class="crusade-loot-source-edit-input admin-disable" data-source-event="${s.eventId}" data-source-item="${s.itemId}" data-source-field="quantity" value="${s.quantity}"></td>
            <td class="crusade-loot-num">🪙 <input type="number" min="0" step="0.01" class="crusade-loot-source-edit-input admin-disable" data-source-event="${s.eventId}" data-source-item="${s.itemId}" data-source-field="crowsValue" value="${s.crowsValue !== null ? roundLootValue(s.crowsValue) : ''}" placeholder="—"></td>
            <td class="crusade-loot-num">💎 <input type="number" min="0" step="0.01" class="crusade-loot-source-edit-input admin-disable" data-source-event="${s.eventId}" data-source-item="${s.itemId}" data-source-field="diamondsValue" value="${s.diamondsValue !== null ? roundLootValue(s.diamondsValue) : ''}" placeholder="—"></td>
            <td>
              <button type="button" class="crusade-loot-sold-toggle admin-disable ${s.sold ? 'is-sold' : s.soldQuantity > 0 ? 'is-partial' : 'is-unsold'}" data-toggle-sold="${s.itemId}" data-sold="${s.sold ? '1' : '0'}" title="${s.soldQuantity > 0 && !s.sold ? 'Click to mark the rest sold' : ''}">
                ${s.sold ? '✅ Sold' : s.soldQuantity > 0 ? `◐ Partial (${s.soldQuantity}/${s.quantity})` : '⭕ Not Sold'}
              </button>
            </td>
          </tr>`
          )
          .join('');
        const isExpanded = r.itemKey === worldBossExpandedLootKey;
        return `
    <tr class="crusade-loot-clickable-row" data-toggle-source-row="${i}" title="Click to see/edit the breakdown">
      <td>
        <span class="${lootItemBadgeClass(r.itemName)}">${escapeHtml(r.itemName)}</span>
        <div class="crusade-loot-source-picker ${isExpanded ? '' : 'hidden'}" id="worldBossLootSource-${i}">
          <span>${t('sovereign.worldBoss.dropsFrom')}</span>
          <select class="admin-disable" data-loot-source-row="${i}">
            <option value="">— Unknown —</option>
            ${WORLD_BOSS_SCHEDULES[worldBossActiveSchedule].bossNames.map((b) => `<option value="${escapeHtml(b)}" ${selectedBoss === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
          </select>
          ${!savedSource && r.guessedBoss ? `<span class="crusade-loot-source-guess-hint">(guessed from kill history)</span>` : ''}
        </div>
        <div class="crusade-loot-breakdown ${isExpanded ? '' : 'hidden'}" id="worldBossLootBreakdown-${i}">
          <table class="crusade-loot-breakdown-table">
            <thead>
              <tr>
                <th>${t('sovereign.worldBoss.thBoss')}</th>
                <th>${t('sovereign.common.date')}</th>
                <th>${t('sovereign.worldBoss.thQuantity')}</th>
                <th>${t('sovereign.worldBoss.thCrows')}</th>
                <th>${t('sovereign.worldBoss.thDiamonds')}</th>
                <th>${t('sovereign.worldBoss.thStatus')}</th>
              </tr>
            </thead>
            <tbody>${breakdownRows}</tbody>
          </table>
        </div>
        <div class="crusade-loot-sales ${isExpanded ? '' : 'hidden'}" id="worldBossLootSales-${i}">
          <h4>${t('sovereign.worldBoss.salesHeading')}</h4>
          <div class="crusade-loot-sales-summary">
            <span>${t('sovereign.worldBoss.salesTotalQty')}: <strong>${r.quantity.toLocaleString()}</strong></span>
            <span>${t('sovereign.worldBoss.salesSold')}: <strong>${r.soldQuantity.toLocaleString()}</strong></span>
            <span>${t('sovereign.worldBoss.salesRemaining')}: <strong>${r.remainingQuantity.toLocaleString()}</strong></span>
          </div>
          ${
            r.saleBatches.length
              ? `<table class="crusade-loot-sales-table">
            <thead><tr><th>${t('sovereign.worldBoss.salesDate')}</th><th>${t('sovereign.worldBoss.thQuantity')}</th><th>${t('sovereign.worldBoss.thCrows')}</th><th>${t('sovereign.worldBoss.thDiamonds')}</th><th></th></tr></thead>
            <tbody>
              ${r.saleBatches
                .map(
                  (b) => `
                <tr>
                  <td class="crusade-loot-date">${formatSaleBatchDate(b.soldAt)}</td>
                  <td class="crusade-loot-num">${b.usedThisMonth && b.usedThisMonth < b.quantity ? `${b.usedThisMonth.toLocaleString()} of ${b.quantity.toLocaleString()}` : b.quantity.toLocaleString()}</td>
                  <td class="crusade-loot-num">${b.crowsValue !== null ? '🪙 ' + formatLootValue(b.crowsValue) : '—'}</td>
                  <td class="crusade-loot-num">${b.diamondsValue !== null ? '💎 ' + formatLootValue(b.diamondsValue) : '—'}</td>
                  <td><button type="button" class="crusade-loot-sale-delete admin-disable" data-delete-sale-batch="${b.id}">✕</button></td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
              : `<p class="crusade-loot-sales-empty">${t('sovereign.worldBoss.salesEmpty')}</p>`
          }
          <form class="crusade-loot-sale-add-form admin-disable" data-add-sale-row="${i}">
            <input type="number" min="0.01" step="0.01" name="quantity" placeholder="${t('sovereign.worldBoss.salesQtyPlaceholder')}" required>
            <input type="number" min="0" step="0.01" name="crowsValue" placeholder="🪙">
            <input type="number" min="0" step="0.01" name="diamondsValue" placeholder="💎">
            <button type="submit">${t('sovereign.worldBoss.salesAdd')}</button>
          </form>
        </div>
      </td>
      <td class="crusade-loot-num">${r.quantity.toLocaleString()}</td>
      <td class="crusade-loot-num">
        <span class="crusade-loot-edit-cell crows">🪙 <input type="number" min="0" step="0.01" class="crusade-loot-edit-input admin-disable" data-loot-row-index="${i}" data-loot-field="crowsValue" value="${r.crowsValue !== null ? roundLootValue(r.crowsValue) : ''}" placeholder="—"></span>
      </td>
      <td class="crusade-loot-num">
        <span class="crusade-loot-edit-cell diamonds">💎 <input type="number" min="0" step="0.01" class="crusade-loot-edit-input admin-disable" data-loot-row-index="${i}" data-loot-field="diamondsValue" value="${r.diamondsValue !== null ? roundLootValue(r.diamondsValue) : ''}" placeholder="—"></span>
      </td>
      <td class="crusade-loot-num"><span class="crusade-loot-sold-ratio ${['is-unsold', 'is-partially-sold', 'is-fully-sold'][monthlyLootSoldRank(r)]}">${r.soldQuantity.toLocaleString()} / ${r.quantity.toLocaleString()}</span></td>
    </tr>`;
      }
    )
    .join('');

  body.querySelectorAll('.crusade-loot-edit-input').forEach((input) => {
    input.addEventListener('change', () => saveMonthlyLootEdit(input));
  });

  body.querySelectorAll('tr[data-toggle-source-row]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      // Ignore clicks on anything interactive inside the row (the inline
      // Crows/Diamonds inputs, or -- once expanded -- the "Drops from"
      // picker and breakdown table's own inputs/buttons) so using those
      // doesn't also toggle the row shut.
      if (e.target.closest('input, select, button, a')) return;
      const row = rows[Number(tr.getAttribute('data-toggle-source-row'))];
      worldBossExpandedLootKey = worldBossExpandedLootKey === row.itemKey ? null : row.itemKey;
      renderWorldBossMonthlyLoot();
    });
  });
  body.querySelectorAll('[data-loot-source-row]').forEach((select) => {
    select.addEventListener('change', () => saveLootItemSource(select, rows[Number(select.getAttribute('data-loot-source-row'))]));
  });
  body.querySelectorAll('.crusade-loot-source-edit-input').forEach((input) => {
    input.addEventListener('change', () => saveLootSourceField(input));
  });
  body.querySelectorAll('[data-toggle-sold]').forEach((btn) => {
    btn.addEventListener('click', () => toggleLootItemSold(btn));
  });
  body.querySelectorAll('[data-add-sale-row]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      addSaleBatch(form, rows[Number(form.getAttribute('data-add-sale-row'))]);
    });
  });
  body.querySelectorAll('[data-delete-sale-batch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rowIndex = Number(btn.closest('[id^="worldBossLootSales-"]').id.replace('worldBossLootSales-', ''));
      deleteSaleBatch(rows[rowIndex], btn.getAttribute('data-delete-sale-batch'));
    });
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.quantity += r.quantity || 0;
      acc.crows += r.crowsValue || 0;
      acc.diamonds += r.diamondsValue || 0;
      return acc;
    },
    { quantity: 0, crows: 0, diamonds: 0 }
  );
  const totalsRow = document.getElementById('worldBossMonthlyLootTotals');
  totalsRow.classList.toggle('hidden', rows.length === 0);
  totalsRow.innerHTML = rows.length
    ? `
    <td class="crusade-loot-total-label">${t('sovereign.worldBoss.thTotal')}</td>
    <td class="crusade-loot-num crusade-loot-total-value">${totals.quantity.toLocaleString()}</td>
    <td class="crusade-loot-num crusade-loot-total-value"><span class="crusade-loot-currency crows">🪙 ${formatLootValue(totals.crows)}</span></td>
    <td class="crusade-loot-num crusade-loot-total-value"><span class="crusade-loot-currency diamonds">💎 ${formatLootValue(totals.diamonds)}</span></td>
    <td></td>`
    : '';

  document.getElementById('worldBossMonthlyLootChips').innerHTML = rows.length
    ? `
    <span class="crusade-loot-chip">${rows.length} item${rows.length === 1 ? '' : 's'}</span>
    <span class="crusade-loot-chip crows">🪙 ${formatLootValue(totals.crows)}</span>
    <span class="crusade-loot-chip diamonds">💎 ${formatLootValue(totals.diamonds)}</span>`
    : '';
}

document.getElementById('worldBossMonthlyLootSearchInput').addEventListener('input', renderWorldBossMonthlyLoot);
document.getElementById('worldBossMonthlyLootSortSelect').addEventListener('change', renderWorldBossMonthlyLoot);

// 0 = nothing sold yet, 1 = partially sold, 2 = fully sold -- against every
// kill this month, same as the Sold column.
function monthlyLootSoldRank(r) {
  if (r.soldQuantity <= 0) return 0;
  return r.soldQuantity >= r.quantity ? 2 : 1;
}

// Stable sort, so rows in the same sold group keep the default
// most-dropped-first order. getRow pulls the loot row out of whatever
// wrapper the caller is sorting ({ r, i } for the live table).
function sortMonthlyLootRows(items, getRow = (x) => x) {
  const mode = document.getElementById('worldBossMonthlyLootSortSelect').value;
  if (mode === 'unsold') return items.slice().sort((a, b) => monthlyLootSoldRank(getRow(a)) - monthlyLootSoldRank(getRow(b)));
  if (mode === 'sold') return items.slice().sort((a, b) => monthlyLootSoldRank(getRow(b)) - monthlyLootSoldRank(getRow(a)));
  return items;
}

// Builds a plain, static table (no inputs/buttons) from whatever's
// currently shown -- respects the search filter -- into a print-only
// container, then hands off to the browser's own print preview. Cleaner
// than printing the live editable table as-is.
document.getElementById('worldBossMonthlyLootPrintBtn').addEventListener('click', () => {
  const search = document.getElementById('worldBossMonthlyLootSearchInput').value.trim().toLowerCase();
  const rows = sortMonthlyLootRows(worldBossMonthlyLootRows.filter((r) => !search || r.itemName.toLowerCase().includes(search)));
  if (!rows.length) {
    toast('Nothing to print');
    return;
  }
  const monthLabel = document.getElementById('worldBossMonthlyLootLabel').textContent;
  const totals = rows.reduce(
    (acc, r) => {
      acc.quantity += r.quantity || 0;
      acc.crows += r.crowsValue || 0;
      acc.diamonds += r.diamondsValue || 0;
      return acc;
    },
    { quantity: 0, crows: 0, diamonds: 0 }
  );
  const scheduleLabel = WORLD_BOSS_SCHEDULES[worldBossActiveSchedule].label;
  document.getElementById('worldBossMonthlyLootPrintArea').innerHTML = `
    <h2>${escapeHtml(scheduleLabel)} — ${t('sovereign.worldBoss.monthlyLootHeading')} — ${escapeHtml(monthLabel)}</h2>
    <table>
      <thead>
        <tr>
          <th>${t('sovereign.worldBoss.thItem')}</th>
          <th>${t('sovereign.worldBoss.thQuantity')}</th>
          <th>${t('sovereign.worldBoss.thCrows')}</th>
          <th>${t('sovereign.worldBoss.thDiamonds')}</th>
          <th>${t('sovereign.worldBoss.thSold')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
        <tr>
          <td>${escapeHtml(r.itemName)}</td>
          <td>${r.quantity.toLocaleString()}</td>
          <td>${r.crowsValue !== null ? formatLootValue(r.crowsValue) : '—'}</td>
          <td>${r.diamondsValue !== null ? formatLootValue(r.diamondsValue) : '—'}</td>
          <td>${r.soldQuantity.toLocaleString()} / ${r.quantity.toLocaleString()}</td>
        </tr>`
          )
          .join('')}
      </tbody>
      <tfoot>
        <tr>
          <td><strong>${t('sovereign.worldBoss.thTotal')}</strong></td>
          <td><strong>${totals.quantity.toLocaleString()}</strong></td>
          <td><strong>${formatLootValue(totals.crows)}</strong></td>
          <td><strong>${formatLootValue(totals.diamonds)}</strong></td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
  document.body.classList.add('is-printing-monthly-loot');
  window.print();
});

window.addEventListener('afterprint', () => {
  document.body.classList.remove('is-printing-monthly-loot');
});

// Marking one specific kill Sold here (as opposed to recording a sale in
// the Sales section) creates a real, linked sale batch for exactly that
// kill's own quantity/price -- otherwise this toggle was cosmetic and
// never actually counted toward the item's Total/Sold/Remaining. Toggling
// back to Not Sold removes that same linked sale. A linked kill is left
// alone by applyFifoSalesToItem's generic matching (it only touches kills
// still marked Not Sold), so this never gets silently overwritten by an
// unrelated sale entered afterward.
async function toggleLootItemSold(btn) {
  const itemId = btn.getAttribute('data-toggle-sold');
  const nextSold = btn.getAttribute('data-sold') !== '1';
  try {
    await api(`/api/world-boss-attendance/loot-items/${itemId}/sold`, { method: 'PUT', body: JSON.stringify({ sold: nextSold }) });
    let ev, item;
    for (const e of sovereignState.worldBossEvents) {
      const found = e.lootItems?.find((l) => l.id === itemId);
      if (found) {
        ev = e;
        item = found;
        break;
      }
    }
    if (item) {
      item.sold = nextSold;
      item.soldQuantity = nextSold ? item.quantity : 0;
    }
    if (ev && item) {
      const itemKey = canonicalizeItemName(item.itemName).toLowerCase();
      if (nextSold) {
        const created = await api('/api/loot-sale-batches', {
          method: 'POST',
          body: JSON.stringify({
            itemName: item.itemName,
            quantity: item.quantity,
            crowsValue: item.crowsValue,
            diamondsValue: item.diamondsValue,
            schedule: ev.schedule || 'world_boss',
            sourceAttendanceId: ev.id,
          }),
        });
        sovereignState.lootSaleBatches.push(created);
      } else {
        const linked = (sovereignState.lootSaleBatches || []).filter((b) => b.sourceAttendanceId === ev.id && b.itemKey === itemKey);
        await Promise.all(linked.map((b) => api(`/api/loot-sale-batches/${b.id}`, { method: 'DELETE' })));
        const linkedIds = new Set(linked.map((b) => b.id));
        sovereignState.lootSaleBatches = (sovereignState.lootSaleBatches || []).filter((b) => !linkedIds.has(b.id));
      }
    }
    renderWorldBossMonthlyLoot();
  } catch (err) {
    toast(err.message);
  }
}

// Records a sale against the month being viewed (rather than any specific
// kill's row), so selling the same item again later at a different price is
// just another independent batch -- it never touches this one's price, and
// it only ever covers this month's kills (see computeFifoAllocation).
async function addSaleBatch(form, row) {
  const quantity = Number(form.elements.quantity.value);
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  if (quantity > row.remainingQuantity) {
    toast(`Only ${row.remainingQuantity.toLocaleString()} left unsold`);
    return;
  }
  const crowsValue = form.elements.crowsValue.value === '' ? null : Number(form.elements.crowsValue.value);
  const diamondsValue = form.elements.diamondsValue.value === '' ? null : Number(form.elements.diamondsValue.value);
  try {
    const created = await api('/api/loot-sale-batches', {
      method: 'POST',
      body: JSON.stringify({ itemName: row.itemName, quantity, crowsValue, diamondsValue, schedule: worldBossActiveSchedule, month: worldBossViewedMonthKey() }),
    });
    sovereignState.lootSaleBatches.push(created);
    await applyFifoSalesToItem(row.itemKey);
    renderWorldBossLog();
    toast('Sale recorded');
  } catch (err) {
    toast(err.message);
  }
}

async function deleteSaleBatch(row, batchId) {
  try {
    await api(`/api/loot-sale-batches/${batchId}`, { method: 'DELETE' });
    sovereignState.lootSaleBatches = sovereignState.lootSaleBatches.filter((b) => b.id !== batchId);
    await applyFifoSalesToItem(row.itemKey);
    renderWorldBossLog();
    toast('Sale removed');
  } catch (err) {
    toast(err.message);
  }
}

// Whenever an item's sale batches change, recompute the implied per-kill
// price from scratch: sum every batch's Crows/Diamonds and spread that
// total across every kill that ever dropped the item (its full pool, not
// just this month's), proportional to quantity -- so the per-kill
// breakdown always reflects what it actually sold for instead of showing
// the 0/blank values a drop starts out with. Recomputed fresh each time
// rather than incrementally, since an earlier or later batch at a
// different price changes what "proportional" means for everyone.
// Every kill that ever dropped this item, read fresh from current state
// (not a snapshot from the last render) -- needed because
// splitLootFieldAcrossSources replaces an event's whole lootItems array
// (delete + reinsert with fresh ids) every time it runs, so a stale
// {eventId, itemId} pair from before that call would 404 on the next one.
function computeAllSourcesForItemKey(itemKey) {
  const sources = [];
  (sovereignState.worldBossEvents || []).forEach((ev) => {
    if ((ev.schedule || 'world_boss') !== worldBossActiveSchedule) return;
    (ev.lootItems || []).forEach((item) => {
      if (canonicalizeItemName(item.itemName).toLowerCase() !== itemKey) return;
      sources.push({ eventId: ev.id, itemId: item.id, quantity: item.quantity, eventDate: ev.eventDate, sold: item.sold, soldQuantity: item.soldQuantity ?? (item.sold ? item.quantity : 0) });
    });
  });
  return sources;
}

// FIFO prices are per-unit splits (e.g. 599.0666...) -- show 2 decimals so
// they fit their input instead of getting cut off mid-number.
function roundLootValue(value) {
  return Math.round(Number(value) * 100) / 100;
}

// Matches each kill to actual sale batches FIFO (oldest kill <-> oldest
// sale) instead of proportionally splitting every batch's total evenly
// across every kill by quantity -- two kills of quantity 1 sold for 4,167
// and 4,273 used to both show 4,220 (the average). Now each kill gets the
// price it actually came from (or a quantity-weighted blend of whichever
// batches its units were drawn from, if its own quantity spans more than
// one batch -- the row itself can't be split any finer than that). A kill
// only counts as Sold once the batch queue can cover its *entire*
// quantity; a kill only partially covered by what's left in the queue
// stays Not Sold (and unpriced) rather than showing a guessed number, and
// everything after it in date order stays Not Sold too. Recomputed from
// scratch every time (not just the newly-added/removed batch), since one
// batch changing shifts which units every later kill draws from.
//
// Each month is its own set of records: a sale recorded against a month
// (b.month, set when it was entered from that month's page) only covers
// that month's kills, and an older untagged sale only covers kills up to
// the month it was sold in -- so a sale can never fill a later month's
// drops, and a new month starts with nothing sold.
//
// computeFifoAllocation works it all out without saving anything (the
// loot table also uses it to tell which sales went into which month);
// applyFifoSalesToItem saves the result onto the kills.
function worldBossViewedMonthKey() {
  const d = worldBossCalendarMonth || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function saleMonthKey(b) {
  if (b.month) return b.month;
  const d = new Date(b.soldAt);
  return Number.isNaN(d.getTime()) ? String(b.soldAt || '').slice(0, 7) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function computeFifoAllocation(itemKey) {
  const itemBatches = (sovereignState.lootSaleBatches || []).filter((b) => (b.schedule || 'world_boss') === worldBossActiveSchedule && b.itemKey === itemKey);
  const usageByBatch = new Map(); // batch id -> Map(month -> units it covered there)

  // A kill with its own linked sale (from toggleLootItemSold) is locked to
  // that sale -- it's always marked sold from its linked batches first,
  // never from the generic pool. It used to be skipped entirely and left
  // "exactly as it is", but re-saving that kill from the attendance edit
  // form resets sold to false (the form doesn't send it), so it got stuck
  // Not Sold forever while its linked sale was also kept out of the pool --
  // e.g. 48 sold in Sales but only 44/48 on the kills. Any linked quantity
  // beyond what the kill itself holds (or a link to a kill that no longer
  // has this item) spills into the generic pool instead of vanishing.
  const allSources = computeAllSourcesForItemKey(itemKey);
  const sourceEventIds = new Set(allSources.map((s) => s.eventId));
  const toQueueEntry = (b, quantity) => ({
    id: b.id,
    soldAt: String(b.soldAt),
    month: b.month || null,
    soldMonth: saleMonthKey(b),
    remaining: quantity,
    diamondsPerUnit: b.diamondsValue !== null ? b.diamondsValue / b.quantity : null,
    crowsPerUnit: b.crowsValue !== null ? b.crowsValue / b.quantity : null,
  });
  const linkedQueues = new Map();
  const genericEntries = [];
  itemBatches
    .slice()
    .sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)))
    .forEach((b) => {
      if (b.sourceAttendanceId && sourceEventIds.has(b.sourceAttendanceId)) {
        if (!linkedQueues.has(b.sourceAttendanceId)) linkedQueues.set(b.sourceAttendanceId, []);
        linkedQueues.get(b.sourceAttendanceId).push(toQueueEntry(b, b.quantity));
      } else {
        genericEntries.push(toQueueEntry(b, b.quantity));
      }
    });
  const sources = allSources.sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
  if (!sources.length) return { updatesByEvent: new Map(), usageByBatch };

  // Takes up to `need` units from the oldest sales in `queue` that may
  // cover a kill from killMonth (mutating it), returning how many it got
  // and their summed price. killMonth null = no month rule (a kill's own
  // linked sales).
  const canCover = (b, killMonth) => !killMonth || (b.month ? b.month === killMonth : killMonth <= b.soldMonth);
  function drawFromQueue(queue, need, killMonth) {
    let taken = 0;
    let diamondsTotal = 0;
    let crowsTotal = 0;
    let anyDiamonds = false;
    let anyCrows = false;
    for (let i = 0; need > 0 && i < queue.length; ) {
      const b = queue[i];
      if (!canCover(b, killMonth)) {
        i++;
        continue;
      }
      const take = Math.min(need, b.remaining);
      if (take > 0 && b.id) {
        const month = killMonth || '';
        if (!usageByBatch.has(b.id)) usageByBatch.set(b.id, new Map());
        const usage = usageByBatch.get(b.id);
        usage.set(month, (usage.get(month) || 0) + take);
      }
      if (b.diamondsPerUnit !== null) {
        diamondsTotal += take * b.diamondsPerUnit;
        anyDiamonds = true;
      }
      if (b.crowsPerUnit !== null) {
        crowsTotal += take * b.crowsPerUnit;
        anyCrows = true;
      }
      b.remaining -= take;
      need -= take;
      taken += take;
      if (b.remaining <= 0) queue.splice(i, 1);
      else i++;
    }
    return { taken, diamondsTotal, crowsTotal, anyDiamonds, anyCrows };
  }

  // Locked kills draw from their own linked sales first; whatever linked
  // quantity is left over joins the generic pool in sale-date order.
  const lockedResults = new Map();
  sources.forEach((s) => {
    const queue = linkedQueues.get(s.eventId);
    if (!queue) return;
    // a kill's own linked sales cover it whatever the month; record that
    // usage under the kill's month too
    const before = queue.map((e) => [e.id, e.remaining]);
    lockedResults.set(s.itemId, drawFromQueue(queue, s.quantity, null));
    const killMonth = String(s.eventDate).slice(0, 7);
    before.forEach(([id, was]) => {
      const now = queue.find((e) => e.id === id)?.remaining ?? 0;
      const usage = usageByBatch.get(id);
      if (usage && was > now) {
        usage.set('', (usage.get('') || 0) - (was - now));
        if (!usage.get('')) usage.delete('');
        usage.set(killMonth, (usage.get(killMonth) || 0) + (was - now));
      }
    });
  });
  linkedQueues.forEach((queue) => queue.forEach((entry) => genericEntries.push(entry)));
  const batchQueue = genericEntries.sort((a, b) => a.soldAt.localeCompare(b.soldAt));

  // Walking kills and batches both in date order, oldest-to-oldest, and
  // just taking whatever's actually left in the queue for each kill (not
  // requiring it to fully cover the kill first) naturally handles all
  // three cases: a kill whose quantity fits entirely gets marked fully
  // Sold; a kill straddling the exact point the queue runs dry gets
  // however much *is* left (a real partial, with a price scaled to just
  // that covered portion); and every kill after that gets 0, since the
  // queue is already empty by the time its turn comes -- without an
  // earlier, larger kill's shortfall letting a later, smaller kill "jump
  // the line" to grab leftover stock instead.
  const updatesByEvent = new Map();
  for (const s of sources) {
    const { taken, diamondsTotal, crowsTotal, anyDiamonds, anyCrows } = lockedResults.get(s.itemId) || drawFromQueue(batchQueue, s.quantity, String(s.eventDate).slice(0, 7));
    const diamondsValue = taken > 0 && anyDiamonds ? diamondsTotal : null;
    const crowsValue = taken > 0 && anyCrows ? crowsTotal : null;
    if (!updatesByEvent.has(s.eventId)) updatesByEvent.set(s.eventId, []);
    updatesByEvent.get(s.eventId).push({ itemId: s.itemId, soldQuantity: taken, sold: taken >= s.quantity, diamondsValue, crowsValue });
  }
  return { updatesByEvent, usageByBatch };
}

// onlyMonth ('YYYY-MM') limits what's saved to that month's kills.
async function applyFifoSalesToItem(itemKey, onlyMonth) {
  const { updatesByEvent } = computeFifoAllocation(itemKey);
  if (onlyMonth) {
    Array.from(updatesByEvent.keys()).forEach((eventId) => {
      const ev = sovereignState.worldBossEvents.find((e) => e.id === eventId);
      if (!ev || String(ev.eventDate).slice(0, 7) !== onlyMonth) updatesByEvent.delete(eventId);
    });
  }

  // Skip writing an event whose computed result exactly matches what's
  // already stored -- this runs opportunistically on every page load (see
  // reconcileFifoSales), not just right after a sale changes, so most runs
  // should find nothing to do and shouldn't spam a no-op PUT (and its
  // activity-log entry) for it.
  const results = await Promise.all(
    Array.from(updatesByEvent.entries()).map(([eventId, updates]) => {
      const ev = sovereignState.worldBossEvents.find((e) => e.id === eventId);
      if (!ev) return null;
      const changed = updates.some((u) => {
        const l = ev.lootItems.find((x) => x.id === u.itemId);
        return !l || l.sold !== u.sold || Number(l.soldQuantity) !== Number(u.soldQuantity) || l.diamondsValue !== u.diamondsValue || l.crowsValue !== u.crowsValue;
      });
      if (!changed) return null;
      const updatedLootItems = ev.lootItems.map((l) => {
        const match = updates.find((u) => u.itemId === l.id);
        if (!match) return { itemName: l.itemName, quantity: l.quantity, crowsValue: l.crowsValue, diamondsValue: l.diamondsValue, sold: l.sold, soldQuantity: l.soldQuantity };
        return { itemName: l.itemName, quantity: l.quantity, crowsValue: match.crowsValue, diamondsValue: match.diamondsValue, sold: match.sold, soldQuantity: match.soldQuantity };
      });
      return api(`/api/world-boss-attendance/${eventId}`, { method: 'PUT', body: JSON.stringify({ lootItems: updatedLootItems }) }).then((updated) => ({ eventId, updated }));
    })
  );
  results.forEach((r) => {
    if (!r) return;
    const idx = sovereignState.worldBossEvents.findIndex((e) => e.id === r.eventId);
    if (idx !== -1) sovereignState.worldBossEvents[idx] = r.updated;
  });
}

// Editing a Crows/Diamonds cell in This Month's Loot edits a *merged* total,
// which has no single row of its own to save to -- so the whole delta (new
// total minus old total) gets applied to the earliest kill that contributed
// to this item, and everything downstream (this table's totals/chips, the
// day-detail loot card, the attendance summary) re-renders from the saved
// result, giving the "auto compute" the edit needs.
// Splits `total` proportional to `weights`, to 2 decimal places, guaranteed
// to sum back to exactly `total` (largest-remainder method run in "cents" --
// floor each share, then hand out the few leftover cents to whichever
// shares had the biggest fractional remainder, so it's not always the same
// source absorbing the rounding error). Not rounded to whole numbers: these
// are NUMERIC columns specifically so a total split across kills doesn't
// have to land on whole units.
function distributeProportionally(total, weights) {
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  if (sumWeights === 0) return weights.map(() => 0);
  const totalCents = Math.round(total * 100);
  const raw = weights.map((w) => (totalCents * w) / sumWeights);
  const shares = raw.map(Math.floor);
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  const byRemainder = raw.map((r, i) => ({ i, frac: r - shares[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) shares[byRemainder[k % byRemainder.length].i] += 1;
  return shares.map((cents) => cents / 100);
}

// Editing the aggregate row's Crows/Diamonds total splits it across every
// contributing kill proportional to how much quantity each one contributed,
// rather than dumping the whole amount into a single kill -- e.g. entering
// a total you only know in aggregate (sold everything at once) still ends
// up attributed sensibly per kill. Sources can span multiple different
// kills, so this may update more than one attendance record at once.
//
// Sources already marked Sold are left out of the split: they were priced
// separately (e.g. sold in an earlier batch at a different rate), so an
// aggregate edit only redistributes the new total across the still-unsold
// sources, never overwriting a price that's already locked in by a sale.
// If every source is already sold, fall back to splitting across all of
// them since there's nothing else to distribute into.
// Shared by manual aggregate edits and the sale-driven auto-fill below:
// splits `newTotal` across `targets` (each {eventId, itemId, quantity})
// proportional to quantity, and PUTs the result back into whichever
// attendance records those sources belong to.
async function splitLootFieldAcrossSources(targets, field, newTotal) {
  const shares = distributeProportionally(
    newTotal,
    targets.map((s) => s.quantity)
  );
  const updatesByEvent = new Map();
  targets.forEach((s, i) => {
    if (!updatesByEvent.has(s.eventId)) updatesByEvent.set(s.eventId, []);
    updatesByEvent.get(s.eventId).push({ itemId: s.itemId, share: shares[i] });
  });

  const results = await Promise.all(
    Array.from(updatesByEvent.entries()).map(([eventId, updates]) => {
      const ev = sovereignState.worldBossEvents.find((e) => e.id === eventId);
      if (!ev) return null;
      const updatedLootItems = ev.lootItems.map((l) => {
        const base = { itemName: l.itemName, quantity: l.quantity, crowsValue: l.crowsValue, diamondsValue: l.diamondsValue, sold: l.sold, soldQuantity: l.soldQuantity };
        const match = updates.find((u) => u.itemId === l.id);
        if (match) base[field] = match.share;
        return base;
      });
      return api(`/api/world-boss-attendance/${eventId}`, { method: 'PUT', body: JSON.stringify({ lootItems: updatedLootItems }) }).then((updated) => ({
        eventId,
        updated,
      }));
    })
  );
  results.forEach((r) => {
    if (!r) return;
    const idx = sovereignState.worldBossEvents.findIndex((e) => e.id === r.eventId);
    if (idx !== -1) sovereignState.worldBossEvents[idx] = r.updated;
  });
}

// Editing the aggregate row's Crows/Diamonds total splits it across every
// contributing kill proportional to how much quantity each one contributed,
// rather than dumping the whole amount into a single kill -- e.g. entering
// a total you only know in aggregate (sold everything at once) still ends
// up attributed sensibly per kill. Sources can span multiple different
// kills, so this may update more than one attendance record at once.
//
// Sources already marked Sold are left out of the split: they were priced
// separately (e.g. sold in an earlier batch at a different rate), so an
// aggregate edit only redistributes the new total across the still-unsold
// sources, never overwriting a price that's already locked in by a sale.
// If every source is already sold, fall back to splitting across all of
// them since there's nothing else to distribute into.
async function saveMonthlyLootEdit(input) {
  const row = worldBossMonthlyLootRows[Number(input.getAttribute('data-loot-row-index'))];
  const field = input.getAttribute('data-loot-field');
  if (!row || !row.sources.length) return;

  const unsold = row.sources.filter((s) => !s.sold);
  const targets = unsold.length ? unsold : row.sources;
  const newTotal = input.value === '' ? 0 : Math.max(0, Number(input.value));

  try {
    await splitLootFieldAcrossSources(targets, field, newTotal);
    renderWorldBossLog(); // re-renders the calendar/day-detail/monthly loot/summary together
    toast(
      targets.length > 1
        ? unsold.length
          ? 'Loot updated — split across unsold kills by quantity'
          : 'Loot updated — split across kills by quantity'
        : 'Loot updated'
    );
  } catch (err) {
    toast(err.message);
    renderWorldBossMonthlyLoot(); // revert the input back to the last known-good value
  }
}

// Which boss an item drops from is a fact about the item itself, saved
// separately from any specific kill record -- picking it here updates
// instantly and applies everywhere that item name shows up.
async function saveLootItemSource(select, row) {
  if (!row) return;
  const bossName = select.value || null;
  try {
    await api('/api/loot-item-sources', { method: 'PUT', body: JSON.stringify({ itemName: row.itemName, bossName, schedule: worldBossActiveSchedule }) });
    sovereignState.lootItemSources.set(`${worldBossActiveSchedule}:${row.itemKey}`, bossName);
    toast(bossName ? `${row.itemName} now shows as dropping from ${bossName}` : `Cleared ${row.itemName}'s drop source`);
  } catch (err) {
    toast(err.message);
    renderWorldBossMonthlyLoot();
  }
}

// Edits one field (quantity/Crows/Diamonds) on one exact drop, identified
// directly by its event + item id -- unlike the aggregate-row editor above
// (which has to guess by applying a delta to the earliest contributing
// kill), the breakdown always knows precisely which drop it's touching.
async function saveLootSourceField(input) {
  const eventId = input.getAttribute('data-source-event');
  const itemId = input.getAttribute('data-source-item');
  const field = input.getAttribute('data-source-field');
  const ev = sovereignState.worldBossEvents.find((e) => e.id === eventId);
  if (!ev) return;

  const updatedLootItems = ev.lootItems.map((l) => {
    const base = { itemName: l.itemName, quantity: l.quantity, crowsValue: l.crowsValue, diamondsValue: l.diamondsValue, sold: l.sold, soldQuantity: l.soldQuantity };
    if (l.id !== itemId) return base;
    if (field === 'quantity') base.quantity = Math.max(1, Number(input.value) || 1);
    else base[field] = input.value === '' ? null : Math.max(0, Number(input.value));
    return base;
  });

  try {
    const updated = await api(`/api/world-boss-attendance/${eventId}`, { method: 'PUT', body: JSON.stringify({ lootItems: updatedLootItems }) });
    const idx = sovereignState.worldBossEvents.findIndex((e) => e.id === eventId);
    if (idx !== -1) sovereignState.worldBossEvents[idx] = updated;
    renderWorldBossLog();
    toast('Loot updated');
  } catch (err) {
    toast(err.message);
    renderWorldBossMonthlyLoot();
  }
}

function renderWorldBossCalendarGrid(byDate) {
  const year = worldBossCalendarMonth.getFullYear();
  const month = worldBossCalendarMonth.getMonth();
  document.getElementById('worldBossCalMonthLabel').textContent = worldBossCalendarMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = new Date().toISOString().slice(0, 10);
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="crusade-calendar-cell is-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayEvents = byDate.get(dateKey);
    const classes = ['crusade-calendar-cell'];
    if (dayEvents) classes.push('has-events');
    if (dateKey === todayKey) classes.push('is-today');
    if (dateKey === worldBossSelectedDate) classes.push('is-selected');
    cells.push(`
      <div class="${classes.join(' ')}" ${dayEvents ? `data-calendar-date="${dateKey}"` : ''}>
        <span class="crusade-calendar-daynum">${day}</span>
        ${dayEvents ? `<span class="crusade-calendar-badge">${dayEvents.length} boss${dayEvents.length === 1 ? '' : 'es'}</span>` : ''}
      </div>`);
  }
  while (cells.length % 7 !== 0) cells.push('<div class="crusade-calendar-cell is-empty"></div>');

  const grid = document.getElementById('worldBossCalendarGrid');
  grid.innerHTML = weekdayLabels.map((w) => `<div class="crusade-calendar-weekday">${w}</div>`).join('') + cells.join('');

  grid.querySelectorAll('[data-calendar-date]').forEach((cell) => {
    cell.addEventListener('click', () => {
      worldBossSelectedDate = cell.getAttribute('data-calendar-date');
      renderWorldBossLog();
    });
  });
}

function formatLootValue(n) {
  return n === null || n === undefined ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Known misspellings of an item name, mapped to the correct one -- corrects
// display and merges them with the correctly-spelled entries everywhere,
// without needing to go fix every already-submitted record in the database.
const ITEM_NAME_ALIASES = new Map([
  ['golden inner armor insignia fragmer', 'Golden Inner Armor Insignia Fragment'],
  ['aura of circulatingg manifestation', 'Aura of Circulating Manifestation'],
  ["forgotten arbitter's remnant", "Forgotten Arbiter's Remnant"],
  ['silver insignia fragment', 'Silver Shield Insignia Fragment'],
  ['higher seal of advancemment', 'Higher Seal of Advancement'],
]);
function canonicalizeItemName(name) {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  return ITEM_NAME_ALIASES.get(cleaned.toLowerCase()) || cleaned;
}

// Items that can be minted -- highlighted in blue wherever a loot item badge
// shows up, so they stand out from ordinary drops at a glance.
const MINTABLE_ITEM_NAMES = new Set(
  ['Frozen Tear', 'Higher Seal of Advancement', 'Piece of the Sky', 'Meticulous Aircraft Component', 'Essence of Curses'].map((n) => n.toLowerCase())
);
function lootItemBadgeClass(itemName) {
  return MINTABLE_ITEM_NAMES.has(itemName.trim().toLowerCase()) ? 'crusade-loot-item-badge is-mintable' : 'crusade-loot-item-badge';
}

// Its own standout card under a boss's attendee list (still nested inside
// that boss's day-row) -- the full Item/Quantity/Crows/Diamonds breakdown
// as a table lives separately in the monthly loot view.
function lootRowsHtml(lootItems) {
  if (!lootItems || !lootItems.length) return '';
  const rows = lootItems
    .map((l) => {
      const itemName = canonicalizeItemName(l.itemName);
      const values = [];
      if (l.crowsValue !== null) values.push(`<span class="crusade-loot-currency crows">🪙 ${formatLootValue(l.crowsValue)}</span>`);
      if (l.diamondsValue !== null) values.push(`<span class="crusade-loot-currency diamonds">💎 ${formatLootValue(l.diamondsValue)}</span>`);
      return `
      <div class="crusade-loot-highlight-row">
        <span class="${lootItemBadgeClass(itemName)}">${escapeHtml(itemName)} ×${l.quantity}</span>
        ${values.join(' ')}
      </div>`;
    })
    .join('');
  return `
    <div class="crusade-loot-highlight-card">
      <div class="crusade-loot-highlight-heading">🎁 Loot</div>
      ${rows}
    </div>`;
}

function renderWorldBossDayDetail(byDate) {
  const detail = document.getElementById('worldBossCalendarDayDetail');
  if (!worldBossSelectedDate || !byDate.has(worldBossSelectedDate)) {
    detail.innerHTML = byDate.size ? `<p class="empty-state">Click a highlighted day above to see its records.</p>` : '';
    return;
  }

  // Earliest kill of the day first -- byDate's own grouping doesn't
  // guarantee any particular order, and now that a kill records a specific
  // time (not just the day), the natural reading order is chronological.
  const dayEvents = byDate.get(worldBossSelectedDate).slice().sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
  const totalAttended = new Set(dayEvents.flatMap((ev) => ev.attendees.map((a) => a.name.toLowerCase()))).size;

  function attendeeBadges(attendees) {
    return attendees
      .map((a) => {
        const color = a.guildName ? crusadeGuildColor(a.guildName) || 'var(--text-muted)' : 'var(--text-muted)';
        return `<span class="crusade-guild-badge" style="color:${color}; border-color:${color};" title="${escapeHtml(a.guildName || '')}">${escapeHtml(a.name)}</span>`;
      })
      .join('');
  }

  const bossRows = dayEvents
    .map(
      (ev) => `
    <div class="crusade-world-boss-day-row ${ev.id === worldBossEditingId ? 'crusade-world-boss-day-row-editing' : ''}">
      <div class="crusade-world-boss-day-row-header" data-toggle-world-boss-log="${ev.id}">
        <span style="font-weight:600;">${escapeHtml(ev.bossName)}</span>
        <span style="color:var(--text-muted); font-size:12px;">${parseWorldBossEventDate(ev.eventDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span style="color:var(--text-muted);">${ev.attendees.length} attended</span>
        ${ev.result && ev.result !== 'pending' ? `<span class="crusade-status-badge ${ev.result}">${t(`sovereign.worldBoss.result${ev.result === 'win' ? 'Win' : 'Lose'}`)}</span>` : ''}
        ${ev.bonusPoints ? `<span style="color:var(--text-muted); font-size:12px;">+${formatLootValue(ev.bonusPoints)} pts</span>` : ''}
        <div class="admin-only" style="display:flex; gap:6px; margin-left:auto;">
          <button type="button" class="icon-btn" data-copy-world-boss-attendees="${ev.id}" title="Copy attendee list">📋</button>
          <button type="button" class="icon-btn" data-edit-world-boss="${ev.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn" data-delete-world-boss="${ev.id}" title="Remove">✕</button>
        </div>
      </div>
      <div class="hidden" id="worldBossAttendees-${ev.id}">
        <div style="padding:8px 0 4px; display:flex; flex-wrap:wrap; gap:8px;">
          ${attendeeBadges(ev.attendees)}
        </div>
        ${lootRowsHtml(ev.lootItems)}
      </div>
    </div>`
    )
    .join('');

  detail.innerHTML = `
    <div class="crusade-party-card">
      <div class="crusade-party-card-header">
        <h3 style="margin:0;">${formatLongDate(worldBossSelectedDate)} <span style="color:var(--text-muted); font-weight:400;">(${dayEvents.length} boss${dayEvents.length === 1 ? '' : 'es'}, ${totalAttended} unique attendee${totalAttended === 1 ? '' : 's'})</span></h3>
      </div>
      <div style="padding:0 16px 12px;">${bossRows}</div>
    </div>`;

  detail.querySelectorAll('[data-toggle-world-boss-log]').forEach((header) => {
    header.addEventListener('click', () => {
      const id = header.getAttribute('data-toggle-world-boss-log');
      document.getElementById(`worldBossAttendees-${id}`).classList.toggle('hidden');
    });
  });

  detail.querySelectorAll('[data-copy-world-boss-attendees]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-copy-world-boss-attendees');
      const ev = (sovereignState.worldBossEvents || []).find((x) => x.id === id);
      if (!ev) return;
      const names = ev.attendees.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
      const text = `${ev.bossName} — ${formatWorldBossEventDateTime(ev.eventDate)}\nAttendees (${ev.attendees.length}):\n${names}`;
      try {
        await navigator.clipboard.writeText(text);
        toast('Attendee list copied');
      } catch (err) {
        toast('Could not copy — clipboard access blocked');
      }
    });
  });

  detail.querySelectorAll('[data-edit-world-boss]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-edit-world-boss');
      const ev = (sovereignState.worldBossEvents || []).find((x) => x.id === id);
      if (!ev) return;
      // Only one row is "being edited" at a time -- clear any previous
      // highlight before marking this one.
      detail.querySelectorAll('.crusade-world-boss-day-row-editing').forEach((row) => row.classList.remove('crusade-world-boss-day-row-editing'));
      btn.closest('.crusade-world-boss-day-row').classList.add('crusade-world-boss-day-row-editing');
      startEditingWorldBossEvent(ev);
    });
  });

  detail.querySelectorAll('[data-delete-world-boss]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-world-boss');
      const ev = (sovereignState.worldBossEvents || []).find((x) => x.id === id);
      if (!confirm(`Remove the ${ev?.bossName} attendance record for ${ev?.eventDate}?`)) return;
      try {
        await api(`/api/world-boss-attendance/${id}`, { method: 'DELETE' });
        sovereignState.worldBossEvents = sovereignState.worldBossEvents.filter((x) => x.id !== id);
        renderWorldBossLog(); // also re-renders the attendance summary
        toast('Attendance record removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// Changing months clears the day selection -- otherwise the detail panel
// below could keep showing a day from whatever month you just navigated
// away from, which reads as a bug rather than "still selected."
document.getElementById('worldBossCalPrevBtn').addEventListener('click', () => {
  worldBossCalendarMonth = new Date(worldBossCalendarMonth.getFullYear(), worldBossCalendarMonth.getMonth() - 1, 1);
  worldBossSelectedDate = null;
  renderWorldBossLog();
});
document.getElementById('worldBossCalNextBtn').addEventListener('click', () => {
  worldBossCalendarMonth = new Date(worldBossCalendarMonth.getFullYear(), worldBossCalendarMonth.getMonth() + 1, 1);
  worldBossSelectedDate = null;
  renderWorldBossLog();
});
document.getElementById('worldBossCalTodayBtn').addEventListener('click', () => {
  const now = new Date();
  worldBossCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  worldBossSelectedDate = null;
  renderWorldBossLog();
});

// Renders the repeatable Item/Quantity/Crows/Diamonds rows in the log-attendance
// form. Each row is standalone markup (not tied to a form field array by
// index) so rows can be added/removed freely; values are read back by
// collectLootRowsFromForm() at submit time.
function renderWorldBossLootRows(lootItems) {
  const container = document.getElementById('worldBossLootRows');
  container.innerHTML = '';
  (lootItems && lootItems.length ? lootItems : []).forEach((item) => addWorldBossLootRow(item));
}

// Every item name ever logged (canonicalized through the same typo-merge
// logic as the loot tables), each mapped to its most recently entered
// Crows/Diamonds values -- events come back from the API newest-first, so
// whichever occurrence is seen first per item is already the latest one.
function computeKnownLootItems() {
  const known = new Map();
  getScheduleEvents().forEach((ev) => {
    (ev.lootItems || []).forEach((item) => {
      const itemName = canonicalizeItemName(item.itemName);
      const key = itemName.toLowerCase();
      if (!known.has(key)) known.set(key, { itemName, crowsValue: item.crowsValue, diamondsValue: item.diamondsValue });
    });
  });
  return known;
}

// Shared by the "+ Add Item" button and pressing Enter in a row's item name
// field, so both paths get the same "pick a boss first" guard.
function addWorldBossLootRowIfBossChosen() {
  if (!document.getElementById('worldBossNameSelect').value) {
    toast('Pick a boss before adding loot');
    return null;
  }
  return addWorldBossLootRow();
}

function addWorldBossLootRow(item) {
  const row = document.createElement('div');
  row.className = 'crusade-loot-row';
  row.innerHTML = `
    <div class="crusade-loot-item-field">
      <input type="text" data-loot-field="itemName" placeholder="Item name" maxlength="120" autocomplete="off" value="${escapeHtml(item?.itemName || '')}">
      <div class="crusade-loot-suggest-list hidden"></div>
    </div>
    <input type="number" data-loot-field="quantity" placeholder="Qty" min="1" step="1" value="${item?.quantity ?? 1}">
    <input type="hidden" data-loot-field="crowsValue" value="${item?.crowsValue ?? ''}">
    <input type="hidden" data-loot-field="diamondsValue" value="${item?.diamondsValue ?? ''}">
    <button type="button" class="icon-btn" title="Remove item">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());

  const nameInput = row.querySelector('[data-loot-field="itemName"]');
  const suggestList = row.querySelector('.crusade-loot-suggest-list');
  const quantityInput = row.querySelector('[data-loot-field="quantity"]');

  // Enter in Quantity also adds the next row and jumps into its item name
  // field, same as Enter in the item name field itself -- there's no
  // suggestion list on it to intercept it first. (Crows/Diamonds aren't on
  // this form: a kill's price only ever comes from a recorded sale, see
  // This Month's Loot.)
  [quantityInput].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const newRow = addWorldBossLootRowIfBossChosen();
      newRow?.querySelector('[data-loot-field="itemName"]').focus();
    });
  });

  // Tracks which suggestion arrow-key navigation has landed on, so Enter can
  // pick it instead of falling through to "add a new row" -- reset whenever
  // the list's contents change since the item at a given index moves.
  let highlightedIndex = -1;

  function pickSuggestion(el) {
    nameInput.value = el.getAttribute('data-suggest-name');
    suggestList.classList.add('hidden');
    highlightedIndex = -1;
  }

  function highlightSuggestion(nextIndex) {
    const items = Array.from(suggestList.querySelectorAll('[data-suggest-name]'));
    if (!items.length) {
      highlightedIndex = -1;
      return;
    }
    highlightedIndex = ((nextIndex % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('is-highlighted', i === highlightedIndex));
    items[highlightedIndex].scrollIntoView({ block: 'nearest' });
  }

  // Custom dropdown (not a native <datalist>) so it can be sized to exactly
  // match the input's width -- a native datalist's popup can't be
  // width-constrained consistently across browsers.
  function showSuggestions() {
    highlightedIndex = -1;
    const query = nameInput.value.trim().toLowerCase();
    const known = computeKnownLootItems();
    // Also offer whatever's already typed into this form's other loot rows
    // (including brand-new item names that haven't been saved anywhere
    // yet) -- so adding "New Item" in row 1 then clicking + Add Item makes
    // it suggestible in row 2 right away, instead of only after saving.
    document.querySelectorAll('#worldBossLootRows .crusade-loot-row [data-loot-field="itemName"]').forEach((input) => {
      if (input === nameInput) return;
      const name = input.value.trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!known.has(key)) known.set(key, { itemName: name, crowsValue: null, diamondsValue: null });
    });
    const knownList = Array.from(known.values()).sort((a, b) => a.itemName.localeCompare(b.itemName));
    const matches = (query ? knownList.filter((o) => o.itemName.toLowerCase().includes(query)) : knownList).slice(0, 20);
    if (!matches.length) {
      suggestList.classList.add('hidden');
      suggestList.innerHTML = '';
      return;
    }
    suggestList.innerHTML = matches.map((o) => `<div class="crusade-loot-suggest-item" data-suggest-name="${escapeHtml(o.itemName)}">${escapeHtml(o.itemName)}</div>`).join('');
    suggestList.classList.remove('hidden');
    suggestList.querySelectorAll('[data-suggest-name]').forEach((el) => {
      // mousedown (not click) fires before the input's blur, so the
      // dropdown's own blur-hide handler below doesn't swallow the pick.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickSuggestion(el);
      });
    });
  }

  nameInput.addEventListener('input', showSuggestions);
  nameInput.addEventListener('focus', showSuggestions);
  nameInput.addEventListener('blur', () => setTimeout(() => suggestList.classList.add('hidden'), 150));
  // Arrow keys move the highlight through the open suggestion list; Enter
  // picks whatever's highlighted. Only once nothing is highlighted (list
  // closed, or no suggestions match) does Enter fall through to adding the
  // next row, so a fast admin can log several items keyboard-only either way.
  nameInput.addEventListener('keydown', (e) => {
    const isOpen = !suggestList.classList.contains('hidden') && suggestList.children.length;
    if (e.key === 'ArrowDown') {
      if (!isOpen) return;
      e.preventDefault();
      highlightSuggestion(highlightedIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!isOpen) return;
      e.preventDefault();
      highlightSuggestion(highlightedIndex - 1);
      return;
    }
    if (e.key === 'Escape') {
      if (!isOpen) return;
      suggestList.classList.add('hidden');
      highlightedIndex = -1;
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (isOpen && highlightedIndex >= 0) {
      pickSuggestion(suggestList.children[highlightedIndex]);
      return;
    }
    const newRow = addWorldBossLootRowIfBossChosen();
    newRow?.querySelector('[data-loot-field="itemName"]').focus();
  });

  document.getElementById('worldBossLootRows').appendChild(row);
  return row;
}

document.getElementById('worldBossAddLootRowBtn').addEventListener('click', () => {
  addWorldBossLootRowIfBossChosen();
});

function collectLootRowsFromForm() {
  return Array.from(document.querySelectorAll('#worldBossLootRows .crusade-loot-row'))
    .map((row) => ({
      itemName: row.querySelector('[data-loot-field="itemName"]').value.trim(),
      quantity: Number(row.querySelector('[data-loot-field="quantity"]').value) || 1,
      crowsValue: row.querySelector('[data-loot-field="crowsValue"]').value === '' ? null : Number(row.querySelector('[data-loot-field="crowsValue"]').value),
      diamondsValue: row.querySelector('[data-loot-field="diamondsValue"]').value === '' ? null : Number(row.querySelector('[data-loot-field="diamondsValue"]').value),
    }))
    .filter((item) => item.itemName);
}

// Bonus Points only makes sense once a result is actually decided (win or
// lose, admin's call either way) -- keep the field hidden while Pending so
// it doesn't look like a routine part of every log entry.
function updateWorldBossBonusPointsVisibility() {
  // Bonus Points (and the Points/Salary pages built on it) are a World Boss
  // concept only -- BF4 Boss is a separate, higher-gear roster that
  // shouldn't feed into either.
  const isDecided = document.getElementById('worldBossResultSelect').value !== 'pending';
  document.getElementById('worldBossBonusPointsField').classList.toggle('hidden', !isDecided || worldBossActiveSchedule === 'bf4');
}
document.getElementById('worldBossResultSelect').addEventListener('change', updateWorldBossBonusPointsVisibility);

// Reveals the attendee checklist (or hides it again if cleared back to the
// blank placeholder) -- see the guard at the top of renderWorldBossMemberGrid.
document.getElementById('worldBossNameSelect').addEventListener('change', () => {
  const currentlyChecked = new Set(Array.from(document.querySelectorAll('.world-boss-attendee-check:checked')).map((cb) => cb.value));
  renderWorldBossMemberGrid(currentlyChecked);
});

function startEditingWorldBossEvent(ev) {
  worldBossEditingId = ev.id;
  worldBossExtraAttendeeNames = new Set();
  const form = document.getElementById('worldBossForm');
  form.elements.eventId.value = ev.id;
  form.elements.bossName.value = ev.bossName;
  form.elements.eventDate.value = toDatetimeLocalValue(ev.eventDate);
  form.elements.result.value = ev.result || 'pending';
  form.elements.bonusPoints.value = ev.bonusPoints ?? '';
  updateWorldBossBonusPointsVisibility();
  renderWorldBossLootRows(ev.lootItems);
  renderWorldBossMemberGrid(new Set(ev.attendees.map((a) => a.name)));
  document.getElementById('worldBossFormHeading').textContent = `${t('sovereign.worldBoss.editHeading')} — ${ev.bossName}`;
  document.getElementById('worldBossCancelEditBtn').classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetWorldBossForm() {
  worldBossEditingId = null;
  worldBossExtraAttendeeNames = new Set();
  const form = document.getElementById('worldBossForm');
  form.reset();
  form.elements.eventId.value = '';
  form.elements.result.value = 'pending';
  updateWorldBossBonusPointsVisibility();
  renderWorldBossLootRows([]);
  renderWorldBossMemberGrid(new Set());
  document.getElementById('worldBossFormHeading').textContent = t('sovereign.worldBoss.logHeading');
  document.getElementById('worldBossCancelEditBtn').classList.add('hidden');
  document.querySelectorAll('.crusade-world-boss-day-row-editing').forEach((row) => row.classList.remove('crusade-world-boss-day-row-editing'));
}

document.getElementById('worldBossCancelEditBtn').addEventListener('click', resetWorldBossForm);

document.getElementById('worldBossForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  // Explicit checks (not just the inputs' own `required`) so there's a
  // clear reason given for not saving, in the same order the fields
  // appear -- boss and date/time before ever getting to attendees.
  if (!form.elements.bossName.value) {
    toast('Pick a boss before saving');
    return;
  }
  if (!form.elements.eventDate.value) {
    toast('Set the date & time before saving');
    return;
  }
  const attendeeNames = Array.from(document.querySelectorAll('.world-boss-attendee-check:checked')).map((cb) => cb.value);
  if (!attendeeNames.length) {
    toast('Check off at least one attendee');
    return;
  }
  const payload = {
    schedule: worldBossActiveSchedule,
    bossName: form.elements.bossName.value,
    eventDate: form.elements.eventDate.value,
    lootItems: collectLootRowsFromForm(),
    attendeeNames,
    result: form.elements.result.value,
    bonusPoints: form.elements.result.value !== 'pending' && form.elements.bonusPoints.value !== '' ? Number(form.elements.bonusPoints.value) : null,
  };
  try {
    if (worldBossEditingId) {
      const updated = await api(`/api/world-boss-attendance/${worldBossEditingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignState.worldBossEvents.findIndex((x) => x.id === worldBossEditingId);
      if (idx !== -1) sovereignState.worldBossEvents[idx] = updated;
      toast('Attendance record updated');
    } else {
      const created = await api('/api/world-boss-attendance', { method: 'POST', body: JSON.stringify(payload) });
      sovereignState.worldBossEvents.unshift(created);
      toast('Attendance logged');
    }
    resetWorldBossForm();
    // Jump the calendar to whatever day was just logged/edited, so the
    // result is immediately visible instead of leaving the admin to hunt
    // for it.
    const [y, m] = payload.eventDate.split('-').map(Number);
    worldBossCalendarMonth = new Date(y, m - 1, 1);
    worldBossSelectedDate = payload.eventDate.slice(0, 10);
    renderWorldBossLog(); // also re-renders the attendance summary
    await reconcileFifoSales(); // re-derives this month's sold status/prices from Sales
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Points leaderboard (standalone, independent of any crusade) ----------
// Bonus points awarded to attendees of a lost World Boss / BF4 Boss fight
// (see the Result/Bonus Points fields on the attendance form above).

async function loadPointsLeaderboard() {
  const rows = await api('/api/world-boss-bonus-points/leaderboard');
  renderPointsLeaderboard(rows);
}

function renderPointsLeaderboard(rows) {
  document.getElementById('pointsLeaderboardEmptyState').classList.toggle('hidden', rows.length !== 0);
  document.getElementById('pointsLeaderboardBody').innerHTML = rows
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${formatLootValue(r.points)}</td>
      <td>${r.eventCount.toLocaleString()}</td>
    </tr>`
    )
    .join('');
}

// ---------- Salary (standalone, independent of any crusade) ----------
// Splits a Diamonds/Crows pool across everyone who attended World Boss in
// the selected month, weighted by both how often they showed up and their
// Growth Rate. Attendance is World Boss only (not BF4 Boss) -- a different,
// higher-gear roster that isn't meant to factor into this.
//
// Brackets picked from the actual live Growth Rate spread the day this was
// built (roughly 447k-921k across ~90 submissions, median ~628k) --
// spaced in even 100k steps from 500k so the multiplier climbs smoothly
// across that range instead of clustering everyone into one or two tiers.
// Adjust freely; there's nothing else derived from these exact numbers.
const SALARY_GR_MULTIPLIER_BRACKETS = [
  { min: 0, max: 500000, multiplier: 1.0 },
  { min: 500000, max: 600000, multiplier: 1.1 },
  { min: 600000, max: 700000, multiplier: 1.2 },
  { min: 700000, max: 800000, multiplier: 1.3 },
  { min: 800000, max: Infinity, multiplier: 1.4 },
];
// One fixed order for "who ranks higher" -- Growth Rate, then more
// attendance, then name -- used both for the Balthazard top-10 bonus and
// the table's row order, so a GR tie always resolves the same way (and the
// Excel export's rank formula, which follows row order, agrees with it).
function compareSalaryRank(a, b) {
  return b.growthRate - a.growthRate || b.attendance - a.attendance || String(a.ign).localeCompare(String(b.ign));
}

function multiplierForGrowthRate(growthRate) {
  const rate = Number(growthRate) || 0;
  const bracket = SALARY_GR_MULTIPLIER_BRACKETS.find((b) => rate >= b.min && rate < b.max);
  return bracket ? bracket.multiplier : SALARY_GR_MULTIPLIER_BRACKETS[SALARY_GR_MULTIPLIER_BRACKETS.length - 1].multiplier;
}

// Balthazard-only: on top of the normal GR-bracket multiplier, the top 10
// attendees ranked by Growth Rate get an extra bump this month, tapering
// by 0.05 per rank from +0.50 at rank 1 down to +0.05 at rank 10. Index 0
// = rank 1's bonus.
const BALTHAZARD_TOP10_RANK_BONUS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];

// Sending diamonds in-game costs the sender a tax on top of what's
// received. Payouts go out as one transfer per guild (each guild's total,
// which that guild then hands out to its members), so the tax is charged on
// each guild's total at that guild's own rate (set on the Salary page,
// stored in salary_guild_taxes; this is the default for a guild with none
// set) and covered out of the diamond pool. Each person's Final is what
// they receive in full. Crows are sent without a fee.
const SALARY_DIAMOND_SEND_FEE_PERCENT = 5;

function salaryGuildKey(guildName) {
  return guildName || 'Unassigned';
}
function guildTaxPercent(guildName) {
  const saved = sovereignState.salaryGuildTaxes?.get(salaryGuildKey(guildName));
  return saved === undefined ? SALARY_DIAMOND_SEND_FEE_PERCENT : saved;
}

let salarySelectedMonth = null; // 'YYYY-MM'
// World Boss and Balthazard each get their own independent pool/attendance
// computation -- switching this re-fills the pool fields from that
// schedule's own sold totals instead of mixing the two together.
let salaryActiveSchedule = 'world_boss';
// The rows last rendered in the Salary Computation table -- what "Record
// payout" snapshots, so the saved amounts match exactly what was on screen.
let salaryComputedRows = [];
// Which guild rows in Total Guild Receives (live and in each payout) are
// open, remembered across re-renders (e.g. after changing a pool), keyed by
// table ("live" or a payout id) + guild.
const salaryExpandedGuilds = new Set();

async function loadSalaryComputation() {
  const [growthSubmissions, events, fees, saleBatches, payouts, guildTaxes] = await Promise.all([
    api('/api/growth-submissions'),
    api('/api/world-boss-attendance'),
    api('/api/world-boss-management-fees'),
    api('/api/loot-sale-batches'),
    api('/api/salary-payouts'),
    api('/api/salary-guild-taxes'),
  ]);
  sovereignState.salaryPayouts = payouts;
  sovereignState.salaryGuildTaxes = new Map(guildTaxes.map((g) => [g.guildName, g.percent]));
  sovereignState.growthSubmissions = growthSubmissions;
  sovereignState.worldBossEvents = events;
  sovereignState.salaryManagementFees = fees;
  sovereignState.lootSaleBatches = saleBatches;
  if (!salarySelectedMonth) salarySelectedMonth = new Date().toISOString().slice(0, 7);
  document.getElementById('salaryMonthInput').value = salarySelectedMonth;
  document.getElementById('salaryScheduleSelect').value = salaryActiveSchedule;
  renderSalaryManagementFees();
  fillSalaryPoolsFromSoldItems();
}

// Same total as the "This Month's Loot" header chip on that schedule's own
// page -- every kill's own diamondsValue/crowsValue logged in
// salarySelectedMonth, regardless of whether it's actually marked Sold yet.
// World Boss and Balthazard are computed one at a time, never combined, so
// switching schedules never mixes their totals together (BF4 was never
// salaried at all, so it's simply not one of the options).
function computeSoldTotalsForSalaryMonth() {
  const [year, month] = salarySelectedMonth.split('-').map(Number);
  const acc = { diamonds: 0, crows: 0 };
  (sovereignState.worldBossEvents || []).forEach((ev) => {
    if ((ev.schedule || 'world_boss') !== salaryActiveSchedule) return;
    const d = new Date(`${String(ev.eventDate).slice(0, 10)}T00:00:00`);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1) return;
    (ev.lootItems || []).forEach((item) => {
      acc.diamonds += item.diamondsValue || 0;
      acc.crows += item.crowsValue || 0;
    });
  });
  return acc;
}

// The pool inputs are plain text (not type="number") specifically so they
// can show comma-grouped thousands -- a number input strips anything that
// isn't a digit/decimal point, so commas have to be added/removed by hand
// here instead of relying on the input's own formatting.
function formatPoolInputValue(n) {
  return n ? Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function parsePoolInputValue(value) {
  return Number(String(value || '').replace(/,/g, '')) || 0;
}

// Pools fill in automatically from sold items whenever the page loads or
// the month changes -- no button to click. Still just a starting point:
// typing over either field (see the 'input' listeners below) is preserved
// until the month changes again.
//
// A month can be paid out in rounds: whatever was already sent (recorded
// payouts for this schedule+month) is subtracted, so the pools only hold
// loot sold since the last payout. Once the leftover items sell, their
// value shows up here as a new pool to split.
function fillSalaryPoolsFromSoldItems() {
  const totals = computeSoldTotalsForSalaryMonth();
  const paid = computePaidTotalsForSalaryMonth();
  const roundCents = (n) => Math.max(0, Math.round(n * 100) / 100);
  document.getElementById('salaryDiamondPoolInput').value = formatPoolInputValue(roundCents(totals.diamonds - paid.diamonds));
  document.getElementById('salaryCrowPoolInput').value = formatPoolInputValue(roundCents(totals.crows - paid.crows));
  const summary = document.getElementById('salaryPaidSummary');
  summary.classList.toggle('hidden', paid.count === 0);
  summary.innerHTML = paid.count
    ? `Sold so far: <strong>💎 ${formatLootValue(totals.diamonds)}</strong> · <strong>🪙 ${formatLootValue(totals.crows)}</strong> — already paid in ${paid.count} payout${paid.count === 1 ? '' : 's'}: <strong>💎 ${formatLootValue(paid.diamonds)}</strong> · <strong>🪙 ${formatLootValue(paid.crows)}</strong>. The pools above are only what's left to pay.`
    : '';
  renderSalaryComputation();
  renderSalaryPayoutHistory();
  updateNewComputationState();
}

// Once a payout has gone out this month, the live table is only for loot
// sold since then. With nothing new sold yet, show that plainly instead of
// a table of zeros (the payout just sent stays visible above, in full).
function updateNewComputationState() {
  const paidCount = salaryPayoutsForCurrentMonth().length;
  const nothingNew =
    paidCount > 0 &&
    !parsePoolInputValue(document.getElementById('salaryDiamondPoolInput').value) &&
    !parsePoolInputValue(document.getElementById('salaryCrowPoolInput').value);
  document.getElementById('salaryComputationHeading').textContent = paidCount
    ? `New computation — loot sold since Payout #${paidCount}`
    : t('sovereign.salary.computationHeading');
  document.getElementById('salaryNoNewSalesState').classList.toggle('hidden', !nothingNew);
  document.getElementById('salaryComputationContent').classList.toggle('hidden', nothingNew);
  document.getElementById('salaryGuildTotalsPanel').classList.toggle('hidden', nothingNew);
}

function salaryPayoutsForCurrentMonth() {
  return (sovereignState.salaryPayouts || []).filter((p) => p.schedule === salaryActiveSchedule && p.month === salarySelectedMonth);
}

// A payout's people grouped by guild -- biggest guild total first, members
// by Growth Rate within each -- matching how Total Guild Receives is laid
// out, since each guild's share goes out as one transfer.
//
// Payouts saved before the full computation row was kept have no
// growthRate of their own, so theirs is looked up from current Growth Rate
// submissions (same name matching as the salary table).
function payoutRowGrowthRate(r) {
  if (r.growthRate !== undefined && r.growthRate !== null) return Number(r.growthRate) || 0;
  const key = memberNameKey(r.ign);
  let best = 0;
  (sovereignState.growthSubmissions || []).forEach((sub) => {
    if (memberNameKey(sub.ign) === key) best = Math.max(best, Number(sub.growthRate) || 0);
  });
  return best;
}
function comparePayoutRowsByGr(a, b) {
  return (
    payoutRowGrowthRate(b) - payoutRowGrowthRate(a) ||
    (Number(b.attendance) || 0) - (Number(a.attendance) || 0) ||
    String(a.ign).localeCompare(String(b.ign))
  );
}
function groupPayoutRowsByGuild(rows) {
  const byGuild = new Map();
  rows.forEach((r) => {
    const key = salaryGuildKey(r.guildName);
    if (!byGuild.has(key)) byGuild.set(key, { guildName: key, rows: [], diamonds: 0, crows: 0 });
    const g = byGuild.get(key);
    g.rows.push(r);
    g.diamonds += Number(r.diamonds) || 0;
    g.crows += Number(r.crows) || 0;
  });
  const groups = Array.from(byGuild.values()).sort((a, b) => b.diamonds - a.diamonds || a.guildName.localeCompare(b.guildName));
  groups.forEach((g) => g.rows.sort(comparePayoutRowsByGr));
  return groups;
}

// What a payout spent on the 5% tax: its diamond pool minus what members
// actually received (~0 for payouts recorded before the tax existed).
function payoutTax(p) {
  return Math.max(0, p.diamondPool - p.rows.reduce((sum, r) => sum + (Number(r.diamonds) || 0), 0));
}

function computePaidTotalsForSalaryMonth() {
  const payouts = salaryPayoutsForCurrentMonth();
  return {
    count: payouts.length,
    diamonds: payouts.reduce((sum, p) => sum + p.diamondPool, 0),
    crows: payouts.reduce((sum, p) => sum + p.crowPool, 0),
  };
}

// Every payout already sent this month, oldest first, each kept on screen
// (open by default) with the full Salary Computation it was sent from and
// its per-guild transfers -- so recording a payout never makes the numbers
// that were just paid disappear; only loot sold afterward shows up in the
// live "New computation" table below.
function renderSalaryPayoutHistory() {
  const payouts = salaryPayoutsForCurrentMonth();
  document.getElementById('salaryPayoutHistoryPanel').classList.toggle('hidden', payouts.length === 0);
  document.getElementById('salaryPayoutHistory').innerHTML = payouts
    .map((p, i) => {
      // Older payouts only saved name/attendance/amounts, so any other
      // column they're missing shows as a dash.
      const val = (v, fmt) => (v === undefined || v === null ? '—' : fmt(Number(v)));
      const hasRank = p.rows.every((r) => r.growthRate !== undefined);
      const computationRows = p.rows
        .slice()
        .sort(hasRank ? compareSalaryRank : comparePayoutRowsByGr)
        .map(
          (r, n) => `
          <tr>
            <td>${n + 1}</td>
            <td>${escapeHtml(r.ign)}</td>
            <td class="member-only">${val(r.growthRate, (v) => v.toLocaleString())}</td>
            <td>${(r.attendance || 0).toLocaleString()}</td>
            <td>${val(r.multiplier, (v) => `${v.toFixed(2)}x`)}</td>
            <td>${val(r.baseShare, (v) => `${(v * 100).toFixed(2)}%`)}</td>
            <td>${val(r.baseMult, (v) => v.toFixed(4))}</td>
            <td>${val(r.normShare, (v) => `${(v * 100).toFixed(2)}%`)}</td>
            <td>${val(r.diamondInitial, formatLootValue)}</td>
            <td><strong>${formatLootValue(r.diamonds)}</strong></td>
            <td>${val(r.crowInitial, formatLootValue)}</td>
            <td><strong>${formatLootValue(r.crows)}</strong></td>
          </tr>`
        )
        .join('');
      const sumRows = (key) => p.rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);

      // Per-guild transfers, taxed on each guild's total at the rate saved
      // with the payout (r.taxPercent). Payouts from before per-guild rates
      // used the flat default; ones from before the tax existed at all
      // (pool == members' total) show no tax.
      const taxed = payoutTax(p) > 0.01;
      const guildRows = groupPayoutRowsByGuild(p.rows)
        .map((g) => {
          const taxPercent = taxed ? g.rows[0].taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT : 0;
          const tax = g.diamonds * (taxPercent / 100);
          const open = salaryExpandedGuilds.has(`${p.id}:${g.guildName}`);
          return `
          <tr class="salary-guild-row is-collapsible" data-guild-toggle="${p.id}:${escapeHtml(g.guildName)}" aria-expanded="${open}">
            <td><span class="salary-guild-chevron">${open ? '▾' : '▸'}</span>${crusadeGuildBadge(g.guildName === 'Unassigned' ? null : g.guildName)}</td>
            <td>${g.rows.length} ${g.rows.length === 1 ? 'member' : 'members'}</td>
            <td><strong>${formatLootValue(g.diamonds)}</strong></td>
            <td class="salary-tax-cell">${taxed ? `<span class="salary-guild-tax-rate">${taxPercent}%</span>${formatLootValue(tax)}` : '—'}</td>
            <td>${formatLootValue(g.diamonds + tax)}</td>
            <td><strong>${formatLootValue(g.crows)}</strong></td>
          </tr>${g.rows
            .map(
              (r) => `
          <tr class="salary-guild-member-row${open ? '' : ' hidden'}">
            <td>${escapeHtml(r.ign)}${hasGrowthEntryFor(r.ign) ? '' : linkOldIgnButton(r.ign) + removeFromPayoutsButton(r.ign)}</td>
            <td>${(r.attendance || 0).toLocaleString()} ${t('sovereign.salary.thAttendance').toLowerCase()}</td>
            <td>${formatLootValue(r.diamonds)}</td>
            <td class="salary-tax-cell">${taxed ? formatLootValue((Number(r.diamonds) || 0) * (taxPercent / 100)) : ''}</td>
            <td>${formatLootValue((Number(r.diamonds) || 0) * (1 + taxPercent / 100))}</td>
            <td>${formatLootValue(r.crows)}</td>
          </tr>`
            )
            .join('')}`;
        })
        .join('');
      return `
      <details class="salary-payout-entry" open>
        <summary>
          <strong>${escapeHtml(formatMonthYear(p.month))} — Payout #${i + 1}</strong>
          <span>Sent ${formatWorldBossEventDateTime(p.createdAt)}</span>
          <span>💎 ${formatLootValue(p.diamondPool)}</span>
          ${payoutTax(p) > 0.01 ? `<span class="salary-tax-cell">Tax 💎 ${formatLootValue(payoutTax(p))}</span>` : ''}
          <span>🪙 ${formatLootValue(p.crowPool)}</span>
          <span style="color:var(--text-muted);">${p.rows.length} people${p.createdBy ? ` · by ${escapeHtml(p.createdBy)}` : ''}</span>
          <button type="button" class="btn small salary-payout-export" data-export-salary-payout="${p.id}">${t('sovereign.salary.exportExcel')}</button>
          <button type="button" class="icon-btn admin-only" data-delete-salary-payout="${p.id}" title="Delete this payout">✕</button>
        </summary>
        <h3 class="salary-payout-subheading">${t('sovereign.salary.computationHeading')}</h3>
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr>
              <th>${t('sovereign.salary.thId')}</th><th>${t('sovereign.common.ign')}</th><th class="member-only">${t('sovereign.salary.thGrowthRate')}</th><th>${t('sovereign.salary.thAttendance')}</th>
              <th>${t('sovereign.salary.thMultiplier')}</th><th>${t('sovereign.salary.thBaseShare')}</th><th>${t('sovereign.salary.thBaseMult')}</th><th>${t('sovereign.salary.thNormShare')}</th>
              <th>${t('sovereign.salary.thDiamondInitial')}</th><th>${t('sovereign.salary.thDiamondFinal')}</th><th>${t('sovereign.salary.thCrowInitial')}</th><th>${t('sovereign.salary.thCrowFinal')}</th>
            </tr></thead>
            <tbody>${computationRows}</tbody>
            <tfoot><tr>
              <td colspan="2"></td><td class="member-only"></td><td colspan="5" style="text-align:right;">${t('sovereign.salary.thTotal')}</td><td></td>
              <td><strong>${formatLootValue(sumRows('diamonds'))}</strong></td><td></td><td><strong>${formatLootValue(sumRows('crows'))}</strong></td>
            </tr></tfoot>
          </table>
        </div>
        <h3 class="salary-payout-subheading">${t('sovereign.salary.guildTotalsHeading')}</h3>
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr>
              <th>${t('sovereign.common.guild')}</th><th>${t('sovereign.salary.thMembers')}</th><th>${t('sovereign.salary.thDiamondFinal')}</th>
              <th>${t('sovereign.salary.thDiamondSendFee')}</th><th>${t('sovereign.salary.thTotalCost')}</th><th>${t('sovereign.salary.thCrowFinal')}</th>
            </tr></thead>
            <tbody>${guildRows}</tbody>
          </table>
        </div>
      </details>`;
    })
    .join('');
}

document.getElementById('salaryRecordPayoutBtn').addEventListener('click', async () => {
  const diamondPool = parsePoolInputValue(document.getElementById('salaryDiamondPoolInput').value);
  const crowPool = parsePoolInputValue(document.getElementById('salaryCrowPoolInput').value);
  if (!diamondPool && !crowPool) {
    toast('Nothing to pay out -- both pools are 0');
    return;
  }
  const rows = salaryComputedRows.filter((r) => r.diamondFinal > 0 || r.crowFinal > 0);
  if (!rows.length) {
    toast('Nobody to pay this month');
    return;
  }
  const scheduleLabel = salaryActiveSchedule === 'balthazard' ? 'Balthazard' : 'World Boss';
  if (!confirm(`Record this ${scheduleLabel} payout for ${salarySelectedMonth}?\n\n💎 ${formatLootValue(diamondPool)} · 🪙 ${formatLootValue(crowPool)} to ${rows.length} people.\n\nThis amount will be subtracted from the month's pool, so the next computation only splits loot sold after this.`)) return;
  try {
    const created = await api('/api/salary-payouts', {
      method: 'POST',
      body: JSON.stringify({
        schedule: salaryActiveSchedule,
        month: salarySelectedMonth,
        diamondPool,
        crowPool,
        rows: rows.map((r) => ({
          ign: r.ign,
          guildName: r.guildName,
          attendance: r.attendance,
          diamonds: r.diamondFinal,
          crows: r.crowFinal,
          taxPercent: r.taxPercent,
          growthRate: r.growthRate,
          multiplier: r.multiplier,
          baseShare: r.baseShare,
          baseMult: r.baseMult,
          normShare: r.normShare,
          diamondInitial: r.diamondInitial,
          crowInitial: r.crowInitial,
          feePercent: r.feePercent,
        })),
      }),
    });
    sovereignState.salaryPayouts = [...(sovereignState.salaryPayouts || []), created];
    fillSalaryPoolsFromSoldItems();
    toast('Payout recorded');
  } catch (err) {
    toast(err.message);
  }
});

// SheetJS is only needed when someone actually exports, so it's loaded on
// first click instead of on every page load.
let sheetJsPromise = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // xlsx-js-style: SheetJS with cell styling (fills, fonts, borders,
      // alignment) -- plain SheetJS can't write styles.
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        sheetJsPromise = null;
        reject(new Error('Could not load the Excel exporter -- check your connection and try again'));
      };
      document.head.appendChild(script);
    });
  }
  return sheetJsPromise;
}

// Every piece of text the salary Excel exports put in a cell, sheet name or
// file name, in English and Chinese (Simplified, matching the site's 中文).
// Names (players, guilds, items, bosses) are data and stay as they are.
const SALARY_EXCEL_TEXT = {
  en: {
    sheetSalary: 'Salary', sheetFees: 'Management Fees', sheetGuilds: 'Guild Totals', sheetPayouts: 'Payouts',
    sheetUnsold: 'Loot', sheetRules: 'Rules', sheetPayout: 'Payout',
    worldBoss: 'World Boss', balthazard: 'Balthazard',
    salaryTitle: (sched, month) => `${sched} Salary — ${month}`,
    payoutTitle: (sched, month, n, date) => `${sched} Salary — ${month} — Payout #${n} (sent ${date})`,
    fileName: (sched, month) => `Salary - ${sched} - ${month}.xlsx`,
    payoutFileName: (sched, month, n) => `Salary - ${sched} - ${month} - Payout ${n}.xlsx`,
    schedule: 'Schedule', diamondsPool: 'Diamonds Pool', crowsPool: 'Crows Pool', totalFee: 'Total Fee %',
    avgTax: 'Avg. Diamond Tax %', toSplit: 'Diamonds to Split', total: 'Total', unassigned: 'Unassigned',
    id: 'ID', ign: 'IGN', guild: 'Guild', growthRate: 'Growth Rate', attendance: 'Attendance', grMultiplier: 'GR Multiplier',
    grRank: 'GR Rank', top10: 'Top 10 Bonus', feePct: 'Fee %', multiplier: 'Multiplier', baseShare: 'Base Share',
    baseMult: 'Base + Mult.', normShare: 'Norm. Share', diamondsInitial: 'Diamonds Initial', diamondsFinal: 'Diamonds Final',
    crowsInitial: 'Crows Initial', crowsFinal: 'Crows Final', splitFraction: 'Split Fraction',
    members: 'Members', taxPct: 'Tax %', diamondTax: 'Guild Tax', totalCost: 'Total Diamonds to Vend',
    payoutNo: 'Payout #', recordedAt: 'Recorded At', recordedBy: 'Recorded By', diamonds: 'Diamonds', crows: 'Crows',
    feeDiamonds: 'Diamonds from Fee', feeCrows: 'Crows from Fee', noFees: 'No management fees this month',
    bracketsHeading: 'Growth Rate Multiplier Brackets', top10Heading: 'Balthazard Top 10 Bonus', minGr: 'Min Growth Rate', extra: 'Extra',
    lootTitle: (sched, month, date) => `Loot — ${sched} ${month} (as of ${date})`,
    lootFileName: (sched, month) => `Loot - ${sched} - ${month}.xlsx`,
    bf4: 'BF4 Boss', itemsHeading: 'Items', killsHeading: 'All kills', status: 'Status', partial: 'Partial', noLoot: 'No loot logged this month',
    payoutWord: (n) => `Payout #${n}`,
    payoutTotal: (n) => `Payout #${n} total`,
    payoutsTitle: (sched, month) => `${sched} Payouts — ${month}`,
    noPayouts: 'No payouts recorded this month',
    item: 'Item', dropped: 'Dropped', sold: 'Sold', notSold: 'Not Sold',
    date: 'Date', boss: 'Boss', quantity: 'Quantity',
  },
  zh: {
    sheetSalary: '工资', sheetFees: '管理费', sheetGuilds: '公会总计', sheetPayouts: '发放记录',
    sheetUnsold: '掉落记录', sheetRules: '规则', sheetPayout: '发放',
    worldBoss: '世界Boss', balthazard: 'Balthazard',
    salaryTitle: (sched, month) => `${sched} 工资 — ${month}`,
    payoutTitle: (sched, month, n, date) => `${sched} 工资 — ${month} — 第 ${n} 次发放（${date} 发出）`,
    fileName: (sched, month) => `工资 - ${sched} - ${month}.xlsx`,
    payoutFileName: (sched, month, n) => `工资 - ${sched} - ${month} - 第${n}次发放.xlsx`,
    schedule: '日程', diamondsPool: '钻石奖池', crowsPool: '乌鸦币奖池', totalFee: '管理费合计 %',
    avgTax: '钻石平均税率 %', toSplit: '可分配钻石', total: '合计', unassigned: '未分配',
    id: '编号', ign: '游戏昵称', guild: '公会', growthRate: '成长率', attendance: '出勤', grMultiplier: '成长率倍率',
    grRank: '成长率排名', top10: '前十加成', feePct: '管理费 %', multiplier: '倍率', baseShare: '基础占比',
    baseMult: '基础 × 倍率', normShare: '标准化占比', diamondsInitial: '钻石（初始）', diamondsFinal: '钻石（最终）',
    crowsInitial: '乌鸦币（初始）', crowsFinal: '乌鸦币（最终）', splitFraction: '分配比例',
    members: '成员数', taxPct: '税率 %', diamondTax: '公会税', totalCost: '应发钻石总数',
    payoutNo: '发放次数', recordedAt: '记录时间', recordedBy: '记录人', diamonds: '钻石', crows: '乌鸦币',
    feeDiamonds: '管理费钻石', feeCrows: '管理费乌鸦币', noFees: '本月无管理费',
    bracketsHeading: '成长率倍率档位', top10Heading: 'Balthazard 前十加成', minGr: '最低成长率', extra: '额外加成',
    lootTitle: (sched, month, date) => `掉落记录 — ${sched} ${month}（截至 ${date}）`,
    lootFileName: (sched, month) => `掉落记录 - ${sched} - ${month}.xlsx`,
    bf4: 'BF4 Boss', itemsHeading: '物品', killsHeading: '全部击杀记录', status: '状态', partial: '部分售出', noLoot: '本月无掉落记录',
    payoutWord: (n) => `第 ${n} 次发放`,
    payoutTotal: (n) => `第 ${n} 次发放合计`,
    payoutsTitle: (sched, month) => `${sched} 发放记录 — ${month}`,
    noPayouts: '本月尚无发放记录',
    item: '物品', dropped: '掉落', sold: '已售', notSold: '未售',
    date: '日期', boss: 'Boss', quantity: '数量',
  },
};
// Exports are always bilingual: every label is "English / 中文" (or just
// one when both are the same, e.g. "Balthazard"). Sheet and file names
// can't contain "/", so those join with a space instead.
const SALARY_EXCEL_SPACE_JOINED = new Set(['sheetSalary', 'sheetFees', 'sheetGuilds', 'sheetPayouts', 'sheetUnsold', 'sheetRules', 'sheetPayout', 'fileName', 'payoutFileName', 'lootFileName']);
function combineSalaryExcelText() {
  const { en, zh } = SALARY_EXCEL_TEXT;
  const join = (key, a, b) => {
    if (a === b) return a;
    if (!SALARY_EXCEL_SPACE_JOINED.has(key)) return `${a} / ${b}`;
    // "Salary - X - 2026-09.xlsx" + "工资 - X - 2026-09.xlsx" -> "Salary 工资 - X - 2026-09.xlsx"
    const [aHead, ...aRest] = a.split(' - ');
    const [bHead] = b.split(' - ');
    return aRest.length ? [`${aHead} ${bHead}`, ...aRest].join(' - ') : `${a} ${b}`;
  };
  const out = {};
  Object.keys(en).forEach((key) => {
    out[key] = typeof en[key] === 'function' ? (...args) => join(key, en[key](...args), zh[key](...args)) : join(key, en[key], zh[key]);
  });
  return out;
}
const SALARY_EXCEL_TEXT_BILINGUAL = combineSalaryExcelText();
function salaryExcelText() {
  return SALARY_EXCEL_TEXT_BILINGUAL;
}
function salaryExportLang() {
  return 'both';
}

// Widens each column to fit its longest label (CJK characters count
// double), ignoring long one-off titles so they don't stretch column A.
function fitColumnWidths(grid, widths) {
  const textWidth = (str) => Array.from(String(str)).reduce((w, ch) => w + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0);
  return widths.map((min, c) => {
    let w = min;
    grid.forEach((row) => {
      const cell = row && row[c];
      const v = cell && typeof cell === 'object' ? cell.v : cell;
      if (typeof v !== 'string') return;
      const tw = textWidth(v) + 2;
      if (tw <= 44) w = Math.max(w, tw);
    });
    return w;
  });
}

// Marks a cell for styleExcelSheet: 'title', 'section', 'header', 'label'
// or 'total' (a total row is any row holding a 'total' cell).
function xlMark(cell, kind) {
  cell._k = kind;
  return cell;
}
const xlHeader = (v) => xlMark({ t: 's', v: String(v) }, 'header');

// One consistent look for every exported sheet: a big title merged across
// the sheet, dark header bars, light borders with striped rows, bold
// shaded total rows, bold labels -- and every cell aligned left. Rows are
// recognised from the xlMark markers the sheet builders put on cells; a
// header row starts a table that runs until a blank row, and the table's
// empty cells are filled in so its stripes and borders are unbroken.
const XL_COLORS = { brand: '1F3A5F', brandText: 'FFFFFF', label: '475569', stripe: 'F4F7FB', total: 'E3EAF3', border: 'D5DCE6' };
function styleExcelSheet(XLSX, ws, { autofilter = false } = {}) {
  if (!ws['!ref']) return ws;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const addr = (r, c) => XLSX.utils.encode_cell({ r, c });
  const thin = { style: 'thin', color: { rgb: XL_COLORS.border } };
  const box = { top: thin, bottom: thin, left: thin, right: thin };
  const rows = [];
  ws['!merges'] = ws['!merges'] || [];
  let tableWidth = -1;
  let stripe = 0;
  let filterStart = -1;
  let filterEnd = -1;
  for (let r = range.s.r; r <= range.e.r; r++) {
    let lastCol = -1;
    const kinds = new Set();
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[addr(r, c)];
      if (!cell || (cell.v === '' && !cell.f)) continue;
      lastCol = c;
      if (cell._k) kinds.add(cell._k);
    }
    const kind = kinds.has('title') ? 'title' : kinds.has('header') ? 'header' : kinds.has('total') ? 'total' : kinds.has('section') ? 'section' : lastCol < 0 ? 'blank' : 'body';
    if (kind === 'header') {
      tableWidth = lastCol;
      stripe = 0;
      if (autofilter && filterStart < 0) filterStart = r;
    }
    if (kind === 'blank' || kind === 'title' || kind === 'section') tableWidth = -1;
    const inTable = tableWidth >= 0 && (kind === 'header' || kind === 'body' || kind === 'total');
    if (inTable && filterStart >= 0 && filterEnd < 0 && kind === 'body') filterEnd = r;
    if (inTable && filterStart >= 0 && kind === 'body' && filterEnd >= 0 && r === filterEnd + 1) filterEnd = r;
    const width = inTable ? Math.max(tableWidth, lastCol) : lastCol;
    if (kind === 'body' && inTable) stripe++;

    for (let c = range.s.c; c <= width; c++) {
      const key = addr(r, c);
      if (!ws[key]) {
        if (!inTable) continue;
        ws[key] = { t: 's', v: '' };
      }
      const cell = ws[key];
      const style = { alignment: { horizontal: 'left', vertical: 'center' }, font: { name: 'Calibri', sz: 11 } };
      if (kind === 'title') style.font = { name: 'Calibri', sz: 15, bold: true, color: { rgb: XL_COLORS.brand } };
      else if (kind === 'section') style.font = { name: 'Calibri', sz: 12, bold: true, color: { rgb: XL_COLORS.brand } };
      else if (kind === 'header') {
        style.font = { name: 'Calibri', sz: 11, bold: true, color: { rgb: XL_COLORS.brandText } };
        style.fill = { patternType: 'solid', fgColor: { rgb: XL_COLORS.brand } };
        style.alignment.wrapText = true;
        style.border = box;
      } else if (kind === 'total') {
        style.font = { name: 'Calibri', sz: 11, bold: true };
        if (inTable) {
          style.fill = { patternType: 'solid', fgColor: { rgb: XL_COLORS.total } };
          style.border = { ...box, top: { style: 'medium', color: { rgb: XL_COLORS.brand } } };
        }
      } else if (inTable) {
        style.border = box;
        if (stripe % 2 === 0) style.fill = { patternType: 'solid', fgColor: { rgb: XL_COLORS.stripe } };
      }
      if (cell._k === 'label') style.font = { name: 'Calibri', sz: 11, bold: true, color: { rgb: XL_COLORS.label } };
      if (cell.z) style.numFmt = cell.z;
      cell.s = style;
      delete cell._k;
    }
    if (kind === 'title') ws['!merges'].push({ s: { r, c: 0 }, e: { r, c: Math.max(range.e.c, 3) } });
    rows[r] = kind === 'title' ? { hpt: 28 } : kind === 'header' ? { hpt: 32 } : kind === 'section' ? { hpt: 22 } : { hpt: 18 };
  }
  ws['!rows'] = rows;
  if (autofilter && filterStart >= 0) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: filterStart, c: 0 }, e: { r: Math.max(filterStart, filterEnd), c: Math.max(0, tableWidthAt(ws, XLSX, filterStart)) } }) };
  }
  return ws;
}
function tableWidthAt(ws, XLSX, r) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  let last = 0;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.v !== '') last = c;
  }
  return last;
}

// Builds the workbook with live Excel formulas, not pasted numbers: the
// people's inputs (Growth Rate, Attendance, Fee %, the two pools) are plain
// values, and every computed column is a formula over them -- so editing
// any input in Excel recomputes everyone's share exactly like this page
// does. The GR brackets and Balthazard top-10 bonuses live on a Rules sheet
// the formulas look up, so those are editable too. Each formula cell also
// carries the value this page computed, so it reads correctly even before
// Excel recalculates.
//
// Defaults to the live computation; a recorded payout passes its own rows,
// pools, title and file name (see exportSalaryPayout).
function buildSalaryWorkbook(XLSX, opts = {}) {
  const rows = opts.rows || salaryComputedRows;
  const schedule = opts.schedule || salaryActiveSchedule;
  const month = opts.month || salarySelectedMonth;
  const L = salaryExcelText(opts.lang);
  const scheduleLabel = schedule === 'balthazard' ? L.balthazard : L.worldBoss;
  // Quoted sheet references for formulas -- the names may be translated
  // (or contain spaces), so they're always quoted.
  const SAL = `'${L.sheetSalary}'!`;
  const RULES = `'${L.sheetRules}'!`;
  const GUILDS = `'${L.sheetGuilds}'!`;
  const guildLabel = (key) => (key === 'Unassigned' ? L.unassigned : key);
  const diamondPool = opts.diamondPool ?? parsePoolInputValue(document.getElementById('salaryDiamondPoolInput').value);
  const crowPool = opts.crowPool ?? parsePoolInputValue(document.getElementById('salaryCrowPoolInput').value);
  const totalFeePercent = rows.reduce((sum, r) => sum + (r.feePercent || 0), 0);
  // Each person's fraction of Diamonds to Split (Salary column R) and the
  // fraction-weighted average guild tax -- same math as
  // renderSalaryComputation, mirrored by formulas below.
  const splitFraction = (r) => r.normShare * Math.max(0, 1 - totalFeePercent / 100) + (r.feePercent || 0) / 100;
  const weightedTaxPercent = rows.reduce((sum, r) => sum + splitFraction(r) * (r.taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT), 0);
  const diamondsToSplit = diamondPool / (1 + weightedTaxPercent / 100);

  const FMT_MONEY = '#,##0.00';
  const FMT_INT = '#,##0';
  const FMT_PCT = '0.00%';
  const FMT_MULT = '0.00"x"';
  const text = (v) => ({ t: 's', v: String(v) });
  const num = (v, z) => ({ t: 'n', v: Number(v) || 0, ...(z ? { z } : {}) });
  const formula = (f, v, z) => ({ t: typeof v === 'string' ? 's' : 'n', f, v: typeof v === 'string' ? v : Number(v) || 0, ...(z ? { z } : {}) });
  function sheetFromCells(grid, colWidths) {
    const sheet = {};
    let maxCol = 0;
    grid.forEach((row, r) => {
      (row || []).forEach((cell, c) => {
        if (cell === null || cell === undefined) return;
        sheet[XLSX.utils.encode_cell({ r, c })] = cell;
        maxCol = Math.max(maxCol, c);
      });
    });
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, grid.length - 1), c: maxCol } });
    if (colWidths) sheet['!cols'] = fitColumnWidths(grid, colWidths).map((wch) => ({ wch }));
    return sheet;
  }

  // ---- Rules sheet: GR brackets (A3:B7) and top-10 bonuses (E3:E12) ----
  const rulesGrid = [
    [xlMark(text(L.bracketsHeading), 'section'), null, null, xlMark(text(L.top10Heading), 'section')],
    [xlHeader(L.minGr), xlHeader(L.multiplier), null, xlHeader(L.grRank), xlHeader(L.extra)],
  ];
  const bracketCount = SALARY_GR_MULTIPLIER_BRACKETS.length;
  const bonusCount = BALTHAZARD_TOP10_RANK_BONUS.length;
  for (let i = 0; i < Math.max(bracketCount, bonusCount); i++) {
    const b = SALARY_GR_MULTIPLIER_BRACKETS[i];
    rulesGrid.push([
      b ? num(b.min, FMT_INT) : null,
      b ? num(b.multiplier, FMT_MULT) : null,
      null,
      i < bonusCount ? num(i + 1) : null,
      i < bonusCount ? num(BALTHAZARD_TOP10_RANK_BONUS[i], '0.00') : null,
    ]);
  }
  const bracketRange = `${RULES}$A$3:$B$${2 + bracketCount}`;
  const bonusRange = `${RULES}$E$3:$E$${2 + bonusCount}`;
  const rulesSheet = styleExcelSheet(XLSX, sheetFromCells(rulesGrid, [18, 12, 4, 10, 10]));

  // ---- Salary sheet ----
  // Rows 1-4 hold the title/schedule/pools/fee total; header on row 6,
  // people from row 7 down. Columns:
  // A ID  B IGN  C Guild  D Growth Rate  E Attendance  F GR Multiplier
  // G GR Rank  H Top 10 Bonus  I Fee %  J Multiplier  K Base Share
  // L Base + Mult.  M Norm. Share  N Diamonds Initial  O Diamonds Final
  // P Crows Initial  Q Crows Final  R Split Fraction (share of Diamonds to
  // Split, used to weight each guild's tax rate)
  const first = 7;
  const last = first + rows.length - 1;
  const col = (letter) => `$${letter}$${first}:$${letter}$${last}`;

  // Cached GR rank, matching the formula below and compareSalaryRank:
  // among people with any attendance, count who has a higher GR, then
  // equal GR with more attendance, then exact ties above in sheet order
  // (rows are already sorted by name within an exact tie).
  const ranks = rows.map((r, i) => {
    if (r.attendance <= 0) return '';
    const higher = rows.filter((o) => o.attendance > 0 && o.growthRate > r.growthRate).length;
    const moreAttendance = rows.filter((o) => o.growthRate === r.growthRate && o.attendance > r.attendance).length;
    const tiedAbove = rows.slice(0, i + 1).filter((o) => o.growthRate === r.growthRate && o.attendance === r.attendance).length;
    return higher + moreAttendance + tiedAbove;
  });

  const salaryGrid = [
    [xlMark(text(opts.title || L.salaryTitle(scheduleLabel, month)), 'title')],
    [xlMark(text(L.schedule), 'label'), text(scheduleLabel)],
    [xlMark(text(L.diamondsPool), 'label'), num(diamondPool, FMT_MONEY), xlMark(text(L.crowsPool), 'label'), num(crowPool, FMT_MONEY)],
    [xlMark(text(L.totalFee), 'label'), formula(`SUM(${col('I')})`, totalFeePercent, '0.00')],
    // B5 is filled in below, once the Guild Totals layout is known
    [xlMark(text(L.avgTax), 'label'), null, xlMark(text(L.toSplit), 'label'), formula('B3/(1+B5/100)', diamondsToSplit, FMT_MONEY)],
    [L.id, L.ign, L.guild, L.growthRate, L.attendance, L.grMultiplier, L.grRank, L.top10, L.feePct, L.multiplier, L.baseShare, L.baseMult, L.normShare, L.diamondsInitial, L.diamondsFinal, L.crowsInitial, L.crowsFinal, L.splitFraction].map(xlHeader),
  ];
  rows.forEach((r, i) => {
    const n = first + i;
    const grMult = multiplierForGrowthRate(r.growthRate);
    salaryGrid.push([
      num(i + 1),
      text(r.ign),
      text(guildLabel(salaryGuildKey(r.guildName))),
      num(r.growthRate, FMT_INT),
      num(r.attendance),
      formula(`VLOOKUP(D${n},${bracketRange},2,1)`, grMult, FMT_MULT),
      formula(`IF(E${n}>0,COUNTIFS(${col('E')},">0",${col('D')},">"&D${n})+COUNTIFS(${col('D')},D${n},${col('E')},">"&E${n})+COUNTIFS($D$${first}:D${n},D${n},$E$${first}:E${n},E${n}),"")`, ranks[i]),
      formula(`IF(AND($B$2="${L.balthazard}",E${n}>0),IF(G${n}<=${bonusCount},INDEX(${bonusRange},G${n}),0),0)`, r.attendance > 0 ? r.multiplier - grMult : 0, '0.00'),
      num(r.feePercent || 0, '0.00'),
      formula(`IF(E${n}>0,F${n}+H${n},0)`, r.multiplier, FMT_MULT),
      formula(`IF(SUM(${col('E')})=0,0,E${n}/SUM(${col('E')}))`, r.baseShare, FMT_PCT),
      formula(`K${n}*J${n}`, r.baseMult, '0.0000'),
      formula(`IF(SUM(${col('L')})=0,0,L${n}/SUM(${col('L')}))`, r.normShare, FMT_PCT),
      formula(`M${n}*MAX(0,$D$5*(1-$B$4/100))`, r.diamondInitial, FMT_MONEY),
      formula(`N${n}+I${n}/100*$D$5`, r.diamondFinal, FMT_MONEY),
      formula(`M${n}*MAX(0,$D$3*(1-$B$4/100))`, r.crowInitial, FMT_MONEY),
      formula(`P${n}+I${n}/100*$D$3`, r.crowFinal, FMT_MONEY),
      formula(`M${n}*MAX(0,1-$B$4/100)+I${n}/100`, splitFraction(r), '0.0000%'),
    ]);
  });
  const totalOf = (key) => rows.reduce((sum, r) => sum + r[key], 0);
  const totalRow = [];
  totalRow[1] = xlMark(text(L.total), 'total');
  totalRow[4] = formula(`SUM(${col('E')})`, totalOf('attendance'));
  totalRow[11] = formula(`SUM(${col('L')})`, totalOf('baseMult'), '0.0000');
  totalRow[12] = formula(`SUM(${col('M')})`, totalOf('normShare'), FMT_PCT);
  ['N', 'O', 'P', 'Q'].forEach((letter, k) => {
    totalRow[13 + k] = formula(`SUM(${col(letter)})`, totalOf(['diamondInitial', 'diamondFinal', 'crowInitial', 'crowFinal'][k]), FMT_MONEY);
  });
  totalRow[17] = formula(`SUM(${col('R')})`, rows.reduce((sum, r) => sum + splitFraction(r), 0), '0.0000%');
  salaryGrid.push(totalRow);

  // ---- Guild Totals: SUMIF/COUNTIF over the Salary sheet ----
  const guildNames = Array.from(new Set(rows.map((r) => r.guildName || 'Unassigned')));
  const guildTotal = (name, key) => rows.filter((r) => (r.guildName || 'Unassigned') === name).reduce((sum, r) => sum + r[key], 0);
  guildNames.sort((a, b) => guildTotal(b, 'diamondFinal') - guildTotal(a, 'diamondFinal'));
  const guildCol = `${SAL}${col('C')}`;
  // One diamond transfer per guild, taxed at that guild's own rate (column
  // D, an editable input) -- Total Cost is what sending it actually costs.
  // Column H is the guild's share of Diamonds to Split, which weights its
  // rate in Salary!B5 (the average that sets Diamonds to Split).
  const guildTaxOf = (name) => rows.find((r) => salaryGuildKey(r.guildName) === name)?.taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT;
  const guildGrid = [[L.guild, L.members, L.diamondsFinal, L.taxPct, L.diamondTax, L.totalCost, L.crowsFinal, L.splitFraction].map(xlHeader)];
  guildNames.forEach((name, i) => {
    const n = i + 2;
    const d = guildTotal(name, 'diamondFinal');
    const pct = guildTaxOf(name);
    guildGrid.push([
      text(guildLabel(name)),
      formula(`COUNTIF(${guildCol},A${n})`, rows.filter((r) => salaryGuildKey(r.guildName) === name).length),
      formula(`SUMIF(${guildCol},A${n},${SAL}${col('O')})`, d, FMT_MONEY),
      num(pct, '0.00'),
      formula(`C${n}*D${n}/100`, (d * pct) / 100, FMT_MONEY),
      formula(`C${n}+E${n}`, d * (1 + pct / 100), FMT_MONEY),
      formula(`SUMIF(${guildCol},A${n},${SAL}${col('Q')})`, guildTotal(name, 'crowFinal'), FMT_MONEY),
      formula(`SUMIF(${guildCol},A${n},${SAL}${col('R')})`, rows.filter((r) => salaryGuildKey(r.guildName) === name).reduce((sum, r) => sum + splitFraction(r), 0), '0.0000%'),
    ]);
  });
  const guildLast = guildNames.length + 1;
  const guildTaxTotal = guildNames.reduce((sum, name) => sum + (guildTotal(name, 'diamondFinal') * guildTaxOf(name)) / 100, 0);
  guildGrid.push([
    xlMark(text(L.total), 'total'),
    formula(`SUM(B2:B${guildLast})`, rows.length),
    formula(`SUM(C2:C${guildLast})`, totalOf('diamondFinal'), FMT_MONEY),
    null,
    formula(`SUM(E2:E${guildLast})`, guildTaxTotal, FMT_MONEY),
    formula(`SUM(F2:F${guildLast})`, totalOf('diamondFinal') + guildTaxTotal, FMT_MONEY),
    formula(`SUM(G2:G${guildLast})`, totalOf('crowFinal'), FMT_MONEY),
    formula(`SUM(H2:H${guildLast})`, rows.reduce((sum, r) => sum + splitFraction(r), 0), '0.0000%'),
  ]);
  const guildSheet = styleExcelSheet(XLSX, sheetFromCells(guildGrid, [18, 10, 15, 8, 13, 19, 13, 14]), { autofilter: true });

  // Salary!B5: the guilds' rates weighted by their share of the split.
  salaryGrid[4][1] = formula(`SUMPRODUCT(${GUILDS}$D$2:$D$${guildLast},${GUILDS}$H$2:$H$${guildLast})`, weightedTaxPercent, '0.00');
  const salarySheet = styleExcelSheet(XLSX, sheetFromCells(salaryGrid, [6, 22, 14, 12, 11, 13, 9, 12, 8, 11, 11, 12, 12, 15, 15, 13, 13, 14]), { autofilter: true });

  // ---- Payouts: per guild, with each guild's tax and total cost (see
  // buildPayoutsByGuildSheet) ----
  const payouts = opts.payouts || salaryPayoutsForCurrentMonth();
  const payoutSheet = buildPayoutsByGuildSheet(XLSX, payouts, { firstPayoutNumber: opts.firstPayoutNumber || 1, lang: opts.lang, schedule, month });

  // ---- Management Fees: who gets a cut and how much of each pool that is.
  // Fee % and Final amounts are looked up from the Salary sheet by IGN, so
  // changing a fee there flows through here too.
  const feeRows = rows.filter((r) => (r.feePercent || 0) > 0);
  const salaryLookup = (letter, n) => `INDEX(${SAL}${col(letter)},MATCH(A${n},${SAL}${col('B')},0))`;
  const feeGrid = [[L.ign, L.guild, L.feePct, L.feeDiamonds, L.feeCrows, L.diamondsFinal, L.crowsFinal].map(xlHeader)];
  feeRows.forEach((r, i) => {
    const n = i + 2;
    feeGrid.push([
      text(r.ign),
      text(guildLabel(salaryGuildKey(r.guildName))),
      formula(salaryLookup('I', n), r.feePercent, '0.00'),
      formula(`C${n}/100*${SAL}$D$5`, (r.feePercent / 100) * diamondsToSplit, FMT_MONEY),
      formula(`C${n}/100*${SAL}$D$3`, (r.feePercent / 100) * crowPool, FMT_MONEY),
      formula(salaryLookup('O', n), r.diamondFinal, FMT_MONEY),
      formula(salaryLookup('Q', n), r.crowFinal, FMT_MONEY),
    ]);
  });
  if (feeRows.length) {
    const feeLast = feeRows.length + 1;
    const feeSum = (key) => feeRows.reduce((sum, r) => sum + r[key], 0);
    feeGrid.push([
      xlMark(text(L.total), 'total'),
      null,
      formula(`SUM(C2:C${feeLast})`, totalFeePercent, '0.00'),
      formula(`SUM(D2:D${feeLast})`, (totalFeePercent / 100) * diamondsToSplit, FMT_MONEY),
      formula(`SUM(E2:E${feeLast})`, (totalFeePercent / 100) * crowPool, FMT_MONEY),
      formula(`SUM(F2:F${feeLast})`, feeSum('diamondFinal'), FMT_MONEY),
      formula(`SUM(G2:G${feeLast})`, feeSum('crowFinal'), FMT_MONEY),
    ]);
  } else {
    feeGrid.push([text(L.noFees)]);
  }
  const feeSheet = styleExcelSheet(XLSX, sheetFromCells(feeGrid, [22, 14, 8, 17, 15, 15, 13]));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, salarySheet, L.sheetSalary);
  XLSX.utils.book_append_sheet(workbook, feeSheet, L.sheetFees);
  XLSX.utils.book_append_sheet(workbook, guildSheet, L.sheetGuilds);
  XLSX.utils.book_append_sheet(workbook, payoutSheet, L.sheetPayouts);
  XLSX.utils.book_append_sheet(workbook, buildMonthLootSheet(XLSX, schedule, month, opts.lang), L.sheetUnsold);
  XLSX.utils.book_append_sheet(workbook, rulesSheet, L.sheetRules);
  return { workbook, fileName: opts.fileName || L.fileName(scheduleLabel, month) };
}

document.getElementById('salaryExportExcelBtn').addEventListener('click', async () => {
  if (!salaryComputedRows.length) {
    toast('Nothing to export for this month');
    return;
  }
  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    toast(err.message);
    return;
  }
  const { workbook, fileName } = buildSalaryWorkbook(XLSX, { lang: salaryExportLang() });
  XLSX.writeFile(workbook, fileName);
});

// A recorded payout's full computation rows, ready for buildSalaryWorkbook.
// Payouts saved since the full row was kept map straight across. Older ones
// only kept name/guild/attendance/amounts, so the rest is re-derived from
// today's Growth Rate and management fees with the payout's own pools and
// tax -- and only trusted if that reproduces every amount that was actually
// paid (to the cent). Returns null when it doesn't, e.g. someone's Growth
// Rate changed since.
function payoutComputationRows(p) {
  const taxed = payoutTax(p) > 0.01;
  const taxOf = (r) => (taxed ? r.taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT : 0);
  if (p.rows.every((r) => r.growthRate !== undefined && r.normShare !== undefined)) {
    return p.rows.map((r) => ({
      ...r,
      taxPercent: taxOf(r),
      feePercent: r.feePercent || 0,
      diamondFinal: Number(r.diamonds) || 0,
      crowFinal: Number(r.crows) || 0,
    }));
  }
  const growthByKey = new Map();
  (sovereignState.growthSubmissions || []).forEach((sub) => {
    const key = memberNameKey(sub.ign);
    const rate = Number(sub.growthRate) || 0;
    if (key && (!growthByKey.has(key) || rate > growthByKey.get(key))) growthByKey.set(key, rate);
  });
  const feeByKey = new Map((sovereignState.salaryManagementFees || []).map((f) => [memberNameKey(f.ign), f.percent]));
  const rows = p.rows.map((r) => {
    const key = memberNameKey(r.ign);
    return {
      key,
      ign: r.ign,
      guildName: r.guildName,
      attendance: Number(r.attendance) || 0,
      growthRate: growthByKey.get(key) || 0,
      feePercent: feeByKey.get(key) || 0,
      taxPercent: taxOf(r),
      paidDiamonds: Number(r.diamonds) || 0,
      paidCrows: Number(r.crows) || 0,
    };
  });
  computeSalaryShares(rows, { schedule: p.schedule, diamondPool: p.diamondPool, crowPool: p.crowPool });
  const matches = rows.every((r) => Math.abs(r.diamondFinal - r.paidDiamonds) < 0.01 && Math.abs(r.crowFinal - r.paidCrows) < 0.01);
  return matches ? rows.sort(compareSalaryRank) : null;
}

// Every loot record from this schedule+month's kills, as of now: a
// per-item summary (Dropped, Sold, Not Sold = Dropped - Sold as a formula,
// and what it's sold for so far) and, below it, every kill's drops with
// their sold status and value. Sold counts and values come from each kill
// (soldQuantity / crowsValue / diamondsValue), the same fields behind the
// loot page's badges and totals -- so Not Sold is what's still to come.
function buildMonthLootSheet(XLSX, schedule, month, lang) {
  const L = salaryExcelText(lang);
  const kills = [];
  (sovereignState.worldBossEvents || []).forEach((ev) => {
    if ((ev.schedule || 'world_boss') !== schedule) return;
    if (String(ev.eventDate).slice(0, 7) !== month) return;
    (ev.lootItems || []).forEach((item) => {
      const quantity = Number(item.quantity) || 0;
      const sold = Math.min(quantity, Number(item.soldQuantity ?? (item.sold ? quantity : 0)) || 0);
      kills.push({
        eventDate: ev.eventDate,
        bossName: ev.bossName,
        itemName: canonicalizeItemName(item.itemName),
        quantity,
        sold,
        crows: Number(item.crowsValue) || 0,
        diamonds: Number(item.diamondsValue) || 0,
      });
    });
  });

  const byItem = new Map();
  kills.forEach((k) => {
    const key = k.itemName.toLowerCase();
    if (!byItem.has(key)) byItem.set(key, { itemName: k.itemName, quantity: 0, sold: 0, crows: 0, diamonds: 0 });
    const it = byItem.get(key);
    it.quantity += k.quantity;
    it.sold += k.sold;
    it.crows += k.crows;
    it.diamonds += k.diamonds;
  });
  const items = Array.from(byItem.values()).sort((a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName));

  const FMT_MONEY = '#,##0.00';
  const text = (v) => ({ t: 's', v: String(v) });
  const num = (v, z) => ({ t: 'n', v: Number(v) || 0, ...(z ? { z } : {}) });
  const formula = (f, v, z) => ({ t: 'n', f, v: Number(v) || 0, ...(z ? { z } : {}) });
  const scheduleLabel = schedule === 'balthazard' ? L.balthazard : schedule === 'bf4' ? L.bf4 : L.worldBoss;
  const grid = [[xlMark(text(L.lootTitle(scheduleLabel, month, new Date().toLocaleDateString('en-CA'))), 'title')], []];
  if (!items.length) {
    grid.push([text(L.noLoot)]);
  } else {
    grid.push([xlMark(text(L.itemsHeading), 'section')], [L.item, L.dropped, L.sold, L.notSold, L.crows, L.diamonds].map(xlHeader));
    const itemFirst = grid.length + 1;
    items.forEach((it) => {
      const n = grid.length + 1;
      grid.push([text(it.itemName), num(it.quantity), num(it.sold), formula(`B${n}-C${n}`, it.quantity - it.sold), num(it.crows, FMT_MONEY), num(it.diamonds, FMT_MONEY)]);
    });
    const itemLast = grid.length;
    const sumItems = (key) => items.reduce((sum, it) => sum + it[key], 0);
    grid.push([
      xlMark(text(L.total), 'total'),
      formula(`SUM(B${itemFirst}:B${itemLast})`, sumItems('quantity')),
      formula(`SUM(C${itemFirst}:C${itemLast})`, sumItems('sold')),
      formula(`SUM(D${itemFirst}:D${itemLast})`, sumItems('quantity') - sumItems('sold')),
      formula(`SUM(E${itemFirst}:E${itemLast})`, sumItems('crows'), FMT_MONEY),
      formula(`SUM(F${itemFirst}:F${itemLast})`, sumItems('diamonds'), FMT_MONEY),
    ]);

    grid.push([], [xlMark(text(L.killsHeading), 'section')], [L.date, L.boss, L.item, L.quantity, L.sold, L.notSold, L.status, L.crows, L.diamonds].map(xlHeader));
    const killFirst = grid.length + 1;
    kills
      .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || a.itemName.localeCompare(b.itemName))
      .forEach((k) => {
        const n = grid.length + 1;
        const status = k.sold >= k.quantity ? L.sold : k.sold > 0 ? L.partial : L.notSold;
        grid.push([
          text(formatWorldBossEventDateTime(k.eventDate)),
          text(k.bossName),
          text(k.itemName),
          num(k.quantity),
          num(k.sold),
          formula(`D${n}-E${n}`, k.quantity - k.sold),
          text(status),
          num(k.crows, FMT_MONEY),
          num(k.diamonds, FMT_MONEY),
        ]);
      });
    const killLast = grid.length;
    const total = [xlMark(text(L.total), 'total'), null, null];
    ['D', 'E', 'F'].forEach((letter, i) => {
      total[3 + i] = formula(`SUM(${letter}${killFirst}:${letter}${killLast})`, [sumItems('quantity'), sumItems('sold'), sumItems('quantity') - sumItems('sold')][i]);
    });
    total[6] = null;
    total[7] = formula(`SUM(H${killFirst}:H${killLast})`, sumItems('crows'), FMT_MONEY);
    total[8] = formula(`SUM(I${killFirst}:I${killLast})`, sumItems('diamonds'), FMT_MONEY);
    grid.push(total);
  }

  const sheet = {};
  let maxCol = 0;
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!cell) return;
      sheet[XLSX.utils.encode_cell({ r, c })] = cell;
      maxCol = Math.max(maxCol, c);
    })
  );
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: grid.length - 1, c: maxCol } });
  sheet['!cols'] = fitColumnWidths(grid, [24, 16, 30, 10, 8, 10, 12, 12, 12]).map((wch) => ({ wch }));
  return styleExcelSheet(XLSX, sheet);
}

// This Month's Loot on its own: the same Loot sheet for the month and
// schedule being viewed, as its own file.
document.getElementById('worldBossMonthlyLootExportBtn').addEventListener('click', async () => {
  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    toast(err.message);
    return;
  }
  const L = salaryExcelText(salaryExportLang());
  const month = worldBossViewedMonthKey();
  const schedule = worldBossActiveSchedule;
  const scheduleLabel = schedule === 'balthazard' ? L.balthazard : schedule === 'bf4' ? L.bf4 : L.worldBoss;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildMonthLootSheet(XLSX, schedule, month, salaryExportLang()), L.sheetUnsold);
  XLSX.writeFile(workbook, L.lootFileName(scheduleLabel, month));
});

// Recorded payouts, each split into one block per guild (biggest guild
// first, members by Growth Rate -- same as the page), since each guild's
// share goes out as one transfer. Every block has its members, then a
// subtotal row; each payout ends with a total of its guild subtotals.
// Members are never taxed individually -- only the guild is: each guild's
// subtotal row carries its Guild Tax (its Diamonds x its rate, saved with
// the payout) and Total Diamonds to Vend (Diamonds + Guild Tax), both
// formulas. Amounts paid stay as the numbers that were sent.
// Columns: A IGN  B Attendance  C Crows  D Diamonds  E Guild Tax
//          F Total Diamonds to Vend
function buildPayoutsByGuildSheet(XLSX, payouts, { firstPayoutNumber = 1, lang, schedule, month } = {}) {
  const L = salaryExcelText(lang);
  const FMT_MONEY = '#,##0.00';
  const text = (v) => ({ t: 's', v: String(v) });
  const num = (v, z) => ({ t: 'n', v: Number(v) || 0, ...(z ? { z } : {}) });
  const formula = (f, v, z) => ({ t: 'n', f, v: Number(v) || 0, ...(z ? { z } : {}) });
  const guildLabel = (key) => (key === 'Unassigned' ? L.unassigned : key);
  const scheduleLabel = schedule === 'balthazard' ? L.balthazard : L.worldBoss;
  const grid = [[xlMark(text(L.payoutsTitle(scheduleLabel, month)), 'title')], []];
  if (!payouts.length) grid.push([text(L.noPayouts)]);

  payouts.forEach((p, i) => {
    const n = firstPayoutNumber + i;
    const taxed = payoutTax(p) > 0.01;
    grid.push([xlMark(text([L.payoutWord(n), formatGrowthTimestamp(p.createdAt) || String(p.createdAt).slice(0, 10), p.createdBy].filter(Boolean).join(' — ')), 'section')]);
    grid.push([xlMark(text(L.diamondsPool), 'label'), num(p.diamondPool, FMT_MONEY), xlMark(text(L.crowsPool), 'label'), num(p.crowPool, FMT_MONEY)]);
    grid.push([]);
    const subtotalRows = [];
    groupPayoutRowsByGuild(p.rows).forEach((g) => {
      const pct = taxed ? g.rows[0].taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT : 0;
      grid.push([xlMark(text(`${guildLabel(g.guildName)} (${g.rows.length}) — ${L.diamondTax} ${pct}%`), 'section')]);
      grid.push([L.ign, L.attendance, L.crows, L.diamonds, L.diamondTax, L.totalCost].map(xlHeader));
      const first = grid.length + 1;
      g.rows.forEach((r) => {
        grid.push([text(r.ign), num(r.attendance || 0), num(r.crows, FMT_MONEY), num(Number(r.diamonds) || 0, FMT_MONEY)]);
      });
      const last = grid.length;
      const sumCol = (letter, v, z) => formula(`SUM(${letter}${first}:${letter}${last})`, v, z);
      const subtotal = grid.length + 1;
      grid.push([
        xlMark(text(`${L.total} — ${guildLabel(g.guildName)}`), 'total'),
        sumCol('B', g.rows.reduce((sum, r) => sum + (Number(r.attendance) || 0), 0)),
        sumCol('C', g.crows, FMT_MONEY),
        sumCol('D', g.diamonds, FMT_MONEY),
        formula(`D${subtotal}*${pct}/100`, (g.diamonds * pct) / 100, FMT_MONEY),
        formula(`D${subtotal}+E${subtotal}`, g.diamonds * (1 + pct / 100), FMT_MONEY),
      ]);
      subtotalRows.push(grid.length);
      grid.push([]);
    });
    // the payout's own total, adding up its guild subtotal rows
    const addUp = (letter) => subtotalRows.map((r) => `${letter}${r}`).join('+') || '0';
    const paidD = p.rows.reduce((sum, r) => sum + (Number(r.diamonds) || 0), 0);
    const paidC = p.rows.reduce((sum, r) => sum + (Number(r.crows) || 0), 0);
    const taxTotal = groupPayoutRowsByGuild(p.rows).reduce((sum, g) => sum + (g.diamonds * (taxed ? g.rows[0].taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT : 0)) / 100, 0);
    grid.push(['', L.attendance, L.crows, L.diamonds, L.diamondTax, L.totalCost].map(xlHeader));
    grid.push([
      xlMark(text(L.payoutTotal(n)), 'total'),
      formula(addUp('B'), p.rows.reduce((sum, r) => sum + (Number(r.attendance) || 0), 0)),
      formula(addUp('C'), paidC, FMT_MONEY),
      formula(addUp('D'), paidD, FMT_MONEY),
      formula(addUp('E'), taxTotal, FMT_MONEY),
      formula(addUp('F'), paidD + taxTotal, FMT_MONEY),
    ]);
    grid.push([], []);
  });

  const sheet = {};
  let maxCol = 0;
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!cell) return;
      sheet[XLSX.utils.encode_cell({ r, c })] = cell;
      maxCol = Math.max(maxCol, c);
    })
  );
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, grid.length - 1), c: Math.max(maxCol, 5) } });
  sheet['!cols'] = fitColumnWidths(grid, [24, 12, 12, 14, 14, 18]).map((wch) => ({ wch }));
  return styleExcelSheet(XLSX, sheet);
}

// Plain amounts-as-paid workbook, for an older payout whose full
// computation can't be re-derived exactly anymore -- better a correct
// record of what was sent than formulas that come out to different numbers.
function buildPayoutAmountsWorkbook(XLSX, p, title, lang, payoutNumber = 1) {
  const L = salaryExcelText(lang);
  const guildLabel = (key) => (key === 'Unassigned' ? L.unassigned : key);
  const FMT_MONEY = '#,##0.00';
  const taxed = payoutTax(p) > 0.01;
  const grid = [[title], [L.diamondsPool, p.diamondPool, L.crowsPool, p.crowPool], [], [L.guild, L.ign, L.attendance, L.diamonds, L.crows]];
  const guildGrid = [[L.guild, L.members, L.diamonds, L.taxPct, L.diamondTax, L.totalCost, L.crows]];
  groupPayoutRowsByGuild(p.rows).forEach((g) => {
    g.rows.forEach((r) => grid.push([guildLabel(g.guildName), r.ign, Number(r.attendance) || 0, Number(r.diamonds) || 0, Number(r.crows) || 0]));
    const pct = taxed ? g.rows[0].taxPercent ?? SALARY_DIAMOND_SEND_FEE_PERCENT : 0;
    guildGrid.push([guildLabel(g.guildName), g.rows.length, g.diamonds, pct, (g.diamonds * pct) / 100, g.diamonds * (1 + pct / 100), g.crows]);
  });
  const peopleLast = grid.length;
  grid.push([L.total, '', '', { t: 'n', f: `SUM(D5:D${peopleLast})` }, { t: 'n', f: `SUM(E5:E${peopleLast})` }]);
  const guildLast = guildGrid.length;
  guildGrid.push([L.total, { t: 'n', f: `SUM(B2:B${guildLast})` }, { t: 'n', f: `SUM(C2:C${guildLast})` }, '', { t: 'n', f: `SUM(E2:E${guildLast})` }, { t: 'n', f: `SUM(F2:F${guildLast})` }, { t: 'n', f: `SUM(G2:G${guildLast})` }]);
  const sheet = XLSX.utils.aoa_to_sheet(grid);
  const guildSheet = XLSX.utils.aoa_to_sheet(guildGrid);
  [sheet, guildSheet].forEach((ws) => {
    Object.keys(ws).forEach((addr) => {
      if (addr[0] !== '!' && ws[addr].t === 'n') ws[addr].z = FMT_MONEY;
    });
  });
  sheet['!cols'] = fitColumnWidths(grid, [16, 22, 11, 14, 12]).map((wch) => ({ wch }));
  guildSheet['!cols'] = fitColumnWidths(guildGrid, [16, 10, 14, 8, 13, 19, 12]).map((wch) => ({ wch }));
  const markRow = (ws, r, width, kind) => {
    for (let c = 0; c < width; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) xlMark(cell, kind);
    }
  };
  markRow(sheet, 0, 1, 'title');
  xlMark(sheet.A2, 'label');
  xlMark(sheet.C2, 'label');
  markRow(sheet, 3, 5, 'header');
  markRow(sheet, grid.length - 1, 1, 'total');
  markRow(guildSheet, 0, 7, 'header');
  markRow(guildSheet, guildGrid.length - 1, 1, 'total');
  styleExcelSheet(XLSX, guildSheet, { autofilter: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildPayoutsByGuildSheet(XLSX, [p], { firstPayoutNumber: payoutNumber, lang, schedule: p.schedule, month: p.month }), L.sheetPayout);
  XLSX.utils.book_append_sheet(workbook, guildSheet, L.sheetGuilds);
  XLSX.utils.book_append_sheet(workbook, buildMonthLootSheet(XLSX, p.schedule, p.month, lang), L.sheetUnsold);
  return workbook;
}

async function exportSalaryPayout(payoutId) {
  const payouts = salaryPayoutsForCurrentMonth();
  const index = payouts.findIndex((x) => x.id === payoutId);
  const p = payouts[index];
  if (!p) return;
  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    toast(err.message);
    return;
  }
  const lang = salaryExportLang();
  const L = salaryExcelText(lang);
  const scheduleLabel = p.schedule === 'balthazard' ? L.balthazard : L.worldBoss;
  const sentOn = String(p.createdAt).slice(0, 10);
  const title = L.payoutTitle(scheduleLabel, p.month, index + 1, sentOn);
  const fileName = L.payoutFileName(scheduleLabel, p.month, index + 1);
  const rows = payoutComputationRows(p);
  if (rows) {
    const { workbook } = buildSalaryWorkbook(XLSX, {
      rows,
      schedule: p.schedule,
      month: p.month,
      diamondPool: p.diamondPool,
      crowPool: p.crowPool,
      payouts: [p],
      firstPayoutNumber: index + 1,
      title,
      fileName,
      lang,
    });
    XLSX.writeFile(workbook, fileName);
  } else {
    XLSX.writeFile(buildPayoutAmountsWorkbook(XLSX, p, title, lang, index + 1), fileName);
    toast("This older payout's Growth Rates/fees have changed since, so it's exported as the amounts paid, without formulas");
  }
}

document.getElementById('salaryPayoutHistory').addEventListener('click', async (e) => {
  const exportBtn = e.target.closest('[data-export-salary-payout]');
  if (exportBtn) {
    e.preventDefault(); // inside <summary> -- don't also toggle the details open/closed
    await exportSalaryPayout(exportBtn.getAttribute('data-export-salary-payout'));
    return;
  }
  const btn = e.target.closest('[data-delete-salary-payout]');
  if (!btn) return;
  e.preventDefault(); // inside <summary> -- don't also toggle the details open/closed
  if (!confirm('Delete this payout record? Its amount goes back into the pool to be paid again.')) return;
  const id = btn.getAttribute('data-delete-salary-payout');
  try {
    await api(`/api/salary-payouts/${id}`, { method: 'DELETE' });
    sovereignState.salaryPayouts = (sovereignState.salaryPayouts || []).filter((p) => p.id !== id);
    fillSalaryPoolsFromSoldItems();
    toast('Payout deleted');
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('salaryMonthInput').addEventListener('change', (e) => {
  salarySelectedMonth = e.target.value || new Date().toISOString().slice(0, 7);
  fillSalaryPoolsFromSoldItems();
});
document.getElementById('salaryScheduleSelect').addEventListener('change', (e) => {
  salaryActiveSchedule = e.target.value;
  fillSalaryPoolsFromSoldItems();
});
// 'input' recomputes live while typing (no reformatting yet -- inserting
// commas mid-type would jump the cursor); 'blur' reformats with commas once
// the admin's done editing, same look as the auto-filled value.
document.getElementById('salaryDiamondPoolInput').addEventListener('input', () => {
  renderSalaryComputation();
  updateNewComputationState();
});
document.getElementById('salaryCrowPoolInput').addEventListener('input', () => {
  renderSalaryComputation();
  updateNewComputationState();
});
document.getElementById('salaryDiamondPoolInput').addEventListener('blur', (e) => {
  e.target.value = formatPoolInputValue(parsePoolInputValue(e.target.value));
});
document.getElementById('salaryCrowPoolInput').addEventListener('blur', (e) => {
  e.target.value = formatPoolInputValue(parsePoolInputValue(e.target.value));
});

function renderSalaryManagementFees() {
  const fees = sovereignState.salaryManagementFees || [];
  document.getElementById('salaryFeeList').innerHTML = fees
    .map(
      (f) => `
    <span class="crusade-loot-chip">${escapeHtml(f.ign)} — ${f.percent}% <button type="button" class="icon-btn admin-only" data-delete-salary-fee="${f.id}" title="Remove">✕</button></span>`
    )
    .join('');
  document.getElementById('salaryFeeList').querySelectorAll('[data-delete-salary-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/world-boss-management-fees/${btn.getAttribute('data-delete-salary-fee')}`, { method: 'DELETE' });
        sovereignState.salaryManagementFees = sovereignState.salaryManagementFees.filter((f) => f.id !== btn.getAttribute('data-delete-salary-fee'));
        renderSalaryManagementFees();
        renderSalaryComputation();
        toast('Fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function showSalaryFeeIgnSuggestions() {
  const input = document.getElementById('salaryFeeIgnInput');
  const list = document.getElementById('salaryFeeIgnSuggestList');
  const query = input.value.trim().toLowerCase();
  const known = deriveMembersFromGrowthSubmissions(sovereignState.growthSubmissions);
  const matches = (query ? known.filter((m) => m.name.toLowerCase().includes(query)) : known).slice(0, 20);
  if (!matches.length) {
    list.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  list.innerHTML = matches.map((m) => `<div class="crusade-loot-suggest-item" data-suggest-name="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>`).join('');
  list.classList.remove('hidden');
  list.querySelectorAll('[data-suggest-name]').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = el.getAttribute('data-suggest-name');
      list.classList.add('hidden');
    });
  });
}
const salaryFeeIgnInput = document.getElementById('salaryFeeIgnInput');
salaryFeeIgnInput.addEventListener('input', showSalaryFeeIgnSuggestions);
salaryFeeIgnInput.addEventListener('focus', showSalaryFeeIgnSuggestions);
salaryFeeIgnInput.addEventListener('blur', () => setTimeout(() => document.getElementById('salaryFeeIgnSuggestList').classList.add('hidden'), 150));

document.getElementById('salaryFeeAddBtn').addEventListener('click', async () => {
  const ignInput = document.getElementById('salaryFeeIgnInput');
  const percentInput = document.getElementById('salaryFeePercentInput');
  const ign = ignInput.value.trim();
  const percent = Number(percentInput.value);
  if (!ign) return;
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    toast('Percent must be between 0 and 100');
    return;
  }
  try {
    const created = await api('/api/world-boss-management-fees', { method: 'POST', body: JSON.stringify({ ign, percent }) });
    sovereignState.salaryManagementFees.push(created);
    ignInput.value = '';
    percentInput.value = '';
    renderSalaryManagementFees();
    renderSalaryComputation();
    toast('Fee added');
  } catch (err) {
    toast(err.message);
  }
});

// Largest-remainder proportional split already exists (distributeProportionally,
// see the World Boss loot code above) but this needs plain fractional shares,
// not a rounded-to-cents split of one fixed total -- kept separate on purpose.
// The salary math itself, on rows that already carry ign, guildName,
// growthRate, attendance, feePercent (management fee %) and taxPercent
// (their guild's diamond tax %). Fills in multiplier, baseShare, baseMult,
// normShare and the Initial/Final diamonds and crows on each row. Shared by
// the live table and by re-deriving an older payout's full computation.
//
// Management fees come off the top of the pool first, then everyone (fee
// recipients included) splits whatever's left by Norm. Share -- so total
// payouts always add back up to exactly the pool, instead of fees inflating
// the total beyond what was actually earned.
//
// The diamond side first sets aside each guild's tax (see
// SALARY_DIAMOND_SEND_FEE_PERCENT), so everything splits diamondsToSplit
// rather than the full pool. Each person ends up with a fixed fraction of
// diamondsToSplit (their norm. share of what's left after management fees,
// plus their own fee), and their guild pays its rate on that -- so the pool
// covers diamondsToSplit * (1 + the fraction-weighted average tax), which
// solves to diamondsToSplit below. Finals + every guild's tax then add back
// up to exactly the pool.
function computeSalaryShares(rows, { schedule, diamondPool, crowPool }) {
  rows.forEach((r) => {
    r.multiplier = r.attendance ? multiplierForGrowthRate(r.growthRate) : 0;
  });
  if (schedule === 'balthazard') {
    [...rows]
      .filter((r) => r.attendance > 0)
      .sort(compareSalaryRank)
      .slice(0, BALTHAZARD_TOP10_RANK_BONUS.length)
      .forEach((r, i) => {
        r.multiplier += BALTHAZARD_TOP10_RANK_BONUS[i];
      });
  }

  const totalAttendance = rows.reduce((sum, r) => sum + r.attendance, 0);
  rows.forEach((r) => {
    r.baseShare = totalAttendance ? r.attendance / totalAttendance : 0;
    r.baseMult = r.baseShare * r.multiplier;
  });
  const totalBaseMult = rows.reduce((sum, r) => sum + r.baseMult, 0);
  rows.forEach((r) => {
    r.normShare = totalBaseMult ? r.baseMult / totalBaseMult : 0;
  });

  const totalFeePercent = rows.reduce((sum, r) => sum + (r.feePercent || 0), 0);
  const weightedTaxPercent = rows.reduce(
    (sum, r) => sum + (r.normShare * Math.max(0, 1 - totalFeePercent / 100) + (r.feePercent || 0) / 100) * r.taxPercent,
    0
  );
  const diamondsToSplit = diamondPool / (1 + weightedTaxPercent / 100);
  const remainingDiamondPool = Math.max(0, diamondsToSplit * (1 - totalFeePercent / 100));
  const remainingCrowPool = Math.max(0, crowPool * (1 - totalFeePercent / 100));
  rows.forEach((r) => {
    const feePercent = r.feePercent || 0;
    r.diamondInitial = r.normShare * remainingDiamondPool;
    r.diamondFinal = r.diamondInitial + (feePercent / 100) * diamondsToSplit;
    r.crowInitial = r.normShare * remainingCrowPool;
    r.crowFinal = r.crowInitial + (feePercent / 100) * crowPool;
  });
  return { diamondsToSplit };
}

function renderSalaryComputation() {
  const [year, month] = salarySelectedMonth.split('-').map(Number);

  // Keyed by memberNameKey (strips spacing/punctuation/case) instead
  // of a plain lowercase trim, so spelling variants of the same person --
  // "uncleken" attendance vs "unclekenツ" submission, "•elijah•" vs "• ELIJAH •"
  // -- fold into one salary row instead of splitting attendance away from GR
  // (showing 0 growth rate for the variant with no submission of its own).
  // A real merge on the Growth Rate page fixes this permanently; this is a
  // display-time fallback for whatever hasn't been merged yet.
  const growthByIgn = new Map();
  (sovereignState.growthSubmissions || []).forEach((s) => {
    const key = memberNameKey(s.ign);
    if (!key) return;
    const rate = Number(s.growthRate) || 0;
    const existing = growthByIgn.get(key);
    if (!existing || rate > existing.growthRate) {
      growthByIgn.set(key, { name: s.ign, growthRate: rate, guildName: s.guildName });
    }
  });

  const attendanceByIgn = new Map();
  (sovereignState.worldBossEvents || []).forEach((ev) => {
    if ((ev.schedule || 'world_boss') !== salaryActiveSchedule) return;
    const d = new Date(`${String(ev.eventDate).slice(0, 10)}T00:00:00`);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1) return;
    ev.attendees.forEach((a) => {
      const key = memberNameKey(a.name);
      if (!key) return;
      const existing = attendanceByIgn.get(key);
      if (existing) existing.count += 1;
      else attendanceByIgn.set(key, { count: 1, sampleName: a.name.trim() });
    });
  });

  const feeByIgn = new Map(
    (sovereignState.salaryManagementFees || []).map((f) => [memberNameKey(f.ign), f.percent])
  );

  // A management fee still pays out even for someone with zero attendance
  // this month (an officer who manages but didn't personally fight) -- so
  // the row set is attendees UNION fee recipients, not just attendees.
  const allKeys = new Set([...attendanceByIgn.keys(), ...feeByIgn.keys()]);
  const allRows = Array.from(allKeys).map((key) => {
    const g = growthByIgn.get(key);
    return {
      key,
      ign: g ? g.name : attendanceByIgn.get(key)?.sampleName || key,
      guildName: g ? g.guildName : null,
      growthRate: g ? g.growthRate : 0,
      hasGrowthEntry: !!g,
      attendance: attendanceByIgn.get(key)?.count || 0,
      feePercent: feeByIgn.get(key) || 0,
    };
  });
  // Growth Rate is the member list: a name with no entry there (removed
  // from it, or an old IGN never linked) isn't paid. Its share is still
  // worked out as usual, then handed to the management fee recipients in
  // proportion to their fee % -- taxed at their guilds' rates, since that's
  // who receives it. With no fees set, it's split among members instead.
  const rows = allRows.filter((r) => r.hasGrowthEntry);
  const unlisted = allRows.filter((r) => !r.hasGrowthEntry).sort((a, b) => b.attendance - a.attendance);
  rows.forEach((r) => {
    r.taxPercent = guildTaxPercent(r.guildName);
  });
  const feeRecipients = rows.filter((r) => r.feePercent > 0);
  const recipientFeeTotal = feeRecipients.reduce((sum, r) => sum + r.feePercent, 0);
  const sendUnlistedToFees = unlisted.length > 0 && recipientFeeTotal > 0;
  unlisted.forEach((r) => {
    r.taxPercent = recipientFeeTotal ? feeRecipients.reduce((sum, f) => sum + f.taxPercent * f.feePercent, 0) / recipientFeeTotal : 0;
  });

  const diamondPool = parsePoolInputValue(document.getElementById('salaryDiamondPoolInput').value);
  const crowPool = parsePoolInputValue(document.getElementById('salaryCrowPoolInput').value);
  const { diamondsToSplit } = computeSalaryShares(sendUnlistedToFees ? [...rows, ...unlisted] : rows, { schedule: salaryActiveSchedule, diamondPool, crowPool });
  const forfeitedDiamonds = sendUnlistedToFees ? unlisted.reduce((sum, r) => sum + r.diamondFinal, 0) : 0;
  const forfeitedCrows = sendUnlistedToFees ? unlisted.reduce((sum, r) => sum + r.crowFinal, 0) : 0;
  feeRecipients.forEach((r) => {
    r.diamondFinal += forfeitedDiamonds * (r.feePercent / recipientFeeTotal);
    r.crowFinal += forfeitedCrows * (r.feePercent / recipientFeeTotal);
  });

  document.getElementById('salaryUnlistedSection').classList.toggle('hidden', unlisted.length === 0);
  document.getElementById('salaryUnlistedNote').textContent = sendUnlistedToFees
    ? `Their share — 💎 ${formatLootValue(forfeitedDiamonds) || 0} · 🪙 ${formatLootValue(forfeitedCrows) || 0} — goes to the management fee recipients (${feeRecipients.map((r) => r.ign).join(', ')}), split by fee %.`
    : 'No management fees are set, so their share is split among members instead.';
  document.getElementById('salaryUnlistedList').innerHTML = unlisted
    .map(
      (r) =>
        `<span class="crusade-loot-chip">${escapeHtml(r.ign)} — ${r.attendance.toLocaleString()} ${t('sovereign.salary.thAttendance').toLowerCase()}${sendUnlistedToFees ? ` · 💎 ${formatLootValue(r.diamondFinal) || 0} to fees` : ''}${linkOldIgnButton(r.ign)}</span>`
    )
    .join('');
  const sendFeeNote = document.getElementById('salarySendFeeNote');
  sendFeeNote.innerHTML = `
    <span class="crusade-loot-chip diamonds">💎 Pool ${formatLootValue(diamondPool) || 0}</span>
    <span class="salary-tax-op">−</span>
    <span class="crusade-loot-chip salary-tax">Tax 💎 ${formatLootValue(diamondPool - diamondsToSplit) || 0}</span>
    <span class="salary-tax-op">=</span>
    <span class="crusade-loot-chip diamonds">Split among members 💎 ${formatLootValue(diamondsToSplit) || 0}</span>
    <span class="salary-tax-note">Each guild's tax is paid on its total when it's sent, at that guild's own rate (set it in Total Guild Receives, default ${SALARY_DIAMOND_SEND_FEE_PERCENT}%) — each Diamonds Final is what that person receives in full.</span>`;

  rows.sort(compareSalaryRank);
  salaryComputedRows = rows;

  document.getElementById('salaryComputationEmptyState').classList.toggle('hidden', rows.length !== 0);
  document.getElementById('salaryComputationBody').innerHTML = rows
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.ign)}</td>
      <td class="member-only">${r.growthRate.toLocaleString()}</td>
      <td>${r.attendance.toLocaleString()}</td>
      <td>${r.multiplier.toFixed(2)}x</td>
      <td>${(r.baseShare * 100).toFixed(2)}%</td>
      <td>${r.baseMult.toFixed(4)}</td>
      <td>${(r.normShare * 100).toFixed(2)}%</td>
      <td>${formatLootValue(r.diamondInitial)}</td>
      <td><strong>${formatLootValue(r.diamondFinal)}</strong></td>
      <td>${formatLootValue(r.crowInitial)}</td>
      <td><strong>${formatLootValue(r.crowFinal)}</strong></td>
    </tr>`
    )
    .join('');

  const totals = rows.reduce(
    (acc, r) => {
      acc.diamondFinal += r.diamondFinal;
      acc.crowFinal += r.crowFinal;
      return acc;
    },
    { diamondFinal: 0, crowFinal: 0 }
  );
  const totalsRow = document.getElementById('salaryComputationTotals');
  totalsRow.classList.toggle('hidden', rows.length === 0);
  totalsRow.innerHTML = rows.length
    ? `<td colspan="2"></td><td class="member-only"></td><td colspan="5" style="text-align:right;">${t('sovereign.salary.thTotal')}</td><td></td><td><strong>${formatLootValue(totals.diamondFinal)}</strong></td><td></td><td><strong>${formatLootValue(totals.crowFinal)}</strong></td>`
    : '';

  renderSalaryGuildTotals(rows);
}

// Every player's Final Salary summed per guild -- "how much does each
// guild receive in total" -- with that guild's members listed right under
// it (highest Growth Rate first), so whoever hands out a guild's transfer can
// see exactly who gets what from it. Each member also shows their share
// of the guild's tax (their Final x the guild's rate), which adds up to
// the guild's. The rate is editable right on the guild's row.
function renderSalaryGuildTotals(rows) {
  const byGuild = new Map();
  rows.forEach((r) => {
    const key = salaryGuildKey(r.guildName);
    if (!byGuild.has(key)) byGuild.set(key, { guildName: key, diamondFinal: 0, crowFinal: 0, members: 0, people: [] });
    const g = byGuild.get(key);
    g.diamondFinal += r.diamondFinal;
    g.crowFinal += r.crowFinal;
    g.members += 1;
    g.people.push(r);
  });
  const guildRows = Array.from(byGuild.values()).sort((a, b) => b.diamondFinal - a.diamondFinal);
  // One transfer per guild, so the tax is on the guild's total.
  guildRows.forEach((g) => {
    g.taxPercent = guildTaxPercent(g.guildName);
    g.tax = g.diamondFinal * (g.taxPercent / 100);
  });
  const sumOf = (key) => guildRows.reduce((sum, g) => sum + g[key], 0);

  document.getElementById('salaryGuildTotalsEmptyState').classList.toggle('hidden', guildRows.length !== 0);
  document.getElementById('salaryGuildTotalsBody').innerHTML = guildRows
    .map((g) => {
      const color = g.guildName === 'Unassigned' ? null : crusadeGuildColor(g.guildName);
      const label = g.guildName === 'Unassigned' ? t('sovereign.common.unassigned') : escapeHtml(g.guildName);
      const open = salaryExpandedGuilds.has(`live:${g.guildName}`);
      const memberRows = g.people
        .slice()
        .sort(compareSalaryRank)
        .map(
          (r) => `
    <tr class="salary-guild-member-row${open ? '' : ' hidden'}">
      <td>${escapeHtml(r.ign)}</td>
      <td>${r.attendance.toLocaleString()} ${t('sovereign.salary.thAttendance').toLowerCase()}</td>
      <td>${formatLootValue(r.diamondFinal)}</td>
      <td class="salary-tax-cell">${formatLootValue(r.diamondFinal * (g.taxPercent / 100))}</td>
      <td>${formatLootValue(r.diamondFinal * (1 + g.taxPercent / 100))}</td>
      <td>${formatLootValue(r.crowFinal)}</td>
    </tr>`
        )
        .join('');
      return `
    <tr class="salary-guild-row is-collapsible" data-guild-toggle="live:${escapeHtml(g.guildName)}" aria-expanded="${open}">
      <td style="${color ? `color:${color}; font-weight:600;` : 'font-weight:600;'}"><span class="salary-guild-chevron">${open ? '▾' : '▸'}</span>${label}</td>
      <td>${g.members.toLocaleString()}</td>
      <td><strong>${formatLootValue(g.diamondFinal)}</strong></td>
      <td class="salary-tax-cell">
        <span class="salary-guild-tax-rate">${g.taxPercent}%</span>${formatLootValue(g.tax)}
        <button type="button" class="icon-btn admin-only salary-guild-tax-edit" data-edit-guild-tax="${escapeHtml(g.guildName)}" title="Change ${escapeHtml(g.guildName)}'s tax %">✎</button>
      </td>
      <td>${formatLootValue(g.diamondFinal + g.tax)}</td>
      <td><strong>${formatLootValue(g.crowFinal)}</strong></td>
    </tr>${memberRows}`;
    })
    .join('') +
    (guildRows.length
      ? `
    <tr class="salary-guild-total-row">
      <td>${t('sovereign.salary.thTotal')}</td>
      <td>${sumOf('members').toLocaleString()}</td>
      <td><strong>${formatLootValue(sumOf('diamondFinal'))}</strong></td>
      <td class="salary-tax-cell"><strong>${formatLootValue(sumOf('tax'))}</strong></td>
      <td><strong>${formatLootValue(sumOf('diamondFinal') + sumOf('tax'))}</strong></td>
      <td><strong>${formatLootValue(sumOf('crowFinal'))}</strong></td>
    </tr>`
      : '');
}

// Saving a guild's tax rate recomputes the whole salary -- a different
// rate changes how much of the pool is left to split for everyone.
document.getElementById('salaryGuildTotalsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-edit-guild-tax]');
  if (!btn) return;
  e.stopPropagation(); // don't also open/close the guild
  const guildName = btn.getAttribute('data-edit-guild-tax');
  const answer = prompt(`Tax % for ${guildName} (default ${SALARY_DIAMOND_SEND_FEE_PERCENT}%)`, String(guildTaxPercent(guildName === 'Unassigned' ? null : guildName)));
  if (answer === null || answer.trim() === '') return;
  const percent = Number(answer);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    toast('Tax must be between 0 and 100%');
    return;
  }
  try {
    await api('/api/salary-guild-taxes', { method: 'PUT', body: JSON.stringify({ guildName, percent }) });
    if (!sovereignState.salaryGuildTaxes) sovereignState.salaryGuildTaxes = new Map();
    sovereignState.salaryGuildTaxes.set(guildName, percent);
    renderSalaryComputation();
    toast(`Tax for ${guildName} set to ${percent}%`);
  } catch (err) {
    toast(err.message);
  }
});

// Someone who changed their IGN outside the Growth Rate edit (e.g. posted
// a fresh submission under the new name) leaves attendance under the old
// name, which matches no Growth Rate entry -- so it gets no salary share
// and saved payouts show it without a guild. Linking renames everything
// under the old name to the member's IGN (see POST
// /api/growth-submissions/link-name), saved payouts included.
function hasGrowthEntryFor(name) {
  const key = memberNameKey(name);
  return (sovereignState.growthSubmissions || []).some((s) => memberNameKey(s.ign) === key);
}
function linkOldIgnButton(name) {
  return ` <button type="button" class="icon-btn admin-only salary-guild-tax-edit" data-link-salary-name="${escapeHtml(name)}" title="Old IGN? Link it to the member it belongs to">🔗</button>`;
}

function removeFromPayoutsButton(name) {
  return ` <button type="button" class="icon-btn admin-only salary-guild-tax-edit" data-remove-payout-name="${escapeHtml(name)}" title="Removed member? Take them out of saved payouts -- their share goes to the management fee recipients">✕</button>`;
}

document.getElementById('sovereignSalaryPanel').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-payout-name]');
  if (!btn) return;
  e.stopPropagation(); // don't also open/close the guild
  const ign = btn.getAttribute('data-remove-payout-name');
  if (!confirm(`Remove "${ign}" from saved payouts? Their diamonds and crows go to each payout's management fee recipients (by fee %), so payout totals stay the same. Use 🔗 instead if this is a member's old IGN.`)) return;
  try {
    const result = await api('/api/salary-payouts/remove-name', { method: 'POST', body: JSON.stringify({ ign }) });
    sovereignState.salaryPayouts = await api('/api/salary-payouts');
    renderSalaryPayoutHistory();
    toast(`Removed "${ign}" from ${result.payoutsChanged} saved payout${result.payoutsChanged === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message);
  }
});

let linkNameOldIgn = null;
function linkNameTarget() {
  const typed = memberNameKey(document.getElementById('linkNameInput').value);
  if (!typed) return null;
  return (sovereignState.growthSubmissions || []).find((s) => memberNameKey(s.ign) === typed) || null;
}
function updateLinkNameMatch() {
  const target = linkNameTarget();
  const el = document.getElementById('linkNameMatch');
  el.style.color = target ? 'var(--text-muted)' : 'var(--gold)';
  el.textContent = target
    ? `${target.ign} — ${target.guildName || t('sovereign.common.unassigned')} · Growth Rate ${target.growthRate?.toLocaleString() ?? '?'}`
    : document.getElementById('linkNameInput').value.trim()
      ? 'Not on the Growth Rate list — pick a name from the suggestions'
      : '';
}

document.getElementById('sovereignSalaryPanel').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-link-salary-name]');
  if (!btn) return;
  e.stopPropagation(); // don't also open/close the guild
  linkNameOldIgn = btn.getAttribute('data-link-salary-name');
  document.getElementById('linkNameModalTitle').textContent = `Link "${linkNameOldIgn}"`;
  document.getElementById('linkNameSuggestions').innerHTML = (sovereignState.growthSubmissions || [])
    .slice()
    .sort((a, b) => a.ign.localeCompare(b.ign))
    .map((s) => `<option value="${escapeHtml(s.ign)}">${escapeHtml(s.guildName || '')}</option>`)
    .join('');
  document.getElementById('linkNameInput').value = '';
  updateLinkNameMatch();
  document.getElementById('linkNameModal').classList.remove('hidden');
  document.getElementById('linkNameInput').focus();
});
document.getElementById('linkNameInput').addEventListener('input', updateLinkNameMatch);

document.getElementById('linkNameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = linkNameTarget();
  if (!target || !linkNameOldIgn) {
    updateLinkNameMatch();
    return;
  }
  if (!confirm(`Link "${linkNameOldIgn}" to "${target.ign}"? Everything under "${linkNameOldIgn}" is renamed to "${target.ign}", including saved payouts.`)) return;
  try {
    await api('/api/growth-submissions/link-name', { method: 'POST', body: JSON.stringify({ keepId: target.id, oldIgn: linkNameOldIgn }) });
    const [growthSubmissions, events, fees, payouts] = await Promise.all([
      api('/api/growth-submissions'),
      api('/api/world-boss-attendance'),
      api('/api/world-boss-management-fees'),
      api('/api/salary-payouts'),
    ]);
    sovereignState.growthSubmissions = growthSubmissions;
    sovereignState.worldBossEvents = events;
    sovereignState.salaryManagementFees = fees;
    sovereignState.salaryPayouts = payouts;
    document.getElementById('linkNameModal').classList.add('hidden');
    renderSalaryManagementFees();
    renderSalaryComputation();
    renderSalaryPayoutHistory();
    toast(`Linked "${linkNameOldIgn}" to "${target.ign}"`);
  } catch (err) {
    toast(err.message);
  }
});

// Guild rows in Total Guild Receives (live and in each payout) open and
// close their member list -- see salaryExpandedGuilds.
document.getElementById('sovereignSalaryPanel').addEventListener('click', (e) => {
  const row = e.target.closest('[data-guild-toggle]');
  if (!row || e.target.closest('button, input, a')) return;
  const key = row.getAttribute('data-guild-toggle');
  const open = !salaryExpandedGuilds.has(key);
  if (open) salaryExpandedGuilds.add(key);
  else salaryExpandedGuilds.delete(key);
  row.setAttribute('aria-expanded', String(open));
  row.querySelector('.salary-guild-chevron').textContent = open ? '▾' : '▸';
  for (let next = row.nextElementSibling; next && next.classList.contains('salary-guild-member-row'); next = next.nextElementSibling) {
    next.classList.toggle('hidden', !open);
  }
});

// ---------- Raffle (standalone, independent of any crusade) ----------
// Draws from the same master Member List as above. Anyone already in the
// Winners stack drops out of the eligible pool until "Clear Winners" resets
// it -- the pool is derived each render, never stored separately.

async function loadRaffle() {
  const [guilds, winners, activity] = await Promise.all([
    api('/api/crusade-guilds'),
    api('/api/raffle-winners'),
    api('/api/activity-log?entityType=raffle_winner&limit=50'),
  ]);
  sovereignState.guilds = guilds;
  sovereignState.raffleWinners = winners;
  sovereignState.raffleActivity = activity;
  renderRafflePool();
  renderRaffleWinners();
  renderRaffleActivity();
}

// Re-fetches just the log (draw/edit/undo/clear all write through
// logActivity() server-side, so the freshest record is whatever comes back
// from there rather than something reconstructed client-side).
async function refreshRaffleActivity() {
  try {
    sovereignState.raffleActivity = await api('/api/activity-log?entityType=raffle_winner&limit=50');
    renderRaffleActivity();
  } catch (err) {
    // non-fatal -- the action itself already succeeded
  }
}

function renderRaffleActivity() {
  const entries = sovereignState.raffleActivity || [];
  document.getElementById('raffleActivityEmptyState').classList.toggle('hidden', entries.length !== 0);

  document.getElementById('raffleActivityList').innerHTML = entries
    .map((e) => {
      const time = new Date(e.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
      <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--gridline); font-size:13px;">
        <span>${escapeHtml(e.description || '')}</span>
        <span style="color:var(--text-muted); white-space:nowrap;">${e.username ? `${escapeHtml(e.username)} · ` : ''}${time}</span>
      </div>`;
    })
    .join('');
}

document.getElementById('clearRaffleActivityBtn').addEventListener('click', async () => {
  if (!sovereignState.raffleActivity.length) return;
  if (!confirm(`Clear all ${sovereignState.raffleActivity.length} raffle activity log entr${sovereignState.raffleActivity.length === 1 ? 'y' : 'ies'}? This can't be undone.`)) return;
  try {
    await api('/api/activity-log?entityType=raffle_winner', { method: 'DELETE' });
    await refreshRaffleActivity();
    toast('Raffle activity log cleared');
  } catch (err) {
    toast(err.message);
  }
});

// The winner is a whole guild, not an individual member -- a guild already
// in the Winners stack drops out of the pool until "Clear Winners" resets it.
function raffleEligibleGuilds() {
  const wonNames = new Set(sovereignState.raffleWinners.map((w) => w.guildName?.trim().toLowerCase()));
  return sovereignState.guilds.filter((g) => !wonNames.has(g.name.trim().toLowerCase()));
}

function renderRafflePool() {
  const container = document.getElementById('rafflePoolDetail');
  const eligible = raffleEligibleGuilds();
  document.getElementById('rafflePoolEmptyState').classList.toggle('hidden', eligible.length !== 0);

  const items = eligible
    .map(
      (g) => `
    <li>
      <label style="display:flex; flex-direction:row; align-items:center; gap:8px; font-weight:400;">
        <input type="checkbox" class="raffle-guild-check admin-disable" data-name="${escapeHtml(g.name)}">
        <span class="schedule-dot" style="background:${g.color}"></span>
        ${escapeHtml(g.name)}
      </label>
    </li>`
    )
    .join('');

  container.innerHTML = eligible.length
    ? `
    <div class="crusade-party-card">
      <div class="crusade-party-card-header">
        <h3>Guilds (${eligible.length})</h3>
        <label style="display:flex; flex-direction:row; align-items:center; gap:4px; font-weight:400; font-size:11px; text-transform:none; color:var(--text-muted);">
          <input type="checkbox" class="raffle-select-all admin-disable">
          All
        </label>
      </div>
      <ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px;">${items}</ul>
    </div>`
    : '';

  container.querySelectorAll('.raffle-select-all').forEach((allCb) => {
    allCb.addEventListener('change', () => {
      const card = allCb.closest('.crusade-party-card');
      card.querySelectorAll('.raffle-guild-check').forEach((cb) => (cb.checked = allCb.checked));
      updateRafflePoolCount();
    });
  });
  container.querySelectorAll('.raffle-guild-check').forEach((cb) => {
    cb.addEventListener('change', updateRafflePoolCount);
  });
  updateRafflePoolCount();
}

function updateRafflePoolCount() {
  const checked = document.querySelectorAll('.raffle-guild-check:checked').length;
  document.getElementById('rafflePoolCount').textContent = checked ? `${checked} selected` : '';
  document.getElementById('raffleDrawBtn').disabled = checked === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fisher-Yates -- the shuffled order IS the draw result, index 0 = 1st place.
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

document.getElementById('raffleDrawBtn').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('.raffle-guild-check:checked')).map((cb) => cb.getAttribute('data-name'));
  if (!checked.length) return;

  const order = shuffled(checked);
  const drawBtn = document.getElementById('raffleDrawBtn');
  const display = document.getElementById('raffleDrawDisplay');

  drawBtn.disabled = true;
  display.classList.remove('hidden');

  // One spin to build suspense (cycling through everyone checked), then
  // reveal every placement in the shuffled order -- one Draw ranks the whole
  // checked pool at once instead of needing a click per placement.
  const spinDelays = [70, 70, 70, 80, 90, 110, 140, 180, 230];
  for (const delay of spinDelays) {
    display.textContent = checked[Math.floor(Math.random() * checked.length)];
    await sleep(delay);
  }

  let failed = null;
  for (const name of order) {
    const nextPlace = sovereignState.raffleWinners.length + 1;
    display.textContent = `${ordinal(nextPlace)}: ${name}`;
    try {
      const created = await api('/api/raffle-winners', {
        method: 'POST',
        body: JSON.stringify({ memberName: name, guildName: name }),
      });
      sovereignState.raffleWinners.unshift(created);
      renderRafflePool();
      renderRaffleWinners();
    } catch (err) {
      failed = err;
      break;
    }
    await sleep(400);
  }
  refreshRaffleActivity();

  if (failed) {
    toast(failed.message);
    updateRafflePoolCount(); // the failed POST's renderRafflePool() never ran, so reset the button here
  } else {
    toast(`🎉 ${order.length} placement${order.length === 1 ? '' : 's'} drawn!`);
  }
  await sleep(1200);
  display.classList.add('hidden');
});

document.getElementById('clearRaffleWinnersBtn').addEventListener('click', async () => {
  if (!sovereignState.raffleWinners.length) return;
  if (!confirm(`Clear all ${sovereignState.raffleWinners.length} raffle winner(s)? Every guild becomes eligible again.`)) return;
  try {
    await api('/api/raffle-winners', { method: 'DELETE' });
    sovereignState.raffleWinners = [];
    renderRafflePool();
    renderRaffleWinners();
    refreshRaffleActivity();
    toast('Raffle winners cleared');
  } catch (err) {
    toast(err.message);
  }
});

// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 21 -> "21st"...
function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const RAFFLE_PLACE_MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

function renderRaffleWinners() {
  const winners = sovereignState.raffleWinners; // newest draw first
  document.getElementById('raffleWinnersEmptyState').classList.toggle('hidden', winners.length !== 0);

  // Placement is draw order, not recency -- whoever was drawn first holds
  // 1st place regardless of how many more have been drawn since.
  const chronological = [...winners].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const placeById = new Map(chronological.map((w, i) => [w.id, i + 1]));

  const list = document.getElementById('raffleWinnersList');
  list.innerHTML = winners
    .map((w) => {
      const color = crusadeGuildColor(w.guildName) || 'var(--text-muted)';
      const time = new Date(w.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const place = placeById.get(w.id);
      const placeLabel = `${RAFFLE_PLACE_MEDAL[place] || '🎗️'} ${ordinal(place)}`;
      return `
      <div class="crusade-guild-summary-row" data-winner-id="${w.id}">
        <span style="font-weight:700; white-space:nowrap; min-width:56px;">${placeLabel}</span>
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1; font-weight:600; white-space:nowrap;">${escapeHtml(w.guildName || w.memberName)}</span>
        <input type="text" class="raffle-item-input admin-disable" data-winner-id="${w.id}" value="${escapeHtml(w.item || '')}" placeholder="What did they win?" style="max-width:200px; flex:1;">
        <span style="color:var(--text-muted); font-size:12px; white-space:nowrap;">${time}</span>
        <button type="button" class="icon-btn admin-only" data-remove-winner="${w.id}" title="Undo this draw">✕</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.raffle-item-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.getAttribute('data-winner-id');
      try {
        const updated = await api(`/api/raffle-winners/${id}`, { method: 'PUT', body: JSON.stringify({ item: input.value }) });
        const idx = sovereignState.raffleWinners.findIndex((w) => w.id === id);
        if (idx !== -1) sovereignState.raffleWinners[idx] = updated;
        refreshRaffleActivity();
        toast('Item saved');
      } catch (err) {
        toast(err.message);
      }
    });
  });
  list.querySelectorAll('[data-remove-winner]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-remove-winner');
      const winner = sovereignState.raffleWinners.find((w) => w.id === id);
      if (!confirm(`Undo ${winner?.guildName || winner?.memberName}'s win? It'll go back into the eligible pool.`)) return;
      try {
        await api(`/api/raffle-winners/${id}`, { method: 'DELETE' });
        sovereignState.raffleWinners = sovereignState.raffleWinners.filter((w) => w.id !== id);
        renderRafflePool();
        renderRaffleWinners();
        refreshRaffleActivity();
        toast('Draw undone');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// ---------- Activity Log (admin-only) ----------
// Every create/update/delete across the whole app funnels through the same
// logActivity() call server-side, so this one page covers everything --
// crusades, members, loot, world boss, growth-rate bot submissions, etc. --
// rather than needing a separate log view per feature.

async function loadActivityLog() {
  sovereignState.activityLog = await api('/api/activity-log?limit=500');
  populateActivityLogFilterOptions(sovereignState.activityLog);
  renderActivityLog();
}

function populateActivityLogFilterOptions(entries) {
  const entityTypeSelect = document.getElementById('activityLogEntityTypeFilter');
  const actionSelect = document.getElementById('activityLogActionFilter');
  const prevType = entityTypeSelect.value;
  const prevAction = actionSelect.value;

  const types = Array.from(new Set(entries.map((e) => e.entityType))).sort();
  entityTypeSelect.innerHTML =
    `<option value="">${t('sovereign.activityLog.allTypes')}</option>` +
    types.map((ty) => `<option value="${escapeHtml(ty)}">${escapeHtml(ty)}</option>`).join('');
  entityTypeSelect.value = types.includes(prevType) ? prevType : '';

  const actions = Array.from(new Set(entries.map((e) => e.action))).sort();
  actionSelect.innerHTML =
    `<option value="">${t('sovereign.activityLog.allActions')}</option>` +
    actions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  actionSelect.value = actions.includes(prevAction) ? prevAction : '';
}

// Distinct colors per action so scanning a long list is quick -- new action
// values (e.g. "reject"/"error" from bot submissions) fall back to a plain
// neutral badge rather than needing this list kept exhaustively in sync.
const ACTIVITY_LOG_ACTION_CLASS = {
  create: 'is-create',
  update: 'is-update',
  delete: 'is-delete',
  reject: 'is-reject',
  error: 'is-delete',
  login: 'is-login',
};

function renderActivityLog() {
  const all = sovereignState.activityLog || [];
  const search = document.getElementById('activityLogSearchInput').value.trim().toLowerCase();
  const entityType = document.getElementById('activityLogEntityTypeFilter').value;
  const action = document.getElementById('activityLogActionFilter').value;

  const entries = all.filter((e) => {
    if (entityType && e.entityType !== entityType) return false;
    if (action && e.action !== action) return false;
    if (search && !`${e.description} ${e.username}`.toLowerCase().includes(search)) return false;
    return true;
  });

  document.getElementById('activityLogEmptyState').classList.toggle('hidden', all.length !== 0);
  document.getElementById('activityLogNoMatchState').classList.toggle('hidden', all.length === 0 || entries.length !== 0);

  document.getElementById('activityLogBody').innerHTML = entries
    .map(
      (e) => `
    <tr>
      <td style="white-space:nowrap; color:var(--text-muted);">${formatLongDate(String(e.createdAt).slice(0, 10))} ${formatTimeOfDay(e.createdAt)}</td>
      <td>${escapeHtml(e.username)} <span style="color:var(--text-muted); font-size:12px;">(${escapeHtml(e.role)})</span></td>
      <td><span class="crusade-status-badge ${ACTIVITY_LOG_ACTION_CLASS[e.action] || ''}">${escapeHtml(e.action)}</span></td>
      <td style="color:var(--text-muted); font-size:12px; white-space:nowrap;">${escapeHtml(e.entityType)}</td>
      <td>${escapeHtml(e.description)}</td>
    </tr>`
    )
    .join('');
}

document.getElementById('activityLogSearchInput').addEventListener('input', renderActivityLog);
document.getElementById('activityLogEntityTypeFilter').addEventListener('change', renderActivityLog);
document.getElementById('activityLogActionFilter').addEventListener('change', renderActivityLog);

// ---------- Users (admin-only) ----------

async function loadUsers() {
  sovereignState.users = await api('/api/users');
  renderUsers();
}

function renderUsers() {
  const users = sovereignState.users || [];
  document.getElementById('usersEmptyState').classList.toggle('hidden', users.length !== 0);
  document.getElementById('usersBody').innerHTML = users
    .map(
      (u) => `
    <tr>
      <td style="font-weight:600;">${escapeHtml(u.username)}</td>
      <td><span class="crusade-status-badge ${u.role === 'admin' ? 'is-create' : u.role === 'editor' || u.role === 'crusade' ? 'is-update' : 'pending'}">${escapeHtml(u.role)}</span></td>
      <td style="color:var(--text-muted);">${formatLongDate(String(u.createdAt).slice(0, 10))}</td>
      <td class="crusade-roster-actions-cell">
        <button type="button" class="icon-btn" data-edit-user="${u.id}" title="Edit">✎</button>
        <button type="button" class="icon-btn" data-delete-user="${u.id}" title="Delete user">✕</button>
      </td>
    </tr>`
    )
    .join('');

  document.getElementById('usersBody').querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = users.find((u) => u.id === btn.getAttribute('data-edit-user'));
      if (user) openUserModal(user);
    });
  });
  document.getElementById('usersBody').querySelectorAll('[data-delete-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const user = users.find((u) => u.id === btn.getAttribute('data-delete-user'));
      if (!confirm(`Delete the user "${user?.username}"? They won't be able to log in anymore.`)) return;
      try {
        await api(`/api/users/${user.id}`, { method: 'DELETE' });
        sovereignState.users = sovereignState.users.filter((u) => u.id !== user.id);
        renderUsers();
        toast('User deleted');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function openUserModal(user) {
  const form = document.getElementById('userForm');
  form.reset();
  form.elements.userId.value = user?.id || '';
  form.elements.username.value = user?.username || '';
  form.elements.role.value = user?.role || 'editor';
  form.elements.password.required = !user;
  document.getElementById('userModalHeading').textContent = user ? `${t('sovereign.common.edit')} — ${user.username}` : t('sovereign.users.addUser');
  document.getElementById('userPasswordLabel').textContent = user ? t('sovereign.users.passwordLabelOptional') : t('sovereign.users.passwordLabel');
  document.getElementById('userModal').classList.remove('hidden');
}

document.getElementById('addUserBtn').addEventListener('click', () => openUserModal(null));

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const userId = form.elements.userId.value;
  const payload = { username: form.elements.username.value.trim(), role: form.elements.role.value };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  else if (!userId) {
    toast('Password is required for a new user');
    return;
  }
  try {
    if (userId) {
      const updated = await api(`/api/users/${userId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignState.users.findIndex((u) => u.id === userId);
      if (idx !== -1) sovereignState.users[idx] = updated;
      toast('User updated');
    } else {
      const created = await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      sovereignState.users.push(created);
      toast('User created');
    }
    document.getElementById('userModal').classList.add('hidden');
    renderUsers();
  } catch (err) {
    toast(err.message);
  }
});
