const express = require('express');
const cookie = require('cookie');
const path = require('path');
const crypto = require('crypto');
const { sql, sqlTransaction, ensureSchema, hashPassword, verifyPassword } = require('./db');
const { handleDiscordInteraction } = require('./discordInteractions');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const AUTH_COOKIE = 'sovAuth';
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds

// Cookie payload is "<userId>.<hmac(userId)>" — the signature just proves
// the userId wasn't tampered with client-side; the actual role/username
// always comes fresh from the users table so a role change or deletion
// takes effect on the user's very next request.
function signUserId(userId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
}

function setAuthCookie(res, userId) {
  const token = `${userId}.${signUserId(userId)}`;
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!process.env.VERCEL,
      maxAge: AUTH_COOKIE_MAX_AGE,
      path: '/',
    })
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!process.env.VERCEL,
      maxAge: 0,
      path: '/',
    })
  );
}

// Resolves the signed cookie to a live user row ({id, username, role}) or
// null. Fails closed (treated as logged-out) on a bad/missing/tampered
// cookie, an unknown user, or a database error.
async function getCurrentUser(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[AUTH_COOKIE] || '';
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const userId = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expectedBuf = Buffer.from(signUserId(userId));
  const providedBuf = Buffer.from(signature);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    await ensureSchema();
    const { rows } = await sql`SELECT id, username, role FROM users WHERE id = ${userId}`;
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

function canEdit(user) {
  return !!user && (user.role === 'admin' || user.role === 'editor');
}

function isAdminUser(user) {
  return !!user && user.role === 'admin';
}

// Records one row per mutating action for the Activity Log page. `before`/
// `after` are optional plain-object snapshots of the affected record — omit
// either when there's nothing meaningful to show. Never throws — a logging
// failure should not take down the action it's describing.
async function logActivity(req, { action, entityType, entityId, description, user: explicitUser, before, after }) {
  const user = explicitUser || req.currentUser;
  if (!user) return;
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, username, role, action, entity_type, entity_id, description, before_data, after_data)
      VALUES (
        ${crypto.randomUUID()}, ${user.id}, ${user.username}, ${user.role}, ${action}, ${entityType}, ${entityId ?? null}, ${description},
        ${before !== undefined ? JSON.stringify(before) : null},
        ${after !== undefined ? JSON.stringify(after) : null}
      )
    `;
  } catch (err) {
    console.error('logActivity failed', err);
  }
}

async function withSchema(req, res, next) {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
}

const app = express();
// Default 100kb is too small for a base64-encoded growth-rate screenshot
// coming from the Discord bot. The `verify` callback stashes the exact raw
// bytes on req.rawBody -- Discord's Ed25519 interaction-signature check
// needs those exact bytes, since re-serializing req.body to JSON can differ
// byte-for-byte from what Discord actually signed.
app.use(
  express.json({
    limit: '8mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Discord POSTs interaction webhooks here (no cookie session -- verified via
// Ed25519 signature inside the handler itself instead). Placed before the
// auth-gate/schema middleware below since neither applies to it.
app.post('/api/discord-interactions', handleDiscordInteraction);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
app.get('/login.html', (req, res) => res.redirect('/login'));

// Sovereign's crusade roster/distribution tool is the whole app here — '/'
// serves it directly rather than living behind a separate '/sovereign' path.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sovereign', 'crusade', 'index.html'));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT id, username, password_hash, role FROM users WHERE LOWER(username) = LOWER(${username})`;
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'incorrect username or password' });
    }
    setAuthCookie(res, user.id);
    await logActivity(req, { action: 'login', entityType: 'user', entityId: user.id, description: `Logged in as "${user.username}"`, user });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

// Viewing the site — every page and every GET /api/* — requires no login at
// all; anyone without a session is just a "viewer" by default. User
// management and the Activity Log are admin-only regardless of method.
const ADMIN_ONLY_PATH_PREFIXES = ['/api/users', '/api/activity-log'];

// The Discord bot posts (and edits) growth-rate submissions from an external
// process with no browser session/cookie -- it authenticates with its own
// shared secret instead (checked inside the route handler itself), so it's
// exempted from the cookie-session check below rather than needing a fake
// logged-in user.
const BOT_AUTH_PATH_PREFIXES = ['/api/growth-submissions/bot'];

// Enforced here in one place rather than per-route, so a new mutating
// endpoint is safe-by-default instead of accidentally open to viewers.
// Stashes the resolved user on req.currentUser so route handlers can log
// activity without a second lookup.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (BOT_AUTH_PATH_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  const needsAdmin = ADMIN_ONLY_PATH_PREFIXES.some((p) => req.path.startsWith(p));
  const needsAuth = req.method !== 'GET' || needsAdmin;
  if (!needsAuth) return next();

  const user = await getCurrentUser(req);
  req.currentUser = user;
  if (needsAdmin && !isAdminUser(user)) {
    return res.status(403).json({ error: 'admin access required' });
  }
  if (needsAuth && !canEdit(user)) {
    return res.status(403).json({ error: 'view-only access — log in to make changes' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', withSchema);

app.get('/api/session', async (req, res) => {
  const user = await getCurrentUser(req);
  res.json({ role: user?.role || 'viewer', username: user?.username || null });
});

const USER_ROLES = new Set(['admin', 'editor', 'viewer']);

app.get('/api/users', async (req, res) => {
  const { rows } = await sql`SELECT id, username, role, created_at FROM users ORDER BY created_at ASC`;
  res.json(rows.map((r) => ({ id: r.id, username: r.username, role: r.role, createdAt: r.created_at })));
});

app.post('/api/users', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'username is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (!USER_ROLES.has(role)) return res.status(400).json({ error: 'role must be admin, editor, or viewer' });

  const trimmedUsername = username.trim();
  const { rows: existing } = await sql`SELECT id FROM users WHERE LOWER(username) = LOWER(${trimmedUsername})`;
  if (existing[0]) return res.status(400).json({ error: 'that username is already taken' });

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO users (id, username, password_hash, role)
    VALUES (${id}, ${trimmedUsername}, ${hashPassword(password)}, ${role})
    RETURNING id, username, role, created_at
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'create',
    entityType: 'user',
    entityId: row.id,
    description: `Created user "${row.username}" with role ${row.role}`,
    after: { username: row.username, role: row.role },
  });
  res.status(201).json({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at });
});

app.put('/api/users/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM users WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'user not found' });

  const { username, password, role } = req.body || {};
  let nextUsername = existing.username;
  let nextPasswordHash = existing.password_hash;
  let nextRole = existing.role;

  if (username !== undefined) {
    if (!username.trim()) return res.status(400).json({ error: 'username cannot be empty' });
    const { rows: dupe } = await sql`SELECT id FROM users WHERE LOWER(username) = LOWER(${username.trim()}) AND id != ${existing.id}`;
    if (dupe[0]) return res.status(400).json({ error: 'that username is already taken' });
    nextUsername = username.trim();
  }
  if (password !== undefined && password !== '') {
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    nextPasswordHash = hashPassword(password);
  }
  if (role !== undefined) {
    if (!USER_ROLES.has(role)) return res.status(400).json({ error: 'role must be admin, editor, or viewer' });
    if (existing.role === 'admin' && role !== 'admin') {
      const { rows: adminCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
      if (adminCountRows[0].count <= 1) {
        return res.status(400).json({ error: 'cannot demote the last remaining admin' });
      }
    }
    nextRole = role;
  }

  const { rows } = await sql`
    UPDATE users SET username = ${nextUsername}, password_hash = ${nextPasswordHash}, role = ${nextRole}
    WHERE id = ${req.params.id}
    RETURNING id, username, role, created_at
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'update',
    entityType: 'user',
    entityId: row.id,
    description: `Updated user "${row.username}" (role: ${row.role})`,
    before: { username: existing.username, role: existing.role },
    after: { username: row.username, role: row.role },
  });
  res.json({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at });
});

app.delete('/api/users/:id', async (req, res) => {
  if (req.params.id === req.currentUser.id) {
    return res.status(400).json({ error: "you can't delete your own account" });
  }
  const { rows: existingRows } = await sql`SELECT username, role FROM users WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'user not found' });

  if (existing.role === 'admin') {
    const { rows: adminCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
    if (adminCountRows[0].count <= 1) {
      return res.status(400).json({ error: 'cannot delete the last remaining admin' });
    }
  }

  await sql`DELETE FROM users WHERE id = ${req.params.id}`;
  await logActivity(req, { action: 'delete', entityType: 'user', entityId: req.params.id, description: `Deleted user "${existing.username}"`, before: { username: existing.username, role: existing.role } });
  res.status(204).end();
});

