const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const port = Number(process.env.PORT || 8000);
const root = path.resolve(__dirname, '..');
const usersFile = path.join(root, 'users.json');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${port}`;
const legacyRoot = root;
const staticRoot = legacyRoot;
const EUROLEAGUE_FEED_BASE = 'https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E';
const DEFAULT_SEASON_CODE = 'E2025';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const LIVE_CACHE_IDLE_MS = 1000 * 60 * 3;
const LIVE_CACHE_LIVE_MS = 1000 * 30;
const TEAM_TLA_MAP = {
  BAR: 'BAR', BAY: 'MUN', PAO: 'PAN', EFS: 'IST', ASM: 'MCO',
  HTA: 'HTA', ZAL: 'ZAL', PBB: 'PRS', DUB: 'DUB', VBC: 'PAM',
  RMB: 'MAD', CZV: 'RED', PAR: 'PAR', KBA: 'BAS', OLY: 'OLY',
  EA7: 'MIL', MTA: 'TEL', VIR: 'VIR', ASV: 'ASV', FBB: 'ULK'
};

const liveDataCache = { expiresAt: 0, payload: null, promise: null };

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function ensureUsersFile() {
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify({ users: [] }, null, 2));
  }
}

function readUsers() {
  ensureUsersFile();
  try {
    const raw = fs.readFileSync(usersFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.users) ? parsed : { users: [] };
  } catch (_) {
    return { users: [] };
  }
}

function writeUsers(data) {
  fs.writeFileSync(usersFile, JSON.stringify(data, null, 2));
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  const [salt, originalHash] = String(storedValue || '').split(':');
  if (!salt || !originalHash) return false;
  const computedHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(computedHash, 'hex'));
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, preferences: user.preferences || null };
}

function createSessionToken() { return crypto.randomBytes(24).toString('hex'); }

function readAuthToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function findUserBySession(token, data) {
  if (!token) return null;
  const now = Date.now();
  return data.users.find(user => user.session?.token === token && user.session?.expiresAt > now) || null;
}

function isValidGoal(goal) { return goal === 'playoffs' || goal === 'playin'; }
function isValidCompetition(comp) { return comp === 'euroleague' || comp === 'nba'; }

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function mapTeamCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return TEAM_TLA_MAP[normalized] || normalized;
}

function normalizeGame(game) {
  const home = game.home ?? {};
  const away = game.away ?? {};
  const status = String(game.status ?? '').toLowerCase();
  return {
    gameCode: game.gameCode ?? game.id ?? game.code ?? null,
    round: Number(game.round?.round ?? game.round ?? game.roundNumber ?? 0),
    date: game.date ?? game.startDate ?? null,
    status: status || null,
    played: ['result', 'final', 'finished', 'played'].includes(status),
    live: ['playing', 'live', 'in_progress', 'in progress'].includes(status),
    minute: game.minute ?? null,
    quarter: game.quarter ?? null,
    quarterMinute: game.quarterMinute ?? game.remainingTime ?? null,
    remainingTime: game.remainingTime ?? null,
    home: {
      code: mapTeamCode(home.code ?? home.clubCode ?? home.tlaCode ?? home.tla ?? game.homeTeamCode ?? ''),
      score: Number(home.score ?? game.homeScore ?? 0)
    },
    away: {
      code: mapTeamCode(away.code ?? away.clubCode ?? away.tlaCode ?? away.tla ?? game.awayTeamCode ?? ''),
      score: Number(away.score ?? game.awayScore ?? 0)
    }
  };
}

function normalizeOfficialStandingsRow(entry, position) {
  const club = entry?.club ?? {};
  const data = entry?.data ?? {};
  const code = mapTeamCode(club.code ?? club.tvCode ?? club.tla ?? '');
  if (!code) return null;
  return {
    code,
    rank: Number(data.position ?? position ?? 99),
    w: Number(data.gamesWon ?? 0),
    l: Number(data.gamesLost ?? 0),
    pts: Number(data.pointsFavour ?? 0),
    ptsA: Number(data.pointsAgainst ?? 0),
    homeW: 0, homeL: 0, awayW: 0, awayL: 0, last10: []
  };
}

async function fetchSeasonGamesFromFeed(seasonCode = DEFAULT_SEASON_CODE) {
  const url = `${EUROLEAGUE_FEED_BASE}/seasons/${seasonCode}/games?limit=400`;
  const payload = await fetchJson(url);
  const rawGames = Array.isArray(payload?.data) ? payload.data : [];
  return rawGames.map(normalizeGame);
}

async function fetchRoundsFromFeed(seasonCode = DEFAULT_SEASON_CODE) {
  const payload = await fetchJson(`${EUROLEAGUE_FEED_BASE}/seasons/${seasonCode}/rounds`);
  const rounds = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return rounds.map(entry => Number(entry?.round ?? entry)).filter(Number.isFinite).sort((a, b) => a - b);
}

async function fetchStandingsFromFeed(round, seasonCode = DEFAULT_SEASON_CODE) {
  if (!Number.isFinite(round)) return { standingsStats: [], teamStandingsTable: {} };
  const payload = await fetchJson(`${EUROLEAGUE_FEED_BASE}/seasons/${seasonCode}/rounds/${round}/standings`);
  const groups = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const rows = groups.find(group => Array.isArray(group?.standings) && group.standings.length)?.standings ?? [];
  const standingsStats = rows.map((entry, index) => normalizeOfficialStandingsRow(entry, index + 1)).filter(Boolean);
  const teamStandingsTable = Object.fromEntries(standingsStats.filter(row => row.code).map(row => [row.code, row.rank]));
  return { standingsStats, teamStandingsTable };
}

function deriveCurrentRound(games) {
  const rounds = [...new Set(games.map(game => Number(game.round)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!rounds.length) return null;
  for (const round of [...rounds].sort((a, b) => b - a)) {
    const roundGames = games.filter(game => game.round === round);
    if (roundGames.some(game => game.live)) return round;
    if (roundGames.some(game => game.played) && roundGames.some(game => !game.played && !game.live)) return round;
    if (roundGames.some(game => game.played)) return round;
  }
  return rounds[rounds.length - 1];
}

function getLiveCacheTtlMs(payload) {
  const hasLiveGame = Array.isArray(payload?.games) && payload.games.some(game => game.live);
  return hasLiveGame ? LIVE_CACHE_LIVE_MS : LIVE_CACHE_IDLE_MS;
}

async function getEuroleagueFeedFallback(error) {
  const games = await fetchSeasonGamesFromFeed(DEFAULT_SEASON_CODE);
  const rounds = await fetchRoundsFromFeed(DEFAULT_SEASON_CODE).catch(() => {
    return [...new Set(games.map(game => Number(game.round)).filter(Number.isFinite))].sort((a, b) => a - b);
  });
  return {
    source: 'feed-fallback', fallbackReason: error?.message || null,
    anyLive: games.some(game => game.live), cacheTtlMs: getLiveCacheTtlMs({ games }),
    buildId: null, currentRound: deriveCurrentRound(games),
    maxRound: rounds.length ? rounds[rounds.length - 1] : null,
    currentSeasonCode: DEFAULT_SEASON_CODE, allAvailableRounds: rounds,
    teamStandingsTable: {}, standingsStats: [], games, fetchedAt: Date.now()
  };
}

async function getEuroleagueLiveData() {
  try {
    const [games, rounds] = await Promise.all([
      fetchSeasonGamesFromFeed(DEFAULT_SEASON_CODE),
      fetchRoundsFromFeed(DEFAULT_SEASON_CODE)
    ]);
    const currentRound = deriveCurrentRound(games);
    const { standingsStats, teamStandingsTable } = await fetchStandingsFromFeed(currentRound, DEFAULT_SEASON_CODE).catch(() => ({ standingsStats: [], teamStandingsTable: {} }));
    return {
      source: 'live', anyLive: games.some(game => game.live), cacheTtlMs: getLiveCacheTtlMs({ games }),
      buildId: null, currentRound, maxRound: rounds.length ? rounds[rounds.length - 1] : null,
      currentSeasonCode: DEFAULT_SEASON_CODE, allAvailableRounds: rounds,
      teamStandingsTable, standingsStats, games, fetchedAt: Date.now()
    };
  } catch (error) {
    return getEuroleagueFeedFallback(error);
  }
}

async function getCachedEuroleagueLiveData() {
  const now = Date.now();
  if (liveDataCache.payload && liveDataCache.expiresAt > now) return liveDataCache.payload;
  if (liveDataCache.promise) return liveDataCache.promise;
  liveDataCache.promise = getEuroleagueLiveData()
    .then(payload => {
      liveDataCache.payload = payload;
      liveDataCache.expiresAt = Date.now() + getLiveCacheTtlMs(payload);
      return payload;
    })
    .finally(() => { liveDataCache.promise = null; });
  return liveDataCache.promise;
}

async function handleRegister(req, res) {
  const data = readUsers();
  const body = await parseBody(req);
  const name = String(body.name || '').trim() || 'Fan';
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) { writeJson(res, 400, { error: 'Email and password are required.' }); return; }
  if (password.length < 6) { writeJson(res, 400, { error: 'Password must be at least 6 characters.' }); return; }
  if (data.users.some(user => user.email === email)) { writeJson(res, 409, { error: 'That email is already registered.' }); return; }
  const token = createSessionToken();
  const user = {
    id: crypto.randomUUID(), name, email, passwordHash: hashPassword(password),
    preferences: null, createdAt: new Date().toISOString(),
    session: { token, expiresAt: Date.now() + SESSION_TTL_MS }
  };
  data.users.push(user);
  writeUsers(data);
  writeJson(res, 201, { token, user: publicUser(user) });
}

async function handleLogin(req, res) {
  const data = readUsers();
  const body = await parseBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const user = data.users.find(entry => entry.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) { writeJson(res, 401, { error: 'Invalid email or password.' }); return; }
  user.session = { token: createSessionToken(), expiresAt: Date.now() + SESSION_TTL_MS };
  writeUsers(data);
  writeJson(res, 200, { token: user.session.token, user: publicUser(user) });
}

function handleSession(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (!user) { writeJson(res, 401, { error: 'Session expired.' }); return; }
  writeJson(res, 200, { user: publicUser(user) });
}

async function handlePreferences(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (!user) { writeJson(res, 401, { error: 'Session expired.' }); return; }
  const body = await parseBody(req);
  const competition = String(body.competition || '').trim().toLowerCase();
  const team = String(body.team || '').trim().toUpperCase();
  const goal = String(body.goal || '').trim();
  if (!isValidCompetition(competition) || !team || !isValidGoal(goal)) {
    writeJson(res, 400, { error: 'Competition, team and goal are required.' });
    return;
  }
  user.preferences = { competition, team, goal };
  writeUsers(data);
  writeJson(res, 200, { user: publicUser(user) });
}

function handleLogout(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (user) { user.session = null; writeUsers(data); }
  writeJson(res, 200, { ok: true });
}

const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

async function sendResetEmail(toEmail, resetToken) {
  if (!RESEND_API_KEY) {
    console.log(`[Password Reset] No RESEND_API_KEY set. Token for ${toEmail}: ${resetToken}`);
    return;
  }
  const resetLink = `${APP_BASE_URL}/?reset=${resetToken}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Is It Good For My Team? <onboarding@resend.dev>',
      to: toEmail,
      subject: 'Reset your password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#09080f;color:#f5f7fb;border-radius:16px">
          <h2 style="margin:0 0 8px;color:#ff8a1d">🏀 Is It Good For My Team?</h2>
          <p style="color:#9ca1bd;margin:0 0 24px">You requested a password reset.</p>
          <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:linear-gradient(180deg,#b85a10,#8d4308);color:#f7f4ee;text-decoration:none;border-radius:12px;font-weight:700">Reset my password</a>
          <p style="color:#9ca1bd;font-size:.85rem;margin-top:24px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
        </div>
      `
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to send email.');
  }
}

async function handleForgotPassword(req, res) {
  const body = await parseBody(req);
  const email = normalizeEmail(body.email);
  if (!email) { writeJson(res, 400, { error: 'Email is required.' }); return; }

  const data = readUsers();
  const user = data.users.find(u => u.email === email);

  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordReset = { token: resetToken, expiresAt: Date.now() + RESET_TOKEN_TTL_MS };
    writeUsers(data);
    try {
      await sendResetEmail(email, resetToken);
    } catch (err) {
      console.error('[Password Reset] Email send failed:', err.message);
    }
  }

  // Always return success to avoid revealing whether email is registered
  writeJson(res, 200, { ok: true, message: 'If that email is registered, a reset link has been sent.' });
}

async function handleResetPassword(req, res) {
  const body = await parseBody(req);
  const token = String(body.token || '').trim();
  const newPassword = String(body.newPassword || '');

  if (!token || !newPassword) { writeJson(res, 400, { error: 'Token and new password are required.' }); return; }
  if (newPassword.length < 6) { writeJson(res, 400, { error: 'Password must be at least 6 characters.' }); return; }

  const data = readUsers();
  const now = Date.now();
  const user = data.users.find(u => u.passwordReset?.token === token && u.passwordReset?.expiresAt > now);

  if (!user) { writeJson(res, 400, { error: 'This reset link is invalid or has expired.' }); return; }

  user.passwordHash = hashPassword(newPassword);
  user.passwordReset = null;
  user.session = null; // Invalidate existing sessions for security
  writeUsers(data);
  writeJson(res, 200, { ok: true, message: 'Password updated. Please log in with your new password.' });
}

function writeStatic(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function serveStatic(parsedUrl, res) {
  let requestPath = decodeURIComponent(parsedUrl.pathname);
  if (requestPath === '/') requestPath = '/index.html';
  const requestedPath = path.normalize(path.join(staticRoot, requestPath));
  if (!requestedPath.startsWith(staticRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    writeStatic(res, requestedPath);
    return;
  }
  writeStatic(res, path.join(staticRoot, 'index.html'));
}

// ============ NBA LIVE DATA SUPPORT ============
const NBA_CDN_BASE = 'https://cdn.nba.com/static/json';
const NBA_STATS_BASE = 'https://stats.nba.com/stats';
const NBA_SEASON = '2025-26';
const NBA_SEASON_START = '2025-10-22';
const NBA_SEASON_END = '2026-04-20';
const ESPN_NBA_SCOREBOARD_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const NBA_TEAM_ID_TO_CODE = {
  1610612737: 'ATL',
  1610612738: 'BOS',
  1610612751: 'BKN',
  1610612766: 'CHA',
  1610612741: 'CHI',
  1610612739: 'CLE',
  1610612742: 'DAL',
  1610612743: 'DEN',
  1610612765: 'DET',
  1610612744: 'GSW',
  1610612745: 'HOU',
  1610612754: 'IND',
  1610612746: 'LAC',
  1610612747: 'LAL',
  1610612763: 'MEM',
  1610612748: 'MIA',
  1610612749: 'MIL',
  1610612750: 'MIN',
  1610612740: 'NOP',
  1610612752: 'NYK',
  1610612760: 'OKC',
  1610612753: 'ORL',
  1610612755: 'PHI',
  1610612756: 'PHX',
  1610612757: 'POR',
  1610612758: 'SAC',
  1610612759: 'SAS',
  1610612761: 'TOR',
  1610612762: 'UTA',
  1610612764: 'WAS'
};
const ESPN_TEAM_CODE_ALIASES = {
  GS: 'GSW',
  NO: 'NOP',
  NY: 'NYK',
  PHO: 'PHX',
  SA: 'SAS'
};
const NBA_REQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true'
};
const nbaCdnHeaders = { 'User-Agent': NBA_REQ_HEADERS['User-Agent'], 'Referer': 'https://www.nba.com/' };
const nbaLiveCache = { expiresAt: 0, payload: null, promise: null };

async function fetchNbaJson(url, useStatsHeaders) {
  const hdrs = useStatsHeaders ? NBA_REQ_HEADERS : nbaCdnHeaders;
  const resp = await fetch(url, { headers: hdrs });
  if (!resp.ok) throw new Error('NBA API error: ' + resp.status + ' ' + url);
  return resp.json();
}

function normalizeEspnTeamCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return ESPN_TEAM_CODE_ALIASES[normalized] || normalized;
}

function formatDateStamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function normalizeEspnNbaGame(event) {
  const competition = event?.competitions?.[0] || {};
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.find(item => item.homeAway === 'home') || {};
  const away = competitors.find(item => item.homeAway === 'away') || {};
  const homeCode = normalizeEspnTeamCode(home?.team?.abbreviation);
  const awayCode = normalizeEspnTeamCode(away?.team?.abbreviation);
  if (!homeCode || !awayCode) return null;

  const dateStr = event?.date || competition?.date || '';
  const tipoff = new Date(dateStr);
  const seasonStart = new Date(NBA_SEASON_START);
  const week = Math.max(1, Math.floor((tipoff - seasonStart) / (7 * 24 * 60 * 60 * 1000)) + 1);
  const completed = Boolean(competition?.status?.type?.completed);
  const liveState = String(competition?.status?.type?.state || '').toLowerCase();
  const live = liveState === 'in';

  return {
    gameCode: event?.id || competition?.id || `${homeCode}-${awayCode}-${formatDateStamp(tipoff)}`,
    round: week,
    date: dateStr,
    status: completed ? 'final' : live ? 'live' : 'confirmed',
    played: completed,
    live,
    minute: live ? (competition?.status?.displayClock || null) : null,
    quarter: live ? Number(competition?.status?.period || 0) : null,
    quarterMinute: null,
    remainingTime: live ? (competition?.status?.displayClock || null) : null,
    home: { code: homeCode, score: Number(home?.score || 0) },
    away: { code: awayCode, score: Number(away?.score || 0) }
  };
}

async function fetchEspnNbaScoreboardForDate(date) {
  const url = `${ESPN_NBA_SCOREBOARD_BASE}?dates=${formatDateStamp(date)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': NBA_REQ_HEADERS['User-Agent'] } });
  if (!resp.ok) throw new Error('ESPN NBA API error: ' + resp.status + ' ' + url);
  return resp.json();
}

async function fetchNbaScheduleFallback() {
  const start = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000));
  const seasonStart = new Date(NBA_SEASON_START);
  const end = new Date(NBA_SEASON_END);
  const current = start > seasonStart ? start : seasonStart;
  const dates = [];
  const gameMap = new Map();

  while (current <= end) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  const payloads = await Promise.all(dates.map(date => fetchEspnNbaScoreboardForDate(date)));
  payloads.forEach(payload => {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    events.forEach(event => {
      const game = normalizeEspnNbaGame(event);
      if (game?.gameCode) gameMap.set(game.gameCode, game);
    });
  });

  return Array.from(gameMap.values());
}

