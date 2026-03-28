// Baked-in data (no network needed)
const GAMES_DATA = window.__GAMES__;
const CLUBS_DATA = window.__CLUBS__;
const STATS_DATA = window.__STATS__;
const META_DATA  = window.__META__;
const MEDALS = ['1.','2.','3.','4.','5.'];
const LIVE_POLL_INTERVAL_MS = 3 * 60 * 1000;
const LIVE_POLL_INTERVAL_LIVE_MS = 30 * 1000;
const TAB_NAMES = ['analysis', 'standings', 'schedule', 'players', 'live', 'scenarios'];
// Keep the bundled snapshot aligned with the known official order when live data is unavailable.
const SNAPSHOT_STANDINGS_OVERRIDES = {
  ULK: 1,
  OLY: 2,
  MAD: 3,
  PAM: 4,
  HTA: 5,
  ZAL: 6,
  MCO: 7,
  PAN: 8,
  RED: 9,
  BAR: 10,
  TEL: 11,
  DUB: 12,
  MIL: 13,
  MUN: 14,
  VIR: 15,
  PAR: 16,
  PRS: 17,
  IST: 18,
  BAS: 19,
  ASV: 20
};

const APP = {
  currentScreen: 'auth',
  authMode: 'login',
  sessionToken: localStorage.getItem('igtmt-session-token') || '',
  currentUser: null,
  selectedCompetition: 'euroleague',
  selectedTeam: null,
  selectedGoal: null,
  allGames: GAMES_DATA,
  clubs: CLUBS_DATA,
  standings: [],
  seasonStats: STATS_DATA,
  playerMeta: META_DATA,
  officialStandingsTable: SNAPSHOT_STANDINGS_OVERRIDES,
  officialStandingsStats: null,
  liveMeta: null,
  authBusy: false
};

const TEAM_CODE_ALIASES = {
  MTA: 'TEL'
};

function normalizeTeamCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  return TEAM_CODE_ALIASES[normalized] || normalized;
}

function getLivePollInterval() {
  return APP.liveMeta?.anyLive ? LIVE_POLL_INTERVAL_LIVE_MS : LIVE_POLL_INTERVAL_MS;
}

let hasInitialized = false;

// Init
async function init() {
  await patchPlayerTeams();
  await loadLiveData();
  const calculatedStandings = calcStandings(APP.allGames, APP.officialStandingsTable);
  APP.standings = mergeStandings(calculatedStandings, APP.officialStandingsStats);
  renderTeamGrid();
  renderScreen();
  setAuthMode(APP.authMode);
  await restoreSession();
  renderStandings();
  renderSchedule();
  renderPlayers();
  renderLiveResults();
  renderScenarios();
  startLivePolling();
}

// Tabs
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', TAB_NAMES[i] === name));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  if (name === 'standings') renderStandings();
  if (name === 'schedule') renderSchedule();
  if (name === 'players') renderPlayers();
  if (name === 'live') renderLiveResults();
  if (name === 'scenarios') renderScenarios();
}

function renderScreen() {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.toggle('active', screen.id === `screen-${APP.currentScreen}`);
  });
  updateHeaderStatus();
  renderAnalysisSummary();
  renderAuthState();
}

function updateHeaderStatus() {
  const subtitle = document.getElementById('appSubtitle');
  const status = document.getElementById('headerStatus');
  if (!subtitle || !status) return;

  if (APP.currentScreen === 'auth') {
    subtitle.textContent = 'EuroLeague 2025-26';
    status.innerHTML = '<span class="header-pill">Step 1: Account</span>';
    return;
  }

  if (APP.currentScreen === 'setup') {
    subtitle.textContent = APP.currentUser ? `Welcome, ${APP.currentUser.name}` : 'EuroLeague 2025-26';
    status.innerHTML = '<span class="header-pill">Step 2: Team + Goal</span>';
    return;
  }

  const team = APP.selectedTeam ? displayTeamName(APP.selectedTeam) : 'No team selected';
  const goal = APP.selectedGoal === 'playoffs' ? 'Playoffs' : APP.selectedGoal === 'playin' ? 'Play-In' : 'No goal';
  subtitle.textContent = APP.currentUser ? `${APP.currentUser.name}'s dashboard` : 'EuroLeague 2025-26';
  status.innerHTML = `<span class="header-pill">${team}</span><span class="header-pill muted-pill">${goal}</span>`;
}

function renderAnalysisSummary() {
  const el = document.getElementById('analysisSummary');
  if (!el) return;
  if (!APP.selectedTeam || !APP.selectedGoal) {
    el.innerHTML = '<div class="analysis-chip">Pick a team and goal to start.</div>';
    return;
  }

  const goalText = APP.selectedGoal === 'playoffs' ? 'Top 6 goal' : 'Top 10 goal';
  el.innerHTML = `
    <div class="analysis-chip strong-chip">${displayTeamName(APP.selectedTeam)}</div>
    <div class="analysis-chip">${goalText}</div>
  `;
}

function renderAuthState(message = '') {
  const errorEl = document.getElementById('authError');
  const submitEl = document.getElementById('authSubmitLabel');
  const logoutEl = document.getElementById('logoutBtn');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = message ? 'block' : 'none';
  }
  if (submitEl) {
    submitEl.textContent = APP.authBusy ? 'Please wait...' : 'Continue';
  }
  if (logoutEl) {
    logoutEl.style.display = APP.currentUser ? 'inline-flex' : 'none';
  }
}

function setAuthMode(mode) {
  APP.authMode = mode;
  document.getElementById('loginModeBtn')?.classList.toggle('active', mode === 'login');
  document.getElementById('registerModeBtn')?.classList.toggle('active', mode === 'register');
  const note = document.getElementById('authModeCopy');
  const nameField = document.getElementById('authName');
  if (note) {
    note.textContent = mode === 'login'
      ? 'Welcome back. Log in to keep your saved team context across devices later.'
      : 'Create a simple account flow now. We can wire real authentication later.';
  }
  if (nameField) {
    nameField.parentElement.style.display = mode === 'register' ? 'block' : 'none';
  }
  renderAuthState('');
}

async function apiRequest(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (APP.sessionToken) headers.Authorization = `Bearer ${APP.sessionToken}`;
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }
  return payload;
}

function setSession(token, user) {
  APP.sessionToken = token || '';
  APP.currentUser = user || null;
  if (APP.sessionToken) {
    localStorage.setItem('igtmt-session-token', APP.sessionToken);
  } else {
    localStorage.removeItem('igtmt-session-token');
  }
}

function getSupportedPreferences(user) {
  const preferences = user?.preferences || null;
  const competition = preferences?.competition || 'euroleague';
  if (!preferences) {
    return { preferences: null, supported: false };
  }
  if (competition !== 'euroleague') {
    return { preferences, supported: false };
  }
  return { preferences, supported: true };
}

function applyUserPreferences(user) {
  const { preferences, supported } = getSupportedPreferences(user);
  APP.selectedCompetition = preferences?.competition || 'euroleague';
  APP.selectedTeam = supported ? (normalizeTeamCode(preferences?.team || null) || null) : null;
  APP.selectedGoal = supported ? (preferences?.goal || null) : null;
  renderTeamGrid();
  document.querySelectorAll('.goal-btn').forEach(btn => btn.classList.remove('selected'));
  if (APP.selectedGoal) document.querySelector(`.goal-btn.${APP.selectedGoal}`)?.classList.add('selected');
  renderAnalysisSummary();
  updateHeaderStatus();
  renderScenarios();
  return supported;
}

async function restoreSession() {
  if (!APP.sessionToken) return;
  try {
    const payload = await apiRequest('/api/auth/session', { method: 'GET', headers: {} });
    setSession(APP.sessionToken, payload.user);
    const hasSupportedPreferences = applyUserPreferences(payload.user);
    APP.currentScreen = hasSupportedPreferences ? 'app' : 'setup';
    renderScreen();
    if (payload.user?.preferences?.competition === 'nba') {
      renderAuthState('This mobile app currently restores EuroLeague selections only. Choose a EuroLeague team to continue.');
    }
    if (APP.currentScreen === 'app') {
      renderStandings();
      renderSchedule();
      renderPlayers();
      renderScenarios();
      runAnalysis();
    }
  } catch (_) {
    setSession('', null);
    APP.currentScreen = 'auth';
    renderScreen();
  }
}

async function submitAuth() {
  const nameInput = document.getElementById('authName');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const email = emailInput?.value.trim();
  const password = passwordInput?.value.trim();
  const enteredName = nameInput?.value.trim();

  if (!email || !password) {
    renderAuthState('Enter email and password.');
    return;
  }
  if (APP.authMode === 'register' && !enteredName) {
    renderAuthState('Enter a name to register.');
    return;
  }

  APP.authBusy = true;
  renderAuthState('');
  try {
    const endpoint = APP.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const payload = await apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ name: enteredName, email, password })
    });
    setSession(payload.token, payload.user);
    const hasSupportedPreferences = applyUserPreferences(payload.user);
    APP.currentScreen = hasSupportedPreferences ? 'app' : 'setup';
    renderScreen();
    if (payload.user?.preferences?.competition === 'nba') {
      renderAuthState('This mobile app currently restores EuroLeague selections only. Choose a EuroLeague team to continue.');
    }
    if (APP.currentScreen === 'app') {
      renderStandings();
      renderSchedule();
      renderPlayers();
      renderScenarios();
      runAnalysis();
    }
  } catch (error) {
    renderAuthState(error.message);
  } finally {
    APP.authBusy = false;
    renderAuthState(document.getElementById('authError')?.textContent?.trim() || '');
  }
}

async function completeSetup() {
  if (!APP.selectedTeam) { alert('Select your team!'); return; }
  if (!APP.selectedGoal) { alert('Select your goal!'); return; }
  try {
    const payload = await apiRequest('/api/user/preferences', {
      method: 'PUT',
      body: JSON.stringify({ team: APP.selectedTeam, goal: APP.selectedGoal })
    });
    APP.currentUser = payload.user;
  } catch (error) {
    alert(error.message);
    return;
  }
  APP.currentScreen = 'app';
  renderScreen();
  renderStandings();
  renderSchedule();
  renderPlayers();
  renderScenarios();
  switchTab('analysis');
  runAnalysis();
}

function goToSetup() {
  APP.currentScreen = 'setup';
  renderScreen();
}