app.get('/api/activity-log', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entityType = req.query.entityType || null;
  const { rows } = entityType
    ? await sql`
        SELECT id, username, role, action, entity_type, entity_id, description, before_data, after_data, created_at
        FROM activity_log
        WHERE entity_type = ${entityType}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, username, role, action, entity_type, entity_id, description, before_data, after_data, created_at
        FROM activity_log
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
  res.json(
    rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      description: r.description,
      before: r.before_data,
      after: r.after_data,
      createdAt: r.created_at,
    }))
  );
});

// Scoped clear -- requires entityType so a stray call can't wipe the whole
// site's audit trail.
app.delete('/api/activity-log', async (req, res) => {
  const entityType = req.query.entityType;
  if (!entityType) return res.status(400).json({ error: 'entityType query param is required' });

  await sql`DELETE FROM activity_log WHERE entity_type = ${entityType}`;
  res.status(204).end();
});

// ---------- Sovereign / Crusade ----------

function serializeCrusadeGuild(row) {
  return { id: row.id, name: row.name, color: row.color };
}

// A crusade is just the shared date/event container now -- name, event
// date. Everything that drives a payout lives on crusade_teams instead (see
// serializeCrusadeTeam), one row per team, so two teams on the same
// crusade can have entirely different rewards/outcomes.
function serializeCrusade(row) {
  return {
    id: row.id,
    name: row.name,
    eventDate: row.event_date,
    createdAt: row.created_at,
  };
}

function serializeCrusadeTeam(row) {
  return {
    id: row.id,
    crusadeId: row.crusade_id,
    teamNumber: row.team_number,
    warType: row.war_type,
    stance: row.stance,
    area: row.area,
    leader: row.leader,
    result: row.result,
    diamondReward: Number(row.diamond_reward),
    attendancePct: Number(row.attendance_pct),
    notes: row.notes,
  };
}

function serializeCrusadeItem(row) {
  return { id: row.id, teamId: row.team_id, name: row.name, quantity: Number(row.quantity) };
}

function serializeCrusadeFee(row) {
  return { id: row.id, teamId: row.team_id, name: row.name, guildName: row.guild_name, percent: Number(row.percent) };
}

function serializeCrusadeParticipant(row) {
  return {
    id: row.id,
    crusadeId: row.crusade_id,
    partyNumber: row.party_number,
    partySlot: row.party_slot,
    name: row.name,
    guildName: row.guild_name,
    position: row.position,
    goldBid: Number(row.gold_bid),
    attended: row.attended,
    paid: row.paid,
    manualDiamonds: Number(row.manual_diamonds),
  };
}

const CRUSADE_PARTY_MAX_MEMBERS = 5;

// A team's roster is split into parties of at most 5 — counts every OTHER
// participant already in that crusade/team/party slot (excludeId lets an
// update check its new slot without counting itself against the cap).
async function countCrusadePartySlot(crusadeId, partyNumber, partySlot, excludeId) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS count FROM crusade_participants
    WHERE crusade_id = ${crusadeId} AND party_number = ${partyNumber} AND party_slot = ${partySlot}
      AND id != ${excludeId ?? '00000000-0000-0000-0000-000000000000'}
  `;
  return rows[0].count;
}

// A team's details/items/fees are created lazily -- opening a team that's
// never been saved shows defaults, and the row only actually gets created
// the first time something on it is saved (its own Team Details form, or
// its first item/fee). Returns the existing row if there is one.
async function ensureCrusadeTeam(crusadeId, teamNumber) {
  const { rows } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${crusadeId} AND team_number = ${teamNumber}`;
  if (rows[0]) return rows[0];
  const id = crypto.randomUUID();
  const { rows: inserted } = await sql`
    INSERT INTO crusade_teams (id, crusade_id, team_number)
    VALUES (${id}, ${crusadeId}, ${teamNumber})
    ON CONFLICT (crusade_id, team_number) DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) {
    // Brand new team -- seed it with the standing default management fees
    // (if any). Only happens once, right here at creation; editing the
    // default list afterward never touches teams that already exist.
    const { rows: defaults } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
    for (const d of defaults) {
      await sql`
        INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
        VALUES (${crypto.randomUUID()}, ${crusadeId}, ${id}, ${d.name}, ${d.guild_name}, ${d.percent})
      `;
    }
    return inserted[0];
  }
  const { rows: refetched } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${crusadeId} AND team_number = ${teamNumber}`;
  return refetched[0];
}

// Winning on Defense pays 40% of a team's reward out to whoever bid gold to
// originally CAPTURE this same area -- a thank-you to the attackers who
// took it, funded for as long as it stays ours. "Captured this same area"
// is tracked by walking every past team (any crusade) with the same `area`
// text (case/whitespace-insensitive) in chronological order and replaying
// what happened to it: an Attack win (re)captures it, a Defense loss hands
// it back to the enemy (clearing the trail until it's recaptured), and a
// Defense win or a losing Attack leaves ownership unchanged. Whatever
// capture is still standing right before this crusade's date is who this
// Defense win's bonus is paid to. No `area` set on either side means there
// is nothing to trace, so no bonus applies.
async function getAreaCaptureBidders(crusade, team) {
  if (!crusade.event_date || team.stance !== 'Defense' || team.result !== 'win' || !team.area || !team.area.trim()) {
    return { lastTeam: null, bidders: [] };
  }

  const { rows: history } = await sql`
    SELECT ct.team_number, ct.stance, ct.result, c.id AS crusade_id, c.name AS crusade_name, c.event_date
    FROM crusade_teams ct
    JOIN crusades c ON c.id = ct.crusade_id
    WHERE TRIM(LOWER(ct.area)) = TRIM(LOWER(${team.area}))
      AND (
        c.event_date < ${crusade.event_date}
        OR (c.event_date = ${crusade.event_date} AND c.created_at < ${crusade.created_at})
      )
    ORDER BY c.event_date ASC, c.created_at ASC, ct.created_at ASC
  `;

  let captureRow = null;
  for (const row of history) {
    if (row.stance !== 'Defense' && row.result === 'win') captureRow = row; // (re)captured
    else if (row.stance === 'Defense' && row.result === 'lose') captureRow = null; // lost to the enemy
  }
  if (!captureRow) return { lastTeam: null, bidders: [] };

  const lastTeam = {
    crusadeId: captureRow.crusade_id,
    crusadeName: captureRow.crusade_name,
    eventDate: captureRow.event_date,
    teamNumber: captureRow.team_number,
    area: team.area,
  };
  const { rows: bidderRows } = await sql`
    SELECT name, guild_name, gold_bid FROM crusade_participants
    WHERE crusade_id = ${captureRow.crusade_id} AND party_number = ${captureRow.team_number} AND gold_bid > 0
    ORDER BY name ASC
  `;
  const bidders = bidderRows.map((r) => ({ name: r.name, guildName: r.guild_name, goldBid: Number(r.gold_bid) }));

  return { lastTeam, bidders };
}

app.get('/api/crusade-guilds', async (req, res) => {
  const { rows } = await sql`SELECT id, name, color FROM crusade_guilds ORDER BY created_at ASC`;
  res.json(rows.map(serializeCrusadeGuild));
});

app.post('/api/crusade-guilds', async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim();
  const { rows: existing } = await sql`SELECT id FROM crusade_guilds WHERE LOWER(name) = LOWER(${trimmed})`;
  if (existing.length) return res.status(400).json({ error: 'that guild already exists' });

  const finalColor = (color && color.trim()) || '#3b82f6';
  const id = crypto.randomUUID();
  await sql`INSERT INTO crusade_guilds (id, name, color) VALUES (${id}, ${trimmed}, ${finalColor})`;
  await logActivity(req, { action: 'create', entityType: 'crusade_guild', entityId: id, description: `Added guild "${trimmed}"`, after: { name: trimmed, color: finalColor } });
  res.status(201).json({ id, name: trimmed, color: finalColor });
});

app.put('/api/crusade-guilds/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM crusade_guilds WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'guild not found' });

  const { name, color } = req.body || {};
  let nextName = existing.name;
  let nextColor = existing.color;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
    const { rows: dup } = await sql`SELECT id FROM crusade_guilds WHERE LOWER(name) = LOWER(${nextName}) AND id != ${req.params.id}`;
    if (dup.length) return res.status(400).json({ error: 'that guild already exists' });
  }
  if (color !== undefined && color.trim()) nextColor = color.trim();

  const { rows } = await sql`UPDATE crusade_guilds SET name = ${nextName}, color = ${nextColor} WHERE id = ${req.params.id} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_guild',
    entityId: req.params.id,
    description: `Updated guild "${rows[0].name}"`,
    before: { name: existing.name, color: existing.color },
    after: { name: rows[0].name, color: rows[0].color },
  });
  res.json(serializeCrusadeGuild(rows[0]));
});