async function fetchNbaStandings() {
  const url = NBA_STATS_BASE + '/leaguestandingsv3?LeagueID=00&Season=' + NBA_SEASON + '&SeasonType=Regular+Season&Section=overall';
  const payload = await fetchNbaJson(url, true);
  const rs = (payload.resultSets || []).find(r => r.name === 'Standings');
  if (!rs) return { standingsStats: [], teamStandingsTable: {} };
  const H = rs.headers || [];
  const idx = n => H.indexOf(n);
  const rows = rs.rowSet || [];
  const standingsStats = rows.map((row, i) => {
    const teamId = Number(row[idx('TeamID')] || 0);
    const abbr = NBA_TEAM_ID_TO_CODE[teamId] || '';
    const wins = Number(row[idx('WINS')] || 0);
    const losses = Number(row[idx('LOSSES')] || 0);
    const homeRec = String(row[idx('HOME')] || '0-0').split('-');
    const roadRec = String(row[idx('ROAD')] || '0-0').split('-');
    const l10 = String(row[idx('L10')] || '0-0').split('-');
    const rank = Number(row[idx('LeagueRank')] || i + 1);
    const confRank = Number(row[idx('PlayoffRank')] || 0);
    const conf = String(row[idx('Conference')] || '');
    const streak = String(row[idx('strCurrentStreak')] || '');
    const streakArr = [];
    const sm = streak.match(/(W|L)(\d+)/);
    if (sm) { const n = Math.min(Number(sm[2]), 10), t = sm[1]; for (let s = 0; s < n; s++) streakArr.push(t); }
    return {
      code: abbr, rank, confRank, conference: conf,
      w: wins, l: losses, pts: 0, ptsA: 0,
      homeW: Number(homeRec[0] || 0), homeL: Number(homeRec[1] || 0),
      awayW: Number(roadRec[0] || 0), awayL: Number(roadRec[1] || 0),
      last10: [...Array.from({ length: Number(l10[0] || 0) }, () => 'W'), ...Array.from({ length: Number(l10[1] || 0) }, () => 'L')].slice(-10)
    };
  });
  const teamStandingsTable = {};
  standingsStats
    .filter(t => t.code)
    .forEach(t => { teamStandingsTable[t.code] = t.rank; });
  return { standingsStats, teamStandingsTable };
}

