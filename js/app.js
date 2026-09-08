// js/app.js
//
// Renders the dashboard. Pulls data via fpl-data.js and writes it into
// the DOM. Kept deliberately framework-free, matching a vanilla-JS +
// Bootstrap-comfortable skill set - no build step required.

import {
  loadDashboardData,
  getSetPieceTakersFromPlayerData,
  getUpcomingFixturesWithDifficulty,
  getCleanSheetLikelihood,
  getElementSummary,
  getSelectionVerdict,
  getLeagueTable,
  getCurrentGameweekFixtures,
  getEntryInfo,
  getEntryPicks,
  getPlayerRecommendation,
  getTopRecommendationsByPosition,
  isGameweekLive,
  getTopScorers,
  getTopAssisters,
  getFixtureSwingPicks,
  getUpcomingGameweeksFixtures,
} from './fpl-data.js';

const STORAGE_KEY_NAME = 'fpl_dashboard_name';
const STORAGE_KEY_TEAM_ID = 'fpl_dashboard_team_id';
const STORAGE_KEY_THEME = 'fpl_dashboard_theme';
const STORAGE_KEY_FREE_TRANSFERS = 'fpl_dashboard_free_transfers';

let bootstrap, fixtures, setPieceNotes;
let teamsById, playersByName;

applyTheme(localStorage.getItem(STORAGE_KEY_THEME) || 'light');
wireUpThemeToggle();

init();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function wireUpThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle');
  toggleBtn.addEventListener('click', () => {
    const current = localStorage.getItem(STORAGE_KEY_THEME) || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY_THEME, next);
    applyTheme(next);
  });
}

async function init() {
  try {
    ({ bootstrap, fixtures, setPieceNotes } = await loadDashboardData());
  } catch (err) {
    document.querySelector('.wrap').innerHTML =
      `<p class="empty-text">Couldn't load FPL data right now (${err.message}). Try refreshing.</p>`;
    return;
  }

  teamsById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  playersByName = new Map(bootstrap.elements.map((p) => [`${p.first_name} ${p.second_name}`, p]));

  renderMasthead();
  renderGreeting();
  renderLiveScores();
  renderUpcomingFixtures();
  renderFixtureTicker();
  renderLeagueTable();
  wireUpTableFilters();
  renderDifferentials();
  renderSetPieceTakers();
  renderCleanSheetWatch();
  renderRecommendations();
  renderFixtureSwingPicks();
  wireUpTransferPlanner();
  renderGoalsAssists();
  renderMySquad();
  populatePlayerList();
  wireUpLookup();
  wireUpPlayerModal();
}

// ---------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------

function renderGreeting() {
  const name = localStorage.getItem(STORAGE_KEY_NAME);
  const el = document.getElementById('masthead-greeting');
  if (!name) {
    el.textContent = '';
    return;
  }

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  el.textContent = `Good ${timeOfDay}, ${name}`;
}

// ---------------------------------------------------------------------
// League table
// ---------------------------------------------------------------------

let currentTableFilter = 'all';

