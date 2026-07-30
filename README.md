# SPCX Mission Board — Project Summary

A live, deployable website tracking SpaceX (SPCX) stock, built collaboratively in Claude chat.

## What's in this package

- **index.html** — the entire website (single file: HTML, CSS, and JS all inline, Chart.js bundled directly into the file so it never depends on an external CDN)
- **netlify/functions/finnhub.js** — a serverless function that holds your Finnhub API key privately on Netlify's server, so it never reaches any visitor's browser
- **netlify.toml** — tells Netlify where to find the function above when deploying
- **live-proxy.py** — an earlier, now-optional local Python proxy (from before the Netlify serverless setup existed). Not needed if you're using the deployed Netlify version with the key set as an environment variable.

## Site features

- Live price chart for SPCX, ticking every ~3 seconds via Finnhub, seeded with real intraday history from Yahoo Finance
- Ticker search — look up any stock (AAPL, TSLA, etc.) and get the same live chart, company profile, and peer comparison
- Live peer comparison (Rocket Lab, Boeing, Lockheed Martin, S&P 500)
- Live news & commentary feed (real headlines/links via Finnhub's news API)
- Daily snapshot — today's move, day range, distance from analyst consensus, countdown to next catalyst
- Patterns & historical context — live-computed RSI/moving-average/volatility readings, cross-referenced against real cited research (e.g., Field & Hanka 2001 on lockup expiration effects)
- Full deep-research briefing embedded as its own section (see below)
- Deep-dive SpaceX research sections: business segments, valuation history timeline, catalysts, analyst views, ownership/insiders, risks, and a buy/sell decision framework (educational, not personalized advice)

## How it's deployed

Hosted for free on **Netlify** via drag-and-drop deploy. The Finnhub API key is stored as an environment variable (`FINNHUB_API_KEY`) in Netlify's site settings — never written into any file — so visitors never see any key-related UI at all; the site just works immediately for anyone who opens the link.

To redeploy after any future changes: extract this folder, select `index.html` + `netlify` + `netlify.toml` together, and drag them onto the Netlify deploy area for your existing site.

## Known open items / things to revisit

- **The written research (all 8 companies' deep-dive sections, plus the standalone research briefing) is a manual-refresh snapshot, current as of July 30, 2026.** Decision made: no daily automation — ask Claude to refresh a specific company's write-up whenever you want current numbers, rather than paying for automated daily regeneration.
- Live data (price, chart, news headlines, peer quotes) already refreshes continuously on its own — only the curated narrative write-ups need manual refresh.
- If priorities change later, daily automation was scoped at ~$5-30/month (lightweight update) up to ~$200-800+/month (full-depth research across all 8 tickers) — see chat history for the full cost breakdown.
- Live data depends on your free Finnhub API key (finnhub.io) — free tier limits: 60 calls/minute, which the site's polling intervals are designed to stay well under.
