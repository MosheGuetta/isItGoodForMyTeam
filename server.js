const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const usersFile = path.join(root, 'users.json');
const EUROLEAGUE_SITE = 'https://www.euroleaguebasketball.net';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Codex Local Proxy'
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 Codex Local Proxy',
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveBuildId() {
  const html = await fetchText(`${EUROLEAGUE_SITE}/euroleague/standings/`);
  const match = html.match(/"buildId":"([^"]+)"/);
  if (!match) throw new Error('Could not find Next.js buildId');
  return match[1];
}

function normalizeGame(game) {
  const home = game.home ?? {};
  const away = game.away ?? {};
  return {
    gameCode: game.gameCode ?? game.id ?? null,
    round: Number(game.round ?? game.roundNumber ?? 0),
    date: game.date ?? game.startDate ?? null,
    status: game.status ?? null,
    home: {
      code: home.code ?? home.clubCode ?? home.tlaCode ?? game.homeTeamCode ?? '',
      score: Number(home.score ?? game.homeScore ?? 0)
    },
    away: {
      code: away.code ?? away.clubCode ?? away.tlaCode ?? game.awayTeamCode ?? '',
      score: Number(away.score ?? game.awayScore ?? 0)
    }
  };
}

async function getEuroleagueLiveData() {
  const buildId = await resolveBuildId();
  const base = `${EUROLEAGUE_SITE}/_next/data/${buildId}/en/euroleague`;
  const [standingsData, gameCenterData] = await Promise.all([
    fetchJson(`${base}/standings.json`),
    fetchJson(`${base}/game-center.json`)
  ]);

  const standingsProps = standingsData?.pageProps ?? {};
  const gameCenterProps = gameCenterData?.pageProps ?? {};
  const games = Array.isArray(gameCenterProps.games) ? gameCenterProps.games.map(normalizeGame) : [];

  return {
    source: 'live',
    buildId,
    currentRound: gameCenterProps.currentRound ?? null,
    maxRound: gameCenterProps.maxRound ?? null,
    currentSeasonCode: gameCenterProps.currentSeasonCode ?? null,
    allAvailableRounds: gameCenterProps.allAvailableRounds ?? [],
    teamStandingsTable: gameCenterProps.teamStandingsTable ?? {},
    standingsStats: standingsProps.statsData ?? [],
    games
  };
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
      const payload = await getEuroleagueLiveData();
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