function renderLeagueTable() {
  const tbody = document.getElementById('league-table-body');
  tbody.innerHTML = '';

  const table = getLeagueTable(bootstrap, fixtures, currentTableFilter);

  table.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num">${index + 1}</td>
      <td style="display:flex;align-items:center;gap:8px">${badgeImgHtml(row.team)}${row.team.name}</td>
      <td class="num">${row.played}</td>
      <td class="num">${row.won}</td>
      <td class="num">${row.drawn}</td>
      <td class="num">${row.lost}</td>
      <td class="num">${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td>
      <td class="num">${row.points}</td>
    `;
    tbody.appendChild(tr);
  });

  const liveBadge = document.getElementById('table-live-badge');
  if (isGameweekLive(bootstrap, fixtures)) {
    liveBadge.innerHTML = '<span class="table-live-badge"><span class="live-dot"></span>LIVE</span>';
  } else {
    liveBadge.innerHTML = '';
  }
}

function wireUpTableFilters() {
  document.querySelectorAll('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTableFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderLeagueTable();
    });
  });
}

// ---------------------------------------------------------------------
// Live scores ticker (this gameweek - live and finished matches only)
// ---------------------------------------------------------------------

function buildScoreItemHtml(f, showGwChip = false) {
  const home = teamsById.get(f.team_h);
  const away = teamsById.get(f.team_a);

  let statusHtml;
  let isLive = false;
  if (f.finished_provisional) {
    statusHtml = '<span class="score-status">FT</span>';
  } else if (f.started) {
    isLive = true;
    statusHtml = '<span class="score-status"><span class="live-dot"></span> LIVE</span>';
  } else {
    const kickoff = new Date(f.kickoff_time);
    const timeStr = kickoff.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    statusHtml = `<span class="score-status score-status-upcoming">${timeStr}</span>`;
  }

  const homeScore = f.team_h_score != null ? f.team_h_score : '-';
  const awayScore = f.team_a_score != null ? f.team_a_score : '-';
  const gwChip = showGwChip ? `<span class="score-gw-chip">GW${f.event}</span>` : '';

  return `
    <div class="score-item${isLive ? ' is-live' : ''}">
      ${gwChip}
      ${badgeImgHtml(home)}<span>${home.short_name}</span>
      <span class="score-value">${homeScore}</span>
      <span>–</span>
      <span class="score-value">${awayScore}</span>
      <span>${away.short_name}</span>${badgeImgHtml(away)}
      ${statusHtml}
    </div>
  `;
}

function renderLiveScores() {
  const track = document.getElementById('scores-track');
  const gwFixtures = getCurrentGameweekFixtures(bootstrap, fixtures)
    .filter((f) => f.started); // live or finished only - no upcoming here

  if (gwFixtures.length === 0) {
    track.innerHTML = '<p class="empty-text">No live or finished matches yet this gameweek.</p>';
    return;
  }

  const itemsHtml = gwFixtures.map((f) => buildScoreItemHtml(f, false)).join('');

  // Duplicate the content once so the CSS animation (translateX -50%) loops seamlessly.
  track.innerHTML = itemsHtml + itemsHtml;
}

// ---------------------------------------------------------------------
// Upcoming fixtures ticker (next 3 gameweeks)
// ---------------------------------------------------------------------

function renderUpcomingFixtures() {
  const container = document.getElementById('upcoming-fixtures-list');
  const upcoming = getUpcomingGameweeksFixtures(bootstrap, fixtures, 3);

  if (upcoming.length === 0) {
    container.innerHTML = '<p class="empty-text">No upcoming fixtures found.</p>';
    return;
  }

  // Group fixtures by gameweek, in order.
  const groups = new Map();
  for (const f of upcoming) {
    if (!groups.has(f.event)) groups.set(f.event, []);
    groups.get(f.event).push(f);
  }

  container.innerHTML = [...groups.entries()].map(([eventId, gwFixtures]) => {
    const rows = gwFixtures.map((f) => {
      const home = teamsById.get(f.team_h);
      const away = teamsById.get(f.team_a);
      const kickoff = new Date(f.kickoff_time);
      const timeStr = kickoff.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

      return `
        <div class="fixture-row">
          <div class="fixture-row-team">${badgeImgHtml(home)}${home.name}</div>
          <div class="fixture-row-vs">vs</div>
          <div class="fixture-row-team away">${away.name}${badgeImgHtml(away)}</div>
          <div class="fixture-row-time">${timeStr}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="gw-group">
        <div class="gw-group-header">Gameweek ${eventId}</div>
        ${rows}
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------
// Masthead
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Club badges
// ---------------------------------------------------------------------

// Community-standard badge URL pattern (uses each team's "code" field
// from bootstrap-static). This isn't officially documented by FPL, so
// every badge has an onerror fallback that just hides the image instead
// of showing a broken-image icon if a particular badge fails to load.
function badgeUrl(team) {
  return `https://resources.premierleague.com/premierleague/badges/70/t${team.code}.png`;
}

function badgeImgHtml(team, sizeClass = 'club-badge') {
  if (!team) return '';
  return `<img src="${badgeUrl(team)}" alt="${team.name}" class="${sizeClass}" onerror="this.style.display='none'" />`;
}

function renderMasthead() {
  const currentEvent = bootstrap.events.find((e) => e.is_current) ||
    bootstrap.events.find((e) => e.is_next);
  const nextEvent = bootstrap.events.find((e) => e.is_next) || currentEvent;

  if (currentEvent) {
    document.getElementById('gw-number').textContent = currentEvent.id;
    document.getElementById('gw-label').textContent = currentEvent.finished
      ? 'Gameweek finished'
      : 'Gameweek in progress';
  }

  if (nextEvent) {
    const deadline = new Date(nextEvent.deadline_time);
    document.getElementById('deadline-date').textContent = deadline.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    startCountdown(deadline);
  }
}

function startCountdown(deadline) {
  const el = document.getElementById('deadline-countdown');

  function tick() {
    const diff = deadline.getTime() - Date.now();
    if (diff <= 0) {
      el.textContent = 'Deadline passed';
      clearInterval(intervalId);
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    el.textContent = `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  tick();
  const intervalId = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------
// Fixture difficulty ticker
// ---------------------------------------------------------------------

function renderFixtureTicker() {
  const container = document.getElementById('ticker-container');
  container.innerHTML = '';

  const sortedTeams = [...bootstrap.teams].sort((a, b) => a.name.localeCompare(b.name));

  for (const team of sortedTeams) {
    const upcoming = getUpcomingFixturesWithDifficulty(team.id, fixtures, 5);

    const row = document.createElement('div');
    row.className = 'ticker-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'ticker-team';
    nameEl.innerHTML = `${badgeImgHtml(team)}<span>${team.name}</span>`;
    row.appendChild(nameEl);

    const chipsEl = document.createElement('div');
    chipsEl.className = 'ticker-fixtures';

    for (const fx of upcoming) {
      const opponent = teamsById.get(fx.opponentId);
      const chip = document.createElement('div');
      chip.className = `fdr-chip fdr-${fx.difficulty}`;
      chip.textContent = (opponent ? opponent.short_name : '?') + (fx.isHome ? '' : ' (a)');
      chipsEl.appendChild(chip);
    }

    row.appendChild(chipsEl);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Differentials
// ---------------------------------------------------------------------

function renderDifferentials() {
  const tbody = document.getElementById('differentials-body');
  tbody.innerHTML = '';

  const differentials = bootstrap.elements
    .filter((p) => parseFloat(p.selected_by_percent) < 10 && parseFloat(p.form) > 0)
    .sort((a, b) => parseFloat(b.form) - parseFloat(a.form))
    .slice(0, 10);

  for (const player of differentials) {
    const tr = document.createElement('tr');
    tr.className = 'clickable-player';
    tr.dataset.playerId = player.id;
    tr.innerHTML = `
      <td>${player.web_name}</td>
      <td class="num">${player.selected_by_percent}%</td>
      <td class="num">${player.form}</td>
      <td class="num">${player.expected_goal_involvements}</td>
    `;
    tbody.appendChild(tr);
  }

  if (differentials.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-text">No qualifying differentials found yet.</td></tr>';
  }
}

// ---------------------------------------------------------------------
// Set-piece takers
// ---------------------------------------------------------------------

function renderSetPieceTakers() {
  const container = document.getElementById('takers-container');
  container.innerHTML = '';

  const takersByTeam = getSetPieceTakersFromPlayerData(bootstrap);
  const sortedTeams = [...bootstrap.teams].sort((a, b) => a.name.localeCompare(b.name));

  for (const team of sortedTeams) {
    const takers = takersByTeam.get(team.id);
    if (!takers.penalties.length && !takers.freeKicks.length && !takers.corners.length) continue;

    const block = document.createElement('div');
    block.className = 'takers-team';

    const roles = [
      ['Penalties', takers.penalties],
      ['Free kicks', takers.freeKicks],
      ['Corners', takers.corners],
    ];

    const roleLines = roles
      .filter(([, list]) => list.length > 0)
      .map(([label, list]) => `
        <div class="takers-role">
          <span class="takers-role-label">${label}</span>
          <span>${list.slice(0, 2).map((t) => t.player.web_name).join(', ')}</span>
        </div>
      `)
      .join('');

    block.innerHTML = `<div class="takers-team-name">${badgeImgHtml(team)}${team.name}</div>${roleLines}`;
    container.appendChild(block);
  }
}

// ---------------------------------------------------------------------
// Clean sheet watch
// ---------------------------------------------------------------------

function renderCleanSheetWatch() {
  const container = document.getElementById('clean-sheet-container');
  container.innerHTML = '';

  const sortedTeams = [...bootstrap.teams].sort((a, b) => a.name.localeCompare(b.name));

  for (const team of sortedTeams) {
    const result = getCleanSheetLikelihood(team.id, fixtures);
    if (!result) continue;

    const opponent = teamsById.get(result.opponentId);

    const card = document.createElement('div');
    card.className = 'verdict-card';

    const tagClass = result.verdict === 'Good chance' ? 'verdict-good'
      : result.verdict === 'Toss-up' ? 'verdict-pending'
      : result.verdict === 'Unlikely' ? 'verdict-risk'
      : 'verdict-pending';

    const detail = result.ownForm.avgGoalsConceded != null
      ? `Conceding <span class="num">${result.ownForm.avgGoalsConceded.toFixed(1)}</span>/game recently, vs ${opponent ? opponent.name : 'their next opponent'} scoring <span class="num">${result.opponentForm.avgGoalsScored.toFixed(1)}</span>/game. ${result.isHome ? 'Home fixture.' : 'Away fixture.'}${result.isSmallSample ? ' (Small sample — early season.)' : ''}`
      : 'Not enough finished matches yet to assess.';

    card.innerHTML = `
      <div class="verdict-header">
        <span class="verdict-subject-row">${badgeImgHtml(team, 'club-badge-lg')}<span class="verdict-subject">${team.name}</span></span>
        <span class="verdict-tag ${tagClass}">${result.verdict}</span>
      </div>
      <div class="verdict-detail">${detail}</div>
    `;
    container.appendChild(card);
  }
}

// ---------------------------------------------------------------------
// Player vs opponent lookup
// ---------------------------------------------------------------------

function populatePlayerList() {
  const datalist = document.getElementById('player-list');
  datalist.innerHTML = '';

  for (const name of playersByName.keys()) {
    const option = document.createElement('option');
    option.value = name;
    datalist.appendChild(option);
  }
}

function wireUpLookup() {
  document.getElementById('lookup-button').addEventListener('click', handleLookup);
  document.getElementById('player-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLookup();
  });
}

async function handleLookup() {
  const name = document.getElementById('player-search').value.trim();
  const container = document.getElementById('verdict-container');
  const player = playersByName.get(name);

  if (!player) {
    container.innerHTML = '<p class="empty-text">Pick a player from the suggestions list.</p>';
    return;
  }

  container.innerHTML = '<p class="loading-text">Checking history…</p>';

  let summary;
  try {
    summary = await getElementSummary(player.id);
  } catch (err) {
    container.innerHTML = `<p class="empty-text">Couldn't load that player's history (${err.message}).</p>`;
    return;
  }

  const result = getSelectionVerdict(player, summary, bootstrap, fixtures);
  const opponentName = result.opponentTeam ? result.opponentTeam.name : 'their next opponent';

  const tagClass = result.verdict === 'Strong pick' ? 'verdict-mid'
    : result.verdict === 'Reasonable pick' ? 'verdict-good'
    : result.verdict === 'Risky pick' ? 'verdict-risk'
    : 'verdict-pending';

  let detail;
  if (result.opponentHistory && !result.opponentHistory.isSmallSample) {
    const t = result.opponentHistory.totals;
    detail = `Vs ${opponentName} this season: <span class="num">${t.goals}</span> goals, <span class="num">${t.assists}</span> assists in <span class="num">${t.minutes}</span> mins across <span class="num">${result.opponentHistory.matchCount}</span> matches. ${result.isHome ? 'Home fixture.' : 'Away fixture.'}`;
  } else {
    detail = `Not enough matches vs ${opponentName} yet this season to judge reliably — the API also doesn't expose opponent-level detail for past seasons, so this only covers the current campaign.`;
  }

  const playerTeam = teamsById.get(player.team);

  container.innerHTML = `
    <div class="verdict-card">
      <div class="verdict-header">
        <span class="verdict-subject-row">${badgeImgHtml(playerTeam, 'club-badge-lg')}<span class="verdict-subject">${player.web_name}</span></span>
        <span class="verdict-tag ${tagClass}">${result.verdict}</span>
      </div>
      <div class="verdict-detail">${detail}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Fixture swing picks
// ---------------------------------------------------------------------

function renderFixtureSwingPicks() {
  const container = document.getElementById('fixture-swing-container');
  const swings = getFixtureSwingPicks(bootstrap, fixtures, 3, 2, 2);

  if (swings.length === 0) {
    container.innerHTML = '<p class="empty-text">No team currently has 3 straight easy fixtures lined up.</p>';
    return;
  }

  container.innerHTML = swings.map(({ team, players }) => {
    const playerRows = players.map(({ player, recommendation }) => `
      <div class="rec-item clickable-player" data-player-id="${player.id}">
        <div class="rec-item-header">
          <span class="rec-item-name">${player.web_name}</span>
          <span class="rec-tag ${tagClassFor(recommendation.tag)}">${recommendation.tag}</span>
        </div>
      </div>
    `).join('');

    return `
      <div class="swing-team-block">
        <div class="swing-team-header">${badgeImgHtml(team)}${team.name}</div>
        ${playerRows}
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------
// Transfer planner
// ---------------------------------------------------------------------

function wireUpTransferPlanner() {
  const ftInput = document.getElementById('free-transfers-input');
  const savedFt = localStorage.getItem(STORAGE_KEY_FREE_TRANSFERS);
  if (savedFt != null) ftInput.value = savedFt;

  ftInput.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY_FREE_TRANSFERS, ftInput.value);
  });

  document.getElementById('transfer-compare-button').addEventListener('click', handleTransferCompare);
}

function buildTransferCompareColumn(player, label) {
  if (!player) {
    return `<div class="transfer-compare-col"><div class="transfer-compare-label">${label}</div><p class="empty-text">Pick a player from the suggestions.</p></div>`;
  }

  const team = teamsById.get(player.team);
  const rec = getPlayerRecommendation(player, bootstrap, fixtures);
  const avgFixture = rec.avgFixtureDifficulty != null ? rec.avgFixtureDifficulty.toFixed(1) : '—';

  return `
    <div class="transfer-compare-col">
      <div class="transfer-compare-label">${label}</div>
      <div class="verdict-subject-row" style="margin-bottom:8px">${badgeImgHtml(team, 'club-badge-lg')}<span class="verdict-subject">${player.web_name}</span></div>
      <span class="rec-tag ${tagClassFor(rec.tag)}">${rec.tag}</span>
      <p style="font-size:0.82rem;color:var(--mid);margin:8px 0 0">Form ${player.form} · Next-5 fixture avg ${avgFixture} · ${rec.reasons[0] || 'No standout factors'}</p>
    </div>
  `;
}

function handleTransferCompare() {
  const outName = document.getElementById('transfer-out-input').value.trim();
  const inName = document.getElementById('transfer-in-input').value.trim();
  const resultContainer = document.getElementById('transfer-planner-result');

  const outPlayer = playersByName.get(outName);
  const inPlayer = playersByName.get(inName);

  if (!outPlayer || !inPlayer) {
    resultContainer.innerHTML = '<p class="empty-text">Pick both players from the suggestions list.</p>';
    return;
  }

  const freeTransfers = parseInt(document.getElementById('free-transfers-input').value, 10) || 0;
  const willCostHit = freeTransfers < 1;

  const hitBannerHtml = willCostHit
    ? `<div class="transfer-hit-banner has-hit">This would cost a -4 point hit (0 free transfers available). Per the Strategy Notes, only worth it for an injury/suspension or a clear upgrade — not a marginal one.</div>`
    : `<div class="transfer-hit-banner no-hit">This uses 1 of your free transfers — no point deduction.</div>`;

  resultContainer.innerHTML = `
    <div class="transfer-compare-grid">
      ${buildTransferCompareColumn(outPlayer, 'Transferring OUT')}
      ${buildTransferCompareColumn(inPlayer, 'Transferring IN')}
    </div>
    ${hitBannerHtml}
  `;
}

// ---------------------------------------------------------------------
// Goals & assists leaders
// ---------------------------------------------------------------------

function renderGoalsAssists() {
  const scorers = getTopScorers(bootstrap, 8);
  const assisters = getTopAssisters(bootstrap, 8);

  const buildList = (players, statKey) => players.map((player, index) => {
    const team = teamsById.get(player.team);
    return `
      <div class="leader-item clickable-player" data-player-id="${player.id}">
        <span class="leader-rank">${index + 1}</span>
        ${badgeImgHtml(team)}
        <span class="leader-name">${player.web_name}</span>
        <span class="leader-value">${player[statKey]}</span>
      </div>
    `;
  }).join('');

  document.getElementById('top-scorers-container').innerHTML = buildList(scorers, 'goals_scored');
  document.getElementById('top-assisters-container').innerHTML = buildList(assisters, 'assists');
}

// ---------------------------------------------------------------------
// Player recommendations
// ---------------------------------------------------------------------

function tagClassFor(tag) {
  return tag === 'Get' ? 'tag-get' : tag === 'Monitor' ? 'tag-monitor' : 'tag-avoid';
}

function renderRecommendations() {
  const container = document.getElementById('recommendations-container');
  container.innerHTML = '';

  const positions = [
    { id: 1, label: 'Goalkeepers' },
    { id: 2, label: 'Defenders' },
    { id: 3, label: 'Midfielders' },
    { id: 4, label: 'Forwards' },
  ];

  for (const pos of positions) {
    const top = getTopRecommendationsByPosition(bootstrap, fixtures, pos.id, 4);

    const block = document.createElement('div');
    block.className = 'rec-position-block';

    const itemsHtml = top.map(({ player, recommendation }) => {
      const team = teamsById.get(player.team);
      const topReason = recommendation.reasons[0] || '';
      return `
        <div class="rec-item clickable-player" data-player-id="${player.id}">
          <div class="rec-item-header">
            <span class="rec-item-name">${badgeImgHtml(team)}${player.web_name}</span>
            <span class="rec-tag ${tagClassFor(recommendation.tag)}">${recommendation.tag}</span>
          </div>
          ${topReason ? `<div class="rec-item-reason">${topReason}</div>` : ''}
        </div>
      `;
    }).join('') || '<p class="empty-text">No qualifying players yet.</p>';

    block.innerHTML = `<div class="rec-position-label">${pos.label}</div>${itemsHtml}`;
    container.appendChild(block);
  }
}

// ---------------------------------------------------------------------
// My Squad (pulls the user's real FPL team, read-only, via their Team ID)
// ---------------------------------------------------------------------

function getCurrentEventId() {
  const currentEvent = bootstrap.events.find((e) => e.is_current) ||
    bootstrap.events.find((e) => e.is_next);
  return currentEvent ? currentEvent.id : null;
}

function renderMySquad() {
  const container = document.getElementById('my-squad-container');
  const name = localStorage.getItem(STORAGE_KEY_NAME);
  const teamId = localStorage.getItem(STORAGE_KEY_TEAM_ID);

  if (!name || !teamId) {
    renderSquadSetupForm(container, name, teamId);
    return;
  }

  loadAndRenderSquad(container, teamId);
}

function renderSquadSetupForm(container, existingName, existingTeamId) {
  container.innerHTML = `
    <div class="setup-card">
      <p class="setup-hint">Enter your name for a personal greeting, and your FPL Team ID to pull in your actual squad (read-only — no login needed). Your Team ID is the number in your FPL team URL, e.g. fantasy.premierleague.com/entry/<strong>1234567</strong>/event/1.</p>
      <div class="setup-row">
        <input type="text" id="setup-name" class="lookup-input" placeholder="Your name" value="${existingName || ''}" />
        <input type="text" id="setup-team-id" class="lookup-input" placeholder="Your FPL Team ID" value="${existingTeamId || ''}" />
        <button class="lookup-button" id="setup-save">Save</button>
      </div>
    </div>
  `;

  document.getElementById('setup-save').addEventListener('click', () => {
    const nameVal = document.getElementById('setup-name').value.trim();
    const teamIdVal = document.getElementById('setup-team-id').value.trim();

    if (nameVal) localStorage.setItem(STORAGE_KEY_NAME, nameVal);
    if (teamIdVal) localStorage.setItem(STORAGE_KEY_TEAM_ID, teamIdVal);

    renderGreeting();
    renderMySquad();
  });
}

async function loadAndRenderSquad(container, teamId) {
  container.innerHTML = '<p class="loading-text">Loading your squad…</p>';

  const eventId = getCurrentEventId();
  if (!eventId) {
    container.innerHTML = '<p class="empty-text">Could not determine the current gameweek.</p>';
    return;
  }

  let entryInfo, picksData;
  try {
    [entryInfo, picksData] = await Promise.all([
      getEntryInfo(teamId),
      getEntryPicks(teamId, eventId),
    ]);
  } catch (err) {
    container.innerHTML = `
      <div class="setup-card">
        <p class="empty-text">Couldn't load that team (${err.message}). Double-check your Team ID.</p>
        <button class="lookup-button" id="squad-retry">Try a different Team ID</button>
      </div>
    `;
    document.getElementById('squad-retry').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY_TEAM_ID);
      renderMySquad();
    });
    return;
  }

  const elementTypeNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const squadTagLabel = { Get: 'Keep', Monitor: 'Monitor', Avoid: 'Sell' };

  // Find the best captaincy candidate among the starting XI (positions 1-11).
  let captainSuggestion = null;
  for (const pick of picksData.picks) {
    if (pick.position > 11) continue;
    const player = bootstrap.elements.find((p) => p.id === pick.element);
    const rec = getPlayerRecommendation(player, bootstrap, fixtures);
    if (!captainSuggestion || rec.score > captainSuggestion.score) {
      captainSuggestion = { player, score: rec.score };
    }
  }

  const playerRows = picksData.picks.map((pick) => {
    const player = bootstrap.elements.find((p) => p.id === pick.element);
    const team = teamsById.get(player.team);
    const isBench = pick.position > 11;
    const captainTag = pick.is_captain ? '<span class="squad-captain-badge">C</span>'
      : pick.is_vice_captain ? '<span class="squad-captain-badge">VC</span>' : '';

    const rec = getPlayerRecommendation(player, bootstrap, fixtures);
    const squadTag = `<span class="rec-tag ${tagClassFor(rec.tag)}" style="margin-left:auto">${squadTagLabel[rec.tag]}</span>`;

    return `
      <div class="squad-player clickable-player${isBench ? ' is-bench' : ''}" data-player-id="${player.id}">
        <span class="squad-position-label">${elementTypeNames[player.element_type]}</span>
        ${badgeImgHtml(team)}
        <span class="squad-player-name">${player.web_name}</span>
        ${captainTag}
        ${squadTag}
      </div>
    `;
  }).join('');

  const captainCalloutHtml = captainSuggestion
    ? `<div class="captain-callout"><span class="captain-callout-label">Suggested captain:</span> ${captainSuggestion.player.web_name}</div>`
    : '';

  container.innerHTML = `
    <div class="squad-header">
      <span style="font-weight:600">${entryInfo.name}</span>
      <button class="squad-edit-link" id="squad-edit">Change team</button>
    </div>
    ${captainCalloutHtml}
    <div class="squad-grid">${playerRows}</div>
  `;

  document.getElementById('squad-edit').addEventListener('click', () => {
    renderSquadSetupForm(container, localStorage.getItem(STORAGE_KEY_NAME), localStorage.getItem(STORAGE_KEY_TEAM_ID));
  });
}

