# The Differential

An FPL analytics dashboard - fixture difficulty, differentials, clean
sheet likelihood, set-piece takers, player recommendations, a live
league table, and more, all built on the public FPL API.

This is plain JavaScript (ES modules) - no framework required.

## Why there's a `netlify/functions` folder

The official FPL API (`fantasy.premierleague.com/api/...`) does not send
CORS headers, so calling it directly with `fetch()` from a browser will
fail. `netlify/functions/fpl-proxy.js` is a small serverless function that
runs on Netlify's servers, fetches the real data, and passes it back to
your front end with CORS allowed. When you deploy this repo to Netlify,
the function goes live automatically at `/.netlify/functions/fpl-proxy`.

**If you're testing locally before deploying:** install the Netlify CLI
(`npm install -g netlify-cli`) and run `netlify dev` instead of opening
the HTML file directly - this runs the function locally too.

## Files

- `index.html` - the page structure
- `css/styles.css` - visual design (matchday team-sheet look: hairline rules, one serif numeral as the hero, gold/clay verdict tags)
- `js/app.js` - renders data into the DOM
- `netlify/functions/fpl-proxy.js` - the CORS proxy (see above)
- `js/fpl-data.js` - fetches and analyzes all FPL data

## Running it locally

You need the Netlify CLI so the proxy function actually runs:

```
npm install -g netlify-cli
cd fpl-dashboard
netlify dev
```

This opens the site at a local URL (usually `localhost:8888`) with the
proxy function working exactly as it will in production. Opening
`index.html` directly in a browser will NOT work - the fetch calls will
fail because there's no server running the proxy function.

## What's in `fpl-data.js`

### Fetching
- `getBootstrapData()` - all players, teams, gameweeks
- `getFixtures()` - every match, past and upcoming
- `getElementSummary(playerId)` - one player's per-gameweek history + upcoming fixtures
- `getSetPieceNotes()` - official set-piece notes (often sparse early season)
- `loadDashboardData()` - fetches bootstrap + fixtures + set-piece notes in one call

### Feature functions
| Feature | Function | Notes |
|---|---|---|
| Set-piece takers | `getSetPieceTakersFromPlayerData(bootstrap)` | Uses `penalties_order`/`direct_freekicks_order`/`corners_and_indirect_freekicks_order` from player data - more reliable than the notes endpoint early in the season |
| Fixture difficulty / team form | `getTeamRecentForm(teamId, fixtures, n)` | Goals scored/conceded and clean sheets over last N games |
| Defender clean sheet likelihood | `getCleanSheetLikelihood(teamId, fixtures)` | Blends own defensive form + opponent's attacking form + home/away |
| Opponent-specific history | `getHistoryAgainstOpponent(elementSummary, opponentTeamId)` | Current season only - the API doesn't expose opponent-level detail for past seasons |
| "Worth selecting" verdict | `getSelectionVerdict(player, elementSummary, bootstrap, fixtures)` | Combines form + opponent history + opponent weakness into a plain-language verdict |

## A known limitation worth remembering

`element-summary`'s `history_past` field only gives season-level totals
for previous years - no opponent breakdown. So "goal involvement vs this
opponent" can only be calculated from the *current* season with this API.
Getting multi-season opponent history would require a different data
source (e.g. a community-maintained historical dataset).

## Small-sample handling

Early in the season, "last 5 games" and "history vs this opponent" will
often be based on 1-2 matches. Every relevant function returns an
`isSmallSample` flag - the UI should surface this honestly (e.g. "Building
history..." or "Insufficient data yet") rather than presenting thin data
with false confidence.

## Example usage

```js
import { loadDashboardData, getElementSummary, getSelectionVerdict } from './js/fpl-data.js';

const { bootstrap, fixtures } = await loadDashboardData();

const player = bootstrap.elements.find((p) => p.web_name === 'Saka');
const summary = await getElementSummary(player.id);

const verdict = getSelectionVerdict(player, summary, bootstrap, fixtures);
console.log(verdict.verdict); // e.g. "Strong pick"
```