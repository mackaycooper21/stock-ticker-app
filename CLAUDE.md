# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page stock-tracking site ("SPCX Mission Board") that started as a SpaceX-only tracker and grew into a live dashboard covering 8 tickers (SPCX, TSLA, AAPL, MSFT, GOOGL, AMZN, META, NVDA). It was built collaboratively in Claude chat and has no build step, package manager, or test suite — it's deployed as static files to Netlify.

## Files

- `index.html` — the entire site: HTML, CSS, and JS all inline in one file (~4400 lines). Chart.js v4.4.4 is bundled directly into a `<script>` tag (line ~28, a single very long minified line) so the site never depends on an external CDN.
- `netlify/functions/finnhub.js` — a Netlify serverless function that holds the Finnhub API key server-side (as the `FINNHUB_API_KEY` env var, never in a file) and proxies whitelisted Finnhub endpoints to the browser.
- `netlify.toml` — publish root `.` and functions dir `netlify/functions`.
- `live-proxy.py` — an old, now-optional local CORS proxy for Yahoo Finance (`http://localhost:8899/proxy?url=...`), from before the Netlify function existed. Not needed for the deployed site; `index.html`'s relay chain still checks for it first if it's running.

There is no `package.json`, no bundler, and no test runner. There is also no git repository initialized in this directory.

## Running it locally

Just open `index.html` in a browser, or serve it with any static server (e.g. `python3 -m http.server`). Some CORS relays (corsproxy.io) only work when served from localhost rather than opened as a `file://` URL.

Optional: `python3 live-proxy.py` runs a local proxy on port 8899 that the page will auto-detect and prefer for Yahoo Finance history calls.

There is no lint/build/test command — changes are verified by opening the page in a browser and checking the console/network tab.

## Deploying

Drag-and-drop `index.html` + `netlify/` + `netlify.toml` onto the Netlify deploy target for the existing site. The Finnhub key must already be set as the `FINNHUB_API_KEY` environment variable in that Netlify site's dashboard — it is never written into any file in this repo.

## Architecture (all inside `index.html`)

**Two data sources, two different access patterns:**
- **Yahoo Finance** (`query1.finance.yahoo.com/v8/finance/chart/...`) — used for seeding intraday chart history. Has no CORS headers, so it's only reachable through a chain of CORS relays (`RELAYS` array): local proxy → r.jina.ai → allorigins.win → codetabs → corsproxy.io. `fetchViaRelays()` races all of them with `Promise.any` and takes whichever responds first.
- **Finnhub** (`finnhub.io/api/v1/...`) — used for live quotes, company profile, peers, news, earnings, insider transactions, and fundamentals. Reached through `finnhubFetch()`, which prefers the Netlify serverless proxy (`detectServerless()` pings it once at startup) and falls back to a direct browser call using a key the visitor pastes into the UI (`key-banner`) or a `HARDCODED_FINNHUB_KEY` constant (left empty in this repo).

**Polling tiers**, all driven from `startup()`:
- `FINNHUB_FAST_POLL_MS` (~3s) for the live price tick, kept under Finnhub's free-tier 60 calls/min.
- `MEDIUM_POLL_MS` (15s) via `scheduleMediumRefresh()`.
- `POLL_MS` (hourly) via `scheduleAutoRefresh()`, used for the Yahoo/relay path and as the slow-path fallback.
- Peers refresh on their own timer via `schedulePeersRefresh()`.

**Multi-ticker deep-dive system:** every company's written research (business segments, valuation timeline, catalysts, analyst views, ownership/risks, buy/sell framework) lives in the same DOM, tagged `data-deepdive="TICKER"`. `switchDeepDive(ticker)` shows/hides those blocks and swaps the hero copy via the `HERO_CONTENT` map. Only tickers in `DD_HAS_CONTENT` (the 8 above) have curated write-ups; anything else falls back to `[data-deepdive-placeholder]` blocks. The curated write-ups are a manual-refresh snapshot (dated in `README.md`) — there's no automated regeneration; refreshing a company's numbers means editing its HTML block directly.

**Client-side "features" that only touch `localStorage`** (namespaced under `spcx_*` via the `LocalStore` wrapper, which no-ops safely if storage is blocked): watchlist, price alerts (browser Notification API, checked by `checkAlerts()`), a paper-trading portfolio (`PAPER_START_CASH`, `executeTrade()`), and a multi-ticker compare chart. None of these hit any backend beyond the same Finnhub/Yahoo calls used elsewhere.

**Ticker search / switching:** `switchTicker(symbol)` re-points the live chart, profile, peers, and news at an arbitrary symbol (not just the 8 curated ones); `resetToSPCX()` restores the default view including the original peers HTML (`DEFAULT_PEERS_HTML`).

## Working in this file

- It's one giant file with no modules — search by section comment (`/* ---------- Name ---------- */` in the `<style>` block, or the `function`/`const` names above) rather than trying to read it linearly. Line 28 (bundled Chart.js) is extremely long; avoid reading it and don't hand-edit it — replace it wholesale if the Chart.js version ever needs bumping.
- Don't add a build step, framework, or package.json unless explicitly asked — the single-file/no-dependency setup is intentional (it's what lets this be deployed by dragging files onto Netlify).
- When adding a new ticker's deep-dive content, follow the existing `data-deepdive="TICKER"` pattern across every section (segments, timeline, catalysts, analysts, ownership, risks, strategy) and add an entry to both `DD_HAS_CONTENT` and `HERO_CONTENT`.
- Nothing in the research/strategy copy should read as personalized financial advice — the existing sections are deliberately framed as educational/factual (see the "How to think about it" and FAQ sections).
