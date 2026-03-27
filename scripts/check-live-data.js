const LIVE_DATA_URL = process.env.LIVE_DATA_URL || 'http://localhost:8000/api/euroleague/live-data';

function formatLiveClock(game) {
  const quarter = Number(game?.quarter);
  const label = Number.isFinite(quarter) && quarter > 0
    ? (quarter <= 4 ? `Q${quarter}` : `OT${quarter - 4}`)
    : '';
  const clock = game?.quarterMinute || game?.remainingTime || game?.minute || '';
  return [label, clock].filter(Boolean).join(' · ');
}

async function main() {
  const response = await fetch(LIVE_DATA_URL, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const liveGames = games.filter(game => game.live);

  console.log(`source=${payload?.source || 'unknown'}`);
  console.log(`currentRound=${payload?.currentRound ?? 'n/a'} maxRound=${payload?.maxRound ?? 'n/a'}`);
  console.log(`cacheTtlMs=${payload?.cacheTtlMs ?? 'n/a'} anyLive=${Boolean(payload?.anyLive)}`);
  console.log(`games=${games.length} liveGames=${liveGames.length}`);

  if (!liveGames.length) {
    console.log('No live games right now.');
    return;
  }

  for (const game of liveGames) {
    const home = game?.home?.code || 'HOME';
    const away = game?.away?.code || 'AWAY';
    const score = `${game?.home?.score ?? '-'}-${game?.away?.score ?? '-'}`;
    const clock = formatLiveClock(game) || 'clock unavailable';
    console.log(`${home} vs ${away} | ${score} | ${clock}`);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
