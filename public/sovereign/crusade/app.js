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

function crusadeFormatItemQty(amount) {
  return `${Math.round(amount || 0).toLocaleString()} pcs`;
}

// Growth Rate submissions are the roster of record across the app (Crusade
// participant/fee autocomplete, World Boss/BF4 attendance) -- there's no
// separately-maintained "Member List" anymore, since that table drifted out
// of sync with who's actually in each guild (missing/renamed guilds).
// Deduped by IGN, case-insensitive; whichever submission is seen first wins.
function deriveMembersFromGrowthSubmissions(submissions) {
  const byName = new Map();
  (submissions || []).forEach((s) => {
    const key = s.ign.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: s.ign, guildName: s.guildName, lampLevel: s.lampLevel });
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

function route() {
  const hash = window.location.hash.slice(1);
  const teamMatch = hash.match(/^crusade\/([^/]+)\/team\/(\d+)$/);
  const guildSalaryMatch = hash.match(/^crusade\/([^/]+)\/guild-salary$/);
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
  if (hash === 'worldboss' || hash === 'bf4boss') {
    sovereignState.mode = null;
    const nextSchedule = hash === 'bf4boss' ? 'bf4' : 'world_boss';
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
  showPanel(sovereignState.mode === 'overview' ? 'detail' : sovereignState.mode === 'guildSalary' ? 'guildSalary' : 'team');
  loadCrusadeDetail(sovereignState.crusadeId).catch((err) => toast(err.message));
}

function showPanel(name) {
  document.getElementById('sovereignListPanel').classList.toggle('hidden', name !== 'list');
  document.getElementById('sovereignDetailPanel').classList.toggle('hidden', name !== 'detail');
  document.getElementById('sovereignGuildSalaryPanel').classList.toggle('hidden', name !== 'guildSalary');
  document.getElementById('sovereignTeamPanel').classList.toggle('hidden', name !== 'team');
  document.getElementById('sovereignRafflePanel').classList.toggle('hidden', name !== 'raffle');
  document.getElementById('sovereignGrowthPanel').classList.toggle('hidden', name !== 'growth');
  // BF4 Boss reuses the same World Boss Attendance panel/markup (see
  // worldBossActiveSchedule) -- it's a separate nav entry, not a separate
  // set of DOM elements, so both hashes show this one panel.
  document.getElementById('sovereignWorldBossPanel').classList.toggle('hidden', name !== 'worldboss' && name !== 'bf4boss');
  document.getElementById('sovereignPointsPanel').classList.toggle('hidden', name !== 'points');
  document.getElementById('sovereignActivityLogPanel').classList.toggle('hidden', name !== 'activitylog');
  document.getElementById('sovereignUsersPanel').classList.toggle('hidden', name !== 'users');
  document.querySelectorAll('#pageNav .nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('data-panel') === name));
  // 'detail', 'guildSalary' and 'team' set their own title once their data loads.
  if (['list', 'raffle', 'growth', 'worldboss', 'bf4boss', 'points', 'activitylog', 'users'].includes(name)) document.title = 'Sovereign — Crusade';
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
        name: fd.get('name'),
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
  const [crusade, guilds, growthSubmissions, defaultFees] = await Promise.all([
    api(`/api/crusades/${id}`),
    api('/api/crusade-guilds'),
    api('/api/growth-submissions'),
    api('/api/crusade-default-fees'),
  ]);
  sovereignState.crusade = crusade;
  sovereignState.participants = crusade.participants;
  sovereignState.teams = crusade.teams;
  sovereignState.guilds = guilds;
  sovereignState.memberList = deriveMembersFromGrowthSubmissions(growthSubmissions);
  sovereignState.defaultFees = defaultFees;
  populateCrusadeGuildSelect(); // shared by the add/edit-participant modal regardless of which page opened it
  populateSovereignMemberSuggestions(); // lets the participant modal's Name field search Growth Rate's roster
  populateCrusadeInfoForm();

  if (sovereignState.mode === 'team') {
    populateTeamDetailsForm(sovereignState.activeTeam);
    renderTeamDetail(sovereignState.activeTeam); // sets its own title
  } else if (sovereignState.mode === 'guildSalary') {
    document.title = `Sovereign — ${crusade.name} — Crusade Salary`;
    renderCrusadeGuildSalary();
  } else {
    document.title = `Sovereign — ${crusade.name}`;
    renderTeamList();
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
  form.elements.leader.value = t.leader || '';
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
  ['crusadeParticipantGuildSelect', 'crusadeFeeGuildSelect', 'crusadeDefaultFeeGuildSelect'].forEach((id) => {
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
        leader: form.elements.leader.value || null,
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
      (team.fees || []).forEach((fee) => {
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

  // Split into parties of up to 5 — Party 1 always shows even if empty, so
  // there's always somewhere to start.
  const byParty = new Map();
  teamRows.forEach((row) => {
    const slot = row.participant.partySlot;
    if (!byParty.has(slot)) byParty.set(slot, []);
    byParty.get(slot).push(row);
  });
  const partySlots = Array.from(new Set([1, ...byParty.keys()])).sort((a, b) => a - b);

  // Each party is its own card/table side by side (grid wraps as needed) —
  // reads all as columns instead of one long table, so a 4-party team
  // doesn't turn into a long vertical scroll.
  const body = document.getElementById('crusadeTeamRosterBody');
  body.innerHTML = partySlots
    .map((slot) => {
      // Checked-in (attended) members float to the top of their party, so a
      // glance at the card shows who's actually present first -- stable sort
      // keeps everyone's relative order within each of the two groups.
      const rowsInParty = (byParty.get(slot) || []).slice().sort((a, b) => (b.participant.attended ? 1 : 0) - (a.participant.attended ? 1 : 0));
      const full = rowsInParty.length >= CRUSADE_PARTY_MAX_MEMBERS;
      const memberRows = rowsInParty
        .map(
          ({ participant: p, attendanceAmount, bidShare, total }, i) => `
      <tr class="crusade-roster-row admin-disable" draggable="true" data-drag-participant="${p.id}">
        <td>${i + 1}</td>
        <td class="crusade-roster-name-cell" style="font-weight:600;"><span class="crusade-roster-name-click" data-edit-participant="${p.id}" title="Click to edit">${escapeHtml(p.name)}</span></td>
        <td>${crusadeGuildBadge(p.guildName)}</td>
        <td class="crusade-roster-position-col">${p.position ? escapeHtml(p.position) : '–'}</td>
        <td>${isDefense ? t('sovereign.common.def') : crusadeFormatGold(p.goldBid)}</td>
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
          <button type="button" class="icon-btn admin-only" data-add-to-party-slot="${slot}" title="Add to Party ${slot}" ${full ? 'disabled' : ''}>+</button>
        </div>
        <div class="table-scroll">
          <table class="members-table crusade-roster-table">
            <thead>
              <tr>
                <th style="width:4%;">#</th><th style="width:20%;">${t('sovereign.common.name')}</th><th>${t('sovereign.common.guild')}</th><th class="crusade-roster-position-col">${t('sovereign.modal.positionLabel')}</th>
                <th>${t('sovereign.roster.thBid')}</th>
                <th style="width:6%;">${t('sovereign.roster.thEnter')}</th>
                <th>${t('sovereign.roster.thAttend')}</th>
                ${isDefense ? '' : `<th>${t('sovereign.roster.thShare')}</th>`}
                <th>${t('sovereign.common.total')}</th>
                <th class="admin-only" style="width:6%;">${t('sovereign.roster.thPaid')}</th><th class="admin-only" style="width:8%;"></th>
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
  body.querySelectorAll('.crusade-paid-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'paid'));
  });
  body.querySelectorAll('[data-edit-participant]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(btn.getAttribute('data-edit-participant')));
  });
  body.querySelectorAll('[data-delete-participant]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCrusadeParticipant(btn.getAttribute('data-delete-participant')));
  });
  body.querySelectorAll('[data-add-to-party-slot]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(null, n, Number(btn.getAttribute('data-add-to-party-slot'))));
  });

  wireCrusadeRosterDragAndDrop(body, n);

  const feeCreditsByGuild = new Map();
  (team.fees || []).forEach((fee) => {
    const guildKey = fee.guildName || 'Unassigned';
    feeCreditsByGuild.set(guildKey, (feeCreditsByGuild.get(guildKey) || 0) + crusadeFeeAmount(fee, team));
  });
  renderCrusadeGuildSummary(teamRows, 'crusadeTeamGuildSummary', undefined, feeCreditsByGuild);
  renderTeamItemTable(n);
  renderCrusadeItemList(n);
  renderCrusadeFeeList(n);
}

// Drag a roster row from one Party card and drop it on another to move that
// participant into the target party slot -- an alternative to opening the
// edit modal just to change the Party field. Blocked the same way every
// other roster edit is for a view-only session (see the `admin-disable`
// class on the row: CSS drops its pointer-events, so dragstart never fires).
function wireCrusadeRosterDragAndDrop(body, teamNumber) {
  let draggedId = null;

  body.querySelectorAll('[data-drag-participant]').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      draggedId = row.getAttribute('data-drag-participant');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedId);
      row.classList.add('crusade-roster-row-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('crusade-roster-row-dragging');
      draggedId = null;
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
  // occupying the same slot at once and rejects the swap.
  body.querySelectorAll('[data-drag-participant]').forEach((row) => {
    row.addEventListener('dragover', (e) => {
      if (!draggedId || draggedId === row.getAttribute('data-drag-participant')) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('crusade-roster-row-drop-target');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('crusade-roster-row-drop-target');
    });
    row.addEventListener('drop', async (e) => {
      const targetId = row.getAttribute('data-drag-participant');
      if (!draggedId || draggedId === targetId) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('crusade-roster-row-drop-target');

      const dragged = sovereignState.participants.find((p) => p.id === draggedId);
      const target = sovereignState.participants.find((p) => p.id === targetId);
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
      if (!draggedId) return;
      e.preventDefault();
      card.classList.add('crusade-party-dropzone-active');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('crusade-party-dropzone-active');
    });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('crusade-party-dropzone-active');
      const participantId = e.dataTransfer.getData('text/plain');
      const targetSlot = Number(card.getAttribute('data-drop-party-slot'));
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

async function toggleCrusadeParticipantFlag(checkbox, field) {
  const id = checkbox.getAttribute('data-participant-id');
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: checkbox.checked }),
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
  form.elements.attended.checked = participant ? participant.attended : true;
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
  form.querySelector('.crusade-goldbid-field').classList.toggle('hidden', noBidding);
  renderCrusadeBulkResults();
  renderCrusadeBulkSelected();
  renderCrusadeBulkUnmatched();
  document.getElementById('crusadeBulkAddModal').classList.remove('hidden');
}

document.getElementById('addCrusadeBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(null));
document.getElementById('addTeamBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(sovereignState.activeTeam));
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
      const created = await api(`/api/crusades/${sovereignState.crusadeId}/participants`, {
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
      const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${participantId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignState.participants.findIndex((p) => p.id === participantId);
      if (idx !== -1) sovereignState.participants[idx] = updated;
    } else {
      const created = await api(`/api/crusades/${sovereignState.crusadeId}/participants`, { method: 'POST', body: JSON.stringify(payload) });
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
function totalTeamFeeAmount(team) {
  if (crusadeWasLost(team)) return 0;
  return (team.fees || []).reduce((sum, f) => sum + team.diamondReward * (f.percent / 100), 0);
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
  const fees = team.fees || [];
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
  const [submissions, guilds] = await Promise.all([api('/api/growth-submissions'), api('/api/crusade-guilds')]);
  sovereignState.growthSubmissions = submissions;
  sovereignState.guilds = guilds;
  populateGrowthFilterOptions(submissions);
  renderGrowthSubmissions();
}

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
    <tr data-growth-id="${s.id}">
      <td>${i + 1}</td>
      <td style="font-weight:600;">${escapeHtml(s.ign)}</td>
      <td style="font-weight:600;">${s.growthRate !== null && s.growthRate !== undefined ? s.growthRate.toLocaleString() : '–'}</td>
      <td>${escapeHtml(s.class)}</td>
      <td>${crusadeGuildBadge(s.guildName)}</td>
      <td>+${s.lampLevel ?? '?'}</td>
      <td><img class="crusade-growth-thumb" src="/api/growth-submissions/${s.id}/image?v=${encodeURIComponent(s.updatedAt || s.createdAt || '')}" alt="${escapeHtml(s.ign)}'s growth rate screenshot" loading="lazy" data-view-growth-image="${s.id}"></td>
      <td>${s.discordUsername ? `@${escapeHtml(s.discordUsername)}` : '–'}</td>
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
      if (!confirm(`Remove the growth-rate submission for "${s?.ign}"?`)) return;
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
    const idx = sovereignState.growthSubmissions.findIndex((s) => s.id === id);
    if (idx !== -1) sovereignState.growthSubmissions[idx] = updated;
    populateGrowthFilterOptions(sovereignState.growthSubmissions);
    renderGrowthSubmissions();
    document.getElementById('growthEditModal').classList.add('hidden');
    toast('Submission updated');
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

  const classSelect = document.getElementById('growthAddClassSelect');
  classSelect.innerHTML = GROWTH_CLASS_CHOICES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  const guildSelect = document.getElementById('growthAddGuildSelect');
  guildSelect.innerHTML = GROWTH_GUILD_CHOICES.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

  document.getElementById('growthAddModal').classList.remove('hidden');
}

document.getElementById('growthAddBtn').addEventListener('click', openGrowthAddModal);

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
  const file = form.elements.screenshot.files[0] || growthAddPastedImage;
  if (!file) {
    toast('A screenshot is required -- choose a file or paste one');
    return;
  }
  try {
    const uploadFile = await compressImageFileIfNeeded(file);
    const imageBase64 = await readFileAsBase64(uploadFile);
    const created = await api('/api/growth-submissions', {
      method: 'POST',
      body: JSON.stringify({
        ign: form.elements.ign.value,
        class: form.elements.class.value,
        guildName: form.elements.guildName.value,
        lampLevel: Number(form.elements.lampLevel.value),
        growthRate: Number(form.elements.growthRate.value),
        imageBase64,
        imageContentType: uploadFile.type,
      }),
    });
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
  'Balthazard',
  'Ducas / Dergio',
];

// A "schedule" is an independent tracker (own calendar/log/loot) sharing
// this same module's code via a `schedule` tag on every row instead of a
// separate copy of it -- see WORLD_BOSS_SCHEDULES in lib/app.js. Kept in
// sync with that map.
const WORLD_BOSS_SCHEDULES = {
  world_boss: { label: 'World Boss', bossNames: WORLD_BOSS_NAMES },
  bf4: { label: 'BF4 Boss', bossNames: ['BF4 Boss'] },
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
  populateWorldBossNameSelect();
  renderWorldBossMemberGrid(new Set());
  renderWorldBossLog(); // also renders the (now month-scoped) attendance summary
}

// Re-resolves guild names for any attendee row saved before
// resolveAttendeeGuilds (server-side) pointed at Growth Rate submissions
// -- those rows are stuck with a null guild_name forever otherwise, since
// it's denormalized at record time rather than looked up live.
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
  select.innerHTML = names.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
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
  groups.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));

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
          <span>${escapeHtml(m.name)}</span>
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
  const byName = new Map();
  events.forEach((ev) => {
    ev.attendees.forEach((a) => {
      const key = a.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: a.name, guildName: a.guildName, count: 0 });
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

  // Sales are tracked independently of which month/kill an item dropped in
  // (see loadWorldBossAttendance), so "Total Quantity" and "sold so far"
  // are computed against every kill ever logged, not just this month's --
  // otherwise an item collected in August and sold in September would look
  // like it has leftover stock it doesn't.
  const totalQuantityByKey = new Map();
  const allSourcesByKey = new Map();
  getScheduleEvents().forEach((ev) => {
    (ev.lootItems || []).forEach((item) => {
      const key = canonicalizeItemName(item.itemName).toLowerCase();
      totalQuantityByKey.set(key, (totalQuantityByKey.get(key) || 0) + (item.quantity || 0));
      if (!allSourcesByKey.has(key)) allSourcesByKey.set(key, []);
      allSourcesByKey.get(key).push({ eventId: ev.id, itemId: item.id, quantity: item.quantity });
    });
  });
  rows.forEach((r) => {
    r.totalQuantityEver = totalQuantityByKey.get(r.itemKey) || r.quantity;
    // Every kill that ever dropped this item, not just this month's --
    // used to spread a sale's price across the whole pool it was sold from.
    r.allSources = allSourcesByKey.get(r.itemKey) || r.sources;
    r.saleBatches = (sovereignState.lootSaleBatches || [])
      .filter((b) => (b.schedule || 'world_boss') === worldBossActiveSchedule && b.itemKey === r.itemKey)
      .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)));
    r.soldQuantity = r.saleBatches.reduce((sum, b) => sum + b.quantity, 0);
    r.remainingQuantity = Math.max(0, r.totalQuantityEver - r.soldQuantity);
  });
  worldBossMonthlyLootRows = rows; // read by the change handler below via data-loot-row-index -- indices below are into this full (unfiltered) array

  const search = document.getElementById('worldBossMonthlyLootSearchInput').value.trim().toLowerCase();
  // Filters which rows are shown, but keeps each row's index into the full
  // `rows` array (not its position in the filtered list) so the save
  // handlers below -- which look items up via rows[i] -- keep working
  // correctly against whatever's actually displayed.
  const displayRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => !search || r.itemName.toLowerCase().includes(search));

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
            <td class="crusade-loot-num">🪙 <input type="number" min="0" step="0.01" class="crusade-loot-source-edit-input admin-disable" data-source-event="${s.eventId}" data-source-item="${s.itemId}" data-source-field="crowsValue" value="${s.crowsValue !== null ? s.crowsValue : ''}" placeholder="—"></td>
            <td class="crusade-loot-num">💎 <input type="number" min="0" step="0.01" class="crusade-loot-source-edit-input admin-disable" data-source-event="${s.eventId}" data-source-item="${s.itemId}" data-source-field="diamondsValue" value="${s.diamondsValue !== null ? s.diamondsValue : ''}" placeholder="—"></td>
            <td>
              <button type="button" class="crusade-loot-sold-toggle admin-disable ${s.sold ? 'is-sold' : 'is-unsold'}" data-toggle-sold="${s.itemId}" data-sold="${s.sold ? '1' : '0'}">
                ${s.sold ? '✅ Sold' : '⭕ Not Sold'}
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
            <span>${t('sovereign.worldBoss.salesTotalQty')}: <strong>${r.totalQuantityEver.toLocaleString()}</strong></span>
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
                  <td class="crusade-loot-num">${b.quantity.toLocaleString()}</td>
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
        <span class="crusade-loot-edit-cell crows">🪙 <input type="number" min="0" step="0.01" class="crusade-loot-edit-input admin-disable" data-loot-row-index="${i}" data-loot-field="crowsValue" value="${r.crowsValue !== null ? r.crowsValue : ''}" placeholder="—"></span>
      </td>
      <td class="crusade-loot-num">
        <span class="crusade-loot-edit-cell diamonds">💎 <input type="number" min="0" step="0.01" class="crusade-loot-edit-input admin-disable" data-loot-row-index="${i}" data-loot-field="diamondsValue" value="${r.diamondsValue !== null ? r.diamondsValue : ''}" placeholder="—"></span>
      </td>
      <td class="crusade-loot-num">${r.soldQuantity.toLocaleString()} / ${r.totalQuantityEver.toLocaleString()}</td>
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

async function toggleLootItemSold(btn) {
  const itemId = btn.getAttribute('data-toggle-sold');
  const nextSold = btn.getAttribute('data-sold') !== '1';
  try {
    await api(`/api/world-boss-attendance/loot-items/${itemId}/sold`, { method: 'PUT', body: JSON.stringify({ sold: nextSold }) });
    for (const ev of sovereignState.worldBossEvents) {
      const item = ev.lootItems?.find((l) => l.id === itemId);
      if (item) item.sold = nextSold;
    }
    renderWorldBossMonthlyLoot();
  } catch (err) {
    toast(err.message);
  }
}

// Records a sale against the item's shared pool (see loadWorldBossAttendance
// / renderWorldBossMonthlyLoot) rather than any specific kill's row, so
// selling the same item again later at a different price is just another
// independent batch -- it never touches this one's price.
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
      body: JSON.stringify({ itemName: row.itemName, quantity, crowsValue, diamondsValue, schedule: worldBossActiveSchedule }),
    });
    sovereignState.lootSaleBatches.push(created);
    await syncLootPricesFromSales(row);
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
    await syncLootPricesFromSales(row);
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
async function syncLootPricesFromSales(row) {
  if (!row.allSources || !row.allSources.length) return;
  const batches = (sovereignState.lootSaleBatches || []).filter((b) => (b.schedule || 'world_boss') === worldBossActiveSchedule && b.itemKey === row.itemKey);
  const anyCrows = batches.some((b) => b.crowsValue !== null);
  const anyDiamonds = batches.some((b) => b.diamondsValue !== null);
  if (anyCrows) {
    const totalCrows = batches.reduce((sum, b) => sum + (b.crowsValue || 0), 0);
    await splitLootFieldAcrossSources(row.allSources, 'crowsValue', totalCrows);
  }
  if (anyDiamonds) {
    const totalDiamonds = batches.reduce((sum, b) => sum + (b.diamondsValue || 0), 0);
    await splitLootFieldAcrossSources(row.allSources, 'diamondsValue', totalDiamonds);
  }
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
        const base = { itemName: l.itemName, quantity: l.quantity, crowsValue: l.crowsValue, diamondsValue: l.diamondsValue, sold: l.sold };
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
    const base = { itemName: l.itemName, quantity: l.quantity, crowsValue: l.crowsValue, diamondsValue: l.diamondsValue, sold: l.sold };
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
    <div class="crusade-world-boss-day-row">
      <div class="crusade-world-boss-day-row-header" data-toggle-world-boss-log="${ev.id}">
        <span style="font-weight:600;">${escapeHtml(ev.bossName)}</span>
        <span style="color:var(--text-muted); font-size:12px;">${parseWorldBossEventDate(ev.eventDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span style="color:var(--text-muted);">${ev.attendees.length} attended</span>
        ${ev.result && ev.result !== 'pending' ? `<span class="crusade-status-badge ${ev.result}">${t(`sovereign.worldBoss.result${ev.result === 'win' ? 'Win' : 'Lose'}`)}</span>` : ''}
        ${ev.bonusPoints ? `<span style="color:var(--text-muted); font-size:12px;">+${formatLootValue(ev.bonusPoints)} pts</span>` : ''}
        <div class="admin-only" style="display:flex; gap:6px; margin-left:auto;">
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

  detail.querySelectorAll('[data-edit-world-boss]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-edit-world-boss');
      const ev = (sovereignState.worldBossEvents || []).find((x) => x.id === id);
      if (ev) startEditingWorldBossEvent(ev);
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

function addWorldBossLootRow(item) {
  const row = document.createElement('div');
  row.className = 'crusade-loot-row';
  row.innerHTML = `
    <div class="crusade-loot-item-field">
      <input type="text" data-loot-field="itemName" placeholder="Item name" maxlength="120" autocomplete="off" value="${escapeHtml(item?.itemName || '')}">
      <div class="crusade-loot-suggest-list hidden"></div>
    </div>
    <input type="number" data-loot-field="quantity" placeholder="Qty" min="1" step="1" value="${item?.quantity ?? 1}">
    <input type="number" data-loot-field="crowsValue" placeholder="Crows" min="0" step="0.01" value="${item?.crowsValue ?? ''}">
    <input type="number" data-loot-field="diamondsValue" placeholder="Diamonds" min="0" step="0.01" value="${item?.diamondsValue ?? ''}">
    <button type="button" class="icon-btn" title="Remove item">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());

  const nameInput = row.querySelector('[data-loot-field="itemName"]');
  const suggestList = row.querySelector('.crusade-loot-suggest-list');
  const crowsInput = row.querySelector('[data-loot-field="crowsValue"]');
  const diamondsInput = row.querySelector('[data-loot-field="diamondsValue"]');

  // Auto-fills the last known Crows/Diamonds values for a matched item --
  // only into fields still empty, so it never clobbers something the admin
  // already typed.
  function applyMatch(match) {
    if (!match) return;
    if (!crowsInput.value && match.crowsValue !== null) crowsInput.value = match.crowsValue;
    if (!diamondsInput.value && match.diamondsValue !== null) diamondsInput.value = match.diamondsValue;
  }

  // Custom dropdown (not a native <datalist>) so it can be sized to exactly
  // match the input's width -- a native datalist's popup can't be
  // width-constrained consistently across browsers.
  function showSuggestions() {
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
        nameInput.value = el.getAttribute('data-suggest-name');
        suggestList.classList.add('hidden');
        applyMatch(computeKnownLootItems().get(nameInput.value.trim().toLowerCase()));
      });
    });
  }

  nameInput.addEventListener('input', () => {
    showSuggestions();
    applyMatch(computeKnownLootItems().get(nameInput.value.trim().toLowerCase()));
  });
  nameInput.addEventListener('focus', showSuggestions);
  nameInput.addEventListener('blur', () => setTimeout(() => suggestList.classList.add('hidden'), 150));

  document.getElementById('worldBossLootRows').appendChild(row);
}

document.getElementById('worldBossAddLootRowBtn').addEventListener('click', () => addWorldBossLootRow());

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
  const isDecided = document.getElementById('worldBossResultSelect').value !== 'pending';
  document.getElementById('worldBossBonusPointsField').classList.toggle('hidden', !isDecided);
}
document.getElementById('worldBossResultSelect').addEventListener('change', updateWorldBossBonusPointsVisibility);

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
}

document.getElementById('worldBossCancelEditBtn').addEventListener('click', resetWorldBossForm);

document.getElementById('worldBossForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
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
      <td><span class="crusade-status-badge ${u.role === 'admin' ? 'is-create' : u.role === 'editor' ? 'is-update' : 'pending'}">${escapeHtml(u.role)}</span></td>
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