app.delete('/api/crusade-guilds/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusade_guilds WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_guilds WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'guild not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_guild',
    entityId: req.params.id,
    description: `Removed guild "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

function serializeCrusadeDefaultFee(row) {
  return { id: row.id, name: row.name, guildName: row.guild_name, percent: Number(row.percent) };
}

// A standing list of fee recipients, copied onto every new team the first
// time it's saved (see ensureCrusadeTeam) -- editing this list never
// touches teams that already exist, only ones created afterward.
app.get('/api/crusade-default-fees', async (req, res) => {
  const { rows } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
  res.json(rows.map(serializeCrusadeDefaultFee));
});

app.post('/api/crusade-default-fees', async (req, res) => {
  const { name, guildName, percent } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalPercent = Number(percent);
  if (Number.isNaN(finalPercent) || finalPercent < 0 || finalPercent > 100) {
    return res.status(400).json({ error: 'percent must be between 0 and 100' });
  }

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_default_fees (id, name, guild_name, percent)
    VALUES (${id}, ${name.trim()}, ${guildName || null}, ${finalPercent})
  `;
  const { rows } = await sql`SELECT * FROM crusade_default_fees WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_default_fee',
    entityId: id,
    description: `Added a standing ${finalPercent}% default fee for "${name.trim()}" (applies to new teams going forward)`,
    after: { name: name.trim(), guildName: guildName || null, percent: finalPercent },
  });
  res.status(201).json(serializeCrusadeDefaultFee(rows[0]));
});

// Same manual escape hatch as PUT .../fees/:feeId, for the standing default
// fee template itself -- otherwise clicking "Apply Defaults" after a member
// rename that predates this fix (or that missed a whitespace/encoding
// mismatch) would keep re-adding the fee under its old, stale name.
app.put('/api/crusade-default-fees/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM crusade_default_fees WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'default fee not found' });

  const { name, guildName, percent } = req.body || {};
  let nextName = existing.name;
  let nextGuildName = existing.guild_name;
  let nextPercent = existing.percent;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name is required' });
    nextName = name.trim();
  }
  if (guildName !== undefined) nextGuildName = guildName || null;
  if (percent !== undefined) {
    const n = Number(percent);
    if (Number.isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'percent must be between 0 and 100' });
    nextPercent = n;
  }

  const { rows } = await sql`
    UPDATE crusade_default_fees SET name = ${nextName}, guild_name = ${nextGuildName}, percent = ${nextPercent}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_default_fee',
    entityId: req.params.id,
    description: `Updated the standing default fee for "${existing.name}"`,
    before: { name: existing.name, guildName: existing.guild_name, percent: existing.percent },
    after: { name: nextName, guildName: nextGuildName, percent: nextPercent },
  });
  res.json(serializeCrusadeDefaultFee(rows[0]));
});

app.delete('/api/crusade-default-fees/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name, percent FROM crusade_default_fees WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_default_fees WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'default fee not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_default_fee',
    entityId: req.params.id,
    description: `Removed the standing default fee for "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name, percent: existingRows[0].percent } : undefined,
  });
  res.status(204).end();
});

app.get('/api/crusades', async (req, res) => {
  const { rows } = await sql`
    SELECT c.id, c.name, c.event_date, c.created_at,
      (SELECT COUNT(*)::int FROM crusade_participants p WHERE p.crusade_id = c.id) AS participant_count,
      (
        -- Sum each of this crusade's teams' own (post-fee, zeroed-if-lost)
        -- pool -- mirrors the client-side math so this matches what the
        -- Team List and Guild Salary page actually pay out in total.
        SELECT COALESCE(SUM(
          CASE WHEN ct.result = 'lose' THEN 0
               ELSE ct.diamond_reward * GREATEST(0, 1 - COALESCE(feesum.total_pct, 0) / 100)
          END
        ), 0)
        FROM crusade_teams ct
        LEFT JOIN (SELECT team_id, SUM(percent) AS total_pct FROM crusade_fees GROUP BY team_id) feesum
          ON feesum.team_id = ct.id
        WHERE ct.crusade_id = c.id
      ) AS net_diamond_reward,
      (
        -- The diamonds management fees actually took off the top -- same
        -- zeroed-if-lost rule as net_diamond_reward, just the other half of
        -- that same split (diamond_reward - net_diamond_reward per team).
        SELECT COALESCE(SUM(
          CASE WHEN ct.result = 'lose' THEN 0
               ELSE ct.diamond_reward * LEAST(1, COALESCE(feesum.total_pct, 0) / 100)
          END
        ), 0)
        FROM crusade_teams ct
        LEFT JOIN (SELECT team_id, SUM(percent) AS total_pct FROM crusade_fees GROUP BY team_id) feesum
          ON feesum.team_id = ct.id
        WHERE ct.crusade_id = c.id
      ) AS fee_diamonds
    FROM crusades c
    ORDER BY c.created_at DESC
  `;
  res.json(
    rows.map((r) => ({
      ...serializeCrusade(r),
      participantCount: r.participant_count,
      netDiamondReward: Number(r.net_diamond_reward),
      feeDiamonds: Number(r.fee_diamonds),
    }))
  );
});

app.post('/api/crusades', async (req, res) => {
  const { name, eventDate } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const id = crypto.randomUUID();
  await sql`INSERT INTO crusades (id, name, event_date) VALUES (${id}, ${name.trim()}, ${eventDate || null})`;
  const { rows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${id}`;
  await logActivity(req, { action: 'create', entityType: 'crusade', entityId: id, description: `Created crusade "${name.trim()}"`, after: { name: name.trim() } });
  res.status(201).json({ ...serializeCrusade(rows[0]), participantCount: 0, netDiamondReward: 0, feeDiamonds: 0 });
});

app.get('/api/crusades/:id', async (req, res) => {
  const { rows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${req.params.id}`;
  const crusade = rows[0];
  if (!crusade) return res.status(404).json({ error: 'crusade not found' });

  const { rows: participantRows } = await sql`
    SELECT * FROM crusade_participants WHERE crusade_id = ${req.params.id} ORDER BY party_number ASC, party_slot ASC, created_at ASC
  `;
  const { rows: teamRows } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${req.params.id} ORDER BY team_number ASC`;
  const { rows: itemRows } = await sql`
    SELECT i.* FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id WHERE t.crusade_id = ${req.params.id} ORDER BY i.created_at ASC
  `;
  const { rows: feeRows } = await sql`
    SELECT f.* FROM crusade_fees f JOIN crusade_teams t ON t.id = f.team_id WHERE t.crusade_id = ${req.params.id} ORDER BY f.created_at ASC
  `;

  const itemsByTeam = new Map();
  itemRows.forEach((r) => {
    if (!itemsByTeam.has(r.team_id)) itemsByTeam.set(r.team_id, []);
    itemsByTeam.get(r.team_id).push(serializeCrusadeItem(r));
  });
  const feesByTeam = new Map();
  feeRows.forEach((r) => {
    if (!feesByTeam.has(r.team_id)) feesByTeam.set(r.team_id, []);
    feesByTeam.get(r.team_id).push(serializeCrusadeFee(r));
  });

  // Each team traces its own area's capture history, so a crusade with
  // multiple Defense-win teams defending different areas can have a
  // different bonus source per team.
  const teams = [];
  for (const t of teamRows) {
    const { lastTeam, bidders: lastTeamBidders } = await getAreaCaptureBidders(crusade, t);
    teams.push({
      ...serializeCrusadeTeam(t),
      items: itemsByTeam.get(t.id) || [],
      fees: feesByTeam.get(t.id) || [],
      lastTeam,
      lastTeamBidders,
    });
  }

  res.json({
    ...serializeCrusade(crusade),
    participants: participantRows.map(serializeCrusadeParticipant),
    teams,
  });
});

app.put('/api/crusades/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'crusade not found' });

  const { name, eventDate } = req.body || {};
  let nextName = existing.name;
  let nextEventDate = existing.event_date;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (eventDate !== undefined) nextEventDate = eventDate || null;

  const { rows } = await sql`
    UPDATE crusades SET name = ${nextName}, event_date = ${nextEventDate}
    WHERE id = ${req.params.id}
    RETURNING id, name, event_date, created_at
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade',
    entityId: req.params.id,
    description: `Updated crusade "${rows[0].name}"`,
    before: serializeCrusade(existing),
    after: serializeCrusade(rows[0]),
  });
  res.json(serializeCrusade(rows[0]));
});

app.put('/api/crusades/:id/teams/:teamNumber', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  if (!Number.isInteger(teamNumber) || teamNumber < 1) return res.status(400).json({ error: 'invalid team number' });

  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const existing = await ensureCrusadeTeam(req.params.id, teamNumber);

  const { warType, stance, area, leader, result, diamondReward, attendancePct, notes } = req.body || {};
  let nextWarType = existing.war_type;
  let nextStance = existing.stance;
  let nextArea = existing.area;
  let nextLeader = existing.leader;
  let nextResult = existing.result;
  let nextDiamondReward = existing.diamond_reward;
  let nextAttendancePct = existing.attendance_pct;
  let nextNotes = existing.notes;

  if (warType !== undefined) nextWarType = warType || null;
  if (stance !== undefined) nextStance = stance || null;
  if (area !== undefined) nextArea = area || null;
  if (leader !== undefined) nextLeader = leader || null;
  if (result !== undefined) nextResult = result || 'pending';
  if (diamondReward !== undefined) {
    const n = Number(diamondReward);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'diamondReward must be a non-negative number' });
    nextDiamondReward = n;
  }
  if (attendancePct !== undefined) {
    const n = Number(attendancePct);
    if (Number.isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'attendancePct must be between 0 and 100' });
    nextAttendancePct = n;
  }
  if (notes !== undefined) nextNotes = notes || null;

  const { rows } = await sql`
    UPDATE crusade_teams SET
      war_type = ${nextWarType}, stance = ${nextStance}, area = ${nextArea}, leader = ${nextLeader},
      result = ${nextResult}, diamond_reward = ${nextDiamondReward}, attendance_pct = ${nextAttendancePct}, notes = ${nextNotes}
    WHERE id = ${existing.id}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_team',
    entityId: rows[0].id,
    description: `Updated Team ${teamNumber} details`,
    before: serializeCrusadeTeam(existing),
    after: serializeCrusadeTeam(rows[0]),
  });
  res.json(serializeCrusadeTeam(rows[0]));
});