async function fetchNbaSchedule() {
  const payload = await fetchNbaJson(NBA_CDN_BASE + '/staticData/scheduleLeagueV2_1.json', false);
  const gameDates = (payload.leagueSchedule || {}).gameDates || [];
  const games = [];
  const seasonStart = new Date(NBA_SEASON_START);
  for (const gd of gameDates) {
    for (const g of (gd.games || [])) {
      const dateStr = g.gameDateTimeUTC || g.gameDateUTC || '';
      const d = new Date(dateStr);
      const week = Math.max(1, Math.floor((d - seasonStart) / (7 * 24 * 60 * 60 * 1000)) + 1);
      const isPlayed = g.gameStatus === 3 || g.gameStatusText === 'Final';
      games.push({
        gameCode: g.gameId, round: week, date: dateStr,
        status: g.gameStatus === 1 ? 'confirmed' : g.gameStatus === 2 ? 'live' : 'final',
        played: isPlayed, live: g.gameStatus === 2,
        minute: null, quarter: null, quarterMinute: null, remainingTime: null,
        home: { code: (g.homeTeam || {}).teamTricode || '', score: Number((g.homeTeam || {}).score || 0) },
        away: { code: (g.awayTeam || {}).teamTricode || '', score: Number((g.awayTeam || {}).score || 0) }
      });
    }
  }
  return games;
}

