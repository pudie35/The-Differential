// js/fpl-data.js
//
// Fetches and normalizes data from the FPL API (via the Netlify proxy
// function, since the real API blocks direct browser requests with CORS).
//
// Data sources used:
//   - bootstrap-static/        -> all players, teams, gameweeks
//   - fixtures/                -> every match, past and upcoming
//   - element-summary/{id}/    -> one player's per-gameweek history + upcoming fixtures
//   - team/set-piece-notes/    -> official set-piece taker notes (often sparse early season)

const PROXY_BASE = '/.netlify/functions/fpl-proxy?path=';

// In-memory cache so we don't re-fetch the same data multiple times per
// page load. This resets on page refresh - that's fine, FPL data doesn't
// need to be more fresh than that.
const cache = {
  bootstrap: null,
  fixtures: null,
  setPieceNotes: null,
  elementSummaries: new Map(), // playerId -> summary data
};

async function fetchFromProxy(path) {
  const response = await fetch(PROXY_BASE + encodeURIComponent(path));
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetches the core dataset: all players, all teams, all gameweeks.
 * This is the foundation almost everything else builds on.
 */
export async function getBootstrapData() {
  if (!cache.bootstrap) {
    cache.bootstrap = await fetchFromProxy('bootstrap-static/');
  }
  return cache.bootstrap;
}

/**
 * Fetches every fixture in the season - past results and future matches.
 */
export async function getFixtures() {
  if (!cache.fixtures) {
    cache.fixtures = await fetchFromProxy('fixtures/');
  }
  return cache.fixtures;
}

/**
 * Fetches a single player's detailed history: their per-gameweek stats
 * this season (with opponent_team on each entry), past-season summaries,
 * and their remaining fixtures.
 */
export async function getElementSummary(playerId) {
  if (!cache.elementSummaries.has(playerId)) {
    const data = await fetchFromProxy(`element-summary/${playerId}/`);
    cache.elementSummaries.set(playerId, data);
  }
  return cache.elementSummaries.get(playerId);
}

/**
 * Fetches official set-piece taker notes. Note: early in the season this
 * is often just placeholder text ("Check back for additional notes soon")
 * for every team - see getSetPieceTakersFromPlayerData() below for a more
 * reliable source using data you already have.
 */
export async function getSetPieceNotes() {
  if (!cache.setPieceNotes) {
    cache.setPieceNotes = await fetchFromProxy('team/set-piece-notes/');
  }
  return cache.setPieceNotes;
}

/**
 * Loads everything needed to power the dashboard in one call.
 * Returns { bootstrap, fixtures, setPieceNotes }.
 */
export async function loadDashboardData() {
  const [bootstrap, fixtures, setPieceNotes] = await Promise.all([
    getBootstrapData(),
    getFixtures(),
    getSetPieceNotes(),
  ]);
  return { bootstrap, fixtures, setPieceNotes };
}

// ---------------------------------------------------------------------
// Player recommendation engine
// ---------------------------------------------------------------------
//
// Heuristic scoring, not a guarantee - built around commonly-cited FPL
// strategy principles: judge fixtures over a run of games rather than
// one big haul, favor nailed-on starters over rotation risks, only rate
// a low-ownership player highly if the underlying stats back it up, and
// give set-piece takers a bump since they have an extra route to points.

/**
 * How many of a team's games so far this season a player has actually
 * started, as a reliability signal. Falls back to a minutes-based
 * estimate if the "starts" field isn't present on this player record.
 */
function getMinutesReliability(player, bootstrap) {
  const finishedEvents = bootstrap.events.filter((e) => e.finished).length;
  if (finishedEvents === 0) return { ratio: null, gamesConsidered: 0 };

  if (typeof player.starts === 'number') {
    return { ratio: player.starts / finishedEvents, gamesConsidered: finishedEvents };
  }

  // Fallback: estimate starts from total minutes (90 min ~ 1 start).
  const estimatedStarts = player.minutes / 90;
  return { ratio: estimatedStarts / finishedEvents, gamesConsidered: finishedEvents };
}

/**
 * Average fixture difficulty over a player's team's next N fixtures
 * (default a 5-game run, per the "judge fixtures over 3-6 weeks, not
 * one Gameweek" principle). Lower is easier.
 */
function getFixtureRunDifficulty(player, fixtures, n = 5) {
  const upcoming = getUpcomingFixturesWithDifficulty(player.team, fixtures, n);
  if (upcoming.length === 0) return null;
  const total = upcoming.reduce((sum, f) => sum + f.difficulty, 0);
  return total / upcoming.length;
}

/**
 * Whether this player is a primary (order 1) set-piece taker of any kind.
 */
function isPrimarySetPieceTaker(player) {
  return player.penalties_order === 1 ||
    player.direct_freekicks_order === 1 ||
    player.corners_and_indirect_freekicks_order === 1;
}

/**
 * Scores a single player and returns a heuristic recommendation.
 * tag is 'Get' / 'Monitor' / 'Avoid' - callers targeting an owned squad
 * can relabel these to Keep / Monitor / Sell, the underlying logic is
 * the same question either way: "is this a good use of a squad slot?"
 */
export function getPlayerRecommendation(player, bootstrap, fixtures) {
  const reasons = [];

  // Availability check first - this can override everything else.
  const chanceOfPlaying = player.chance_of_playing_this_round;
  const isFlagged = chanceOfPlaying != null && chanceOfPlaying < 75;
  if (isFlagged) {
    reasons.push(player.news || 'Flagged as a doubt for the next match');
  }

  const reliability = getMinutesReliability(player, bootstrap);
  const avgFixtureDifficulty = getFixtureRunDifficulty(player, fixtures, 5);
  const form = parseFloat(player.form || 0);
  const xgi90 = parseFloat(player.expected_goal_involvements_per_90 || 0);
  const ownership = parseFloat(player.selected_by_percent || 0);
  const isSetPieceTaker = isPrimarySetPieceTaker(player);

  let score = 0;
  score += form * 2;
  score += xgi90 * 12;
  if (avgFixtureDifficulty != null) score += (6 - avgFixtureDifficulty) * 1.5;
  if (reliability.ratio != null) score += Math.min(reliability.ratio, 1) * 3;
  if (isSetPieceTaker) score += 1.5;
  if (isFlagged) score -= 6;

  // Build human-readable reasons for the top factors.
  if (reliability.ratio != null && reliability.ratio < 0.5 && reliability.gamesConsidered >= 3) {
    reasons.push('Rotation risk - not a nailed starter recently');
  }
  if (avgFixtureDifficulty != null && avgFixtureDifficulty >= 3.6) {
    reasons.push('Tough fixture run over the next few Gameweeks');
  }
  if (avgFixtureDifficulty != null && avgFixtureDifficulty <= 2.4) {
    reasons.push('Favorable fixture run over the next few Gameweeks');
  }
  if (isSetPieceTaker) {
    reasons.push('Primary set-piece taker - extra route to points');
  }
  if (ownership < 10 && xgi90 > 0.4) {
    reasons.push('Low-owned differential backed by strong underlying stats');
  } else if (ownership < 10 && xgi90 <= 0.4) {
    reasons.push('Low ownership, but underlying stats don\'t back a differential pick yet');
  }
  if (reliability.ratio != null && reliability.ratio >= 0.8) {
    reasons.push('Nailed-on starter');
  }

  let tag;
  if (isFlagged || score < 2) tag = 'Avoid';
  else if (score < 6) tag = 'Monitor';
  else tag = 'Get';

  return { score, tag, reasons, avgFixtureDifficulty, reliability, form, xgi90, ownership, isSetPieceTaker };
}

/**
 * Top recommended players for a given position (element_type: 1=GKP,
 * 2=DEF, 3=MID, 4=FWD), ranked by score. Excludes anyone currently
 * flagged as a doubt, since "Get this player" shouldn't recommend an
 * injury risk even if their underlying stats are good.
 */
export function getTopRecommendationsByPosition(bootstrap, fixtures, elementType, count = 5) {
  return bootstrap.elements
    .filter((p) => p.element_type === elementType)
    .map((p) => ({ player: p, recommendation: getPlayerRecommendation(p, bootstrap, fixtures) }))
    .filter((r) => r.recommendation.tag !== 'Avoid')
    .sort((a, b) => b.recommendation.score - a.recommendation.score)
    .slice(0, count);
}

// ---------------------------------------------------------------------
// Fixture swing picks (teams with a run of easy fixtures ahead)
// ---------------------------------------------------------------------

/**
 * Teams whose next N fixtures (default 3) are ALL at or below a given
 * difficulty (default 2, i.e. "easy"). Useful for spotting a genuine
 * fixture swing worth targeting, not just one good match.
 */
export function getFixtureSwingTeams(bootstrap, fixtures, n = 3, maxDifficulty = 2) {
  return bootstrap.teams.filter((team) => {
    const upcoming = getUpcomingFixturesWithDifficulty(team.id, fixtures, n);
    if (upcoming.length < n) return false;
    return upcoming.every((f) => f.difficulty <= maxDifficulty);
  });
}

/**
 * For each team on a fixture swing, the top recommended players (any
 * position, excluding Avoid-tagged players) worth targeting because of
 * that run - not just individually good stats.
 */
export function getFixtureSwingPicks(bootstrap, fixtures, n = 3, maxDifficulty = 2, playersPerTeam = 2) {
  const teams = getFixtureSwingTeams(bootstrap, fixtures, n, maxDifficulty);

  return teams.map((team) => {
    const teamPlayers = bootstrap.elements
      .filter((p) => p.team === team.id)
      .map((p) => ({ player: p, recommendation: getPlayerRecommendation(p, bootstrap, fixtures) }))
      .filter((r) => r.recommendation.tag !== 'Avoid')
      .sort((a, b) => b.recommendation.score - a.recommendation.score)
      .slice(0, playersPerTeam);

    return { team, players: teamPlayers };
  }).filter((entry) => entry.players.length > 0);
}

// ---------------------------------------------------------------------
// Goals & assists leaders
// ---------------------------------------------------------------------

export function getTopScorers(bootstrap, count = 8) {
  return bootstrap.elements
    .filter((p) => p.minutes > 0)
    .sort((a, b) => b.goals_scored - a.goals_scored)
    .slice(0, count);
}

export function getTopAssisters(bootstrap, count = 8) {
  return bootstrap.elements
    .filter((p) => p.minutes > 0)
    .sort((a, b) => b.assists - a.assists)
    .slice(0, count);
}

// ---------------------------------------------------------------------
// League table
// ---------------------------------------------------------------------

/**
 * Computes the league table from match results. The FPL API has no
 * standings endpoint, so this is built directly from fixture data.
 *
 * By counting any fixture that has started (not just ones marked
 * "finished"), the table reflects live scores while matches are in
 * progress - not just after full time.
 *
 * @param {string} filter - 'all' (default), 'home', or 'away'. 'home'
 *   only counts each team's home fixtures toward their record, 'away'
 *   only counts their away fixtures - useful for spotting home/away form.
 */
export function getLeagueTable(bootstrap, fixtures, filter = 'all') {
  const table = new Map();

  for (const team of bootstrap.teams) {
    table.set(team.id, {
      team,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    });
  }

  const includeHome = filter !== 'away';
  const includeAway = filter !== 'home';

  for (const fixture of fixtures) {
    if (!fixture.started) continue;

    const hs = fixture.team_h_score;
    const as = fixture.team_a_score;
    if (hs == null || as == null) continue;

    if (includeHome) {
      const home = table.get(fixture.team_h);
      home.played += 1;
      home.goalsFor += hs;
      home.goalsAgainst += as;
      if (hs > as) { home.won += 1; home.points += 3; }
      else if (hs < as) { home.lost += 1; }
      else { home.drawn += 1; home.points += 1; }
    }

    if (includeAway) {
      const away = table.get(fixture.team_a);
      away.played += 1;
      away.goalsFor += as;
      away.goalsAgainst += hs;
      if (as > hs) { away.won += 1; away.points += 3; }
      else if (as < hs) { away.lost += 1; }
      else { away.drawn += 1; away.points += 1; }
    }
  }

  return [...table.values()]
    .map((row) => ({ ...row, goalDifference: row.goalsFor - row.goalsAgainst }))
    .sort((a, b) =>
      b.points - a.points ||
      b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor
    );
}

/**
 * True if any fixture in the current gameweek is currently in progress
 * (started but not yet finished). Used to show a "Live" indicator.
 */
export function isGameweekLive(bootstrap, fixtures) {
  const gwFixtures = getCurrentGameweekFixtures(bootstrap, fixtures);
  return gwFixtures.some((f) => f.started && !f.finished_provisional);
}

// ---------------------------------------------------------------------
// Current gameweek fixtures (for the live scores ticker)
// ---------------------------------------------------------------------

/**
 * Returns every fixture belonging to the current gameweek, in kickoff
 * order, regardless of whether it's finished, in progress, or upcoming.
 * `started` and `finished_provisional` on each fixture indicate live
 * status; `team_h_score`/`team_a_score` update during play.
 */
export function getCurrentGameweekFixtures(bootstrap, fixtures) {
  const currentEvent = bootstrap.events.find((e) => e.is_current) ||
    bootstrap.events.find((e) => e.is_next);
  if (!currentEvent) return [];

  return fixtures
    .filter((f) => f.event === currentEvent.id)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
}

/**
 * Fetches basic public info about an FPL manager (team name, manager name,
 * overall rank, etc.) - no login required, just their Team ID.
 */
export async function getEntryInfo(entryId) {
  return fetchFromProxy(`entry/${entryId}/`);
}

/**
 * Fetches an FPL manager's squad picks for a given gameweek - which 15
 * players, who's captain/vice-captain, and who's on the bench. Public
 * data, no login required.
 */
export async function getEntryPicks(entryId, eventId) {
  return fetchFromProxy(`entry/${entryId}/event/${eventId}/picks/`);
}

// ---------------------------------------------------------------------
// Squad recommendations (Keep / Monitor / Sell) and captain suggestion
// ---------------------------------------------------------------------
//
// Built around a few explicit principles rather than chasing last
// week's score:
//   - Use FPL's own "form" figure (averaged over recent gameweeks), not
//     a single match, to avoid knee-jerk reactions to one blank.
//   - Look at fixture difficulty over the next several gameweeks, not
//     just the next one.
//   - Weigh minutes security (is this player actually nailed on) as
//     heavily as raw talent - a rotation risk is a real cost.
//   - Treat set-piece involvement (penalties/free kicks/corners) as a
//     genuine positive signal, not decoration.
// This is a heuristic scoring system, not a guarantee - it's meant to
// surface things worth considering, not make the decision for you.

/**
 * Average minutes played per appearance over a player's last N gameweek
 * entries in their current-season history. Used as a proxy for how
 * "nailed on" they are, separate from reputation or price.
 */
function getAverageRecentMinutes(elementSummary, n = 5) {
  const recent = elementSummary.history.slice(-n);
  if (recent.length === 0) return null;
  const total = recent.reduce((sum, gw) => sum + gw.minutes, 0);
  return total / recent.length;
}

/**
 * Assesses a single squad player: Keep / Monitor / Sell, with the
 * reasons behind the call so the person can weigh it themselves rather
 * than just trusting a label.
 */
export function getSquadPlayerOutlook(player, elementSummary, fixtures) {
  const reasons = [];
  let score = 0;

  // Form (FPL's own multi-gameweek average, not a single match)
  const form = parseFloat(player.form || 0);
  if (form >= 5) { score += 2; reasons.push(`Strong recent form (${form})`); }
  else if (form >= 3) { score += 1; reasons.push(`Steady recent form (${form})`); }
  else { reasons.push(`Quiet recent form (${form}) - one bad match alone isn't a reason to panic`); }

  // Fixtures over the next several gameweeks, not just the next one
  const upcoming = getUpcomingFixturesWithDifficulty(player.team, fixtures, 6);
  const avgFdr = upcoming.length
    ? upcoming.reduce((sum, f) => sum + f.difficulty, 0) / upcoming.length
    : null;
  if (avgFdr != null) {
    if (avgFdr <= 2.4) { score += 2; reasons.push(`Favourable fixtures over the next ${upcoming.length} gameweeks`); }
    else if (avgFdr <= 3.4) { score += 1; reasons.push(`Mixed fixtures over the next ${upcoming.length} gameweeks`); }
    else { reasons.push(`Tough run of fixtures over the next ${upcoming.length} gameweeks`); }
  }

  // Minutes security
  const avgMinutes = getAverageRecentMinutes(elementSummary, 5);
  const chance = player.chance_of_playing_this_round;
  if (chance != null && chance < 75) {
    reasons.push(`Flagged - ${chance}% chance of playing next match`);
  } else if (avgMinutes != null) {
    if (avgMinutes >= 75) { score += 2; reasons.push('Nailed on for minutes recently'); }
    else if (avgMinutes >= 60) { score += 1; reasons.push('Usually starts, occasional early sub'); }
    else { reasons.push('Rotation risk - minutes have been inconsistent'); }
  }

  // Set-piece involvement as a genuine positive, not decoration
  const isSetPieceTaker = player.penalties_order === 1 ||
    player.direct_freekicks_order === 1 ||
    player.corners_and_indirect_freekicks_order === 1;
  if (isSetPieceTaker) {
    score += 1;
    reasons.push('Primary set-piece taker - extra route to points');
  }

  let tier;
  if (score >= 5) tier = 'Keep';
  else if (score >= 3) tier = 'Monitor';
  else tier = 'Sell';

  return { tier, reasons, score, avgFdr, avgMinutes, isSetPieceTaker, form };
}

/**
 * Suggests a captain from the squad's starting XI, weighing fixture
 * quality, home advantage, set-piece involvement, and current form -
 * the checklist approach rather than just picking the most expensive
 * player.
 */
export function getCaptainSuggestion(picksData, bootstrap, fixtures, outlooksByPlayerId) {
  const starters = picksData.picks.filter((p) => p.position <= 11);

  let best = null;
  let bestScore = -Infinity;

  for (const pick of starters) {
    const player = bootstrap.elements.find((p) => p.id === pick.element);
    const outlook = outlooksByPlayerId.get(pick.element);
    const next = getNextFixture(player.team, fixtures);
    if (!next) continue;

    const form = parseFloat(player.form || 0);
    const fixtureBonus = next.fixture.team_h_difficulty && next.fixture.team_a_difficulty
      ? (6 - (next.isHome ? next.fixture.team_h_difficulty : next.fixture.team_a_difficulty))
      : 0;
    const homeBonus = next.isHome ? 1 : 0;
    const setPieceBonus = outlook && outlook.isSetPieceTaker ? 1.5 : 0;

    const captainScore = form * 0.4 + fixtureBonus * 0.8 + homeBonus + setPieceBonus;

    if (captainScore > bestScore) {
      bestScore = captainScore;
      best = { player, next, form, isSetPieceTaker: outlook ? outlook.isSetPieceTaker : false };
    }
  }

  return best;
}


/**
 * Returns fixtures across the next N upcoming gameweeks (default 3),
 * starting from whichever gameweek hasn't started yet. Used for a
 * forward-looking fixtures view, separate from "this gameweek"'s
 * live/finished scores.
 */
export function getUpcomingGameweeksFixtures(bootstrap, fixtures, numGameweeks = 3) {
  const nextEvent = bootstrap.events.find((e) => e.is_next) ||
    bootstrap.events.find((e) => !e.finished);
  if (!nextEvent) return [];

  const startId = nextEvent.id;
  const endId = startId + numGameweeks - 1;

  return fixtures
    .filter((f) => f.event != null && f.event >= startId && f.event <= endId)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
}

// ---------------------------------------------------------------------
// Set-piece takers
// ---------------------------------------------------------------------

/**
 * Builds a set-piece taker list per team directly from player data
 * (penalties_order, direct_freekicks_order, corners_and_indirect_freekicks_order).
 * This is more reliable early in the season than the notes endpoint, which
 * is often unpopulated until injuries/rotation force an update.
 *
 * Returns a Map<teamId, { penalties: [...players sorted by order], freeKicks: [...], corners: [...] }>
 */
export function getSetPieceTakersFromPlayerData(bootstrap) {
  const takersByTeam = new Map();

  for (const team of bootstrap.teams) {
    takersByTeam.set(team.id, { penalties: [], freeKicks: [], corners: [] });
  }

  for (const player of bootstrap.elements) {
    const entry = takersByTeam.get(player.team);
    if (!entry) continue;

    if (player.penalties_order != null) {
      entry.penalties.push({ player, order: player.penalties_order });
    }
    if (player.direct_freekicks_order != null) {
      entry.freeKicks.push({ player, order: player.direct_freekicks_order });
    }
    if (player.corners_and_indirect_freekicks_order != null) {
      entry.corners.push({ player, order: player.corners_and_indirect_freekicks_order });
    }
  }

  for (const entry of takersByTeam.values()) {
    entry.penalties.sort((a, b) => a.order - b.order);
    entry.freeKicks.sort((a, b) => a.order - b.order);
    entry.corners.sort((a, b) => a.order - b.order);
  }

  return takersByTeam;
}

// ---------------------------------------------------------------------
// Team recent form (used for both fixture difficulty and clean sheets)
// ---------------------------------------------------------------------

/**
 * Returns a team's last N finished fixtures, most recent first.
 */
function getRecentFinishedFixtures(teamId, fixtures, n = 5) {
  return fixtures
    .filter((f) => f.finished && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => new Date(b.kickoff_time) - new Date(a.kickoff_time))
    .slice(0, n);
}

/**
 * Computes a team's recent scoring and defensive form over their last N
 * finished matches. Returns goals scored/conceded per game and clean
 * sheet count, plus how many matches the calculation is actually based on
 * (important early in the season when 5 games may not exist yet).
 */
export function getTeamRecentForm(teamId, fixtures, n = 5) {
  const recent = getRecentFinishedFixtures(teamId, fixtures, n);

  let goalsScored = 0;
  let goalsConceded = 0;
  let cleanSheets = 0;

  for (const fixture of recent) {
    const isHome = fixture.team_h === teamId;
    const scored = isHome ? fixture.team_h_score : fixture.team_a_score;
    const conceded = isHome ? fixture.team_a_score : fixture.team_h_score;

    goalsScored += scored ?? 0;
    goalsConceded += conceded ?? 0;
    if (conceded === 0) cleanSheets += 1;
  }

  const gamesPlayed = recent.length;

  return {
    gamesConsidered: gamesPlayed,
    avgGoalsScored: gamesPlayed ? goalsScored / gamesPlayed : null,
    avgGoalsConceded: gamesPlayed ? goalsConceded / gamesPlayed : null,
    cleanSheets,
    isSmallSample: gamesPlayed < n,
  };
}

/**
 * Finds a team's next unplayed fixture, along with the opponent's ID and
 * whether the team is playing at home.
 */
export function getNextFixture(teamId, fixtures) {
  const upcoming = fixtures
    .filter((f) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  if (upcoming.length === 0) return null;

  const fixture = upcoming[0];
  const isHome = fixture.team_h === teamId;
  const opponentId = isHome ? fixture.team_a : fixture.team_h;

  return { fixture, isHome, opponentId };
}

/**
 * Returns a team's next N upcoming fixtures with FPL's own difficulty
 * rating (1 = easiest, 5 = hardest) from that team's point of view.
 * Used for the fixture difficulty ticker.
 */
export function getUpcomingFixturesWithDifficulty(teamId, fixtures, n = 5) {
  return fixtures
    .filter((f) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
    .slice(0, n)
    .map((f) => {
      const isHome = f.team_h === teamId;
      return {
        opponentId: isHome ? f.team_a : f.team_h,
        difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
        isHome,
      };
    });
}

// ---------------------------------------------------------------------
// Defender clean sheet likelihood
// ---------------------------------------------------------------------

/**
 * Estimates how likely a defender's team is to keep a clean sheet in
 * their next fixture, based on:
 *   - their own team's recent defensive form (last 5 games)
 *   - the opponent's recent attacking form (last 5 games)
 *   - home/away split (defending at home is generally easier)
 *
 * Returns a verdict label rather than a fake-precise percentage, since
 * this is a heuristic, not a statistical model.
 */
export function getCleanSheetLikelihood(teamId, fixtures) {
  const next = getNextFixture(teamId, fixtures);
  if (!next) return null;

  const { opponentId, isHome } = next;

  const ownForm = getTeamRecentForm(teamId, fixtures, 5);
  const opponentForm = getTeamRecentForm(opponentId, fixtures, 5);

  if (ownForm.avgGoalsConceded == null || opponentForm.avgGoalsScored == null) {
    return {
      verdict: 'Not enough data yet',
      ownForm,
      opponentForm,
      isHome,
      opponentId,
    };
  }

  // Simple heuristic score: lower is better for a clean sheet.
  // Blend own defensive concession rate with opponent's scoring rate,
  // and give a small home-advantage adjustment.
  let riskScore = (ownForm.avgGoalsConceded * 0.6) + (opponentForm.avgGoalsScored * 0.4);
  if (isHome) riskScore -= 0.2;

  let verdict;
  if (riskScore <= 0.8) verdict = 'Good chance';
  else if (riskScore <= 1.4) verdict = 'Toss-up';
  else verdict = 'Unlikely';

  return {
    verdict,
    riskScore,
    ownForm,
    opponentForm,
    isHome,
    opponentId,
    isSmallSample: ownForm.isSmallSample || opponentForm.isSmallSample,
  };
}

// ---------------------------------------------------------------------
// Player history against a specific opponent
// ---------------------------------------------------------------------

/**
 * Filters a player's current-season match history down to games played
 * against a specific opponent team, and summarizes goal involvement.
 *
 * Note: element-summary's "history_past" (previous seasons) does NOT
 * include opponent-level detail, only season totals - so this can only
 * cover the current season using the standard FPL API.
 */
export function getHistoryAgainstOpponent(elementSummary, opponentTeamId) {
  const matches = elementSummary.history.filter((gw) => gw.opponent_team === opponentTeamId);

  const totals = matches.reduce(
    (acc, gw) => {
      acc.minutes += gw.minutes;
      acc.goals += gw.goals_scored;
      acc.assists += gw.assists;
      acc.expectedGoalInvolvements += parseFloat(gw.expected_goal_involvements || 0);
      return acc;
    },
    { minutes: 0, goals: 0, assists: 0, expectedGoalInvolvements: 0 }
  );

  return {
    matches,
    matchCount: matches.length,
    totals,
    isSmallSample: matches.length < 2 || totals.minutes < 90,
  };
}

/**
 * Combines opponent history, recent form, and opponent defensive strength
 * into a plain-language verdict on whether a player is worth selecting
 * for their next fixture.
 */
export function getSelectionVerdict(player, elementSummary, bootstrap, fixtures) {
  const next = getNextFixture(player.team, fixtures);
  if (!next) {
    return { verdict: 'No upcoming fixture found', details: null };
  }

  const opponentHistory = getHistoryAgainstOpponent(elementSummary, next.opponentId);
  const opponentTeam = bootstrap.teams.find((t) => t.id === next.opponentId);
  const opponentForm = getTeamRecentForm(next.opponentId, fixtures, 5);

  if (opponentHistory.isSmallSample) {
    return {
      verdict: 'Insufficient history vs this opponent yet',
      opponentHistory,
      opponentTeam,
      opponentForm,
      isHome: next.isHome,
    };
  }

  // Rough weighted score: recent form (via player's own current form stat),
  // history vs this specific opponent, and opponent's defensive weakness.
  const currentForm = parseFloat(player.form || 0);
  const involvementRate90 = (opponentHistory.totals.expectedGoalInvolvements /
    (opponentHistory.totals.minutes / 90)) || 0;
  const opponentWeakness = opponentForm.avgGoalsConceded ?? 1;

  const score = (currentForm * 0.4) + (involvementRate90 * 10 * 0.35) + (opponentWeakness * 0.25);

  let verdict;
  if (score >= 3) verdict = 'Strong pick';
  else if (score >= 1.5) verdict = 'Reasonable pick';
  else verdict = 'Risky pick';

  return {
    verdict,
    score,
    opponentHistory,
    opponentTeam,
    opponentForm,
    isHome: next.isHome,
  };
}