// Moves diamonds from one team's reward pool to another's -- e.g. paying a
// member out of a different team's pot than the one they're rostered on.
// Manual diamonds alone can't do this: they only carve a guaranteed amount
// off a team's *own* diamond_reward and hand it to one of that same team's
// participants, so crediting a recipient on team B never actually debits
// team A. Moving diamond_reward itself between the two teams (in one
// transaction, so a mid-flight failure can't debit one side without
// crediting the other) keeps the crusade-wide total conserved.
app.post('/api/crusades/:id/teams/:teamNumber/transfer-diamonds', async (req, res) => {
  const fromTeamNumber = Number(req.params.teamNumber);
  if (!Number.isInteger(fromTeamNumber) || fromTeamNumber < 1) return res.status(400).json({ error: 'invalid team number' });

  const toTeamNumber = Number(req.body?.toTeamNumber);
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(toTeamNumber) || toTeamNumber < 1) return res.status(400).json({ error: 'invalid destination team number' });
  if (toTeamNumber === fromTeamNumber) return res.status(400).json({ error: 'cannot transfer a team\'s diamonds to itself' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const fromTeam = await ensureCrusadeTeam(req.params.id, fromTeamNumber);
  const toTeam = await ensureCrusadeTeam(req.params.id, toTeamNumber);
  if (Number(fromTeam.diamond_reward) < amount) {
    return res.status(400).json({ error: `Team ${fromTeamNumber} only has ${fromTeam.diamond_reward} diamonds to transfer` });
  }

  const [fromResult, toResult] = await sqlTransaction([
    sql`UPDATE crusade_teams SET diamond_reward = diamond_reward - ${amount} WHERE id = ${fromTeam.id} RETURNING *`,
    sql`UPDATE crusade_teams SET diamond_reward = diamond_reward + ${amount} WHERE id = ${toTeam.id} RETURNING *`,
  ]);
  const updatedFrom = fromResult.rows[0];
  const updatedTo = toResult.rows[0];

  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_team',
    entityId: updatedFrom.id,
    description: `Transferred ${amount} diamonds from Team ${fromTeamNumber} to Team ${toTeamNumber}`,
    before: serializeCrusadeTeam(fromTeam),
    after: serializeCrusadeTeam(updatedFrom),
  });
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_team',
    entityId: updatedTo.id,
    description: `Received ${amount} diamonds from Team ${fromTeamNumber} into Team ${toTeamNumber}`,
    before: serializeCrusadeTeam(toTeam),
    after: serializeCrusadeTeam(updatedTo),
  });

  res.json({ from: serializeCrusadeTeam(updatedFrom), to: serializeCrusadeTeam(updatedTo) });
});

// Removing a team clears its roster (participants are keyed by party_number,
// not a foreign key to crusade_teams, so they don't cascade-delete on their
// own) plus its crusade_teams row -- which does cascade-delete that team's
// own items and fees.
app.delete('/api/crusades/:id/teams/:teamNumber', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  if (!Number.isInteger(teamNumber) || teamNumber < 1) return res.status(400).json({ error: 'invalid team number' });

  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { rows: participantRows } = await sql`
    SELECT id FROM crusade_participants WHERE crusade_id = ${req.params.id} AND party_number = ${teamNumber}
  `;
  await sql`DELETE FROM crusade_participants WHERE crusade_id = ${req.params.id} AND party_number = ${teamNumber}`;
  await sql`DELETE FROM crusade_teams WHERE crusade_id = ${req.params.id} AND team_number = ${teamNumber}`;

  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_team',
    entityId: `${req.params.id}:${teamNumber}`,
    description: `Removed Team ${teamNumber} and its ${participantRows.length} participant${participantRows.length === 1 ? '' : 's'} from crusade`,
  });
  res.status(204).end();
});

app.delete('/api/crusades/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusades WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusades WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'crusade not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade',
    entityId: req.params.id,
    description: `Deleted crusade "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/teams/:teamNumber/items', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, quantity } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalQuantity = Number(quantity) || 0;
  if (finalQuantity < 0) return res.status(400).json({ error: 'quantity must be a non-negative number' });

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const id = crypto.randomUUID();
  await sql`INSERT INTO crusade_items (id, crusade_id, team_id, name, quantity) VALUES (${id}, ${req.params.id}, ${team.id}, ${name.trim()}, ${finalQuantity})`;
  const { rows } = await sql`SELECT * FROM crusade_items WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_item',
    entityId: id,
    description: `Added item "${name.trim()}" (${finalQuantity}) to Team ${teamNumber}`,
    after: { name: name.trim(), quantity: finalQuantity },
  });
  res.status(201).json(serializeCrusadeItem(rows[0]));
});

app.put('/api/crusades/:id/teams/:teamNumber/items/:itemId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT i.* FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id
    WHERE i.id = ${req.params.itemId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'item not found' });

  const { name, quantity } = req.body || {};
  let nextName = existing.name;
  let nextQuantity = existing.quantity;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (quantity !== undefined) {
    const n = Number(quantity);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'quantity must be a non-negative number' });
    nextQuantity = n;
  }

  const { rows } = await sql`UPDATE crusade_items SET name = ${nextName}, quantity = ${nextQuantity} WHERE id = ${req.params.itemId} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_item',
    entityId: req.params.itemId,
    description: `Updated item "${rows[0].name}"`,
    before: serializeCrusadeItem(existing),
    after: serializeCrusadeItem(rows[0]),
  });
  res.json(serializeCrusadeItem(rows[0]));
});

app.delete('/api/crusades/:id/teams/:teamNumber/items/:itemId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT i.name FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id
    WHERE i.id = ${req.params.itemId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  if (!existingRows.length) return res.status(404).json({ error: 'item not found' });
  await sql`DELETE FROM crusade_items WHERE id = ${req.params.itemId}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_item',
    entityId: req.params.itemId,
    description: `Removed item "${existingRows[0]?.name}" from Team ${req.params.teamNumber}`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/teams/:teamNumber/fees', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, guildName, percent } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalPercent = Number(percent);
  if (Number.isNaN(finalPercent) || finalPercent < 0 || finalPercent > 100) {
    return res.status(400).json({ error: 'percent must be between 0 and 100' });
  }

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
    VALUES (${id}, ${req.params.id}, ${team.id}, ${name.trim()}, ${guildName || null}, ${finalPercent})
  `;
  const { rows } = await sql`SELECT * FROM crusade_fees WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_fee',
    entityId: id,
    description: `Added a ${finalPercent}% management fee for "${name.trim()}" on Team ${teamNumber}`,
    after: { name: name.trim(), guildName: guildName || null, percent: finalPercent },
  });
  res.status(201).json(serializeCrusadeFee(rows[0]));
});

// Copies the current standing default fees (see crusade_default_fees) onto
// THIS specific team -- for teams that already existed before a default was
// added, since ensureCrusadeTeam only auto-seeds brand-new teams. Skips any
// default whose IGN (case-insensitive) is already on this team's fee list,
// so it's safe to click more than once.
app.post('/api/crusades/:id/teams/:teamNumber/apply-default-fees', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const { rows: existingFees } = await sql`SELECT name FROM crusade_fees WHERE team_id = ${team.id}`;
  const existingNames = new Set(existingFees.map((f) => f.name.trim().toLowerCase()));
  const { rows: defaults } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
  const toAdd = defaults.filter((d) => !existingNames.has(d.name.trim().toLowerCase()));

  const added = [];
  for (const d of toAdd) {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
      VALUES (${id}, ${req.params.id}, ${team.id}, ${d.name}, ${d.guild_name}, ${d.percent})
    `;
    const { rows } = await sql`SELECT * FROM crusade_fees WHERE id = ${id}`;
    added.push(serializeCrusadeFee(rows[0]));
  }

  if (added.length) {
    await logActivity(req, {
      action: 'update',
      entityType: 'crusade_fee',
      entityId: team.id,
      description: `Applied ${added.length} standing default fee${added.length === 1 ? '' : 's'} to Team ${teamNumber}`,
      after: { names: added.map((f) => f.name) },
    });
  }
  res.status(201).json(added);
});

// Manual escape hatch for a fee whose IGN drifted out of sync with the
// Member List (e.g. a rename that happened before the rename-cascade existed,
// or a name that technically differs in whitespace/encoding from the member
// row so the automatic cascade in PUT /api/sovereign-members/:id didn't match
// it) -- lets an admin fix it here directly instead of only through a rename.
app.put('/api/crusades/:id/teams/:teamNumber/fees/:feeId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT f.* FROM crusade_fees f JOIN crusade_teams t ON t.id = f.team_id
    WHERE f.id = ${req.params.feeId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'fee not found' });

  const { name, guildName, percent } = req.body || {};
  let nextName = existing.name;
  let nextGuildName = existing.guild_name;
  let nextPercent = existing.percent;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name is required' });
    nextName = name.trim();
  }
  if (guildName !== undefined) nextGuildName = guildName || null;
  if (percent !== undefined) {
    const n = Number(percent);
    if (Number.isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'percent must be between 0 and 100' });
    nextPercent = n;
  }

  const { rows } = await sql`
    UPDATE crusade_fees SET name = ${nextName}, guild_name = ${nextGuildName}, percent = ${nextPercent}
    WHERE id = ${req.params.feeId}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_fee',
    entityId: req.params.feeId,
    description: `Updated the management fee for "${existing.name}" on Team ${req.params.teamNumber}`,
    before: { name: existing.name, guildName: existing.guild_name, percent: existing.percent },
    after: { name: nextName, guildName: nextGuildName, percent: nextPercent },
  });
  res.json(serializeCrusadeFee(rows[0]));
});

