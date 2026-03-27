const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const usersFile = path.join(root, 'users.json');
const EUROLEAGUE_FEED_BASE = 'https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E';
const DEFAULT_SEASON_CODE = 'E2025';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const LIVE_CACHE_TTL_MS = 1000 * 60 * 5;
const TEAM_TLA_MAP = {
  BAR: 'BAR',
  BAY: 'MUN',
  PAO: 'PAN',
  EFS: 'IST',
  ASM: 'MCO',
  HTA: 'HTA',
  ZAL: 'ZAL',
  PBB: 'PRS',
  DUB: 'DUB',
  VBC: 'PAM',
  RMB: 'MAD',
  CZV: 'RED',
  PAR: 'PAR',
  KBA: 'BAS',
  OLY: 'OLY',
  EA7: 'MIL',
  MTA: 'TEL',
  VIR: 'VIR',
  ASV: 'ASV',
  FBB: 'ULK'
};

const liveDataCache = {
  expiresAt: 0,
  payload: null,
  promise: null
};

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
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    preferences: user.preferences || null
  };
}

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

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

function isValidGoal(goal) {
  return goal === 'playoffs' || goal === 'playin';
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
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

function normalizeStandingsRow(group) {
  const tla = String(group?.groupName ?? group?.tla ?? group?.code ?? '').toUpperCase();
  if (!tla) return null;
  const stats = Array.isArray(group?.stats) ? group.stats : [];
  const values = Object.fromEntries(stats.map(stat => {
    const name = stat?.name;
    const rawValue = Array.isArray(stat?.value) ? stat.value[0]?.statValue : stat?.value;
    return [name, rawValue];
  }));
  const parseRecord = record => {
    const match = String(record || '').match(/(\d+)\s*-\s*(\d+)/);
    return match ? { w: Number(match[1]), l: Number(match[2]) } : { w: 0, l: 0 };
  };
  const home = parseRecord(values.H);
  const away = parseRecord(values.A);
  const last10 = parseRecord(values.L10);
  return {
    code: mapTeamCode(tla),
    rank: Number(values.Position ?? values.position ?? 99),
    w: Number(values.Won ?? 0),
    l: Number(values.Lost ?? 0),
    pts: Number(String(values['Pts+'] ?? 0).replace(/,/g, '')),
    ptsA: Number(String(values['Pts-'] ?? 0).replace(/,/g, '')),
    homeW: home.w,
    homeL: home.l,
    awayW: away.w,
    awayL: away.l,
    last10: [...Array.from({ length: last10.w }, () => 'W'), ...Array.from({ length: last10.l }, () => 'L')].slice(-10)
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
  return rounds
    .map(entry => Number(entry?.round ?? entry))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
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
    homeW: 0,
    homeL: 0,
    awayW: 0,
    awayL: 0,
    last10: []
  };
}

async function fetchStandingsFromFeed(round, seasonCode = DEFAULT_SEASON_CODE) {
  if (!Number.isFinite(round)) {
    return { standingsStats: [], teamStandingsTable: {} };
  }

  const payload = await fetchJson(`${EUROLEAGUE_FEED_BASE}/seasons/${seasonCode}/rounds/${round}/standings`);
  const groups = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const rows = groups.find(group => Array.isArray(group?.standings) && group.standings.length)?.standings ?? [];
  const standingsStats = rows.map((entry, index) => normalizeOfficialStandingsRow(entry, index + 1)).filter(Boolean);
  const teamStandingsTable = Object.fromEntries(
    standingsStats
      .filter(row => row.code)
      .map(row => [row.code, row.rank])
  );

  return { standingsStats, teamStandingsTable };
}

function deriveCurrentRound(games) {
  const rounds = [...new Set(games.map(game => Number(game.round)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!rounds.length) return null;

  for (const round of [...rounds].sort((a, b) => b - a)) {
    const roundGames = games.filter(game => game.round === round);
    const hasLiveGame = roundGames.some(game => game.live);
    const hasPlayedGame = roundGames.some(game => game.played);
    const hasPendingGame = roundGames.some(game => !game.played && !game.live);
    if (hasLiveGame) return round;
    if (hasPlayedGame && hasPendingGame) return round;
    if (hasPlayedGame) return round;
  }

  return rounds[rounds.length - 1];
}

async function getEuroleagueFeedFallback(error) {
  const games = await fetchSeasonGamesFromFeed(DEFAULT_SEASON_CODE);
  const rounds = await fetchRoundsFromFeed(DEFAULT_SEASON_CODE).catch(() => {
    return [...new Set(games.map(game => Number(game.round)).filter(Number.isFinite))].sort((a, b) => a - b);
  });

  return {
    source: 'feed-fallback',
    fallbackReason: error?.message || null,
    buildId: null,
    currentRound: deriveCurrentRound(games),
    maxRound: rounds.length ? rounds[rounds.length - 1] : null,
    currentSeasonCode: DEFAULT_SEASON_CODE,
    allAvailableRounds: rounds,
    teamStandingsTable: {},
    standingsStats: [],
    games,
    fetchedAt: Date.now()
  };
}

async function getEuroleagueLiveData() {
  try {
    const [games, rounds] = await Promise.all([
      fetchSeasonGamesFromFeed(DEFAULT_SEASON_CODE),
      fetchRoundsFromFeed(DEFAULT_SEASON_CODE)
    ]);
    const currentRound = deriveCurrentRound(games);
    const { standingsStats, teamStandingsTable } = await fetchStandingsFromFeed(currentRound, DEFAULT_SEASON_CODE).catch(() => {
      return { standingsStats: [], teamStandingsTable: {} };
    });

    return {
      source: 'live',
      buildId: null,
      currentRound,
      maxRound: rounds.length ? rounds[rounds.length - 1] : null,
      currentSeasonCode: DEFAULT_SEASON_CODE,
      allAvailableRounds: rounds,
      teamStandingsTable,
      standingsStats,
      games,
      fetchedAt: Date.now()
    };
  } catch (error) {
    return getEuroleagueFeedFallback(error);
  }
}

async function getCachedEuroleagueLiveData() {
  const now = Date.now();
  if (liveDataCache.payload && liveDataCache.expiresAt > now) {
    return liveDataCache.payload;
  }

  if (liveDataCache.promise) {
    return liveDataCache.promise;
  }

  liveDataCache.promise = getEuroleagueLiveData()
    .then(payload => {
      liveDataCache.payload = payload;
      liveDataCache.expiresAt = Date.now() + LIVE_CACHE_TTL_MS;
      return payload;
    })
    .finally(() => {
      liveDataCache.promise = null;
    });

  return liveDataCache.promise;
}

async function handleRegister(req, res) {
  const data = readUsers();
  const body = await parseBody(req);
  const name = String(body.name || '').trim() || 'Fan';
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!email || !password) {
    writeJson(res, 400, { error: 'Email and password are required.' });
    return;
  }
  if (password.length < 6) {
    writeJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }
  if (data.users.some(user => user.email === email)) {
    writeJson(res, 409, { error: 'That email is already registered.' });
    return;
  }

  const token = createSessionToken();
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    preferences: null,
    createdAt: new Date().toISOString(),
    session: {
      token,
      expiresAt: Date.now() + SESSION_TTL_MS
    }
  };
  data.users.push(user);
  writeUsers(data);

  writeJson(res, 201, {
    token,
    user: publicUser(user)
  });
}

async function handleLogin(req, res) {
  const data = readUsers();
  const body = await parseBody(req);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const user = data.users.find(entry => entry.email === email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    writeJson(res, 401, { error: 'Invalid email or password.' });
    return;
  }

  user.session = {
    token: createSessionToken(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  writeUsers(data);

  writeJson(res, 200, {
    token: user.session.token,
    user: publicUser(user)
  });
}

function handleSession(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (!user) {
    writeJson(res, 401, { error: 'Session expired.' });
    return;
  }
  writeJson(res, 200, { user: publicUser(user) });
}

async function handlePreferences(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (!user) {
    writeJson(res, 401, { error: 'Session expired.' });
    return;
  }

  const body = await parseBody(req);
  const team = String(body.team || '').trim().toUpperCase();
  const goal = String(body.goal || '').trim();
  if (!team || !isValidGoal(goal)) {
    writeJson(res, 400, { error: 'Team and goal are required.' });
    return;
  }

  user.preferences = { team, goal };
  writeUsers(data);
  writeJson(res, 200, { user: publicUser(user) });
}

function handleLogout(req, res) {
  const data = readUsers();
  const user = findUserBySession(readAuthToken(req), data);
  if (user) {
    user.session = null;
    writeUsers(data);
  }
  writeJson(res, 200, { ok: true });
}

function serveStatic(parsedUrl, res) {
  const requestPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const filePath = path.join(root, decodeURIComponent(requestPath));

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${port}`);

  try {
    if (req.method === 'GET' && parsedUrl.pathname === '/api/euroleague/live-data') {
      const payload = await getCachedEuroleagueLiveData();
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/register') {
      await handleRegister(req, res);
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/session') {
      handleSession(req, res);
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/logout') {
      handleLogout(req, res);
      return;
    }

    if (req.method === 'PUT' && parsedUrl.pathname === '/api/user/preferences') {
      await handlePreferences(req, res);
      return;
    }

    serveStatic(parsedUrl, res);
  } catch (error) {
    const statusCode = error.message === 'Invalid JSON body' ? 400 : 500;
    writeJson(res, statusCode, { error: error.message || 'Server error' });
  }
}).listen(port, () => {
  ensureUsersFile();
  console.log(`Server running at http://localhost:${port}`);
});
