// Netlify serverless function — runs on Netlify's server, not in the visitor's browser.
// Your Finnhub key lives here as an environment variable (set in the Netlify dashboard,
// never written in any file), so it's never sent to anyone who visits the site.
//
// The site's JavaScript calls this function instead of calling Finnhub directly:
//   /.netlify/functions/finnhub?endpoint=quote&symbol=SPCX
//   /.netlify/functions/finnhub?endpoint=profile&symbol=SPCX
//   /.netlify/functions/finnhub?endpoint=peers&symbol=SPCX
//   /.netlify/functions/finnhub?endpoint=news&symbol=SPCX&from=2026-06-24&to=2026-07-24
//   /.netlify/functions/finnhub?endpoint=earnings&symbol=SPCX&from=2026-07-24&to=2026-09-24
//   /.netlify/functions/finnhub?endpoint=insider&symbol=SPCX
//   /.netlify/functions/finnhub?endpoint=fundamentals&symbol=SPCX
// This function then adds the secret key and forwards the request to Finnhub.

const ALLOWED_ENDPOINTS = {
  quote: 'quote',
  profile: 'stock/profile2',
  peers: 'stock/peers',
  news: 'company-news',
  earnings: 'calendar/earnings',
  insider: 'stock/insider-transactions',
  fundamentals: 'stock/metric'
};

// Extra query params each endpoint is allowed to pass through to Finnhub, beyond symbol/token.
const EXTRA_PARAMS = {
  news: ['from', 'to'],
  earnings: ['from', 'to'],
  fundamentals: ['metric']
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'FINNHUB_API_KEY is not set in this site\'s Netlify environment variables.' })
    };
  }

  const params = event.queryStringParameters || {};
  const endpointKey = params.endpoint;
  const endpointPath = ALLOWED_ENDPOINTS[endpointKey];

  if (!endpointPath) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Missing or invalid "endpoint" query parameter.' })
    };
  }

  // The earnings calendar endpoint doesn't require a symbol (it can list all upcoming
  // earnings), everything else does.
  const symbol = params.symbol;
  if (!symbol && endpointKey !== 'earnings') {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Missing "symbol" query parameter.' })
    };
  }

  let targetUrl = `https://finnhub.io/api/v1/${endpointPath}?token=${key}`;
  if (symbol) targetUrl += `&symbol=${encodeURIComponent(symbol)}`;
  const allowedExtras = EXTRA_PARAMS[endpointKey] || [];
  for (const p of allowedExtras) {
    if (params[p]) targetUrl += `&${p}=${encodeURIComponent(params[p])}`;
  }

  try {
    const res = await fetch(targetUrl);
    const data = await res.json();
    return {
      statusCode: res.ok ? 200 : res.status,
      headers: corsHeaders(),
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to reach Finnhub: ' + String(err) })
    };
  }
};