async function fetchNbaTodayLive() {
  const data = await fetchNbaJson(NBA_CDN_BASE + '/liveData/scoreboard/todaysScoreboard_00.json', false);
  const games = ((data.scoreboard || {}).games) || [];
  const seasonStart = new Date(NBA_SEASON_START);
  return games.map(g => {
    const d = new Date(g.gameTimeUTC || '');
    const week = Math.max(1, Math.floor((d - seasonStart) / (7 * 24 * 60 * 60 * 1000)) + 1);
    return {
      gameCode: g.gameId, round: week, date: g.gameTimeUTC || '',
      status: g.gameStatus === 1 ? 'confirmed' : g.gameStatus === 2 ? 'live' : 'final',
      played: g.gameStatus === 3, live: g.gameStatus === 2,
      minute: g.gameStatus === 2 ? (g.gameClock || null) : null,
      quarter: g.gameStatus === 2 ? g.period : null,
      quarterMinute: null, remainingTime: g.gameStatus === 2 ? (g.gameClock || null) : null,
      home: { code: (g.homeTeam || {}).teamTricode || '', score: Number((g.homeTeam || {}).score || 0) },
      away: { code: (g.awayTeam || {}).teamTricode || '', score: Number((g.awayTeam || {}).score || 0) }
    };
  });
}