app.delete('/api/crusades/:id/teams/:teamNumber/fees/:feeId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT f.name, f.percent FROM crusade_fees f JOIN crusade_teams t ON t.id = f.team_id
    WHERE f.id = ${req.params.feeId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  if (!existingRows.length) return res.status(404).json({ error: 'fee not found' });
  await sql`DELETE FROM crusade_fees WHERE id = ${req.params.feeId}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_fee',
    entityId: req.params.feeId,
    description: `Removed the management fee for "${existingRows[0]?.name}" from Team ${req.params.teamNumber}`,
    before: existingRows[0] ? { name: existingRows[0].name, percent: existingRows[0].percent } : undefined,
  });
  res.status(204).end();
});

function serializeSovereignMember(row) {
  return { id: row.id, name: row.name, guildName: row.guild_name, position: row.position, updatedAt: row.updated_at };
}

// Keeps the master Member List (sovereign_members) in sync every time a
// crusade participant is saved — one row per unique name, always reflecting
// whichever guild/position was most recently entered for them. Never
// throws: a failure here shouldn't take down the participant save that
// triggered it.
async function upsertSovereignMember(name, guildName, position) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  try {
    const { rows: existing } = await sql`SELECT id FROM sovereign_members WHERE LOWER(name) = LOWER(${trimmed})`;
    if (existing.length) {
      await sql`UPDATE sovereign_members SET name = ${trimmed}, guild_name = ${guildName || null}, position = ${position || null}, updated_at = now() WHERE id = ${existing[0].id}`;
    } else {
      await sql`INSERT INTO sovereign_members (id, name, guild_name, position) VALUES (${crypto.randomUUID()}, ${trimmed}, ${guildName || null}, ${position || null})`;
    }
  } catch (err) {
    console.error('upsertSovereignMember failed', err);
  }
}

app.get('/api/sovereign-members', async (req, res) => {
  const { rows } = await sql`SELECT * FROM sovereign_members ORDER BY guild_name ASC NULLS LAST, LOWER(name) ASC`;
  res.json(rows.map(serializeSovereignMember));
});

// Renames a member on the master list -- also updates every crusade_participants
// and crusade_fees row that used the old name (fees store their IGN as their
// own denormalized name column, same as a roster row), so past rosters and
// management fees reflect the correction instead of the next participant
// save (upsertSovereignMember) re-creating the old name and fighting it.
app.put('/api/sovereign-members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM sovereign_members WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'member not found' });

  const { name } = req.body || {};
  if (name === undefined || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim();

  const { rows: dupeRows } = await sql`
    SELECT id FROM sovereign_members WHERE LOWER(name) = LOWER(${trimmed}) AND id != ${req.params.id}
  `;
  if (dupeRows.length) return res.status(400).json({ error: `"${trimmed}" is already on the member list` });

  const { rows } = await sql`
    UPDATE sovereign_members SET name = ${trimmed}, updated_at = now() WHERE id = ${req.params.id} RETURNING *
  `;
  await sql`UPDATE crusade_participants SET name = ${trimmed} WHERE LOWER(TRIM(name)) = LOWER(TRIM(${existing.name}))`;
  await sql`UPDATE crusade_fees SET name = ${trimmed} WHERE LOWER(TRIM(name)) = LOWER(TRIM(${existing.name}))`;
  await sql`UPDATE crusade_default_fees SET name = ${trimmed} WHERE LOWER(TRIM(name)) = LOWER(TRIM(${existing.name}))`;

  await logActivity(req, {
    action: 'update',
    entityType: 'sovereign_member',
    entityId: req.params.id,
    description: `Renamed "${existing.name}" to "${trimmed}" on the Sovereign member list`,
    before: { name: existing.name },
    after: { name: trimmed },
  });
  res.json(serializeSovereignMember(rows[0]));
});

app.delete('/api/sovereign-members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM sovereign_members WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM sovereign_members WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'member not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'sovereign_member',
    entityId: req.params.id,
    description: `Removed "${existingRows[0]?.name}" from the Sovereign member list`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

// ---------- Growth Rate submissions (populated by the Discord bot) ----------

function serializeGrowthSubmission(row) {
  return {
    id: row.id,
    ign: row.ign,
    class: row.class,
    guildName: row.guild_name,
    lampLevel: row.lamp_level,
    growthRate: row.growth_rate === null || row.growth_rate === undefined ? null : Number(row.growth_rate),
    discordUsername: row.discord_username,
    imageContentType: row.image_content_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Kept in sync with the choices offered by the bot's /uniongr command --
// this is the server-side check, since the bot's own choice list can't be
// trusted as the only guard (a direct API call could send anything).
const GROWTH_SUBMISSION_GUILDS = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL', 'BUBBLEGANG'];

// The Volcano Lamp only goes up to +25.
const GROWTH_LAMP_MIN = 1;
const GROWTH_LAMP_MAX = 25;
function isValidLampLevel(n) {
  return Number.isInteger(n) && n >= GROWTH_LAMP_MIN && n <= GROWTH_LAMP_MAX;
}

function requireGrowthBotSecret(req, res) {
  const expected = process.env.GROWTH_BOT_SECRET;
  if (!expected || req.headers['x-bot-secret'] !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Ranked by growth rate (highest first, unranked/never-set ones last), no
// image bytes -- the web page fetches each screenshot separately via
// GET .../:id/image so the list itself stays small.
app.get('/api/growth-submissions', async (req, res) => {
  const { rows } = await sql`
    SELECT id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
    FROM growth_submissions
    ORDER BY growth_rate DESC NULLS LAST, created_at DESC
  `;
  res.json(rows.map(serializeGrowthSubmission));
});

// Manual entry from the web UI (an admin/editor adding someone's stats
// directly instead of them running /uniongr) -- same table and same
// IGN-match-updates-in-place rule as the bot route, just gated by the
// normal cookie-session check instead of the bot secret.
app.post('/api/growth-submissions', async (req, res) => {
  const { ign, class: className, guildName, lampLevel, growthRate, imageBase64, imageContentType } = req.body || {};
  if (!ign || !ign.trim()) return res.status(400).json({ error: 'ign is required' });
  if (!className || !className.trim()) return res.status(400).json({ error: 'class is required' });
  if (!GROWTH_SUBMISSION_GUILDS.includes(guildName)) {
    return res.status(400).json({ error: `guildName must be one of: ${GROWTH_SUBMISSION_GUILDS.join(', ')}` });
  }
  const lampLevelNum = Number(lampLevel);
  if (!isValidLampLevel(lampLevelNum)) {
    return res.status(400).json({ error: `lampLevel must be an integer between ${GROWTH_LAMP_MIN} and ${GROWTH_LAMP_MAX}` });
  }
  const growthRateNum = Number(growthRate);
  if (!Number.isInteger(growthRateNum) || growthRateNum < 0) {
    return res.status(400).json({ error: 'growthRate must be a non-negative integer' });
  }
  if (!imageBase64 || !imageContentType || !imageContentType.startsWith('image/')) {
    return res.status(400).json({ error: 'a screenshot image is required' });
  }
  let imageBuffer;
  try {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'imageBase64 could not be decoded' });
  }

  const ignTrimmed = ign.trim();
  const { rows: existingByIgn } = await sql`SELECT id FROM growth_submissions WHERE LOWER(ign) = LOWER(${ignTrimmed})`;
  const submitterLabel = `Added by ${req.currentUser.username}`;

  let rows;
  let isUpdate;
  if (existingByIgn.length) {
    isUpdate = true;
    ({ rows } = await sql`
      UPDATE growth_submissions SET
        ign = ${ignTrimmed},
        class = ${className.trim()},
        guild_name = ${guildName},
        lamp_level = ${lampLevelNum},
        growth_rate = ${growthRateNum},
        image_data = ${imageBuffer},
        image_content_type = ${imageContentType},
        discord_username = ${submitterLabel},
        updated_at = now()
      WHERE id = ${existingByIgn[0].id}
      RETURNING id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
    `);
  } else {
    isUpdate = false;
    const id = crypto.randomUUID();
    ({ rows } = await sql`
      INSERT INTO growth_submissions (id, discord_message_id, discord_user_id, discord_username, ign, class, guild_name, lamp_level, growth_rate, image_data, image_content_type)
      VALUES (${id}, ${crypto.randomUUID()}, ${'manual:' + req.currentUser.id}, ${submitterLabel}, ${ignTrimmed}, ${className.trim()}, ${guildName}, ${lampLevelNum}, ${growthRateNum}, ${imageBuffer}, ${imageContentType})
      RETURNING id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
    `);
  }
  await logActivity(req, {
    action: isUpdate ? 'update' : 'create',
    entityType: 'growth_submission',
    entityId: rows[0].id,
    description: `${isUpdate ? 'Updated' : 'Manually added'} a growth-rate entry for "${ignTrimmed}"`,
    after: { ign: ignTrimmed, class: className.trim(), guildName, lampLevel: lampLevelNum, growthRate: growthRateNum },
  });
  res.status(201).json(serializeGrowthSubmission(rows[0]));
});

app.get('/api/growth-submissions/:id/image', async (req, res) => {
  const { rows } = await sql`SELECT image_data, image_content_type FROM growth_submissions WHERE id = ${req.params.id}`;
  const row = rows[0];
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.image_content_type);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(row.image_data);
});

// Called by the Discord bot for every qualifying message (IGN + Class +
// screenshot) in the growth-rate channel -- upserts on discord_message_id so
// editing the original message (e.g. fixing a typo'd IGN) updates the same
// row instead of creating a duplicate.
app.post('/api/growth-submissions/bot', async (req, res) => {
  if (!requireGrowthBotSecret(req, res)) return;

  const { discordMessageId, discordUserId, discordUsername, ign, class: className, guildName, lampLevel, growthRate, imageBase64, imageContentType } = req.body || {};
  if (
    !discordMessageId ||
    !discordUserId ||
    !ign ||
    !className ||
    !guildName ||
    lampLevel === undefined ||
    lampLevel === null ||
    growthRate === undefined ||
    growthRate === null ||
    !imageBase64 ||
    !imageContentType
  ) {
    return res.status(400).json({ error: 'discordMessageId, discordUserId, ign, class, guildName, lampLevel, growthRate, imageBase64, and imageContentType are all required' });
  }
  if (!GROWTH_SUBMISSION_GUILDS.includes(guildName)) {
    return res.status(400).json({ error: `guildName must be one of: ${GROWTH_SUBMISSION_GUILDS.join(', ')}` });
  }
  const lampLevelNum = Number(lampLevel);
  if (!isValidLampLevel(lampLevelNum)) {
    return res.status(400).json({ error: `lampLevel must be an integer between ${GROWTH_LAMP_MIN} and ${GROWTH_LAMP_MAX}` });
  }
  const growthRateNum = Number(growthRate);
  if (!Number.isInteger(growthRateNum) || growthRateNum < 0) {
    return res.status(400).json({ error: 'growthRate must be a non-negative integer' });
  }
  if (!imageContentType.startsWith('image/')) {
    return res.status(400).json({ error: 'imageContentType must be an image type' });
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'imageBase64 could not be decoded' });
  }

  const ignTrimmed = ign.trim();
  // Matched by exact IGN (case-insensitive) only. Matching by discord_user_id
  // was tried to catch a typo'd re-spelling of the same character, but one
  // Discord account can legitimately submit multiple *different* characters
  // (an alt, an officer submitting on someone's behalf, etc.) -- matching on
  // the account alone silently overwrote a different, real character's row
  // with an unrelated submission. A typo'd IGN needs a human to notice and
  // merge deliberately (or an admin can add a specific alias), not an
  // automatic match that can't tell "same character, respelled" apart from
  // "same person, different character."
  const { rows: existingByIgn } = await sql`SELECT id FROM growth_submissions WHERE LOWER(ign) = LOWER(${ignTrimmed})`;

  // Bot-driven submissions have no browser session, so logActivity's usual
  // req.currentUser is never set -- attribute the log entry to whichever
  // Discord member actually submitted it instead, tagged with role "bot" so
  // it reads distinctly from an admin's own edits in the log.
  const botUser = { id: null, username: discordUsername || 'Discord Bot', role: 'bot' };

  let rows;
  let isUpdate;
  if (existingByIgn.length) {
    isUpdate = true;
    ({ rows } = await sql`
      UPDATE growth_submissions SET
        discord_message_id = ${discordMessageId},
        discord_user_id = ${discordUserId},
        discord_username = ${discordUsername || null},
        ign = ${ignTrimmed},
        class = ${className.trim()},
        guild_name = ${guildName},
        lamp_level = ${lampLevelNum},
        growth_rate = ${growthRateNum},
        image_data = ${imageBuffer},
        image_content_type = ${imageContentType},
        updated_at = now()
      WHERE id = ${existingByIgn[0].id}
      RETURNING id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
    `);
  } else {
    isUpdate = false;
    const id = crypto.randomUUID();
    ({ rows } = await sql`
      INSERT INTO growth_submissions (id, discord_message_id, discord_user_id, discord_username, ign, class, guild_name, lamp_level, growth_rate, image_data, image_content_type)
      VALUES (${id}, ${discordMessageId}, ${discordUserId}, ${discordUsername || null}, ${ignTrimmed}, ${className.trim()}, ${guildName}, ${lampLevelNum}, ${growthRateNum}, ${imageBuffer}, ${imageContentType})
      RETURNING id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
    `);
  }
  await logActivity(req, {
    action: isUpdate ? 'update' : 'create',
    entityType: 'growth_submission',
    entityId: rows[0].id,
    description: `${isUpdate ? 'Updated' : 'Submitted'} a growth-rate entry for "${ignTrimmed}" via /uniongr`,
    user: botUser,
    after: { ign: ignTrimmed, class: className.trim(), guildName, lampLevel: lampLevelNum, growthRate: growthRateNum },
  });
  res.status(201).json(serializeGrowthSubmission(rows[0]));
});

// Called by the bot when the source Discord message itself is deleted.
app.delete('/api/growth-submissions/bot/by-message/:discordMessageId', async (req, res) => {
  if (!requireGrowthBotSecret(req, res)) return;
  await sql`DELETE FROM growth_submissions WHERE discord_message_id = ${req.params.discordMessageId}`;
  res.status(204).end();
});

// Manual edit from the web UI (e.g. fixing a typo'd IGN, or correcting the
// class/guild/lamp level someone got wrong on Discord) -- gated by the
// normal cookie-session/editor check like every other PUT in this app, not
// the bot secret. Doesn't touch the screenshot itself; re-submit on Discord
// (same message, edited) for that.
app.put('/api/growth-submissions/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM growth_submissions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'submission not found' });

  const { ign, class: className, guildName, lampLevel, growthRate } = req.body || {};
  let nextIgn = existing.ign;
  let nextClass = existing.class;
  let nextGuild = existing.guild_name;
  let nextLamp = existing.lamp_level;
  let nextGrowthRate = existing.growth_rate;

  if (ign !== undefined) {
    if (!ign.trim()) return res.status(400).json({ error: 'ign cannot be empty' });
    nextIgn = ign.trim();
  }
  if (className !== undefined) {
    if (!className.trim()) return res.status(400).json({ error: 'class cannot be empty' });
    nextClass = className.trim();
  }
  if (guildName !== undefined) {
    if (!GROWTH_SUBMISSION_GUILDS.includes(guildName)) {
      return res.status(400).json({ error: `guildName must be one of: ${GROWTH_SUBMISSION_GUILDS.join(', ')}` });
    }
    nextGuild = guildName;
  }
  if (lampLevel !== undefined) {
    const n = Number(lampLevel);
    if (!isValidLampLevel(n)) return res.status(400).json({ error: `lampLevel must be an integer between ${GROWTH_LAMP_MIN} and ${GROWTH_LAMP_MAX}` });
    nextLamp = n;
  }
  if (growthRate !== undefined) {
    const n = Number(growthRate);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'growthRate must be a non-negative integer' });
    nextGrowthRate = n;
  }

  const { rows } = await sql`
    UPDATE growth_submissions SET ign = ${nextIgn}, class = ${nextClass}, guild_name = ${nextGuild}, lamp_level = ${nextLamp}, growth_rate = ${nextGrowthRate}, updated_at = now()
    WHERE id = ${req.params.id}
    RETURNING id, ign, class, guild_name, lamp_level, growth_rate, discord_username, image_content_type, created_at, updated_at
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'growth_submission',
    entityId: req.params.id,
    description: `Updated the growth-rate submission for "${nextIgn}"`,
    before: { ign: existing.ign, class: existing.class, guildName: existing.guild_name, lampLevel: existing.lamp_level, growthRate: existing.growth_rate },
    after: { ign: nextIgn, class: nextClass, guildName: nextGuild, lampLevel: nextLamp, growthRate: nextGrowthRate },
  });
  res.json(serializeGrowthSubmission(rows[0]));
});