async function logout() {
  try {
    if (APP.sessionToken) {
      await apiRequest('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    }
  } catch (_) {}
  setSession('', null);
  APP.selectedTeam = null;
  APP.selectedGoal = null;
  APP.currentScreen = 'auth';
  renderTeamGrid();
  renderScreen();
  setAuthMode('login');
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authName').value = '';
  document.getElementById('analysis-result').innerHTML = '';
  renderStandings();
  renderSchedule();
  renderPlayers();
  renderScenarios();
}

// Helpers
function getTeam(c) {
  const code = normalizeTeamCode(c);
  return APP.standings.find(s => s.code === code);
}
function clubOf(c) {
  const code = normalizeTeamCode(c);
  return APP.clubs?.[code] || {abbr:code, name:code, logo:''};
}
function displayTeamName(c) { return teamLabel(c); }
function getTeamRecordParts(code) {
  const normalizedCode = normalizeTeamCode(code);
  const team = getTeam(normalizedCode) || APP.officialStandingsStats?.find(item => item.code === normalizedCode) || null;
  if (team && Number.isFinite(team.w) && Number.isFinite(team.l)) {
    return { w: team.w, l: team.l };
  }

  const calculated = calcStandings(APP.allGames || [], APP.officialStandingsTable || {}).find(item => item.code === normalizedCode) || null;
  if (calculated && Number.isFinite(calculated.w) && Number.isFinite(calculated.l)) {
    return { w: calculated.w, l: calculated.l };
  }

  return { w: 0, l: 0 };
}
function formatTeamRecord(code) {
  const record = getTeamRecordParts(code);
  return `(${record.w}-${record.l})`;
}
function rankZone(r) { return r<=6 ? 'playoff' : r<=10 ? 'playin' : 'out'; }
function zoneColor(z) { return z==='playoff' ? '#4CAF50' : z==='playin' ? '#2196F3' : '#f44336'; }
function winnerCodeForGame(game) {
  if (!game?.played) return null;
  if (game.home.score === game.away.score) return null;
  return game.home.score > game.away.score ? game.home.code : game.away.code;
}
function renderLogoMarkup(club, size = 'lg') {
  const shellClass = size === 'sm' ? 'logo-shell logo-shell-sm' : 'logo-shell logo-shell-lg';
  return `<span class="${shellClass}"><img class="team-logo" src="${club.logo}" onerror="this.style.opacity='.2'" alt="${club.abbr}"></span>`;
}
function buildSummaryBullet(item, mode, myTeam, goalLabel) {
  if (item.type === 'myteam') {
    return mode === 'good'
      ? `${displayTeamName(myTeam.code)} taking care of their own game flips the pressure back onto everyone chasing the ${goalLabel}.`
      : `${displayTeamName(myTeam.code)} dropping their own game would waste the cleanest chance to move the race.`;
  }

  const preferred = item.preferredWinnerCode ? displayTeamName(item.preferredWinnerCode) : 'the right side';
  const threatened = item.threatenedCode ? displayTeamName(item.threatenedCode) : 'the dangerous team';
  return mode === 'good'
    ? `${preferred} doing the job against ${threatened} would give ${displayTeamName(myTeam.code)} real breathing room around the ${goalLabel}.`
    : `${threatened} winning would tighten the table and leave ${displayTeamName(myTeam.code)} needing extra help later.`;
}
function formatTeamList(codes) {
  const names = [...new Set(codes.filter(Boolean).map(code => displayTeamName(code)))];
  if (!names.length) return 'the teams around them';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
function buildCutoffContext(myTeam, goalRank) {
  const cutoffTeam = APP.standings[goalRank - 1];
  const winsFromCutoff = (cutoffTeam?.w ?? myTeam.w) - myTeam.w;
  const spotsFromCutoff = myTeam.rank <= goalRank ? 0 : myTeam.rank - goalRank;
  return { cutoffTeam, winsFromCutoff, spotsFromCutoff };
}
function getCompetingTeamCodes(myTeam, goalRank) {
  const lowerBound = Math.max(1, goalRank - 3);
  const upperBound = Math.min(APP.standings.length, Math.max(goalRank + 1, myTeam.rank + 1));
  return APP.standings
    .filter(team => team.code !== myTeam.code && team.rank >= lowerBound && team.rank <= upperBound)
    .map(team => team.code);
}
function isCompetingTeam(code, myTeam, goalRank) {
  return getCompetingTeamCodes(myTeam, goalRank).includes(code);
}
function buildStandingsPositionPhrase(myTeam, goalRank) {
  const { winsFromCutoff, spotsFromCutoff } = buildCutoffContext(myTeam, goalRank);
  if (myTeam.rank <= goalRank) {
    if (winsFromCutoff >= 1) return `currently sitting inside the line but with little breathing room`;
    return `currently sitting on the line with almost no margin for error`;
  }
  if (spotsFromCutoff === 1 && winsFromCutoff <= 1) {
    return `just outside the line and within one swing of the cutoff`;
  }
  return `${spotsFromCutoff} place${spotsFromCutoff === 1 ? '' : 's'} outside the line and needing help to climb back`;
}
function buildPlayedResultsPhrase(played) {
  const goodTeams = played.filter(item => item.resultImpact === 'good').map(item => item.threatenedCode).filter(Boolean);
  const badTeams = played.filter(item => item.resultImpact === 'bad').map(item => item.threatenedCode).filter(Boolean);
  if (badTeams.length && !goodTeams.length) {
    return `after wins by rivals such as ${formatTeamList(badTeams)}`;
  }
  if (goodTeams.length && !badTeams.length) {
    return `with rivals such as ${formatTeamList(goodTeams)} already slipping`;
  }
  if (goodTeams.length && badTeams.length) {
    return `after a mixed board that saw help from ${formatTeamList(goodTeams)} but pressure from ${formatTeamList(badTeams)}`;
  }
  return '';
}
function bulletToClause(text) {
  const trimmed = String(text || '').trim().replace(/[.]+$/, '');
  if (!trimmed) return '';
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
function buildSummaryIntro(relevant, played, myTeam, goalLabel, goalRank, goodBullets, badBullets) {
  const teamName = displayTeamName(myTeam.code);
  const positionPhrase = buildStandingsPositionPhrase(myTeam, goalRank);
  const playedPhrase = buildPlayedResultsPhrase(played);
  const goodPath = goodBullets.slice(0, 2).map(bulletToClause).filter(Boolean).join(', and ');
  const badPath = badBullets.slice(0, 2).map(bulletToClause).filter(Boolean).join(', while ');
  const scoreboardClause = playedPhrase ? ` ${playedPhrase}` : '';
  const competitors = formatTeamList(getCompetingTeamCodes(myTeam, goalRank));

  if (!relevant.length) {
    return `${teamName} are ${positionPhrase} in the ${goalLabel} race. The teams directly shaping that fight are ${competitors}, so the consequence is simple: win their own game and keep the door open; lose it, and they hand away control.`;
  }
  return `${teamName} are ${positionPhrase} in the ${goalLabel} race, with ${competitors} forming the key standings cluster${scoreboardClause}. The good path is clear: ${goodPath}. The danger is just as clear: ${badPath}.`;
}
function buildRoundSummary(items, myTeam, goalLabel, goalRank) {
  const relevant = items
    .filter(item => item && (
      item.type === 'myteam' ||
      ((item.type === 'good' || item.type === 'watch') && isCompetingTeam(item.threatenedCode, myTeam, goalRank))
    ))
    .sort((a,b) => (b?.sortScore ?? -999) - (a?.sortScore ?? -999))
    .slice(0, 6);

  const goodBullets = relevant.map(item => buildSummaryBullet(item, 'good', myTeam, goalLabel));
  const badBullets = relevant.map(item => buildSummaryBullet(item, 'bad', myTeam, goalLabel));
  const played = relevant.filter(item => item.resultImpact === 'good' || item.resultImpact === 'bad');

  return {
    intro: buildSummaryIntro(relevant, played, myTeam, goalLabel, goalRank, goodBullets, badBullets),
    goodBullets: goodBullets.length ? goodBullets : [`The cleanest boost is still ${displayTeamName(myTeam.code)} winning their own game and avoiding extra pressure.`],
    badBullets: badBullets.length ? badBullets : [`There is no major external result hurting ${displayTeamName(myTeam.code)} right now, so self-inflicted damage is the main danger.`]
  };
}
function buildResultNotification(items, myTeam, goalLabel) {
  const goalRank = APP.selectedGoal === 'playoffs' ? 6 : 10;
  const resolved = items
    .filter(item => item.type === 'myteam' || isCompetingTeam(item.threatenedCode, myTeam, goalRank))
    .filter(item => item.resultImpact === 'good' || item.resultImpact === 'bad')
    .sort((a,b) => (b?.sortScore ?? -999) - (a?.sortScore ?? -999))
    .slice(0, 4);

  if (!resolved.length) return null;

  const goodCount = resolved.filter(item => item.resultImpact === 'good').length;
  const badCount = resolved.filter(item => item.resultImpact === 'bad').length;
  const title = goodCount >= badCount
    ? `Good news for ${displayTeamName(myTeam.code)}`
    : `${displayTeamName(myTeam.code)} took a hit`;
  const lead = goodCount >= badCount
    ? `The latest finished games helped more than they hurt in the ${goalLabel} race.`
    : `The latest finished games hurt more than they helped in the ${goalLabel} race.`;
  const bullets = resolved.map(item => {
    if (item.type === 'myteam') {
      return item.resultImpact === 'good'
        ? `${displayTeamName(myTeam.code)} handled their own business.`
        : `${displayTeamName(myTeam.code)} missed their own chance to control the night.`;
    }
    const threatened = item.threatenedCode ? displayTeamName(item.threatenedCode) : 'the pressure team';
    return item.resultImpact === 'good'
      ? `${threatened} lost, which helped ${displayTeamName(myTeam.code)} in the standings fight.`
      : `${threatened} won, which hurt ${displayTeamName(myTeam.code)} in the standings fight.`;
  });
  const alertKey = `${myTeam.code}:${APP.selectedGoal}:${resolved.map(item => `${item.gameCode || item.summary}:${item.resultImpact}`).join('|')}`;

  return { title, lead, bullets, alertKey, notificationBody: `${title}. ${bullets[0]}` };
}
function closeResultAlert() {
  const modal = document.getElementById('resultAlertModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}
function maybeSendBrowserNotification(payload) {
  if (!payload || typeof Notification === 'undefined') return;
  const show = () => {
    try {
      new Notification(payload.title, { body: payload.notificationBody });
    } catch (_) {}
  };
  if (Notification.permission === 'granted') {
    show();
    return;
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') show();
    }).catch(() => {});
  }
}
function presentResultAlert(payload) {
  if (!payload) return;
  const storageKey = 'igtmt-last-result-alert';
  if (localStorage.getItem(storageKey) === payload.alertKey) return;

  const modal = document.getElementById('resultAlertModal');
  const titleEl = document.getElementById('resultAlertTitle');
  const bodyEl = document.getElementById('resultAlertBody');
  if (!modal || !titleEl || !bodyEl) return;

  titleEl.textContent = payload.title;
  bodyEl.innerHTML = `<p>${payload.lead}</p><ul class="summary-list">${payload.bullets.map(item => `<li>${item}</li>`).join('')}</ul>`;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  localStorage.setItem(storageKey, payload.alertKey);
  maybeSendBrowserNotification(payload);
}

async function loadLiveData() {
  try {
    const res = await fetch('/api/euroleague/live-data');
    if (!res.ok) return;
    const live = await res.json();
    if (!live || !Array.isArray(live.games)) return;
    APP.allGames = normalizeGames(live.games);
    const liveStandingsTable = live.teamStandingsTable && typeof live.teamStandingsTable === 'object'
      ? live.teamStandingsTable
      : {};
    APP.officialStandingsTable = {...SNAPSHOT_STANDINGS_OVERRIDES, ...liveStandingsTable};
    APP.officialStandingsStats = normalizeOfficialStandings(live.standingsStats, APP.officialStandingsTable);
    APP.liveMeta = {
      buildId: live.buildId || null,
      currentRound: live.currentRound || null,
      maxRound: live.maxRound || null,
      allAvailableRounds: Array.isArray(live.allAvailableRounds) ? live.allAvailableRounds : [],
      currentSeasonCode: live.currentSeasonCode || null,
      source: live.source || 'live',
      fetchedAt: live.fetchedAt || null,
      anyLive: Boolean(live.anyLive ?? live.games.some(game => game.live)),
      cacheTtlMs: Number(live.cacheTtlMs) || LIVE_POLL_INTERVAL_MS
    };
  } catch (_) {
    APP.officialStandingsStats = null;
    APP.liveMeta = { source: 'snapshot' };
  }
}

function mergeStandings(calculatedStandings, officialStandingsStats) {
  if (!officialStandingsStats?.length) return calculatedStandings;
  const calculatedByCode = Object.fromEntries(calculatedStandings.map(team => [team.code, team]));
  return officialStandingsStats.map(team => ({
    ...(calculatedByCode[team.code] || {}),
    ...team,
    h2h: calculatedByCode[team.code]?.h2h || {},
    code: team.code
  }));
}

function normalizeOfficialStandings(rows, standingsTable) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const normalized = rows
    .map(row => normalizeOfficialStandingRow(row, standingsTable))
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
  return normalized.length ? normalized : null;
}

function normalizeOfficialStandingRow(row, standingsTable) {
  const teamInfo = row?.Club ?? row?.club ?? row?.team ?? row?.Team ?? row?.clubInfo ?? {};
  const code = String(
    teamInfo?.TLA ??
    teamInfo?.tla ??
    teamInfo?.Code ??
    teamInfo?.code ??
    row?.TLA ??
    row?.tla ??
    row?.Code ??
    row?.code ??
    ''
  ).toUpperCase();
  if (!code) return null;

  const rank = toNumber(
    row?.Position ??
    row?.position ??
    row?.Rank ??
    row?.rank ??
    standingsTable?.[code]
  );
  const wins = toNumber(row?.W ?? row?.w ?? row?.wins ?? row?.Wins);
  const losses = toNumber(row?.L ?? row?.l ?? row?.losses ?? row?.Losses);
  const ptsFor = toNumber(row?.['Pts+'] ?? row?.pts ?? row?.PtsPlus ?? row?.ptsFor ?? row?.pointsFor);
  const ptsAgainst = toNumber(row?.['Pts-'] ?? row?.ptsA ?? row?.PtsMinus ?? row?.ptsAgainst ?? row?.pointsAgainst);
  const home = splitRecord(row?.H ?? row?.home ?? row?.Home);
  const away = splitRecord(row?.A ?? row?.away ?? row?.Away);
  const last10 = splitLast10(row?.L10 ?? row?.last10 ?? row?.Last10);

  return {
    code,
    rank: Number.isFinite(rank) ? rank : standingsTable?.[code] || 99,
    ...(Number.isFinite(wins) ? { w: wins } : {}),
    ...(Number.isFinite(losses) ? { l: losses } : {}),
    ...(Number.isFinite(ptsFor) ? { pts: ptsFor } : {}),
    ...(Number.isFinite(ptsAgainst) ? { ptsA: ptsAgainst } : {}),
    ...(home.w || home.l ? { homeW: home.w, homeL: home.l } : {}),
    ...(away.w || away.l ? { awayW: away.w, awayL: away.l } : {}),
    ...(last10.length ? { last10 } : {})
  };
}

function splitRecord(value) {
  const match = String(value ?? '').match(/(\d+)\s*-\s*(\d+)/);
  return match ? { w: Number(match[1]), l: Number(match[2]) } : { w: 0, l: 0 };
}

function splitLast10(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  if (/^[WL,\s-]+$/i.test(raw)) {
    return raw
      .split(/[\s,-]+/)
      .filter(Boolean)
      .map(item => item.toUpperCase().startsWith('W') ? 'W' : 'L')
      .slice(-10);
  }
  const match = raw.match(/(\d+)\s*-\s*(\d+)/);
  if (match) {
    return [
      ...Array.from({length: Number(match[1])}, () => 'W'),
      ...Array.from({length: Number(match[2])}, () => 'L')
    ].slice(-10);
  }
  return [];
}

function toNumber(value) {
  const normalized = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeGames(games) {
  return games.map(g => ({
    gameCode: g.gameCode ?? g.id ?? g.code ?? null,
    round: Number(g.round ?? g.roundNumber ?? 0),
    date: g.date ?? g.startDate ?? g.datetime ?? null,
    played: isPlayedGame(g),
    live: isLiveGame(g),
    status: g.status ?? null,
    minute: g.minute ?? null,
    quarter: g.quarter ?? null,
    quarterMinute: g.quarterMinute ?? g.remainingTime ?? null,
    remainingTime: g.remainingTime ?? null,
    home: {
      code: normalizeTeamCode(g.home?.code ?? g.home?.clubCode ?? g.home?.tlaCode ?? g.homeTeam?.code ?? g.homeTeam?.tla ?? ''),
      score: Number(g.home?.score ?? g.homeScore ?? g.homePoints ?? 0)
    },
    away: {
      code: normalizeTeamCode(g.away?.code ?? g.away?.clubCode ?? g.away?.tlaCode ?? g.awayTeam?.code ?? g.awayTeam?.tla ?? ''),
      score: Number(g.away?.score ?? g.awayScore ?? g.awayPoints ?? 0)
    }
  }));
}

function isPlayedGame(game) {
  if (typeof game.played === 'boolean') return game.played;
  const status = String(game.status || '').toLowerCase();
  return ['result', 'final', 'finished', 'played'].includes(status);
}

function isLiveGame(game) {
  if (typeof game.live === 'boolean') return game.live;
  const status = String(game.status || '').toLowerCase();
  return ['live', 'playing', 'in_progress', 'in progress'].includes(status);
}

// Standings calculation
function calcStandings(games, standingsOverride) {
  const teams = {};
  const completedGames = games
    .filter(g => g.played)
    .slice()
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  function ensure(code) {
    if (!teams[code]) teams[code] = {code,w:0,l:0,pts:0,ptsA:0,homeW:0,homeL:0,awayW:0,awayL:0,last10:[],h2h:{}};
  }
  for (const g of completedGames) {
    const hc = g.home.code, ac = g.away.code;
    if (!hc || !ac) continue;
    const hp = g.home.score, ap = g.away.score;
    ensure(hc); ensure(ac);
    teams[hc].pts += hp; teams[hc].ptsA += ap;
    teams[ac].pts += ap; teams[ac].ptsA += hp;
    if (!teams[hc].h2h[ac]) teams[hc].h2h[ac] = {w:0,l:0,pf:0,pa:0};
    if (!teams[ac].h2h[hc]) teams[ac].h2h[hc] = {w:0,l:0,pf:0,pa:0};
    if (hp > ap) {
      teams[hc].w++; teams[hc].homeW++; teams[hc].last10.push('W');
      teams[ac].l++; teams[ac].awayL++; teams[ac].last10.push('L');
      teams[hc].h2h[ac].w++; teams[hc].h2h[ac].pf+=hp; teams[hc].h2h[ac].pa+=ap;
      teams[ac].h2h[hc].l++; teams[ac].h2h[hc].pf+=ap; teams[ac].h2h[hc].pa+=hp;
    } else {
      teams[ac].w++; teams[ac].awayW++; teams[ac].last10.push('W');
      teams[hc].l++; teams[hc].homeL++; teams[hc].last10.push('L');
      teams[ac].h2h[hc].w++; teams[ac].h2h[hc].pf+=ap; teams[ac].h2h[hc].pa+=hp;
      teams[hc].h2h[ac].l++; teams[hc].h2h[ac].pf+=hp; teams[hc].h2h[ac].pa+=ap;
    }
  }
  for (const t of Object.values(teams)) t.last10 = t.last10.slice(-10);
  const arr = Object.values(teams);
  const fallbackSort = (a,b) => {
    if (b.w !== a.w) return b.w - a.w;
    const ah = a.h2h[b.code]||{w:0,l:0,pf:0,pa:0}, bh = b.h2h[a.code]||{w:0,l:0,pf:0,pa:0};
    if (ah.w !== bh.w) return ah.w > bh.w ? -1 : 1;
    const ad = ah.pf-ah.pa, bd = bh.pf-bh.pa;
    if (ad !== bd) return ad > bd ? -1 : 1;
    return (b.pts-b.ptsA) - (a.pts-a.ptsA);
  };
  arr.sort((a,b) => {
    const officialA = standingsOverride?.[a.code];
    const officialB = standingsOverride?.[b.code];
    const officialCount = Object.values(standingsOverride || {}).filter(Number.isInteger).length;
    const useOfficialTable = officialCount >= Math.max(10, Math.floor(arr.length * 0.75));
    if (useOfficialTable && Number.isInteger(officialA) && Number.isInteger(officialB) && officialA !== officialB) {
      return officialA - officialB;
    }
    return fallbackSort(a, b);
  });
  const officialCount = Object.values(standingsOverride || {}).filter(Number.isInteger).length;
  const useOfficialTable = officialCount >= Math.max(10, Math.floor(arr.length * 0.75));
  return arr.map((t,i) => ({
    ...t,
    rank: useOfficialTable && Number.isInteger(standingsOverride?.[t.code]) ? standingsOverride[t.code] : i + 1
  }));
}

// Team grid
function renderTeamGrid() {
  document.getElementById('teamGrid').innerHTML = APP.standings.map(t => {
    const c = clubOf(t.code);
    const sel = APP.selectedTeam === t.code ? ' selected' : '';
    const record = getTeamRecordParts(t.code);
    return `<div class="team-card${sel}" onclick="selectTeam('${t.code}',event)">
      ${renderLogoMarkup(c)}
      <div class="team-name">${teamLabel(t.code)}</div>
      <div class="team-record">${record.w}-${record.l}</div>
    </div>`;
  }).join('');
}

function selectTeam(code, e) {
  APP.selectedTeam = normalizeTeamCode(code);
  document.querySelectorAll('.team-card').forEach(c => c.classList.remove('selected'));
  if (e && e.currentTarget) e.currentTarget.classList.add('selected');
  updateHeaderStatus();
  renderAnalysisSummary();
  renderScenarios();
}

function selectGoal(g) {
  APP.selectedGoal = g;
  document.querySelectorAll('.goal-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector('.goal-btn.'+g).classList.add('selected');
  updateHeaderStatus();
  renderAnalysisSummary();
}

// Analysis
function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toTimestamp(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function getRoundContext() {
  const now = Date.now();
  const LIVE_ROUND_WINDOW_MS = 12 * 60 * 60 * 1000;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const rounds = [...new Set(APP.allGames.map(g => g.round).filter(Number.isFinite))].sort((a,b)=>a-b);
  const roundStats = rounds.map(round => {
    const games = APP.allGames.filter(g => g.round === round);
    const played = games.filter(g => g.played);
    const unplayed = games.filter(g => !g.played);
    const unplayedTips = unplayed
      .map(g => toTimestamp(g.date))
      .filter(Number.isFinite)
      .sort((a,b)=>a-b);
    const nextTip = unplayedTips[0] ?? null;
    const hasLiveOrTodayTip = unplayedTips.some(ts => (
      ts >= now - LIVE_ROUND_WINDOW_MS && ts <= now
    ) || new Date(ts).setHours(0, 0, 0, 0) === todayStart);
    return { round, games, playedCount: played.length, unplayedCount: unplayed.length, nextTip, hasLiveOrTodayTip };
  });
  const latestStartedRound = roundStats
    .filter(r => r.playedCount > 0)
    .map(r => r.round)
    .sort((a,b)=>b-a)[0] ?? null;
  const mainlineRounds = latestStartedRound === null
    ? roundStats
    : roundStats.filter(r => r.round >= latestStartedRound);

  const activeRound = mainlineRounds
    .filter(r => r.unplayedCount > 0 && r.hasLiveOrTodayTip)
    .sort((a,b) => a.round - b.round || (a.nextTip ?? Number.MAX_SAFE_INTEGER) - (b.nextTip ?? Number.MAX_SAFE_INTEGER))[0];
  if (activeRound) {
    const nextRound = roundStats.find(r => r.round > activeRound.round && r.unplayedCount > 0)?.round ?? null;
    return { currentRound: activeRound.round, focusRound: activeRound.round, nextRound, roundState: 'current', rounds };
  }

  const upcomingRound = latestStartedRound === null
    ? roundStats.find(r => r.unplayedCount > 0) ?? null
    : roundStats.find(r => r.round > latestStartedRound && r.unplayedCount > 0) ?? null;
  if (upcomingRound) {
    const nextRound = roundStats.find(r => r.round > upcomingRound.round && r.unplayedCount > 0)?.round ?? null;
    return { currentRound: upcomingRound.round, focusRound: upcomingRound.round, nextRound, roundState: 'next', rounds };
  }

  const fallbackRound = rounds[rounds.length - 1] || null;
  return { currentRound: fallbackRound, focusRound: fallbackRound, nextRound: null, roundState: 'current', rounds };
}

function getThreatScore(team, myTeam, goalRank, cutoffWins) {
  if (!team || !myTeam) return -999;
  if (team.code === myTeam.code) return 999;
  const winsAhead = team.w - myTeam.w;
  const winsFromCutoff = team.w - cutoffWins;
  let score = 0;

  if (team.rank <= goalRank) score += 12;
  if (team.rank < myTeam.rank) score += 8;
  if (winsAhead >= 0) score += Math.max(0, 5 - winsAhead);
  if (team.rank > myTeam.rank) score += Math.max(0, 4 - (myTeam.w - team.w));
  if (Math.abs(winsFromCutoff) <= 1) score += 5;
  if (Math.abs(team.rank - goalRank) <= 1) score += 4;
  if (Math.abs(team.rank - myTeam.rank) <= 2) score += 3;
  if (team.rank > goalRank && myTeam.w - team.w >= 3) score -= 6;

  return score;
}

function buildPressureReason(team, myTeam, goalRank) {
  const club = displayTeamName(team.code);
  const parts = [];
  const winGap = team.w - myTeam.w;

  parts.push(`${club} are #${team.rank}`);
  if (team.rank <= goalRank && team.rank < myTeam.rank) {
    parts.push(`they currently occupy a Top ${goalRank} spot`);
  }
  if (winGap > 0) {
    parts.push(`${pluralize(winGap, 'win')} ahead of ${displayTeamName(myTeam.code)}`);
  } else if (winGap === 0) {
    parts.push(`level on wins with ${displayTeamName(myTeam.code)}`);
  } else if (team.rank > myTeam.rank && Math.abs(winGap) <= 2) {
    parts.push(`only ${pluralize(Math.abs(winGap), 'win')} behind ${displayTeamName(myTeam.code)}`);
  }

  return parts.join(', ');
}

function buildLowImpactReason(homeTeam, awayTeam, myTeam, goalRank) {
  const homeGap = myTeam.w - homeTeam.w;
  const awayGap = myTeam.w - awayTeam.w;
  if (homeTeam.rank > goalRank && awayTeam.rank > goalRank && homeGap >= 3 && awayGap >= 3) {
    return `${displayTeamName(homeTeam.code)} are ${pluralize(homeGap, 'win')} behind ${displayTeamName(myTeam.code)} and ${displayTeamName(awayTeam.code)} are ${pluralize(awayGap, 'win')} behind, so this game does not shift the race much right now.`;
  }
  return `Neither side is a direct blocker for ${displayTeamName(myTeam.code)} right now, so this result matters less than the games around the cutoff.`;
}

function analyzeGameForTeam(game, myTeam, goalRank, goalLabel) {
  const tc = myTeam.code;
  const myClub = clubOf(tc);
  const hc = game.home.code, ac = game.away.code;
  const homeTeam = getTeam(hc), awayTeam = getTeam(ac);
  const isMyGame = hc === tc || ac === tc;
  const cutoffTeam = APP.standings[goalRank - 1];
  const cutoffWins = cutoffTeam ? cutoffTeam.w : myTeam.w;

  if (isMyGame) {
    const opp = hc === tc ? awayTeam : homeTeam;
    const oppClub = displayTeamName(opp?.code || (hc === tc ? ac : hc));
    const summary = `${displayTeamName(tc)} must beat ${oppClub}.`;
    const details = `A win is the most direct way to close the gap to ${goalLabel} and prevents dropping further behind in the standings race.`;
    const mv = myTeam.h2h[opp?.code] || {w:0,l:0,pf:0,pa:0};
    const d = mv.pf - mv.pa;
    const h2hNote = mv.w + mv.l > 0
      ? `H2H vs ${oppClub}: ${mv.w}-${mv.l}${mv.w + mv.l > 1 ? `, ${d >= 0 ? '+' : ''}${d} points` : ''}.`
      : '';
    return {
      sortScore: 999,
      type: 'myteam',
      badge: 'YOUR GAME',
      summary,
      details,
      h2hNote,
      effectIfGood: `${displayTeamName(tc)} would improve their position by taking care of their own game.`,
      effectIfBad: `${displayTeamName(tc)} would miss a direct chance to gain ground in the standings.`
    };
  }

  if (!homeTeam || !awayTeam) {
    return {
      sortScore: -999,
      type: 'neutral',
      badge: 'LOW IMPACT',
      summary: `No strong result preference.`,
      details: `This matchup does not directly affect ${displayTeamName(tc)} with the current data.`
    };
  }

  const homeThreat = getThreatScore(homeTeam, myTeam, goalRank, cutoffWins);
  const awayThreat = getThreatScore(awayTeam, myTeam, goalRank, cutoffWins);
  let preferredWinner = homeThreat > awayThreat ? ac : hc;
  if (homeThreat === awayThreat) {
    preferredWinner = preferredWinnerForStandings(homeTeam, awayTeam, myTeam) || preferredWinner;
  }

  const threatenedTeam = preferredWinner === hc ? awayTeam : homeTeam;
  const saferTeam = preferredWinner === hc ? homeTeam : awayTeam;
  const topThreat = Math.max(homeThreat, awayThreat);
  const threatGap = Math.abs(homeThreat - awayThreat);
  const lowImpact = topThreat < 8 || (topThreat < 12 && threatGap <= 1);

  if (lowImpact) {
    return {
      sortScore: topThreat,
      type: 'neutral',
      badge: 'LOW IMPACT',
      summary: `${displayTeamName(preferredWinner)} winning is slightly better, but this is not a key swing game.`,
      details: buildLowImpactReason(homeTeam, awayTeam, myTeam, goalRank),
      effectIfGood: '',
      effectIfBad: ''
    };
  }

  const summary = `${displayTeamName(preferredWinner)} win is good for ${displayTeamName(tc)}.`;
  const details = `${buildPressureReason(threatenedTeam, myTeam, goalRank)}, so ${displayTeamName(threatenedTeam.code)} losing helps ${displayTeamName(tc)}'s path to ${goalLabel}.`;
  const mv = myTeam.h2h[threatenedTeam.code] || {w:0,l:0,pf:0,pa:0};
  const d = mv.pf - mv.pa;
  const h2hNote = mv.w + mv.l > 0
    ? `H2H vs ${displayTeamName(threatenedTeam.code)}: ${mv.w}-${mv.l}, ${d >= 0 ? '+' : ''}${d} points.`
    : '';

  return {
    sortScore: topThreat + threatGap,
    type: topThreat >= 18 ? 'good' : 'watch',
    badge: topThreat >= 18 ? 'IMPORTANT' : 'WATCH',
    summary,
    details,
    h2hNote,
    threatenedCode: threatenedTeam.code,
    preferredWinnerCode: preferredWinner,
    effectIfGood: `If ${displayTeamName(threatenedTeam.code)} lose, ${displayTeamName(tc)} get a cleaner path toward ${goalLabel} because one of the teams ahead or around the cutoff drops a game.`,
    effectIfBad: `If ${displayTeamName(threatenedTeam.code)} win, they stay stronger in the race and ${displayTeamName(tc)} will likely need extra wins later to pass them.`
  };
}

function preferredWinnerForStandings(homeTeam, awayTeam, myTeam) {
  const homeAbove = homeTeam.rank < myTeam.rank;
  const awayAbove = awayTeam.rank < myTeam.rank;
  const homeBelow = homeTeam.rank > myTeam.rank;
  const awayBelow = awayTeam.rank > myTeam.rank;

  if (homeAbove && !awayAbove) return awayTeam.code;
  if (awayAbove && !homeAbove) return homeTeam.code;
  if (homeBelow && !awayBelow) return awayTeam.code;
  if (awayBelow && !homeBelow) return homeTeam.code;

  if (homeAbove && awayAbove) {
    return homeTeam.rank < awayTeam.rank ? awayTeam.code : homeTeam.code;
  }
  if (homeBelow && awayBelow) {
    return homeTeam.rank > awayTeam.rank ? homeTeam.code : awayTeam.code;
  }
  return null;
}

function buildSeasonVerdict(myTeam, goalRank, gamesLeft) {
  const cutoffTeam = APP.standings[goalRank - 1];
  const cutoffWins = cutoffTeam ? cutoffTeam.w : myTeam.w;
  const winsBehind = Math.max(0, cutoffWins - myTeam.w);
  const spotsBehind = Math.max(0, myTeam.rank - goalRank);

  if (spotsBehind === 0) {
    return {
      title: 'Inside the Line',
      icon: '✅',
      summary: `${displayTeamName(myTeam.code)} are currently in position for the cutoff at #${myTeam.rank}. With ${gamesLeft} ${gamesLeft === 1 ? 'game' : 'games'} left, the priority is holding the spot.`
    };
  }

  if (winsBehind > gamesLeft) {
    return {
      title: 'Almost Out',
      icon: '⚠️',
      summary: `${displayTeamName(myTeam.code)} are at position ${myTeam.rank}, ${spotsBehind} spot(s) behind the cutoff. With ${gamesLeft} ${gamesLeft === 1 ? 'game' : 'games'} left, they need outside help and a near-perfect finish.`
    };
  }

  return {
    title: 'Still Alive!',
    icon: '⚡',
    summary: `${displayTeamName(myTeam.code)} is at position ${myTeam.rank}, ${spotsBehind} spot(s) behind the cutoff. With ${gamesLeft} ${gamesLeft === 1 ? 'game' : 'games'} left, it's mathematically possible but needs help.`
  };
}

function runAnalysis() {
  if (!APP.selectedTeam) { alert('Select your team!'); return; }
  if (!APP.selectedGoal) { alert('Select your goal!'); return; }
  const tc = APP.selectedTeam, goal = APP.selectedGoal;
  const goalRank = goal === 'playoffs' ? 6 : 10;
  const goalLabel = goal === 'playoffs' ? 'Playoffs (Top 6)' : 'Play-In (Top 10)';
  const myTeam = getTeam(tc); if (!myTeam) return;
  const myClub = clubOf(tc);
  const myGames = APP.allGames.filter(g => g.home.code===tc || g.away.code===tc);
  const { focusRound, roundState } = getRoundContext();
  const result = document.getElementById('analysis-result');
  if (!myGames.find(g => !g.played)) {
    const msg = myTeam.rank<=6 ? 'Made Playoffs!' : myTeam.rank<=10 ? 'Made Play-In!' : 'Did not qualify';
    result.innerHTML = `<div class="no-selection">Season complete! Final rank: <strong style="color:#f7b731">#${myTeam.rank}</strong><br>${msg}</div>`;
    return;
  }
  const rank = myTeam.rank, zone = rankZone(rank), gamesLeft = myGames.filter(g=>!g.played).length;
  const atCutoff = APP.standings[goalRank-1];
  const wDiff = myTeam.w - (atCutoff ? atCutoff.w : 0);
  const diffLabel = wDiff>0 ? `<span style="color:#4CAF50">+${wDiff} ahead</span>` :
                   wDiff<0 ? `<span style="color:#f44336">${wDiff} behind</span>` :
                   `<span style="color:#f7b731">tied</span>`;
  let barHtml = '';
  for (let i=1; i<=20; i++) {
    const z = i<=6 ? 'zone-playoff' : i<=10 ? 'zone-playin' : 'zone-out';
    barHtml += `<div class="pos-zone ${z}${i===rank?' zone-current':''}" title="#${i}">${i}</div>`;
  }
  const roundGames = APP.allGames
    .filter(g => g.round === focusRound)
    .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  const analyzedGames = roundGames
    .map(g => {
      const analysis = analyzeGameForTeam(g, myTeam, goalRank, goalLabel);
      const winner = winnerCodeForGame(g);
      const preferredWinnerCode = analysis.preferredWinnerCode || (analysis.type === 'myteam' ? tc : null);
      const resultImpact = !g.played || !winner || !preferredWinnerCode
        ? null
        : winner === preferredWinnerCode ? 'good' : 'bad';
      const homeClub = clubOf(g.home.code);
      const awayClub = clubOf(g.away.code);
      const ds = g.date ? new Date(g.date).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : '';
      const ts = g.date ? new Date(g.date).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
      return {
        gameCode: g.gameCode || `${g.home.code}-${g.away.code}-${g.round}`,
        type: analysis.type,
        summary: analysis.summary,
        sortScore: analysis.sortScore,
        preferredWinnerCode,
        threatenedCode: analysis.threatenedCode || null,
        resultImpact,
        html: `<div class="game-card ${analysis.type}">
          <div class="game-card-head">
            <span class="game-date">${ds}${ts ? ` ${ts}` : ''}</span>
          </div>
          <div class="game-teams">
            <div class="matchup-team">
              ${renderLogoMarkup(homeClub, 'sm')}
              <div class="matchup-team-copy">
                <span class="matchup-team-name">${homeClub.abbr}</span>
                <span class="matchup-team-record">${formatTeamRecord(g.home.code)}</span>
              </div>
            </div>
            <span class="vs-label">vs</span>
            <div class="matchup-team matchup-team-away">
              ${renderLogoMarkup(awayClub, 'sm')}
              <div class="matchup-team-copy">
                <span class="matchup-team-name">${awayClub.abbr}</span>
                <span class="matchup-team-record">${formatTeamRecord(g.away.code)}</span>
              </div>
            </div>
          </div>
          <div class="game-verdict"><span class="verdict-badge badge-${analysis.type}">${analysis.badge}</span> ${analysis.summary}</div>
          <div class="h2h-note">${analysis.details}</div>
          ${analysis.h2hNote?'<div class="h2h-note">'+analysis.h2hNote+'</div>':''}
        </div>`
      };
    });
  const sortedGames = analyzedGames.sort((a,b)=>b.sortScore-a.sortScore);
  const cards = sortedGames.map(card => card.html).join('');
  const roundSummary = buildRoundSummary(sortedGames, myTeam, goalLabel, goalRank);
  const resultAlert = buildResultNotification(sortedGames, myTeam, goalLabel);
  const seasonVerdict = buildSeasonVerdict(myTeam, goalRank, gamesLeft);
  const verdictSection = `<div class="verdict-card"><div class="verdict-label">📋 VERDICT</div><div class="verdict-headline">${seasonVerdict.icon} ${seasonVerdict.title}</div><div class="verdict-copy">${seasonVerdict.summary}</div></div>`;
  const roundHeading = `${roundState === 'next' ? 'Next' : 'Current'} Round ${focusRound}`;
  const roundSection = `<div class="section-title" style="margin-top:16px">${roundHeading}</div><div class="games-list">${cards}</div><div class="position-card summary-card" style="margin-top:12px"><div class="section-title" style="margin:0 0 8px 0">Short Summary</div><div class="summary-lede">${roundSummary.intro}</div><div class="summary-grid"><div class="summary-column good-summary"><div class="summary-heading">If the important teams lose</div><ul class="summary-list">${roundSummary.goodBullets.map(item => `<li>${item}</li>`).join('')}</ul></div><div class="summary-column bad-summary"><div class="summary-heading">If the important teams win</div><ul class="summary-list">${roundSummary.badBullets.map(item => `<li>${item}</li>`).join('')}</ul></div></div></div>`;
  result.innerHTML = `
    <div class="position-card">
      <div class="pos-row">
        <div class="pos-bubble" style="background:${zoneColor(zone)}22;border:2px solid ${zoneColor(zone)};color:${zoneColor(zone)}">#${rank}</div>
        <div class="pos-info">
          <h3>${myClub.name}</h3>
          <p>${myTeam.w}W - ${myTeam.l}L | ${gamesLeft} games left</p>
          <p style="margin-top:3px">Goal: ${goalLabel} | ${diffLabel}</p>
        </div>
      </div>
      <div class="pos-bar">${barHtml}</div>
      <div class="pos-legend">
        <span class="pos-legend-item pos-legend-playoff">🥇 Top 6 = Playoffs</span>
        <span class="pos-legend-item pos-legend-playin">🥈 7-10 = Play-In</span>
        <span class="pos-legend-item pos-legend-out">❌ 11-20 = Out</span>
      </div>
    </div>
    ${verdictSection}
    ${roundSection}`;
  presentResultAlert(resultAlert);
}

// Standings tab
function renderStandings() {
  const rows = APP.standings.map(t => {
    const c=clubOf(t.code), z=rankZone(t.rank), zc=zoneColor(z);
    const cls=t.code===APP.selectedTeam?' my-team':'';
    const bCls=t.rank===6?' zone-border-playoff':t.rank===10?' zone-border-playin':'';
    const diff=t.pts-t.ptsA;
    const dH=diff>0?`<span class="diff-pos">+${diff}</span>`:diff<0?`<span class="diff-neg">${diff}</span>`:'0';
    const dots=t.last10.map(r=>`<div class="dot dot-${r==='W'?'w':'l'}" title="${r==='W'?'Win':'Loss'}"></div>`).join('');
    return `<tr class="${cls}${bCls}">
      <td><span class="pos-num ${z}" style="color:${zc}">${t.rank}</span></td>
      <td><div class="team-cell">${renderLogoMarkup(c, 'sm')}<span>${c.abbr}</span></div></td>
      <td style="font-weight:700">${t.w}</td><td>${t.l}</td>
      <td>${t.homeW}-${t.homeL}</td><td>${t.awayW}-${t.awayL}</td>
      <td>${dH}</td><td><div class="l10-dots">${dots}</div></td>
    </tr>`;
  }).join('');
  document.getElementById('standings-content').innerHTML=`
    <div style="font-size:.6rem;color:#8892b0;margin-bottom:8px;display:flex;gap:12px;flex-wrap:wrap">
      <span><span style="color:#4CAF50">■</span> Playoffs (1-6)</span>
      <span><span style="color:#2196F3">■</span> Play-In (7-10)</span>
      <span><span style="color:#f44336">■</span> Eliminated (11+)</span>
      <span><span style="color:#51c878">●</span> L10 Wins</span>
      <span><span style="color:#d36b79">●</span> L10 Losses</span>
    </div>
    <div class="standings-wrap"><table class="standings-table">
      <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>Home</th><th>Away</th><th>+/-</th><th>L10</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Schedule tab
function renderSchedule() {
  const { focusRound, roundState } = getRoundContext();
  const allRounds = [...new Set(APP.allGames.map(g => g.round).filter(Boolean))].sort((a,b)=>a-b);
  const feedRounds = (APP.liveMeta?.allAvailableRounds || [])
    .map(r => Number(r?.round ?? r))
    .filter(Number.isFinite)
    .sort((a,b) => a-b);
  const rounds = feedRounds.length ? [...new Set(feedRounds)] : allRounds;
  const showRounds = rounds.filter(r => r >= focusRound - 3 && r <= focusRound + 3);
  const myCode=APP.selectedTeam;
  let html='';
  for (const round of showRounds) {
    const games=APP.allGames
      .filter(g => g.round === round)
      .sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
    const isFocusRound = round===focusRound;
    const roundSuffix = !isFocusRound ? '' : roundState === 'next' ? ' - NEXT' : ' - CURRENT';
    html+=`<div class="round-group"><div class="round-label${isFocusRound?' next-round':''}">${isFocusRound?'> ':''}Round ${round}${roundSuffix}</div>`;
    for (const g of games) {
      const hc=g.home.code, ac=g.away.code;
      const hCl=clubOf(hc), aCl=clubOf(ac);
      const isMyGame=hc===myCode||ac===myCode;
      const hp=g.home.score, ap=g.away.score;
      const hWon=g.played&&hp>ap, aWon=g.played&&ap>hp;
      const ts=g.date?new Date(g.date).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}):'';
      const ds=g.date?new Date(g.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
      html+=`<div class="game-row${isMyGame?' my-game':''}">
        <div class="gr-teams">
          <div class="gr-team${hWon?' winner':''}">${renderLogoMarkup(hCl, 'sm')}${hCl.abbr}</div>
          <div class="gr-team${aWon?' winner':''}">${renderLogoMarkup(aCl, 'sm')}${aCl.abbr}</div>
        </div>
        ${g.played?`<div class="gr-scores"><div class="gr-score${hWon?' winner':''}">${hp}</div><div class="gr-score${aWon?' winner':''}">${ap}</div></div>`:''}
        <div class="gr-time">${g.played?'FINAL':ts||ds}</div>
      </div>`;
    }
    html+='</div>';
  }
  document.getElementById('schedule-content').innerHTML=html;
}

// Players tab
function renderPlayers() {
  const el=document.getElementById('players-content');
  const myCode=APP.selectedTeam;
  let rosterHtml='';
  if (myCode) {
    const myPlayers=Object.entries(APP.seasonStats)
      .filter(([code])=>APP.playerMeta[code]&&APP.playerMeta[code].team===myCode)
      .sort(([,a],[,b])=>(b.gp?b.pts/b.gp:0)-(a.gp?a.pts/a.gp:0));
    if (!myPlayers.length) {
      rosterHtml=`<div class="error-msg">No player data for ${clubOf(myCode).name}</div>`;
    } else {
      const cards=myPlayers.slice(0,15).map(([code,s])=>{
        const gp=s.gp||1, m=APP.playerMeta[code]||{};
        const ppg=(s.pts/gp).toFixed(1),rpg=(s.reb/gp).toFixed(1),apg=(s.ast/gp).toFixed(1),bpg=(s.blk/gp).toFixed(1);
        return `<div class="player-card">
          <img class="player-img" src="${m.photo||''}" onerror="this.src=''" alt="${m.name||code}">
          <div class="player-info">
            <div class="player-name">${m.name||code}</div>
            <div class="player-pos">${m.pos||''} - ${gp} GP</div>
            <div class="player-stats">
              <div class="pstat"><span class="pstat-val">${ppg}</span><span class="pstat-lbl">PTS</span></div>
              <div class="pstat"><span class="pstat-val">${rpg}</span><span class="pstat-lbl">REB</span></div>
              <div class="pstat"><span class="pstat-val">${apg}</span><span class="pstat-lbl">AST</span></div>
              <div class="pstat"><span class="pstat-val">${bpg}</span><span class="pstat-lbl">BLK</span></div>
            </div>
          </div>
        </div>`;
      }).join('');
      rosterHtml=`<div class="section-title">${clubOf(myCode).name} - 2025-26</div><div class="player-list">${cards}</div>`;
    }
  } else {
    rosterHtml='<div class="no-selection">Select a team in the Analysis tab to see their roster</div>';
  }
  const cats=[{key:'pts',label:'Points'},{key:'reb',label:'Rebounds'},{key:'ast',label:'Assists'},{key:'blk',label:'Blocks'},{key:'stl',label:'Steals'},{key:'pir',label:'PIR'}];
  let leadersHtml='<div class="section-title" style="margin-top:8px">EuroLeague Leaders 2025-26</div><div class="leaders-grid">';
  for (const cat of cats) {
    const sorted=Object.entries(APP.seasonStats)
      .filter(([,s])=>s.gp>=15)
      .map(([code,s])=>({code,avg:s[cat.key]/s.gp}))
      .sort((a,b)=>b.avg-a.avg).slice(0,5);
    const rows=sorted.map(({code,avg},i)=>{
      const m=APP.playerMeta[code]||{};
      const parts=(m.name||code).split(' ');
      const sn=parts.length>1?parts[0][0]+'. '+parts.slice(1).join(' '):(m.name||code);
      return `<div class="leader-row">
        <div class="leader-medal">${MEDALS[i]}</div>
        <img class="leader-img" src="${m.photo||''}" onerror="this.src=''" alt="${sn}">
        <div class="leader-info"><div class="leader-name">${sn}</div><div class="leader-team">${clubOf(m.team||'').abbr}</div></div>
        <div class="leader-val">${avg.toFixed(1)}</div>
      </div>`;
    }).join('');
    leadersHtml+=`<div class="leader-card"><div class="leader-cat">${cat.label}</div>${rows}</div>`;
  }
  leadersHtml+='</div>';
  el.innerHTML=rosterHtml+leadersHtml;
}

function renderScenarioOutcomeLine(item) {
  const winText = item.wins?.length ? `Beats ${item.wins.join(', ')}` : 'No required wins listed';
  const lossText = item.losses?.length ? `Loses to ${item.losses.join(', ')}` : 'No required losses listed';
  return `<div class="scenario-team-outcome">
    <div class="scenario-team-head">
      <div class="scenario-team-name">${item.team}</div>
      <div class="scenario-team-record">${item.record}</div>
    </div>
    <div class="scenario-split">${winText}</div>
    <div class="scenario-split">${lossText}</div>
  </div>`;
}

function ordinalPlace(value) {
  const n = Number(value) || 0;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

function scenarioZoneLabel(rank) {
  if (rank <= 6) return 'Playoffs';
  if (rank <= 10) return 'Play-In';
  return 'Eliminated';
}

function getScenarioRounds() {
  const { focusRound, rounds } = getRoundContext();
  const remainingRounds = rounds.filter(round =>
    round >= focusRound && APP.allGames.some(game => game.round === round && !game.played)
  );
  return remainingRounds;
}

function getScenarioImportantTeamCodes(myTeam, goalRank, remainingGames) {
  const cutoffTeam = APP.standings[goalRank - 1];
  const cutoffWins = cutoffTeam?.w ?? myTeam.w;
  const threatTeams = APP.standings
    .filter(team => team.code !== myTeam.code)
    .map(team => ({
      code: team.code,
      rank: team.rank,
      wins: team.w,
      threat: getThreatScore(team, myTeam, goalRank, cutoffWins)
    }))
    .filter(team =>
      team.threat >= 8 ||
      Math.abs(team.rank - myTeam.rank) <= 3 ||
      Math.abs(team.rank - goalRank) <= 2 ||
      Math.abs(team.wins - myTeam.w) <= 2
    )
    .sort((a, b) => b.threat - a.threat)
    .slice(0, 7)
    .map(team => team.code);

  const remainingOpponents = remainingGames
    .filter(game => game.home.code === myTeam.code || game.away.code === myTeam.code)
    .map(game => game.home.code === myTeam.code ? game.away.code : game.home.code);

  return [...new Set([myTeam.code, ...remainingOpponents, ...threatTeams])];
}

function chooseScenarioWinner(game, myTeam, goalRank, goalLabel, mode) {
  const homeCode = game.home.code;
  const awayCode = game.away.code;
  if (homeCode === myTeam.code || awayCode === myTeam.code) {
    return mode.myOutcome === 'win'
      ? myTeam.code
      : (homeCode === myTeam.code ? awayCode : homeCode);
  }

  const analysis = analyzeGameForTeam(game, myTeam, goalRank, goalLabel);
  if (analysis?.preferredWinnerCode) {
    return mode.rivalOutcome === 'help'
      ? analysis.preferredWinnerCode
      : (analysis.preferredWinnerCode === homeCode ? awayCode : homeCode);
  }

  const homeTeam = getTeam(homeCode);
  const awayTeam = getTeam(awayCode);
  const cutoffWins = APP.standings[goalRank - 1]?.w ?? myTeam.w;
  const homeThreat = homeTeam ? getThreatScore(homeTeam, myTeam, goalRank, cutoffWins) : -999;
  const awayThreat = awayTeam ? getThreatScore(awayTeam, myTeam, goalRank, cutoffWins) : -999;
  if (mode.rivalOutcome === 'help') return homeThreat <= awayThreat ? homeCode : awayCode;
  return homeThreat >= awayThreat ? homeCode : awayCode;
}

function applyScenarioResult(game, winnerCode) {
  const homeWins = winnerCode === game.home.code;
  return {
    ...game,
    played: true,
    live: false,
    status: 'result',
    home: {
      ...game.home,
      score: homeWins ? 80 : 70
    },
    away: {
      ...game.away,
      score: homeWins ? 70 : 80
    }
  };
}

function buildScenarioOutcomeSummary(teamCode, remainingGames, simulatedGames, simulatedStandings) {
  const remainingKeys = new Set(remainingGames.map(game => game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`));
  const relevantGames = simulatedGames.filter(game =>
    remainingKeys.has(game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`) &&
    (game.home.code === teamCode || game.away.code === teamCode)
  );
  const wins = [];
  const losses = [];
  for (const game of relevantGames) {
    const opponentCode = game.home.code === teamCode ? game.away.code : game.home.code;
    const winnerCode = winnerCodeForGame(game);
    if (winnerCode === teamCode) wins.push(displayTeamName(opponentCode));
    else losses.push(displayTeamName(opponentCode));
  }
  const finalRow = simulatedStandings.find(team => team.code === teamCode);
  return {
    team: displayTeamName(teamCode),
    wins,
    losses,
    record: finalRow ? `${finalRow.w}-${finalRow.l}` : formatTeamRecord(teamCode).replace(/[()]/g, '')
  };
}

function chooseBaselineWinner(game) {
  const homeTeam = getTeam(game.home.code);
  const awayTeam = getTeam(game.away.code);
  if (homeTeam && awayTeam) {
    if (homeTeam.w !== awayTeam.w) return homeTeam.w > awayTeam.w ? game.home.code : game.away.code;
    if (homeTeam.rank !== awayTeam.rank) return homeTeam.rank < awayTeam.rank ? game.home.code : game.away.code;
  }
  return game.home.code;
}

function getScenarioImportantGames(myTeam, goalRank, goalLabel, remainingRounds) {
  const remainingGames = APP.allGames.filter(game =>
    !game.played && remainingRounds.includes(game.round)
  );
  const importantCodes = getScenarioImportantTeamCodes(myTeam, goalRank, remainingGames);
  return remainingGames
    .map(game => {
      const analysis = analyzeGameForTeam(game, myTeam, goalRank, goalLabel);
      const involvesImportantTeam = importantCodes.includes(game.home.code) || importantCodes.includes(game.away.code);
      const isMyGame = game.home.code === myTeam.code || game.away.code === myTeam.code;
      return {
        ...game,
        analysis,
        scenarioWeight: isMyGame ? 999 : Math.max(analysis?.sortScore ?? -999, involvesImportantTeam ? 9 : -999)
      };
    })
    .filter(game => game.scenarioWeight >= 8)
    .sort((a, b) => b.scenarioWeight - a.scenarioWeight || a.round - b.round)
    .slice(0, 11);
}

function summarizeScenarioTeamLine(teamCode, games) {
  const wins = [];
  const losses = [];
  for (const game of games) {
    if (game.home.code !== teamCode && game.away.code !== teamCode) continue;
    const opponentCode = game.home.code === teamCode ? game.away.code : game.home.code;
    const winnerCode = winnerCodeForGame(game);
    if (winnerCode === teamCode) wins.push(displayTeamName(opponentCode));
    else losses.push(displayTeamName(opponentCode));
  }
  if (!wins.length && !losses.length) return '';
  const parts = [];
  if (wins.length) parts.push(`${displayTeamName(teamCode)} beat ${wins.join(', ')}`);
  if (losses.length) parts.push(`${displayTeamName(teamCode)} lose to ${losses.join(', ')}`);
  return `${parts.join(' and ')}.`;
}

function buildScenarioOptionText(myTeam, importantGames, simulatedImportantGames, finalStandings) {
  const importantCodes = [...new Set(simulatedImportantGames.flatMap(game => [game.home.code, game.away.code]))];
  const myLine = summarizeScenarioTeamLine(myTeam.code, simulatedImportantGames);
  const rivalLines = importantCodes
    .filter(code => code !== myTeam.code)
    .map(code => summarizeScenarioTeamLine(code, simulatedImportantGames))
    .filter(Boolean)
    .slice(0, 4);
  const myFinalRow = finalStandings.find(team => team.code === myTeam.code);
  return {
    text: [myLine, ...rivalLines].join(' '),
    finalRank: myFinalRow?.rank ?? 99,
    finalRecord: myFinalRow ? `${myFinalRow.w}-${myFinalRow.l}` : formatTeamRecord(myTeam.code).replace(/[()]/g, '')
  };
}

function buildDirectedScenarioOption(myTeam, goalRank, goalLabel, remainingRounds, mode) {
  const importantGames = getScenarioImportantGames(myTeam, goalRank, goalLabel, remainingRounds);
  const importantKeys = new Set(importantGames.map(game => game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`));
  const simulatedGames = APP.allGames.map(game => {
    if (game.played || !remainingRounds.includes(game.round)) return game;
    const winnerCode = chooseScenarioWinner(game, myTeam, goalRank, goalLabel, mode);
    return applyScenarioResult(game, winnerCode);
  });
  const simulatedStandings = calcStandings(simulatedGames, {});
  const simulatedImportantGames = simulatedGames.filter(game =>
    importantKeys.has(game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`)
  );
  const option = buildScenarioOptionText(myTeam, importantGames, simulatedImportantGames, simulatedStandings);
  return {
    ...option,
    zone: scenarioZoneLabel(option.finalRank)
  };
}

function enumerateScenarioBuckets(myTeam, goalRank, goalLabel, remainingRounds) {
  const importantGames = getScenarioImportantGames(myTeam, goalRank, goalLabel, remainingRounds);
  const importantKeys = new Set(importantGames.map(game => game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`));
  const totalScenarios = Math.max(1, 2 ** importantGames.length);
  const buckets = {
    Playoffs: { label: 'Playoff scenarios', zone: 'Playoffs', count: 0, options: new Map() },
    'Play-In': { label: 'Play-In scenarios', zone: 'Play-In', count: 0, options: new Map() },
    Eliminated: { label: 'Cut out scenarios', zone: 'Eliminated', count: 0, options: new Map() }
  };

  for (let mask = 0; mask < totalScenarios; mask += 1) {
    const simulatedGames = APP.allGames.map(game => {
      if (game.played || !remainingRounds.includes(game.round)) return game;
      const key = game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`;
      if (importantKeys.has(key)) {
        const index = importantGames.findIndex(item => (item.gameCode || `${item.home.code}-${item.away.code}-${item.round}`) === key);
        const winnerCode = ((mask >> index) & 1) === 1 ? game.home.code : game.away.code;
        return applyScenarioResult(game, winnerCode);
      }
      return applyScenarioResult(game, chooseBaselineWinner(game));
    });

    const simulatedStandings = calcStandings(simulatedGames, {});
    const myFinalRow = simulatedStandings.find(team => team.code === myTeam.code);
    const zone = scenarioZoneLabel(myFinalRow?.rank ?? 99);
    const simulatedImportantGames = simulatedGames.filter(game => importantKeys.has(game.gameCode || `${game.home.code}-${game.away.code}-${game.round}`));
    const option = buildScenarioOptionText(myTeam, importantGames, simulatedImportantGames, simulatedStandings);
    const bucket = buckets[zone];
    bucket.count += 1;
    if (!bucket.options.has(option.text)) {
      bucket.options.set(option.text, { ...option, count: 0 });
    }
    bucket.options.get(option.text).count += 1;
  }

  const directedFallbacks = [
    { zone: 'Playoffs', mode: { myOutcome: 'win', rivalOutcome: 'help' } },
    { zone: 'Play-In', mode: { myOutcome: 'win', rivalOutcome: 'hurt' } },
    { zone: 'Eliminated', mode: { myOutcome: 'lose', rivalOutcome: 'hurt' } }
  ];
  for (const fallback of directedFallbacks) {
    const directedOption = buildDirectedScenarioOption(myTeam, goalRank, goalLabel, remainingRounds, fallback.mode);
    if (directedOption.zone !== fallback.zone) continue;
    const bucket = buckets[fallback.zone];
    if (!bucket.options.has(directedOption.text)) {
      bucket.options.set(directedOption.text, { ...directedOption, count: 0, rarePath: true });
    }
  }

  return { importantGames, totalScenarios, buckets: Object.values(buckets) };
}

function renderScenarios() {
  const el = document.getElementById('scenarios-content');
  if (!el) return;

  if (!APP.selectedTeam) {
    el.innerHTML = '<div class="no-selection">Select a team to view its scenario paths.</div>';
    return;
  }

  const myTeam = getTeam(APP.selectedTeam);
  if (!myTeam) {
    el.innerHTML = `<div class="scenario-empty">
      <div class="section-title" style="margin-bottom:10px">Scenarios</div>
      <div class="summary-lede">Standings data is not ready yet for ${displayTeamName(APP.selectedTeam)}.</div>
    </div>`;
    return;
  }

  const goalRank = APP.selectedGoal === 'playoffs' ? 6 : 10;
  const goalLabel = APP.selectedGoal === 'playoffs' ? 'Playoffs' : 'Play-In';
  const remainingRounds = getScenarioRounds();
  if (!remainingRounds.length) {
    el.innerHTML = `<div class="scenario-empty">
      <div class="section-title" style="margin-bottom:10px">Scenarios</div>
      <div class="summary-lede">The season is already decided for ${displayTeamName(APP.selectedTeam)}. No future rounds remain.</div>
    </div>`;
    return;
  }

  const { importantGames, totalScenarios, buckets } = enumerateScenarioBuckets(myTeam, goalRank, goalLabel, remainingRounds);
  const cards = buckets.map(bucket => {
    const percent = bucket.count > 0 ? `${((bucket.count / totalScenarios) * 100).toFixed(1)}%` : bucket.options.size ? '<0.1%' : '0.0%';
    const options = [...bucket.options.values()]
      .sort((a, b) => b.count - a.count || a.finalRank - b.finalRank)
      .slice(0, 6)
      .map((option, index) => `<li class="scenario-option-item">
        <span class="scenario-option-title">Option ${index + 1} - Finish ${ordinalPlace(option.finalRank)}${option.count > 0 ? ` - ${((option.count / totalScenarios) * 100).toFixed(1)}%` : option.rarePath ? ' - rare path' : ''}</span>
        <span class="scenario-option-copy">${option.text}</span>
      </li>`)
      .join('');
    return `<article class="scenario-card">
      <div class="scenario-bucket-head">
        <div>
          <div class="scenario-title">${bucket.label}</div>
          <div class="scenario-bucket-meta">${bucket.count} of ${totalScenarios} important-game outcomes${bucket.count === 0 && bucket.options.size ? ' in the main model, but a rare path was still found' : ''}</div>
        </div>
        <div class="scenario-percent">${percent}</div>
      </div>
      <ol class="scenario-option-list">${options || '<li class="scenario-option-item"><span class="scenario-option-copy">No options found.</span></li>'}</ol>
    </article>`;
  }).join('');

  el.innerHTML = `<section class="scenario-intro">
    <div class="section-title" style="margin-bottom:8px">${displayTeamName(APP.selectedTeam)} scenarios after Round ${remainingRounds[0] - 1}</div>
    <div class="summary-lede">The app is using rounds ${remainingRounds.join(', ')} and enumerating ${importantGames.length} important games. Percentages are based on those important-game combinations, while the other remaining games are filled with a simple baseline result.</div>
  </section>
  <div class="scenario-stack">${cards}</div>`;
}

const TEAM_DISPLAY_NAMES = {
  BAR: 'Barcelona',
  BAS: 'Baskonia',
  DUB: 'Dubai',
  HTA: 'Hapoel',
  MAD: 'Real',
  MCO: 'Monaco',
  MIL: 'Milan',
  MUN: 'Bayern',
  OLY: 'Olympiacos',
  PAN: 'Panathinaikos',
  PAM: 'Valencia',
  PAR: 'Paris',
  PRS: 'Partizan',
  RED: 'Red Star',
  TEL: 'Maccabi',
  ULK: 'Fenerbahce',
  VIR: 'Virtus',
  ZAL: 'Zalgiris'
};

const TEAM_MAP_FALLBACK = {
  '006835': 'TEL',
  '007990': 'TEL',
  '010781': 'TEL',
  '011193': 'TEL',
  '012336': 'TEL',
  '013289': 'TEL',
  '013304': 'TEL',
  '013381': 'TEL',
  '013403': 'TEL',
  '013699': 'TEL',
  '014012': 'TEL',
  '014120': 'TEL',
  '014123': 'TEL',
  '014127': 'TEL'
};

async function patchPlayerTeams() {
  try {
    const resp = await fetch('https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/E2025/people?personType=J&Limit=500&Offset=0&active=true&sortBy=name');
    if (resp.ok) {
      const data = await resp.json();
      (data.data || []).forEach(p => {
        const code = p.person?.code;
        const club = p.club?.code;
        if (code && club && APP.playerMeta[code]) APP.playerMeta[code].team = club;
      });
      return;
    }
  } catch (_) {}

  for (const [code, team] of Object.entries(TEAM_MAP_FALLBACK)) {
    if (APP.playerMeta[code]) APP.playerMeta[code].team = team;
  }
}

function teamLabel(code) {
  const normalizedCode = normalizeTeamCode(code);
  return TEAM_DISPLAY_NAMES[normalizedCode] || clubOf(normalizedCode).name || normalizedCode;
}

function getLiveGameWindow(daysAhead = 3) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const games = APP.allGames || [];
  const live = games.filter(game => game.live);
  const recentResults = games.filter(game => {
    if (!game.played || !game.date) return false;
    const ts = new Date(game.date).getTime();
    return Number.isFinite(ts) && now - ts <= dayMs;
  });
  const upcoming = games.filter(game => {
    if (game.played || game.live || !game.date) return false;
    const ts = new Date(game.date).getTime();
    return Number.isFinite(ts) && ts >= now && ts - now <= daysAhead * dayMs;
  });
  return { live, recentResults, upcoming };
}

function formatLiveClock(game) {
  const quarter = Number(game?.quarter);
  const label = Number.isFinite(quarter) && quarter > 0
    ? (quarter <= 4 ? `Q${quarter}` : `OT${quarter - 4}`)
    : '';
  const clock = game?.quarterMinute || game?.remainingTime || game?.minute || '';
  return [label, clock].filter(Boolean).join(' · ');
}

function getWantedResultLabel(game) {
  if (!APP.selectedTeam || !APP.selectedGoal) return '';
  const myTeam = getTeam(APP.selectedTeam);
  if (!myTeam) return '';
  const goalRank = APP.selectedGoal === 'playoffs' ? 6 : 10;
  const goalLabel = APP.selectedGoal === 'playoffs' ? 'Playoffs (Top 6)' : 'Play-In (Top 10)';
  const analysis = analyzeGameForTeam(game, myTeam, goalRank, goalLabel);

  if (analysis.type === 'myteam') {
    return `Wanted: ${displayTeamName(APP.selectedTeam)} win`;
  }

  if (analysis.preferredWinnerCode) {
    return `Wanted: ${displayTeamName(analysis.preferredWinnerCode)} win`;
  }

  if (analysis.threatenedCode) {
    return `Wanted: ${displayTeamName(analysis.threatenedCode)} lose`;
  }

  return 'Wanted: Low impact';
}

function renderLiveResults() {
  const el = document.getElementById('live-results-content');
  if (!el) return;

  const { live, recentResults, upcoming } = getLiveGameWindow();
  const round = APP.liveMeta?.currentRound;
  const selectedCode = APP.selectedTeam;

  function renderBadge(game) {
    if (game.live) {
      const clock = formatLiveClock(game);
      return `
        <span class="live-badge live-badge--pulsing">LIVE</span>
        ${clock ? `<span class="live-clock">${clock}</span>` : ''}
      `;
    }
    if (game.played) return '<span class="final-badge">FINAL</span>';
    if (!game.date) return '<span class="upcoming-badge">TBD</span>';
    const ts = new Date(game.date);
    return `<span class="upcoming-badge">${ts.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  function renderCard(game) {
    const homeClub = clubOf(game.home.code);
    const awayClub = clubOf(game.away.code);
    const isMine = selectedCode && (game.home.code === selectedCode || game.away.code === selectedCode);
    const clock = game.live ? formatLiveClock(game) : '';
    const wantedLabel = getWantedResultLabel(game);
    const scoreMarkup = game.live || game.played
      ? `<span class="live-score">${game.home.score} - ${game.away.score}</span>`
      : '<span class="live-score live-score--tbd">vs</span>';
    return `<article class="live-game-card${isMine ? ' live-game-card--mine' : ''}">
      <div class="live-game-header">${renderBadge(game)}</div>
      <div class="live-game-body">
        <div class="live-team">${renderLogoMarkup(homeClub, 'sm')}<span>${homeClub.abbr || game.home.code}</span></div>
        <div class="live-score-stack">
          ${scoreMarkup}
          ${clock ? `<div class="live-game-clock">${clock}</div>` : ''}
        </div>
        <div class="live-team">${renderLogoMarkup(awayClub, 'sm')}<span>${awayClub.abbr || game.away.code}</span>${wantedLabel ? `<div class="wanted-result-label">${wantedLabel}</div>` : ''}</div>
      </div>
    </article>`;
  }

  const sections = [];
  if (live.length) {
    sections.push(`<section class="live-section"><div class="live-section-title">Live Now</div><div class="live-games-grid">${live.map(renderCard).join('')}</div></section>`);
  }
  if (recentResults.length) {
    sections.push(`<section class="live-section"><div class="live-section-title">${round ? `Round ${round} ` : ''}Results</div><div class="live-games-grid">${recentResults.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).map(renderCard).join('')}</div></section>`);
  }
  if (upcoming.length) {
    sections.push(`<section class="live-section"><div class="live-section-title">${round ? `Round ${round} ` : ''}Upcoming</div><div class="live-games-grid">${upcoming.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)).map(renderCard).join('')}</div></section>`);
  }

  const source = APP.liveMeta?.source === 'live' ? 'Live data' : APP.liveMeta?.source === 'feed-fallback' ? 'Fallback data' : 'Snapshot data';
  const updated = APP.liveMeta?.fetchedAt
    ? `Updated ${new Date(APP.liveMeta.fetchedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  el.innerHTML = `<div class="live-results-header">
    <span class="live-data-source">${source}${updated ? ` · ${updated}` : ''}</span>
    <button class="secondary-btn compact-btn" onclick="refreshLiveResults()">Refresh Live</button>
  </div>${sections.join('') || '<div class="no-results">No recent or upcoming games found.</div>'}`;
}

async function refreshLiveResults() {
  await refreshLiveViews();
}

async function refreshLiveViews() {
  await loadLiveData();
  const calculatedStandings = calcStandings(APP.allGames, APP.officialStandingsTable);
  APP.standings = mergeStandings(calculatedStandings, APP.officialStandingsStats);
  renderStandings();
  renderSchedule();
  renderLiveResults();
  renderScenarios();
  if (APP.selectedTeam) runAnalysis();
}

function startLivePolling() {
  window.clearTimeout(window.__igtmtLivePollTimer);
  const scheduleNextRefresh = () => {
    window.__igtmtLivePollTimer = window.setTimeout(() => {
      refreshLiveViews()
        .catch(error => console.warn('Auto-refresh error:', error))
        .finally(scheduleNextRefresh);
    }, getLivePollInterval());
  };
  scheduleNextRefresh();
}

window.switchTab = switchTab;
window.setAuthMode = setAuthMode;
window.submitAuth = submitAuth;
window.completeSetup = completeSetup;
window.goToSetup = goToSetup;
window.logout = logout;
window.selectTeam = selectTeam;
window.selectGoal = selectGoal;
window.runAnalysis = runAnalysis;
window.closeResultAlert = closeResultAlert;
window.refreshLiveResults = refreshLiveResults;

export function initLegacyApp() {
  if (hasInitialized) return;
  hasInitialized = true;
  init();
}