// ---------------------------------------------------------------------
// Player detail modal (click any player card/row to open)
// ---------------------------------------------------------------------

function wireUpPlayerModal() {
  const overlay = document.getElementById('player-modal-overlay');

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-player-id]');
    if (target) {
      openPlayerModal(parseInt(target.dataset.playerId, 10));
    }
  });

  document.getElementById('modal-close').addEventListener('click', closePlayerModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePlayerModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePlayerModal();
  });
}

function closePlayerModal() {
  document.getElementById('player-modal-overlay').classList.remove('open');
}

async function openPlayerModal(playerId) {
  const player = bootstrap.elements.find((p) => p.id === playerId);
  if (!player) return;

  const overlay = document.getElementById('player-modal-overlay');
  const body = document.getElementById('modal-body');
  const team = teamsById.get(player.team);
  const rec = getPlayerRecommendation(player, bootstrap, fixtures);

  const priceStr = `£${(player.now_cost / 10).toFixed(1)}m`;
  const setPieceRoles = [];
  if (player.penalties_order === 1) setPieceRoles.push('Penalties');
  if (player.direct_freekicks_order === 1) setPieceRoles.push('Free kicks');
  if (player.corners_and_indirect_freekicks_order === 1) setPieceRoles.push('Corners');

  const isGoalkeeper = player.element_type === 1;
  const thirdStatLabel = isGoalkeeper ? 'Saves' : 'Goals';
  const thirdStatValue = isGoalkeeper ? player.saves : player.goals_scored;
  const fourthStatLabel = isGoalkeeper ? 'Clean Sheets' : 'Assists';
  const fourthStatValue = isGoalkeeper ? player.clean_sheets : player.assists;

  body.innerHTML = `
    <div class="modal-header">
      ${badgeImgHtml(team, 'club-badge-lg')}
      <div>
        <div class="modal-player-name">${player.web_name}</div>
        <div class="modal-player-team">${team.name}</div>
      </div>
    </div>

    <div class="modal-stat-grid">
      <div class="modal-stat"><div class="modal-stat-label">Price</div><div class="modal-stat-value">${priceStr}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Owned</div><div class="modal-stat-value">${player.selected_by_percent}%</div></div>
      <div class="modal-stat"><div class="modal-stat-label">${thirdStatLabel}</div><div class="modal-stat-value">${thirdStatValue}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">${fourthStatLabel}</div><div class="modal-stat-value">${fourthStatValue}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Form</div><div class="modal-stat-value">${player.form}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">${isGoalkeeper ? 'Saves /90' : 'xGI /90'}</div><div class="modal-stat-value">${isGoalkeeper ? (player.saves && player.minutes ? (player.saves / (player.minutes / 90)).toFixed(2) : '—') : (player.expected_goal_involvements_per_90 ?? '—')}</div></div>
    </div>

    <div class="modal-section-title">Recommendation</div>
    <span class="rec-tag ${tagClassFor(rec.tag)}">${rec.tag}</span>
    <ul class="modal-reasons">
      ${rec.reasons.map((r) => `<li>${r}</li>`).join('') || '<li>No standout factors either way.</li>'}
    </ul>

    ${setPieceRoles.length ? `<div class="modal-section-title">Set pieces</div><p style="margin:0;font-size:0.85rem">${setPieceRoles.join(', ')}</p>` : ''}

    <div class="modal-section-title">Vs next opponent</div>
    <p id="modal-opponent-detail" class="loading-text" style="padding:0">Loading…</p>
  `;

  overlay.classList.add('open');

  // Opponent history needs an extra fetch (element-summary), so it loads
  // in after the rest of the modal is already visible.
  try {
    const summary = await getElementSummary(playerId);
    const verdict = getSelectionVerdict(player, summary, bootstrap, fixtures);
    const opponentName = verdict.opponentTeam ? verdict.opponentTeam.name : 'their next opponent';
    const detailEl = document.getElementById('modal-opponent-detail');
    if (!detailEl) return; // modal may have been closed already

    if (verdict.opponentHistory && !verdict.opponentHistory.isSmallSample) {
      const t = verdict.opponentHistory.totals;
      detailEl.textContent = `Vs ${opponentName} this season: ${t.goals} goals, ${t.assists} assists in ${t.minutes} mins across ${verdict.opponentHistory.matchCount} matches.`;
    } else {
      detailEl.textContent = `Not enough matches vs ${opponentName} yet this season to judge reliably.`;
    }
    detailEl.className = 'verdict-detail';
  } catch (err) {
    const detailEl = document.getElementById('modal-opponent-detail');
    if (detailEl) detailEl.textContent = 'Could not load opponent history.';
  }
}