// Manual cleanup from the web UI (e.g. a submission that slipped through
// with a wrong IGN) -- gated by the normal cookie-session/editor check like
// every other DELETE in this app, not the bot secret.
app.delete('/api/growth-submissions/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT ign FROM growth_submissions WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM growth_submissions WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'submission not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'growth_submission',
    entityId: req.params.id,
    description: `Removed the growth-rate submission for "${existingRows[0]?.ign}"`,
    before: existingRows[0] ? { ign: existingRows[0].ign } : undefined,
  });
  res.status(204).end();
});

// ---------- World Boss Attendance ----------

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
  'Ducas',
  'Dergio',
];

function serializeWorldBossEvent(row, attendees, lootItems) {
  return {
    id: row.id,
    bossName: row.boss_name,
    eventDate: row.event_date,
    createdAt: row.created_at,
    attendees: attendees.map((a) => ({ name: a.member_name, guildName: a.guild_name })),
    lootItems: (lootItems || []).map((l) => ({
      id: l.id,
      itemName: l.item_name,
      quantity: l.quantity,
      crowsValue: l.crows_value === null ? null : Number(l.crows_value),
      diamondsValue: l.diamonds_value === null ? null : Number(l.diamonds_value),
      sold: l.sold === true,
    })),
  };
}

// Normalizes the client's lootItems payload into insertable rows. Silently
// drops rows with no item name rather than erroring -- a half-filled loot
// row is a UI mistake, not something worth blocking the whole submission.
function normalizeLootItems(lootItems) {
  if (!Array.isArray(lootItems)) return [];
  return lootItems
    .map((l) => ({
      itemName: String(l?.itemName || '').trim(),
      quantity: Number.isFinite(Number(l?.quantity)) && Number(l?.quantity) > 0 ? Math.floor(Number(l.quantity)) : 1,
      crowsValue: l?.crowsValue === '' || l?.crowsValue === null || l?.crowsValue === undefined ? null : Number(l.crowsValue),
      diamondsValue: l?.diamondsValue === '' || l?.diamondsValue === null || l?.diamondsValue === undefined ? null : Number(l.diamondsValue),
      sold: l?.sold === true,
    }))
    .filter((l) => l.itemName);
}

