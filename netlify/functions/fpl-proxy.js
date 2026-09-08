// netlify/functions/fpl-proxy.js
//
// The official FPL API (fantasy.premierleague.com/api/...) does not send
// CORS headers, so a browser fetch() call to it directly will be blocked.
// This function runs on Netlify's servers (not in the browser), fetches
// the real FPL data, and hands it back to your front-end with CORS allowed.
//
// Deployed automatically when you push this repo to Netlify (no extra
// setup needed beyond the file being in netlify/functions/).
//
// Usage from the browser:
//   fetch('/.netlify/functions/fpl-proxy?path=bootstrap-static/')
//   fetch('/.netlify/functions/fpl-proxy?path=fixtures/')
//   fetch('/.netlify/functions/fpl-proxy?path=element-summary/4/')
//   fetch('/.netlify/functions/fpl-proxy?path=team/set-piece-notes/')

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api/';

// Only these path prefixes are allowed through the proxy. This keeps the
// function from being abused as an open proxy to arbitrary URLs.
const ALLOWED_PREFIXES = [
  'bootstrap-static',
  'fixtures',
  'element-summary',
  'team/set-piece-notes',
  'entry',
];

exports.handler = async (event) => {
  const path = event.queryStringParameters && event.queryStringParameters.path;

  if (!path) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing "path" query parameter.' }),
    };
  }

  const isAllowed = ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!isAllowed) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'That FPL API path is not allowed through this proxy.' }),
    };
  }

  try {
    const response = await fetch(FPL_BASE_URL + path);

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `FPL API responded with status ${response.status}` }),
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Cache for 5 minutes at the edge - FPL data doesn't change second to second,
        // and this cuts down on repeat calls to the upstream API.
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to reach the FPL API.', details: err.message }),
    };
  }
};