async function fetchNbaPlayerStats() {
  const url = NBA_STATS_BASE + '/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=';
  const payload = await fetchNbaJson(url, true);
  const rs = (payload.resultSets || []).find(r => r.name === 'LeagueDashPlayerStats');
  if (!rs) return {};
  const H = rs.headers || [];
  const idx = n => H.indexOf(n);
  const result = {};
  for (const row of (rs.rowSet || [])) {
    const pid = String(row[idx('PLAYER_ID')] || '');
    if (!pid) continue;
    result[pid] = {
      name: row[idx('PLAYER_NAME')] || '',
      team: row[idx('TEAM_ABBREVIATION')] || '',
      photo: 'https://cdn.nba.com/headshots/nba/latest/260x190/' + pid + '.png',
      pos: row[idx('PlayerPosition')] || '',
      gp: Number(row[idx('GP')] || 0),
      pts: +(Number(row[idx('PTS')] || 0).toFixed(1)),
      reb: +(Number(row[idx('REB')] || 0).toFixed(1)),
      ast: +(Number(row[idx('AST')] || 0).toFixed(1)),
      stl: +(Number(row[idx('STL')] || 0).toFixed(1)),
      blk: +(Number(row[idx('BLK')] || 0).toFixed(1)),
      pir: 0
    };
  }
  return result;
}