async function insertLootItems(attendanceId, lootItems) {
  for (const item of lootItems) {
    await sql`
      INSERT INTO world_boss_loot_items (id, attendance_id, item_name, quantity, crows_value, diamonds_value, sold)
      VALUES (${crypto.randomUUID()}, ${attendanceId}, ${item.itemName}, ${item.quantity}, ${item.crowsValue}, ${item.diamondsValue}, ${item.sold})
    `;
  }
}

// Newest event first. Two extra queries for all attendees/loot (rather than
// N+1 per event) since a guild's history can run to hundreds of events.
app.get('/api/world-boss-attendance', async (req, res) => {
  const { rows: events } = await sql`SELECT * FROM world_boss_attendance ORDER BY event_date DESC, created_at DESC`;
  const { rows: attendeeRows } = await sql`SELECT * FROM world_boss_attendees ORDER BY member_name ASC`;
  const { rows: lootRows } = await sql`SELECT * FROM world_boss_loot_items ORDER BY created_at ASC`;
  const attendeesByEvent = new Map();
  attendeeRows.forEach((a) => {
    if (!attendeesByEvent.has(a.attendance_id)) attendeesByEvent.set(a.attendance_id, []);
    attendeesByEvent.get(a.attendance_id).push(a);
  });
  const lootByEvent = new Map();
  lootRows.forEach((l) => {
    if (!lootByEvent.has(l.attendance_id)) lootByEvent.set(l.attendance_id, []);
    lootByEvent.get(l.attendance_id).push(l);
  });
  res.json(events.map((e) => serializeWorldBossEvent(e, attendeesByEvent.get(e.id) || [], lootByEvent.get(e.id) || [])));
});

// Looks up each attendee's current guild from the master member list at
// record time -- denormalized onto world_boss_attendees so a member's later
// guild change (or removal from the list) doesn't rewrite this history.
async function resolveAttendeeGuilds(names) {
  if (!names.length) return new Map();
  const { rows } = await sql`SELECT name, guild_name FROM sovereign_members WHERE LOWER(name) = ANY(${names.map((n) => n.toLowerCase())})`;
  const byLowerName = new Map(rows.map((r) => [r.name.toLowerCase(), r.guild_name]));
  return new Map(names.map((n) => [n, byLowerName.get(n.toLowerCase()) || null]));
}

app.post('/api/world-boss-attendance', async (req, res) => {
  const { bossName, eventDate, attendeeNames, lootItems } = req.body || {};
  if (!bossName || !WORLD_BOSS_NAMES.includes(bossName)) {
    return res.status(400).json({ error: `bossName must be one of: ${WORLD_BOSS_NAMES.join(', ')}` });
  }
  if (!eventDate) return res.status(400).json({ error: 'eventDate is required' });
  const names = Array.isArray(attendeeNames) ? [...new Set(attendeeNames.map((n) => String(n).trim()).filter(Boolean))] : [];
  if (!names.length) return res.status(400).json({ error: 'attendeeNames must include at least one name' });
  const loot = normalizeLootItems(lootItems);

  const id = crypto.randomUUID();
  await sql`INSERT INTO world_boss_attendance (id, boss_name, event_date) VALUES (${id}, ${bossName}, ${eventDate})`;
  const guildByName = await resolveAttendeeGuilds(names);
  for (const name of names) {
    await sql`INSERT INTO world_boss_attendees (id, attendance_id, member_name, guild_name) VALUES (${crypto.randomUUID()}, ${id}, ${name}, ${guildByName.get(name) || null})`;
  }
  await insertLootItems(id, loot);

  const { rows } = await sql`SELECT * FROM world_boss_attendance WHERE id = ${id}`;
  const { rows: attendees } = await sql`SELECT * FROM world_boss_attendees WHERE attendance_id = ${id} ORDER BY member_name ASC`;
  const { rows: lootRows } = await sql`SELECT * FROM world_boss_loot_items WHERE attendance_id = ${id} ORDER BY created_at ASC`;
  await logActivity(req, {
    action: 'create',
    entityType: 'world_boss_attendance',
    entityId: id,
    description: `Logged ${names.length} attendee${names.length === 1 ? '' : 's'} for ${bossName} on ${eventDate}`,
    after: { bossName, eventDate, attendees: names, lootItems: loot },
  });
  res.status(201).json(serializeWorldBossEvent(rows[0], attendees, lootRows));
});

app.put('/api/world-boss-attendance/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM world_boss_attendance WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'event not found' });
  const { rows: existingAttendees } = await sql`SELECT member_name FROM world_boss_attendees WHERE attendance_id = ${req.params.id}`;
  const { rows: existingLoot } = await sql`SELECT item_name, quantity, crows_value, diamonds_value FROM world_boss_loot_items WHERE attendance_id = ${req.params.id}`;

  const { bossName, eventDate, attendeeNames, lootItems } = req.body || {};
  let nextBoss = existing.boss_name;
  let nextDate = existing.event_date;
  if (bossName !== undefined) {
    if (!WORLD_BOSS_NAMES.includes(bossName)) return res.status(400).json({ error: `bossName must be one of: ${WORLD_BOSS_NAMES.join(', ')}` });
    nextBoss = bossName;
  }
  if (eventDate !== undefined) {
    if (!eventDate) return res.status(400).json({ error: 'eventDate cannot be empty' });
    nextDate = eventDate;
  }
  let nextNames = existingAttendees.map((a) => a.member_name);
  if (attendeeNames !== undefined) {
    nextNames = Array.isArray(attendeeNames) ? [...new Set(attendeeNames.map((n) => String(n).trim()).filter(Boolean))] : [];
    if (!nextNames.length) return res.status(400).json({ error: 'attendeeNames must include at least one name' });
  }
  const nextLoot = lootItems !== undefined ? normalizeLootItems(lootItems) : null;

  await sql`UPDATE world_boss_attendance SET boss_name = ${nextBoss}, event_date = ${nextDate} WHERE id = ${req.params.id}`;
  if (attendeeNames !== undefined) {
    await sql`DELETE FROM world_boss_attendees WHERE attendance_id = ${req.params.id}`;
    const guildByName = await resolveAttendeeGuilds(nextNames);
    for (const name of nextNames) {
      await sql`INSERT INTO world_boss_attendees (id, attendance_id, member_name, guild_name) VALUES (${crypto.randomUUID()}, ${req.params.id}, ${name}, ${guildByName.get(name) || null})`;
    }
  }
  if (nextLoot !== null) {
    await sql`DELETE FROM world_boss_loot_items WHERE attendance_id = ${req.params.id}`;
    await insertLootItems(req.params.id, nextLoot);
  }

  const { rows } = await sql`SELECT * FROM world_boss_attendance WHERE id = ${req.params.id}`;
  const { rows: attendees } = await sql`SELECT * FROM world_boss_attendees WHERE attendance_id = ${req.params.id} ORDER BY member_name ASC`;
  const { rows: lootRows } = await sql`SELECT * FROM world_boss_loot_items WHERE attendance_id = ${req.params.id} ORDER BY created_at ASC`;
  await logActivity(req, {
    action: 'update',
    entityType: 'world_boss_attendance',
    entityId: req.params.id,
    description: `Updated the ${nextBoss} attendance record for ${nextDate}`,
    before: { bossName: existing.boss_name, eventDate: existing.event_date, attendees: existingAttendees.map((a) => a.member_name), lootItems: existingLoot },
    after: { bossName: nextBoss, eventDate: nextDate, attendees: nextNames, lootItems: nextLoot !== null ? nextLoot : existingLoot },
  });
  res.json(serializeWorldBossEvent(rows[0], attendees, lootRows));
});