async function buildNbaLiveData() {
  const [standingsData, seasonGames, fallbackGames] = await Promise.all([
    fetchNbaStandings(),
    fetchNbaSchedule().catch(() => []),
    fetchNbaScheduleFallback().catch(() => [])
  ]);
  const todayGames = await fetchNbaTodayLive().catch(() => []);
  const seasonSchedule = seasonGames.length ? seasonGames : fallbackGames;
  const gamesMap = {};
  for (const g of seasonSchedule) gamesMap[g.gameCode] = g;
  for (const g of todayGames) gamesMap[g.gameCode] = { ...(gamesMap[g.gameCode] || {}), ...g };
  const allGames = Object.values(gamesMap);
  const anyLive = allGames.some(g => g.live);
  const weeks = [...new Set(allGames.map(g => g.round).filter(Number.isFinite))].sort((a, b) => a - b);
  const maxRound = weeks.length ? weeks[weeks.length - 1] : 30;
  const playedGames = allGames.filter(g => g.played);
  const currentRound = playedGames.length ? Math.max(...playedGames.map(g => g.round)) : 1;
  return {
    source: 'live', anyLive, cacheTtlMs: anyLive ? 30000 : 180000, buildId: null,
    currentRound, maxRound, currentSeasonCode: NBA_SEASON,
    allAvailableRounds: weeks.length ? weeks : [...Array(30)].map((_, i) => i + 1),
    teamStandingsTable: standingsData.teamStandingsTable,
    standingsStats: standingsData.standingsStats,
    games: allGames, fetchedAt: new Date()
  };
}

async function getCachedNbaLiveData() {
  const now = Date.now();
  if (nbaLiveCache.payload && nbaLiveCache.expiresAt > now) return nbaLiveCache.payload;
  if (nbaLiveCache.promise) return nbaLiveCache.promise;
  nbaLiveCache.promise = buildNbaLiveData()
    .then(p => { nbaLiveCache.payload = p; nbaLiveCache.expiresAt = Date.now() + (p.cacheTtlMs || 180000); return p; })
    .catch(err => ({
      source: 'error', error: err.message, anyLive: false, cacheTtlMs: 60000, buildId: null,
      currentRound: 1, maxRound: 30, currentSeasonCode: NBA_SEASON,
      allAvailableRounds: [...Array(30)].map((_, i) => i + 1),
      teamStandingsTable: {}, standingsStats: [], games: [], fetchedAt: new Date()
    }))
    .finally(() => { nbaLiveCache.promise = null; });
  return nbaLiveCache.promise;
}
// ============ END NBA LIVE DATA SUPPORT ============

http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${port}`);

  if (req.method === 'OPTIONS') {
    writeJson(res, 204, {});
    return;
  }

  try {
    if (req.method === 'GET' && parsedUrl.pathname === '/api/euroleague/live-data') {
      const payload = await getCachedEuroleagueLiveData();
      writeJson(res, 200, payload);
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/nba/live-data') {
      const payload = await getCachedNbaLiveData();
      writeJson(res, 200, payload);
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/nba/players') {
      const players = await fetchNbaPlayerStats().catch(err => ({ error: err.message }));
      writeJson(res, 200, players);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/register') { await handleRegister(req, res); return; }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/login') { await handleLogin(req, res); return; }
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/session') { handleSession(req, res); return; }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/logout') { handleLogout(req, res); return; }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/forgot-password') { await handleForgotPassword(req, res); return; }
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/reset-password') { await handleResetPassword(req, res); return; }
    if (req.method === 'PUT' && parsedUrl.pathname === '/api/user/preferences') { await handlePreferences(req, res); return; }
    serveStatic(parsedUrl, res);
  } catch (error) {
    const statusCode = error.message === 'Invalid JSON body' ? 400 : 500;
    writeJson(res, statusCode, { error: error.message || 'Server error' });
  }
}).listen(port, () => {
  ensureUsersFile();
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Static root: ${staticRoot}`);
});