app.delete('/api/world-boss-attendance/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM world_boss_attendance WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'event not found' });
  await sql`DELETE FROM world_boss_attendance WHERE id = ${req.params.id}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'world_boss_attendance',
    entityId: req.params.id,
    description: `Removed the ${existing.boss_name} attendance record for ${existing.event_date}`,
    before: { bossName: existing.boss_name, eventDate: existing.event_date },
  });
  res.status(204).end();
});

// A direct targeted update to one specific drop's sold flag -- deliberately
// NOT going through the world-boss-attendance PUT's full lootItems replace
// (which deletes and reinserts every item on that event with fresh ids),
// since that would silently reset every other item's sold status too.
app.put('/api/world-boss-attendance/loot-items/:itemId/sold', async (req, res) => {
  const { sold } = req.body || {};
  const { rows } = await sql`
    UPDATE world_boss_loot_items SET sold = ${sold === true}
    WHERE id = ${req.params.itemId}
    RETURNING id, item_name, sold
  `;
  if (!rows[0]) return res.status(404).json({ error: 'loot item not found' });
  await logActivity(req, {
    action: 'update',
    entityType: 'world_boss_loot_item',
    entityId: req.params.itemId,
    description: `Marked "${rows[0].item_name}" as ${sold ? 'sold' : 'not sold'}`,
    after: { sold: sold === true },
  });
  res.json({ id: rows[0].id, sold: rows[0].sold === true });
});

// Same key shape the monthly loot view merges items on (trim + collapse
// whitespace + lowercase) -- keeps this table's keys aligned with whatever
// row a saved source ends up attached to on the frontend.
function lootItemKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Every item name that has a "drops from" boss set -- returned as a flat
// list rather than paginated since this is a small reference table (one row
// per distinct item ever annotated), not per-event data.
app.get('/api/loot-item-sources', async (req, res) => {
  const { rows } = await sql`SELECT item_key, item_name, boss_name FROM loot_item_sources`;
  res.json(rows.map((r) => ({ itemKey: r.item_key, itemName: r.item_name, bossName: r.boss_name })));
});

app.put('/api/loot-item-sources', async (req, res) => {
  const { itemName, bossName } = req.body || {};
  const itemKey = lootItemKey(itemName);
  if (!itemKey) return res.status(400).json({ error: 'itemName is required' });
  if (bossName !== null && bossName !== undefined && !WORLD_BOSS_NAMES.includes(bossName)) {
    return res.status(400).json({ error: `bossName must be one of: ${WORLD_BOSS_NAMES.join(', ')}` });
  }
  await sql`
    INSERT INTO loot_item_sources (item_key, item_name, boss_name, updated_at)
    VALUES (${itemKey}, ${String(itemName).trim()}, ${bossName || null}, now())
    ON CONFLICT (item_key) DO UPDATE SET item_name = EXCLUDED.item_name, boss_name = EXCLUDED.boss_name, updated_at = now()
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'loot_item_source',
    entityId: itemKey,
    description: `Set "${itemName}"'s drop source to ${bossName || 'unknown'}`,
    after: { itemName, bossName: bossName || null },
  });
  res.status(204).end();
});

function serializeRaffleWinner(row) {
  return { id: row.id, memberName: row.member_name, guildName: row.guild_name, item: row.item, createdAt: row.created_at };
}

// Standalone raffle draw stack, independent of any crusade -- newest first
// so the most recent draw shows at the top of the Winners list.
app.get('/api/raffle-winners', async (req, res) => {
  const { rows } = await sql`SELECT * FROM raffle_winners ORDER BY created_at DESC`;
  res.json(rows.map(serializeRaffleWinner));
});

// The winner itself is picked client-side (Math.random over whoever's
// checked and not already in the stack) -- this just persists that result.
app.post('/api/raffle-winners', async (req, res) => {
  const { memberName, guildName, item } = req.body || {};
  if (!memberName || !memberName.trim()) return res.status(400).json({ error: 'memberName is required' });

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO raffle_winners (id, member_name, guild_name, item)
    VALUES (${id}, ${memberName.trim()}, ${guildName || null}, ${item ? item.trim() : null})
  `;
  const { rows } = await sql`SELECT * FROM raffle_winners WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'raffle_winner',
    entityId: id,
    description: `🎲 ${memberName.trim()} won the raffle${item && item.trim() ? ` (${item.trim()})` : ''}`,
    after: { memberName: memberName.trim(), guildName: guildName || null, item: item ? item.trim() : null },
  });
  res.status(201).json(serializeRaffleWinner(rows[0]));
});

// Lets the item be filled in (or corrected) after the draw, since you often
// don't know exactly what they won until you've handed it over.
app.put('/api/raffle-winners/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM raffle_winners WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'raffle winner not found' });

  const { item } = req.body || {};
  const nextItem = item !== undefined ? (item ? item.trim() : null) : existing.item;

  const { rows } = await sql`UPDATE raffle_winners SET item = ${nextItem} WHERE id = ${req.params.id} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'raffle_winner',
    entityId: req.params.id,
    description: `Updated ${rows[0].member_name}'s raffle item to "${rows[0].item || '—'}"`,
    before: serializeRaffleWinner(existing),
    after: serializeRaffleWinner(rows[0]),
  });
  res.json(serializeRaffleWinner(rows[0]));
});

// Undoes a single draw -- that member goes back into the eligible pool.
app.delete('/api/raffle-winners/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT member_name FROM raffle_winners WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM raffle_winners WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'raffle winner not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'raffle_winner',
    entityId: req.params.id,
    description: `Removed "${existingRows[0]?.member_name}" from the raffle winners list`,
    before: existingRows[0] ? { name: existingRows[0].member_name } : undefined,
  });
  res.status(204).end();
});

// Clears the whole stack to start a fresh raffle -- everyone becomes
// eligible again.
app.delete('/api/raffle-winners', async (req, res) => {
  const { rows: countRows } = await sql`SELECT COUNT(*)::int AS count FROM raffle_winners`;
  await sql`DELETE FROM raffle_winners`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'raffle_winner',
    entityId: 'all',
    description: `Cleared the raffle winners list (${countRows[0].count} winner${countRows[0].count === 1 ? '' : 's'})`,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/participants', async (req, res) => {
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, guildName, position, goldBid, partyNumber, partySlot, attended, manualDiamonds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalGoldBid = Number(goldBid) || 0;
  if (finalGoldBid < 0) return res.status(400).json({ error: 'goldBid must be a non-negative number' });
  const finalManualDiamonds = Number(manualDiamonds) || 0;
  if (finalManualDiamonds < 0) return res.status(400).json({ error: 'manualDiamonds must be a non-negative number' });
  const finalPartyNumber = Number(partyNumber) || 1;
  const finalPartySlot = Number(partySlot) || 1;

  const partyCount = await countCrusadePartySlot(req.params.id, finalPartyNumber, finalPartySlot);
  if (partyCount >= CRUSADE_PARTY_MAX_MEMBERS) {
    return res.status(400).json({ error: `Party ${finalPartySlot} on Team ${finalPartyNumber} already has ${CRUSADE_PARTY_MAX_MEMBERS} members — pick another party.` });
  }

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_participants (id, crusade_id, party_number, party_slot, name, guild_name, position, gold_bid, attended, manual_diamonds)
    VALUES (${id}, ${req.params.id}, ${finalPartyNumber}, ${finalPartySlot}, ${name.trim()}, ${guildName || null}, ${position || null}, ${finalGoldBid}, ${attended !== false}, ${finalManualDiamonds})
  `;
  const { rows } = await sql`SELECT * FROM crusade_participants WHERE id = ${id}`;
  await upsertSovereignMember(rows[0].name, rows[0].guild_name, rows[0].position);
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_participant',
    entityId: id,
    description: `Added "${name.trim()}" to crusade roster`,
    after: { name: name.trim(), guildName: guildName || null, partyNumber: finalPartyNumber },
  });
  res.status(201).json(serializeCrusadeParticipant(rows[0]));
});

app.put('/api/crusades/:id/participants/:pid', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'participant not found' });

  const { name, guildName, position, goldBid, partyNumber, partySlot, attended, paid, manualDiamonds } = req.body || {};
  let nextName = existing.name;
  let nextGuildName = existing.guild_name;
  let nextPosition = existing.position;
  let nextGoldBid = existing.gold_bid;
  let nextPartyNumber = existing.party_number;
  let nextPartySlot = existing.party_slot;
  let nextAttended = existing.attended;
  let nextPaid = existing.paid;
  let nextManualDiamonds = existing.manual_diamonds;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (guildName !== undefined) nextGuildName = guildName || null;
  if (position !== undefined) nextPosition = position || null;
  if (goldBid !== undefined) {
    const n = Number(goldBid);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'goldBid must be a non-negative number' });
    nextGoldBid = n;
  }
  if (manualDiamonds !== undefined) {
    const n = Number(manualDiamonds);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'manualDiamonds must be a non-negative number' });
    nextManualDiamonds = n;
  }
  if (partyNumber !== undefined) nextPartyNumber = Number(partyNumber) || 1;
  if (partySlot !== undefined) nextPartySlot = Number(partySlot) || 1;
  if (attended !== undefined) nextAttended = !!attended;
  if (paid !== undefined) nextPaid = !!paid;

  if (nextPartyNumber !== existing.party_number || nextPartySlot !== existing.party_slot) {
    const partyCount = await countCrusadePartySlot(req.params.id, nextPartyNumber, nextPartySlot, req.params.pid);
    if (partyCount >= CRUSADE_PARTY_MAX_MEMBERS) {
      return res.status(400).json({ error: `Party ${nextPartySlot} on Team ${nextPartyNumber} already has ${CRUSADE_PARTY_MAX_MEMBERS} members — pick another party.` });
    }
  }

  const { rows } = await sql`
    UPDATE crusade_participants SET
      name = ${nextName}, guild_name = ${nextGuildName}, position = ${nextPosition},
      gold_bid = ${nextGoldBid}, party_number = ${nextPartyNumber}, party_slot = ${nextPartySlot},
      attended = ${nextAttended}, paid = ${nextPaid}, manual_diamonds = ${nextManualDiamonds}
    WHERE id = ${req.params.pid}
    RETURNING *
  `;
  await upsertSovereignMember(rows[0].name, rows[0].guild_name, rows[0].position);
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_participant',
    entityId: req.params.pid,
    description: `Updated "${rows[0].name}" in crusade roster`,
    before: serializeCrusadeParticipant(existing),
    after: serializeCrusadeParticipant(rows[0]),
  });
  res.json(serializeCrusadeParticipant(rows[0]));
});

app.delete('/api/crusades/:id/participants/:pid', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'participant not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_participant',
    entityId: req.params.pid,
    description: `Removed "${existingRows[0]?.name}" from crusade roster`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

module.exports = app;
