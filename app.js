  (function(){
    // Safe localStorage wrapper — some browsers/settings block storage (private mode etc.),
    // so every read/write is wrapped to fail quietly rather than break the page.
    const LocalStore = {
      get(key, fallback){
        try{
          const raw = localStorage.getItem('spcx_' + key);
          return raw ? JSON.parse(raw) : fallback;
        }catch(e){ return fallback; }
      },
      set(key, value){
        try{ localStorage.setItem('spcx_' + key, JSON.stringify(value)); return true; }
        catch(e){ return false; }
      }
    };

    let TICKER = 'SPCX';
    const LAST_KNOWN_PRICE = 115.26;
    const LAST_KNOWN_PREV_CLOSE = 123.54;
    const POLL_MS = 60 * 60 * 1000; // hourly — used for Yahoo/relay path and peer quotes
    const FINNHUB_FAST_POLL_MS = 3000; // ~3s — Finnhub free tier allows 60 calls/min, so this stays well under that

    // If this site is deployed on Netlify with a netlify/functions/finnhub.js function
    // and a FINNHUB_API_KEY environment variable set, this proxy is used automatically
    // and no key ever needs to touch the visitor's browser. See netlify.toml.
    const SERVERLESS_ENDPOINT = '/.netlify/functions/finnhub';
    let serverlessAvailable = false; // detected once at startup, see detectServerless()

    // Optional local fallback: paste a Finnhub key here so the page connects automatically
    // when opened as a plain local file (where the serverless proxy above can't run).
    // Get a free key at finnhub.io/register. Left blank here on purpose — once deployed
    // to Netlify with FINNHUB_API_KEY set there, the site connects with no key needed at all.
    const HARDCODED_FINNHUB_KEY = '';

    // Keyless CORS relays, raced in parallel — no account/signup needed for any of them.
    // Free public relays go down or get locked to specific tiers without warning,
    // so several independent ones are tried at once; whichever answers first wins.
    function extractJson(text){
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('no JSON found in relay response');
      return JSON.parse(text.slice(start, end + 1));
    }

    const RELAYS = [
      // Local proxy (see live-proxy.py) — if you're running it, this wins every time
      // since it's on your own machine and doesn't depend on any public service.
      async (url, signal) => {
        const res = await fetch(`http://localhost:8899/proxy?url=${encodeURIComponent(url)}`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error('local proxy http ' + res.status);
        return res.json();
      },
      // r.jina.ai: free text-proxy/reader, works well for raw JSON endpoints, no key.
      async (url, signal) => {
        const res = await fetch(`https://r.jina.ai/${url}`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error('jina http ' + res.status);
        return extractJson(await res.text());
      },
      // allorigins: free JSON-passthrough proxy, no key.
      async (url, signal) => {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error('allorigins http ' + res.status);
        return res.json();
      },
      // codetabs: free generic proxy, no key.
      async (url, signal) => {
        const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error('codetabs http ' + res.status);
        return res.json();
      },
      // corsproxy.io: free for localhost/dev use — works if you serve this file from
      // a local dev server (e.g. `python3 -m http.server`) instead of opening it directly.
      async (url, signal) => {
        const res = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, { cache: 'no-store', signal });
        if (!res.ok) throw new Error('corsproxy http ' + res.status);
        return res.json();
      }
    ];

    const statusTag   = document.getElementById('chart-status-tag');
    const liveDot     = document.getElementById('live-dot');
    const livePriceEl = document.getElementById('live-price');
    const liveChangeEl= document.getElementById('live-change');
    const updatedEl   = document.getElementById('chart-updated');
    const sourceEl    = document.getElementById('chart-source');
    const canvas      = document.getElementById('priceChart');
    const peersGrid   = document.getElementById('peers-grid');
    const DEFAULT_PEERS_HTML = peersGrid.innerHTML; // saved so "Back to SPCX" can restore the curated set
    function getPeerCards(){ return peersGrid.querySelectorAll('.peer-card'); }
    const peersStatus = document.getElementById('peers-status');
    const keyBanner   = document.getElementById('key-banner');
    const keyInput    = document.getElementById('finnhub-key-input');
    const keySaveBtn  = document.getElementById('finnhub-key-save');
    const rangeButtonsWrap = document.getElementById('range-buttons');
    const chartNoteEl = document.getElementById('chart-note');

    let chart = null;
    let currentRange = '1d';
    let currentInterval = '15m';
    let pollTimer = null;
    let finnhubKey = HARDCODED_FINNHUB_KEY || '';
    let finnhubSessions = {}; // symbol -> array of {t, price, prevClose}, builds up while the tab stays open

    function fmtTime(ts, range){
      const d = new Date(ts * 1000);
      if (range === '1d' || range === '5d'){
        return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      }
      return d.toLocaleDateString([], {month:'short', day:'numeric'});
    }

    function yahooUrl(symbol, range, interval){
      return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=true`;
    }

    async function fetchViaRelays(targetUrl){
      const attempts = RELAYS.map(relay => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 9000);
        return relay(targetUrl, controller.signal).finally(() => clearTimeout(timeout));
      });
      // Race all relays — whichever answers first wins. Promise.any needs at least one to succeed.
      try{
        return await Promise.any(attempts);
      }catch(aggregate){
        throw new Error('all relays failed');
      }
    }

    // Tries the secure server-side proxy first (if this site is deployed on Netlify
    // with a key set there); falls back to a direct client-side call using a locally
    // pasted/hardcoded key. Used by every Finnhub-backed call below.
    const FINNHUB_ENDPOINT_PATHS = {
      quote: 'quote',
      profile: 'stock/profile2',
      peers: 'stock/peers',
      news: 'company-news',
      earnings: 'calendar/earnings',
      insider: 'stock/insider-transactions',
      fundamentals: 'stock/metric'
    };

    async function finnhubFetch(endpoint, symbol, extraParams){
      const extra = extraParams ? '&' + new URLSearchParams(extraParams).toString() : '';
      if (serverlessAvailable){
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try{
          const res = await fetch(`${SERVERLESS_ENDPOINT}?endpoint=${endpoint}&symbol=${encodeURIComponent(symbol||'')}${extra}`, { cache: 'no-store', signal: controller.signal });
          if (!res.ok) throw new Error('proxy http ' + res.status);
          return await res.json();
        } finally { clearTimeout(timeout); }
      }
      if (!finnhubKey) throw new Error('no Finnhub key available (proxy unavailable and no local key set)');
      const path = FINNHUB_ENDPOINT_PATHS[endpoint] || 'quote';
      const symbolPart = symbol ? `&symbol=${encodeURIComponent(symbol)}` : '';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try{
        const res = await fetch(`https://finnhub.io/api/v1/${path}?token=${finnhubKey}${symbolPart}${extra}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error('finnhub http ' + res.status);
        return await res.json();
      } finally { clearTimeout(timeout); }
    }

    async function detectServerless(){
      try{
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(`${SERVERLESS_ENDPOINT}?endpoint=quote&symbol=SPCX`, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return false;
        const d = await res.json();
        serverlessAvailable = typeof d.c === 'number';
      }catch(err){
        serverlessAvailable = false;
      }
      return serverlessAvailable;
    }

    // Finnhub: direct browser call (or via the secure server proxy above) —
    // most reliable option on locked-down networks either way, since there's
    // no third-party CORS relay in the middle to block.
    async function fetchFinnhubQuote(symbol){
      const q = await finnhubFetch('quote', symbol);
      if (typeof q.c !== 'number' || q.c === 0) throw new Error('finnhub returned no data (check your key or the ticker)');
      return { price: q.c, prevClose: q.pc || LAST_KNOWN_PREV_CLOSE, dayHigh: q.h, dayLow: q.l, openPrice: q.o };
    }

    // ---------- Daily snapshot: factual stat deltas, never a buy/sell verdict ----------
    const SPCX_AVG_ANALYST_TARGET = 240; // researched consensus figure, SPCX only — see Analyst views section
    const KNOWN_CATALYSTS = [
      { label: 'First earnings report', date: '2026-08-04' },
      { label: 'Insider lockup unlock', date: '2026-08-06' }
    ];

    function daysUntil(dateStr){
      const target = new Date(dateStr + 'T00:00:00');
      const now = new Date();
      const diffMs = target - new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return Math.round(diffMs / 86400000);
    }

    function nextCatalyst(){
      const upcoming = KNOWN_CATALYSTS.map(c => ({...c, days: daysUntil(c.date)})).filter(c => c.days >= 0);
      upcoming.sort((a,b) => a.days - b.days);
      return upcoming[0] || null;
    }

    function renderSnapshot(q){
      const change = q.price - q.prevClose;
      const pct = (change / q.prevClose) * 100;
      const changeEl = document.getElementById('snap-change');
      const changeSubEl = document.getElementById('snap-change-sub');
      changeEl.textContent = (change >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
      changeEl.className = 'v ' + (change >= 0 ? 'up' : 'down');
      changeSubEl.textContent = (change >= 0 ? '+' : '') + '$' + change.toFixed(2) + ' vs. previous close ($' + q.prevClose.toFixed(2) + ')';

      const rangeEl = document.getElementById('snap-range');
      rangeEl.textContent = (typeof q.dayLow === 'number' && typeof q.dayHigh === 'number' && q.dayLow > 0)
        ? '$' + q.dayLow.toFixed(2) + ' – $' + q.dayHigh.toFixed(2)
        : '—';

      const targetCard = document.getElementById('snap-target').closest('.snap-card');
      if (TICKER === 'SPCX'){
        const diffPct = ((q.price - SPCX_AVG_ANALYST_TARGET) / SPCX_AVG_ANALYST_TARGET) * 100;
        document.getElementById('snap-target').textContent = (diffPct <= 0 ? '' : '+') + diffPct.toFixed(1) + '%';
        document.getElementById('snap-target').className = 'v ' + (diffPct <= 0 ? 'down' : 'up');
        document.getElementById('snap-target-sub').textContent = diffPct <= 0
          ? 'Below the ~$' + SPCX_AVG_ANALYST_TARGET + ' researched consensus target'
          : 'Above the ~$' + SPCX_AVG_ANALYST_TARGET + ' researched consensus target';
        targetCard.style.display = '';
      } else {
        targetCard.style.display = 'none';
      }

      const cat = nextCatalyst();
      if (cat){
        document.getElementById('snap-catalyst').textContent = cat.days === 0 ? 'Today' : cat.days + ' day' + (cat.days===1?'':'s');
        document.getElementById('snap-catalyst-sub').textContent = cat.label + ' — ' + new Date(cat.date+'T00:00:00').toLocaleDateString([], {month:'long', day:'numeric', year:'numeric'});
      } else {
        document.getElementById('snap-catalyst').textContent = '—';
        document.getElementById('snap-catalyst-sub').textContent = 'No further known dates tracked';
      }
    }

    async function updateSnapshot(symbol){
      try{
        const q = await fetchFinnhubQuote(symbol);
        renderSnapshot(q);
        document.getElementById('snapshot-status').textContent = 'Live · updated ' + new Date().toLocaleTimeString();
      }catch(err){
        document.getElementById('snapshot-status').textContent = 'Unavailable this cycle';
      }
    }

    async function fetchQuoteSeriesFinnhub(symbol){
      const q = await fetchFinnhubQuote(symbol);
      if (!finnhubSessions[symbol]) finnhubSessions[symbol] = [];
      const points = finnhubSessions[symbol];
      points.push({ t: Date.now()/1000, price: q.price, prevClose: q.prevClose });
      if (points.length > 2000) points.shift(); // holds a full day of seeded history plus hours of live ticks
      return {
        labels: points.map(p => new Date(p.t*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})),
        prices: points.map(p => p.price),
        last: q.price,
        prevClose: q.prevClose,
        dayHigh: q.dayHigh,
        dayLow: q.dayLow,
        openPrice: q.openPrice,
        live: true
      };
    }

    // Seeds today's real intraday history from Yahoo (via relay/proxy) once, so the
    // Finnhub live-ticking session doesn't start from a blank/near-empty chart.
    // This is a best-effort, one-time call — if it fails, live ticking still works fine,
    // it just starts from whatever moment you connected instead of from market open.
    // Seeds today's real intraday history from Yahoo (via relay/proxy) once per symbol,
    // so the Finnhub live-ticking session doesn't start from a blank/near-empty chart.
    // This is a best-effort, one-time-per-symbol call — if it fails, live ticking still
    // works fine, it just starts from whatever moment you connected instead of market open.
    let seededSymbols = new Set();
    let volumeData = {}; // symbol -> {labels, volumes}
    async function seedHistoryFromYahoo(symbol){
      if (seededSymbols.has(symbol)) return;
      seededSymbols.add(symbol); // only ever try once per symbol per page load, even if it fails
      try{
        const json = await fetchViaRelays(yahooUrl(symbol, '1d', '15m'));
        const result = json && json.chart && json.chart.result && json.chart.result[0];
        if (!result) return;
        const ts = result.timestamp || [];
        const quote0 = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
        const closes = quote0.close || [];
        const volumes = quote0.volume || [];
        const meta = result.meta || {};
        const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? LAST_KNOWN_PREV_CLOSE;
        const seeded = ts.map((t,i)=>({ t, price: closes[i], prevClose }))
          .filter(p => typeof p.price === 'number');
        if (seeded.length){
          finnhubSessions[symbol] = seeded; // live Finnhub points get appended onto the end of this
        }
        const volPoints = ts.map((t,i)=>({ t, vol: volumes[i] })).filter(p => typeof p.vol === 'number');
        if (volPoints.length){
          volumeData[symbol] = {
            labels: volPoints.map(p => new Date(p.t*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})),
            volumes: volPoints.map(p => p.vol)
          };
          if (symbol === TICKER) renderVolumeChart(volumeData[symbol]);
        }
      }catch(err){
        // No history today — that's fine, the live session just starts from now.
      }
    }

    async function fetchQuoteSeries(symbol, range, interval){
      if (finnhubKey || serverlessAvailable){
        return fetchQuoteSeriesFinnhub(symbol);
      }
      const json = await fetchViaRelays(yahooUrl(symbol, range, interval));
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      if (!result) throw new Error('no result in payload');
      const ts = result.timestamp || [];
      const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
      const meta = result.meta || {};
      const pts = ts.map((t,i)=>({t, c: closes[i]})).filter(p => typeof p.c === 'number');
      if (pts.length < 2) throw new Error('not enough points');
      return {
        labels: pts.map(p => fmtTime(p.t, range)),
        prices: pts.map(p => p.c),
        last: meta.regularMarketPrice ?? pts[pts.length-1].c,
        prevClose: meta.chartPreviousClose ?? meta.previousClose ?? pts[0].c,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        weekHigh: meta.fiftyTwoWeekHigh,
        weekLow: meta.fiftyTwoWeekLow,
        openPrice: meta.regularMarketOpen,
        exchangeName: meta.fullExchangeName || meta.exchangeName,
        live: true
      };
    }

    function simulateData(range){
      const n = range === '1d' ? 26 : range === '5d' ? 30 : 30;
      let price = LAST_KNOWN_PRICE;
      const prices = [];
      for (let i=0;i<n;i++){
        price += (Math.random()-0.5) * (LAST_KNOWN_PRICE * 0.006);
        prices.push(Number(price.toFixed(2)));
      }
      const now = Date.now()/1000;
      const stepSec = range === '1d' ? 900 : range === '5d' ? 3600 : 86400;
      const labels = prices.map((_,i)=> fmtTime(now - (n-1-i)*stepSec, range));
      return { labels, prices, last: prices[prices.length-1], prevClose: LAST_KNOWN_PREV_CLOSE, live: false };
    }

    let lastTickPrice = null;

    // ---------- Live technical calculations, from the actual price series being charted ----------
    function calcRSI(prices, period){
      period = period || 14;
      if (prices.length < period + 1) return null;
      const recent = prices.slice(-(period + 1));
      let gains = 0, losses = 0;
      for (let i = 1; i < recent.length; i++){
        const diff = recent[i] - recent[i-1];
        if (diff >= 0) gains += diff; else losses += Math.abs(diff);
      }
      const avgGain = gains / period, avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    function calcSMA(prices, period){
      period = period || 20;
      if (prices.length < period) period = prices.length;
      if (period === 0) return null;
      const slice = prices.slice(-period);
      return slice.reduce((a,b) => a+b, 0) / slice.length;
    }

    function calcVolatility(prices){
      if (prices.length < 3) return null;
      const returns = [];
      for (let i = 1; i < prices.length; i++){
        returns.push((prices[i] - prices[i-1]) / prices[i-1]);
      }
      const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
      const variance = returns.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / returns.length;
      return Math.sqrt(variance) * 100; // as a percentage
    }

    function calcEMASeries(prices, period){
      if (prices.length < period) return null;
      const k = 2 / (period + 1);
      let ema = prices.slice(0, period).reduce((a,b)=>a+b,0) / period;
      const series = new Array(period - 1).fill(null).concat([ema]);
      for (let i = period; i < prices.length; i++){
        ema = prices[i] * k + ema * (1 - k);
        series.push(ema);
      }
      return series; // same length as prices, leading nulls before it has enough data
    }

    function calcMACD(prices){
      if (prices.length < 26 + 9) return null; // need enough for signal line too
      const ema12 = calcEMASeries(prices, 12);
      const ema26 = calcEMASeries(prices, 26);
      const macdLine = prices.map((_, i) => (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null);
      const macdValues = macdLine.filter(v => v !== null);
      if (macdValues.length < 9) return null;
      const signalSeries = calcEMASeries(macdValues, 9);
      const signal = signalSeries[signalSeries.length - 1];
      const macd = macdValues[macdValues.length - 1];
      return { macd, signal, histogram: macd - signal };
    }

    function calcBollinger(prices, period, mult){
      period = period || 20; mult = mult || 2;
      if (prices.length < period) return null;
      const slice = prices.slice(-period);
      const mean = slice.reduce((a,b)=>a+b,0) / period;
      const variance = slice.reduce((a,b)=> a + Math.pow(b - mean, 2), 0) / period;
      const stdev = Math.sqrt(variance);
      return { upper: mean + mult*stdev, lower: mean - mult*stdev, mid: mean };
    }

    let volumeChart = null;
    function renderVolumeChart(data){
      if (!data || !data.volumes || !data.volumes.length || typeof Chart === 'undefined') return;
      const canvas = document.getElementById('volumeChart');
      if (!canvas) return;
      const cfg = {
        type: 'bar',
        data: {
          labels: data.labels,
          datasets: [{ data: data.volumes, backgroundColor: 'rgba(77,159,255,0.5)', borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display:false }, tooltip: {
            backgroundColor: '#141a24', bodyColor: '#e7eaf0', titleColor: '#8a94a6',
            bodyFont: { family: 'JetBrains Mono' }, titleFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: { label: ctx => ctx.parsed.y.toLocaleString() + ' shares' }
          }},
          scales: {
            x: { grid: { display:false }, ticks: { color:'#55606f', font:{family:'JetBrains Mono', size:9}, maxTicksLimit:6 } },
            y: { grid: { color:'#1a202b' }, ticks: { color:'#55606f', font:{family:'JetBrains Mono', size:9}, callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v } }
          }
        }
      };
      if (volumeChart){
        volumeChart.data.labels = data.labels;
        volumeChart.data.datasets[0].data = data.volumes;
        volumeChart.update('none');
      } else {
        volumeChart = new Chart(canvas.getContext('2d'), cfg);
      }
    }

    function renderPatterns(prices){
      const rsiEl = document.getElementById('pat-rsi');
      const rsiSubEl = document.getElementById('pat-rsi-sub');
      const rsi = calcRSI(prices, 14);
      if (rsi === null){
        rsiEl.textContent = '—';
        rsiSubEl.textContent = 'Need at least 15 data points — still building up';
      } else {
        rsiEl.textContent = rsi.toFixed(1);
        rsiEl.className = 'v' + (rsi < 30 ? ' oversold' : rsi > 70 ? ' overbought' : '');
        rsiSubEl.textContent = rsi < 30 ? 'Oversold territory (below 30)' : rsi > 70 ? 'Overbought territory (above 70)' : 'Neutral range (30–70)';
      }

      const smaEl = document.getElementById('pat-sma');
      const smaSubEl = document.getElementById('pat-sma-sub');
      const sma = calcSMA(prices, 20);
      if (sma === null || !prices.length){
        smaEl.textContent = '—';
        smaSubEl.textContent = 'Not enough data yet';
      } else {
        const last = prices[prices.length-1];
        const diffPct = ((last - sma) / sma) * 100;
        smaEl.textContent = (diffPct >= 0 ? '+' : '') + diffPct.toFixed(2) + '%';
        smaEl.className = 'v' + (diffPct <= -5 ? ' oversold' : diffPct >= 5 ? ' overbought' : '');
        smaSubEl.textContent = '20-period avg: $' + sma.toFixed(2) + ' · price is ' + (diffPct >= 0 ? 'above' : 'below') + ' it';
      }

      const volEl = document.getElementById('pat-vol');
      const volSubEl = document.getElementById('pat-vol-sub');
      const vol = calcVolatility(prices);
      if (vol === null){
        volEl.textContent = '—';
      } else {
        volEl.textContent = vol.toFixed(2) + '%';
        volSubEl.textContent = vol > 1.5 ? 'Elevated — larger swings between data points than typical' : 'Standard deviation of recent price changes';
      }

      const macdEl = document.getElementById('pat-macd');
      const macdSubEl = document.getElementById('pat-macd-sub');
      const macd = calcMACD(prices);
      if (!macd){
        macdEl.textContent = '—';
        macdSubEl.textContent = 'Need at least 35 data points — still building up';
      } else {
        macdEl.textContent = macd.histogram.toFixed(3);
        macdEl.className = 'v' + (macd.histogram > 0 ? ' overbought' : ' oversold');
        macdSubEl.textContent = macd.histogram > 0 ? 'MACD above signal line (bullish momentum)' : 'MACD below signal line (bearish momentum)';
      }

      const bbEl = document.getElementById('pat-bb');
      const bbSubEl = document.getElementById('pat-bb-sub');
      const bb = calcBollinger(prices, 20, 2);
      if (!bb || !prices.length){
        bbEl.textContent = '—';
      } else {
        const last = prices[prices.length-1];
        const pctB = (last - bb.lower) / (bb.upper - bb.lower) * 100;
        bbEl.textContent = pctB.toFixed(0) + '% of band';
        bbEl.className = 'v' + (pctB <= 10 ? ' oversold' : pctB >= 90 ? ' overbought' : '');
        bbSubEl.textContent = 'Band: $' + bb.lower.toFixed(2) + ' – $' + bb.upper.toFixed(2) + (pctB <= 10 ? ' · near lower band' : pctB >= 90 ? ' · near upper band' : ' · mid-range');
      }
    }

    function renderHeroPanel(data){
      const change = data.last - data.prevClose;
      const pct = (change / data.prevClose) * 100;
      const up = change >= 0;

      const priceEl = document.getElementById('hero-price');
      const changeEl = document.getElementById('hero-change');
      if (priceEl) priceEl.textContent = '$' + data.last.toFixed(2);
      if (changeEl){
        changeEl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(change).toFixed(2) + ' (' + (up?'+':'−') + Math.abs(pct).toFixed(2) + '%)';
        changeEl.className = 'price-change ' + (up ? 'up' : 'down');
      }
      const metaEl = document.getElementById('hero-meta');
      if (metaEl) metaEl.textContent = 'Prev. close $' + data.prevClose.toFixed(2) + (data.exchangeName ? ' · ' + data.exchangeName : '');

      const setStat = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = (typeof val === 'number' && !isNaN(val)) ? '$' + val.toFixed(2) : '—'; };
      setStat('hero-open', data.openPrice);
      setStat('hero-dayhigh', data.dayHigh);
      setStat('hero-daylow', data.dayLow);
      setStat('hero-52wlow', data.weekLow);
      setStat('hero-52whigh', data.weekHigh);

      const asOfEl = document.getElementById('hero-asof');
      if (asOfEl){
        const sourceLabel3 = finnhubKey || serverlessAvailable ? 'Finnhub' : 'Yahoo Finance';
        asOfEl.textContent = 'Live via ' + sourceLabel3 + ' · updated ' + new Date().toLocaleTimeString() + ' · always confirm against your broker before trading.';
      }
    }

    function renderChart(data){
      const up = data.last >= data.prevClose;
      const lineColor = up ? '#35d68f' : '#ff4d5e';
      const fillColor = up ? 'rgba(53,214,143,0.12)' : 'rgba(255,77,94,0.12)';

      if (data.prices && data.prices.length) renderPatterns(data.prices);
      if (data.live && typeof data.last === 'number' && typeof data.prevClose === 'number'){
        renderSnapshot({ price: data.last, prevClose: data.prevClose, dayHigh: data.dayHigh, dayLow: data.dayLow });
        renderHeroPanel(data);
        const sourceLabel2 = finnhubKey || serverlessAvailable ? 'Finnhub' : 'Yahoo Finance';
        document.getElementById('snapshot-status').textContent = 'Live (' + sourceLabel2 + ') · updated ' + new Date().toLocaleTimeString();
      }

      if (chart){
        // Update in place instead of destroying/rebuilding — much smoother for frequent ticks.
        chart.data.labels = data.labels;
        chart.data.datasets[0].data = data.prices;
        chart.data.datasets[0].borderColor = lineColor;
        chart.data.datasets[0].backgroundColor = fillColor;
        chart.update('none');
      } else {
        const cfg = {
          type: 'line',
          data: {
            labels: data.labels,
            datasets: [{
              data: data.prices,
              borderColor: lineColor,
              backgroundColor: fillColor,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHoverBackgroundColor: lineColor,
              fill: true,
              tension: 0.25
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#141a24', borderColor: '#34404f', borderWidth: 1,
                titleColor: '#8a94a6', bodyColor: '#e7eaf0',
                bodyFont: { family: 'JetBrains Mono' }, titleFont: { family: 'JetBrains Mono', size: 11 },
                callbacks: { label: ctx => '$' + ctx.parsed.y.toFixed(2) }
              }
            },
            scales: {
              x: { grid: { color: '#1a202b' }, ticks: { color: '#55606f', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 } },
              y: { grid: { color: '#1a202b' }, ticks: { color: '#55606f', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '$' + v } }
            }
          }
        };
        chart = new Chart(canvas.getContext('2d'), cfg);
      }

      const change = data.last - data.prevClose;
      const pct = (change / data.prevClose) * 100;
      livePriceEl.textContent = '$' + data.last.toFixed(2);
      liveChangeEl.textContent = (change >= 0 ? '▲ ' : '▼ ') + Math.abs(change).toFixed(2) + ' (' + Math.abs(pct).toFixed(2) + '%)';
      liveChangeEl.className = 'price-change ' + (change >= 0 ? 'up' : 'down');

      // Flash the price tick-to-tick (separate from the vs-prevClose color above) for a "live" feel.
      if (data.live && lastTickPrice !== null && data.last !== lastTickPrice){
        livePriceEl.classList.remove('tick-up', 'tick-down');
        void livePriceEl.offsetWidth; // restart CSS animation
        livePriceEl.classList.add(data.last > lastTickPrice ? 'tick-up' : 'tick-down');
      }
      if (data.live) lastTickPrice = data.last;

      liveDot.className = 'dot ' + (data.live ? 'live' : data.loading ? 'sim' : 'sim');
      const sourceLabel = finnhubKey ? 'Finnhub' : 'Yahoo Finance';
      statusTag.textContent = TICKER + ' · ' + (data.live ? 'live feed connected (' + sourceLabel + ')' : data.loading ? 'loading live feed…' : 'simulated (feed unavailable)');
      sourceEl.textContent = data.live ? 'Source: ' + sourceLabel + (finnhubKey ? ' real-time quote API' : ' public quote endpoint') : data.loading ? 'Connecting…' : 'Source: simulated — no live connection';
      updatedEl.innerHTML = data.live
        ? 'Last updated ' + new Date().toLocaleTimeString()
        : data.loading
          ? 'Showing last known price while the live feed connects…'
          : '<span class="warn">Live feed unavailable — showing simulated data</span> · retrying next cycle';
    }

    function placeholderData(range){
      const d = simulateData(range);
      d.prices = d.prices.map(() => LAST_KNOWN_PRICE); // flat line, not jittered — this is a placeholder, not a guess
      d.last = LAST_KNOWN_PRICE;
      d.loading = true;
      return d;
    }

    function showFatalError(msg){
      statusTag.textContent = TICKER + ' · error';
      updatedEl.innerHTML = '<span class="warn">' + msg + '</span>';
      sourceEl.textContent = '';
    }

    async function loadAndRenderChart(range, interval, instantPlaceholder){
      if (typeof Chart === 'undefined'){
        showFatalError('Chart library failed to initialize unexpectedly. The rest of the page still works.');
        return;
      }
      try{
        if (instantPlaceholder) renderChart(placeholderData(range));
      }catch(err){
        showFatalError('Placeholder render failed: ' + err.message);
        return;
      }
      try{
        renderChart(await fetchQuoteSeries(TICKER, range, interval));
      }catch(err){
        try{
          renderChart(simulateData(range));
        }catch(err2){
          showFatalError('Chart render failed: ' + err2.message);
        }
      }
    }

    async function loadPeers(){
      let anyLive = false;
      for (const card of getPeerCards()){
        const symbol = card.dataset.symbol;
        const priceEl = card.querySelector('.peer-price');
        const changeEl = card.querySelector('.peer-change');
        try{
          const data = await fetchQuoteSeries(symbol, '1d', '15m');
          const change = data.last - data.prevClose;
          const pct = (change / data.prevClose) * 100;
          priceEl.textContent = '$' + data.last.toFixed(2);
          changeEl.textContent = (change >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
          changeEl.className = 'peer-change ' + (change >= 0 ? 'up' : 'down');
          anyLive = true;
        }catch(err){
          priceEl.textContent = '—';
          changeEl.textContent = 'unavailable';
          changeEl.className = 'peer-change';
        }
      }
      peersStatus.textContent = anyLive ? 'Live peer quotes' : 'Peer quotes unavailable this cycle';
    }

    function scheduleAutoRefresh(){
      if (pollTimer) clearInterval(pollTimer);
      const interval = finnhubKey ? FINNHUB_FAST_POLL_MS : POLL_MS;
      pollTimer = setInterval(() => {
        loadAndRenderChart(currentRange, currentInterval).catch(()=>{});
        if (finnhubKey || serverlessAvailable) updateSnapshot(TICKER).catch(()=>{});
      }, interval);
    }

    // Watchlist/alerts/paper-trading each poll multiple symbols, so they run on a
    // slower cadence than the single main ticker to stay comfortably within the
    // free API rate limit even with several tickers tracked at once.
    const MEDIUM_POLL_MS = 15000; // 15s
    let mediumTimer = null;
    function scheduleMediumRefresh(){
      if (mediumTimer) clearInterval(mediumTimer);
      if (!(finnhubKey || serverlessAvailable)) return;
      mediumTimer = setInterval(() => {
        refreshWatchlistPrices().catch(()=>{});
        checkAlerts().catch(()=>{});
        renderPaperAccount().catch(()=>{});
        refreshCompareChart().catch(()=>{});
      }, MEDIUM_POLL_MS);
    }

    let peersTimer = null;
    function schedulePeersRefresh(){
      if (peersTimer) clearInterval(peersTimer);
      // Peers and news always stay on the slower hourly cycle, even in Finnhub mode —
      // polling several extra endpoints every few seconds isn't worth the rate limit.
      peersTimer = setInterval(() => {
        loadPeers().catch(()=>{});
        if (finnhubKey || serverlessAvailable) loadNews(TICKER).catch(()=>{});
      }, POLL_MS);
    }

    // ================= WATCHLIST =================
    const wlInput = document.getElementById('wl-input');
    const wlAddBtn = document.getElementById('wl-add-btn');
    const wlGrid = document.getElementById('watchlist-grid');
    const wlEmpty = document.getElementById('wl-empty');
    let watchlist = LocalStore.get('watchlist', []);

    function saveWatchlist(){ LocalStore.set('watchlist', watchlist); }

    function renderWatchlistShell(){
      wlGrid.querySelectorAll('.wl-card').forEach(el => el.remove());
      wlEmpty.style.display = watchlist.length ? 'none' : 'block';
      watchlist.forEach(sym => {
        const card = document.createElement('div');
        card.className = 'wl-card';
        card.dataset.symbol = sym;
        card.innerHTML = `
          <button class="wl-remove" data-symbol="${sym}" title="Remove">&times;</button>
          <div class="wl-ticker">${sym}</div>
          <div class="wl-price">$—.—</div>
          <div class="wl-change">—</div>`;
        wlGrid.appendChild(card);
      });
      wlGrid.querySelectorAll('.wl-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          watchlist = watchlist.filter(s => s !== btn.dataset.symbol);
          saveWatchlist();
          renderWatchlistShell();
          refreshWatchlistPrices();
        });
      });
    }

    async function refreshWatchlistPrices(){
      for (const card of wlGrid.querySelectorAll('.wl-card')){
        const sym = card.dataset.symbol;
        try{
          const data = await fetchQuoteSeries(sym, '1d', '15m');
          const change = data.last - data.prevClose;
          const pct = (change / data.prevClose) * 100;
          card.querySelector('.wl-price').textContent = '$' + data.last.toFixed(2);
          const chEl = card.querySelector('.wl-change');
          chEl.textContent = (change >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
          chEl.className = 'wl-change ' + (change >= 0 ? 'up' : 'down');
        }catch(err){
          card.querySelector('.wl-price').textContent = '—';
          card.querySelector('.wl-change').textContent = 'unavailable';
        }
      }
    }

    function addToWatchlist(raw){
      const sym = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9.\^\-]/g, '').slice(0, 10);
      if (!sym || watchlist.includes(sym)) return;
      watchlist.push(sym);
      saveWatchlist();
      wlInput.value = '';
      renderWatchlistShell();
      refreshWatchlistPrices();
    }

    wlAddBtn.addEventListener('click', () => addToWatchlist(wlInput.value));
    wlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addToWatchlist(wlInput.value); });
    renderWatchlistShell();

    // ================= COMPARE CHART =================
    const CHART_COLORS = ['#ff6a3d', '#4d9fff', '#35d68f', '#e0c341', '#c46bff'];
    const compareInput = document.getElementById('compare-input');
    const compareAddBtn = document.getElementById('compare-add-btn');
    const compareChips = document.getElementById('compare-chips');
    let compareSymbols = LocalStore.get('compare', ['SPCX']);
    if (!compareSymbols.length) compareSymbols = ['SPCX'];
    let compareChart = null;

    function saveCompare(){ LocalStore.set('compare', compareSymbols); }

    function renderCompareChips(){
      compareChips.innerHTML = compareSymbols.map((s,i) => `
        <span class="compare-chip" style="border-color:${CHART_COLORS[i % CHART_COLORS.length]}">
          <span style="color:${CHART_COLORS[i % CHART_COLORS.length]}">●</span> ${s}
          ${s !== 'SPCX' ? `<button data-symbol="${s}">&times;</button>` : ''}
        </span>`).join('');
      compareChips.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          compareSymbols = compareSymbols.filter(s => s !== btn.dataset.symbol);
          saveCompare();
          renderCompareChips();
          refreshCompareChart();
        });
      });
    }

    async function refreshCompareChart(){
      if (typeof Chart === 'undefined') return;
      const canvas = document.getElementById('compareChart');
      if (!canvas) return;

      // Fetch all compared tickers in parallel — sequential awaits here were the cause
      // of the slowdown (N tickers took N times as long instead of running together).
      const results = await Promise.allSettled(
        compareSymbols.map(sym => fetchQuoteSeries(sym, '1d', '15m'))
      );

      const datasets = [];
      let labels = [];
      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return; // skip symbols that failed to load
        const data = result.value;
        if (!data.prices || !data.prices.length) return;
        const base = data.prices[0];
        const pctSeries = data.prices.map(p => ((p - base) / base) * 100);
        if (data.labels.length > labels.length) labels = data.labels;
        datasets.push({
          label: compareSymbols[i],
          data: pctSeries,
          borderColor: CHART_COLORS[i % CHART_COLORS.length],
          backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, tension: 0.2
        });
      });

      // Update the existing chart in place instead of destroying/recreating it —
      // destroy+rebuild every refresh cycle was causing the visible "glitch."
      if (compareChart){
        compareChart.data.labels = labels;
        compareChart.data.datasets = datasets;
        compareChart.update('none');
        return;
      }

      const cfg = {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 300 },
          interaction: { intersect:false, mode:'index' },
          plugins: {
            legend: { display:true, labels:{ color:'#8a94a6', font:{family:'JetBrains Mono', size:11} } },
            tooltip: {
              backgroundColor:'#141a24', bodyColor:'#e7eaf0', titleColor:'#8a94a6',
              bodyFont:{family:'JetBrains Mono'}, titleFont:{family:'JetBrains Mono', size:11},
              callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y>=0?'+':'') + ctx.parsed.y.toFixed(2) + '%' }
            }
          },
          scales: {
            x: { grid:{color:'#1a202b'}, ticks:{color:'#55606f', font:{family:'JetBrains Mono', size:10}, maxTicksLimit:8} },
            y: { grid:{color:'#1a202b'}, ticks:{color:'#55606f', font:{family:'JetBrains Mono', size:10}, callback: v => (v>=0?'+':'')+v+'%'} }
          }
        }
      };
      compareChart = new Chart(canvas.getContext('2d'), cfg);
    }

    function addToCompare(raw){
      const sym = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9.\^\-]/g, '').slice(0, 10);
      if (!sym || compareSymbols.includes(sym) || compareSymbols.length >= 5) return;
      compareSymbols.push(sym);
      saveCompare();
      compareInput.value = '';
      renderCompareChips();
      refreshCompareChart();
    }

    compareAddBtn.addEventListener('click', () => addToCompare(compareInput.value));
    compareInput.addEventListener('keydown', e => { if (e.key === 'Enter') addToCompare(compareInput.value); });
    renderCompareChips();

    // ================= PRICE ALERTS =================
    const alertTickerInput = document.getElementById('alert-ticker');
    const alertDirectionSel = document.getElementById('alert-direction');
    const alertPriceInput = document.getElementById('alert-price');
    const alertAddBtn = document.getElementById('alert-add-btn');
    const alertsList = document.getElementById('alerts-list');
    const alertsEmpty = document.getElementById('alerts-empty');
    const alertsPermStatus = document.getElementById('alerts-perm-status');
    let alerts = LocalStore.get('alerts', []); // {id, symbol, direction, price, triggered}

    function saveAlerts(){ LocalStore.set('alerts', alerts); }

    function renderAlerts(){
      alertsList.querySelectorAll('.alert-item').forEach(el => el.remove());
      alertsEmpty.style.display = alerts.length ? 'none' : 'block';
      alerts.forEach(a => {
        const item = document.createElement('div');
        item.className = 'alert-item' + (a.triggered ? ' triggered' : '');
        item.innerHTML = `
          <div>
            <div class="ai-text">${a.symbol} ${a.direction === 'above' ? 'rises above' : 'falls below'} $${a.price.toFixed(2)}</div>
            <div class="ai-status">${a.triggered ? 'Triggered — notification sent' : 'Watching…'}</div>
          </div>
          <button class="ai-remove" data-id="${a.id}">Remove</button>`;
        alertsList.appendChild(item);
      });
      alertsList.querySelectorAll('.ai-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          alerts = alerts.filter(a => String(a.id) !== btn.dataset.id);
          saveAlerts();
          renderAlerts();
        });
      });
    }

    function updateNotifPermStatus(){
      if (!('Notification' in window)){ alertsPermStatus.textContent = 'Notifications not supported'; return; }
      alertsPermStatus.textContent = Notification.permission === 'granted' ? 'Notifications enabled'
        : Notification.permission === 'denied' ? 'Notifications blocked' : 'Will ask on first alert';
    }

    function addAlert(){
      const symbol = (alertTickerInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9.\^\-]/g, '').slice(0, 10);
      const price = parseFloat(alertPriceInput.value);
      if (!symbol || !price || price <= 0) return;
      if ('Notification' in window && Notification.permission === 'default'){
        Notification.requestPermission().then(updateNotifPermStatus);
      }
      alerts.push({ id: Date.now(), symbol, direction: alertDirectionSel.value, price, triggered: false });
      saveAlerts();
      alertTickerInput.value = ''; alertPriceInput.value = '';
      renderAlerts();
    }

    async function checkAlerts(){
      const pending = alerts.filter(a => !a.triggered);
      if (!pending.length) return;
      const symbols = [...new Set(pending.map(a => a.symbol))];
      const prices = {};
      for (const sym of symbols){
        try{ prices[sym] = (await fetchQuoteSeries(sym, '1d', '15m')).last; }catch(e){}
      }
      let changed = false;
      alerts.forEach(a => {
        if (a.triggered || !(a.symbol in prices)) return;
        const p = prices[a.symbol];
        const hit = a.direction === 'above' ? p >= a.price : p <= a.price;
        if (hit){
          a.triggered = true; changed = true;
          if ('Notification' in window && Notification.permission === 'granted'){
            new Notification('SPCX Mission Board alert', {
              body: `${a.symbol} ${a.direction === 'above' ? 'rose above' : 'fell below'} $${a.price.toFixed(2)} — now $${p.toFixed(2)}`
            });
          }
        }
      });
      if (changed){ saveAlerts(); renderAlerts(); }
    }

    alertAddBtn.addEventListener('click', addAlert);
    [alertTickerInput, alertPriceInput].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') addAlert(); }));
    renderAlerts();
    updateNotifPermStatus();

    // ================= PAPER TRADING =================
    const PAPER_START_CASH = 10000;
    let paperAccount = LocalStore.get('paper', { cash: PAPER_START_CASH, holdings: {}, startingCash: PAPER_START_CASH });
    const tradeTicker = document.getElementById('trade-ticker');
    const tradeShares = document.getElementById('trade-shares');
    const tradeBuyBtn = document.getElementById('trade-buy-btn');
    const tradeSellBtn = document.getElementById('trade-sell-btn');
    const tradeResetBtn = document.getElementById('trade-reset-btn');
    const holdingsTbody = document.getElementById('holdings-tbody');

    function savePaper(){ LocalStore.set('paper', paperAccount); }

    async function executeTrade(action){
      const symbol = (tradeTicker.value || '').trim().toUpperCase().replace(/[^A-Z0-9.\^\-]/g, '').slice(0, 10);
      const shares = parseFloat(tradeShares.value);
      if (!symbol || !shares || shares <= 0) return;
      let price;
      try{ price = (await fetchQuoteSeries(symbol, '1d', '15m')).last; }
      catch(err){ alert('Could not get a live price for ' + symbol + ' right now — try again in a moment.'); return; }

      const cost = price * shares;
      if (action === 'buy'){
        if (cost > paperAccount.cash){ alert('Not enough hypothetical cash for that trade.'); return; }
        paperAccount.cash -= cost;
        const h = paperAccount.holdings[symbol] || { shares: 0, avgCost: 0 };
        const totalCost = h.avgCost * h.shares + cost;
        h.shares += shares;
        h.avgCost = totalCost / h.shares;
        paperAccount.holdings[symbol] = h;
      } else {
        const h = paperAccount.holdings[symbol];
        if (!h || h.shares < shares){ alert('You don\'t own that many shares of ' + symbol + '.'); return; }
        h.shares -= shares;
        paperAccount.cash += cost;
        if (h.shares <= 0.0001) delete paperAccount.holdings[symbol];
      }
      savePaper();
      tradeShares.value = '';
      renderPaperAccount();
    }

    async function renderPaperAccount(){
      document.getElementById('paper-cash').textContent = '$' + paperAccount.cash.toFixed(2);
      const symbols = Object.keys(paperAccount.holdings);
      if (!symbols.length){
        holdingsTbody.innerHTML = '<tr><td colspan="6" class="wl-empty">No holdings yet — buy something above.</td></tr>';
        document.getElementById('paper-holdings-value').textContent = '$0.00';
        document.getElementById('paper-total').textContent = '$' + paperAccount.cash.toFixed(2);
        const pnl = paperAccount.cash - paperAccount.startingCash;
        const pnlEl = document.getElementById('paper-pnl');
        pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
        pnlEl.className = 'v ' + (pnl >= 0 ? 'up' : 'down');
        return;
      }
      let holdingsValue = 0;
      const rows = [];
      for (const sym of symbols){
        const h = paperAccount.holdings[sym];
        let price = null;
        try{ price = (await fetchQuoteSeries(sym, '1d', '15m')).last; }catch(e){}
        const value = price ? price * h.shares : null;
        const pnl = price ? (price - h.avgCost) * h.shares : null;
        if (value) holdingsValue += value;
        rows.push(`<tr>
          <td>${sym}</td>
          <td>${h.shares.toFixed(4)}</td>
          <td>$${h.avgCost.toFixed(2)}</td>
          <td>${price ? '$' + price.toFixed(2) : '—'}</td>
          <td>${value ? '$' + value.toFixed(2) : '—'}</td>
          <td class="${pnl >= 0 ? 'up' : 'down'}">${pnl !== null ? (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2) : '—'}</td>
        </tr>`);
      }
      holdingsTbody.innerHTML = rows.join('');
      document.getElementById('paper-holdings-value').textContent = '$' + holdingsValue.toFixed(2);
      const total = paperAccount.cash + holdingsValue;
      document.getElementById('paper-total').textContent = '$' + total.toFixed(2);
      const pnl = total - paperAccount.startingCash;
      const pnlEl = document.getElementById('paper-pnl');
      pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
      pnlEl.className = 'v ' + (pnl >= 0 ? 'up' : 'down');
    }

    tradeBuyBtn.addEventListener('click', () => executeTrade('buy'));
    tradeSellBtn.addEventListener('click', () => executeTrade('sell'));
    tradeResetBtn.addEventListener('click', () => {
      if (!confirm('Reset your paper trading account back to $' + PAPER_START_CASH.toLocaleString() + '? This clears all holdings.')) return;
      paperAccount = { cash: PAPER_START_CASH, holdings: {}, startingCash: PAPER_START_CASH };
      savePaper();
      renderPaperAccount();
    });
    renderPaperAccount();

    function applyFinnhubMode(){
      if (serverlessAvailable){
        keyBanner.style.display = 'none'; // nothing to show or ask visitors for — server handles it silently
      } else {
        keyBanner.style.display = 'flex'; // fallback: local file or non-Netlify hosting, needs a pasted key
      }
      if (finnhubKey || serverlessAvailable){
        rangeButtonsWrap.style.opacity = '0.4';
        rangeButtonsWrap.style.pointerEvents = 'none';
        const via = serverlessAvailable ? 'a secure server-side proxy (your key never reaches this browser)' : 'Finnhub directly';
        chartNoteEl.innerHTML = 'Connected via <b>Finnhub</b> for live ticking (updates every ~3 seconds), through ' + via + '. Today\'s earlier history is loaded once from Yahoo Finance to give the chart context, then Finnhub takes over for live updates going forward (the range buttons above are disabled in this mode, since the chart is always "today plus live"). If the one-time history load fails, the chart still works — it just starts from whenever you connected instead of from market open.';
      } else {
        rangeButtonsWrap.style.opacity = '1';
        rangeButtonsWrap.style.pointerEvents = 'auto';
        chartNoteEl.innerHTML = 'No account or API key needed. This chart fetches quote history client-side, in your browser, from Yahoo Finance\'s public quote endpoint — routed through free, keyless CORS relays (and your local proxy, if it\'s running) since Yahoo doesn\'t allow direct browser calls. It refreshes automatically about once an hour. If all sources are down or you\'re offline, the chart falls back to a clearly-labeled <b>simulated</b> line so it\'s never ambiguous what\'s real. Data is exchange-delayed, not tick-by-tick — confirm against your broker before trading.';
      }
    }

    async function connectFinnhub(){
      updatedEl.textContent = 'Loading today\u2019s history, then connecting live…';
      await seedHistoryFromYahoo(TICKER);
      loadAndRenderChart(currentRange, currentInterval).catch(()=>{});
      loadPeers().catch(()=>{});
      updateSnapshot(TICKER).catch(()=>{});
      scheduleAutoRefresh(); // switch to fast polling now that a key is connected
    }

    // ---------- Ticker search: profile lookup + dynamic peers ----------
    const tickerSearchInput = document.getElementById('ticker-search-input');
    const tickerSearchBtn   = document.getElementById('ticker-search-btn');
    const tickerResetBtn    = document.getElementById('ticker-reset-btn');
    const tickerProfileEl   = document.getElementById('ticker-profile');

    function fmtMarketCap(millions){
      if (!millions || millions <= 0) return null;
      if (millions >= 1e6) return '$' + (millions/1e6).toFixed(2) + 'T';
      if (millions >= 1e3) return '$' + (millions/1e3).toFixed(1) + 'B';
      return '$' + millions.toFixed(0) + 'M';
    }

    async function fetchFinnhubProfile(symbol){
      const p = await finnhubFetch('profile', symbol);
      if (!p || !p.name) throw new Error('no profile data (symbol may not exist)');
      return p;
    }

    async function fetchFinnhubPeers(symbol){
      const arr = await finnhubFetch('peers', symbol);
      return (Array.isArray(arr) ? arr : []).filter(s => s && s.toUpperCase() !== symbol.toUpperCase()).slice(0, 4);
    }

    const newsFeedEl = document.getElementById('news-feed');
    const newsStatusEl = document.getElementById('news-status');

    function fmtNewsDate(unixSeconds){
      const d = new Date(unixSeconds * 1000);
      return d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' · ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }

    async function loadNews(symbol){
      newsStatusEl.textContent = 'Loading…';
      try{
        const to = new Date();
        const from = new Date(to.getTime() - 30*24*60*60*1000); // last 30 days
        const fmt = d => d.toISOString().slice(0,10);
        const articles = await finnhubFetch('news', symbol, { from: fmt(from), to: fmt(to) });
        if (!Array.isArray(articles) || !articles.length){
          newsFeedEl.innerHTML = '<div class="news-feed-item"><div class="nf-title">No recent news found for ' + symbol + '.</div></div>';
          newsStatusEl.textContent = 'No results';
          return;
        }
        const top = articles
          .filter(a => a && a.headline)
          .sort((a,b) => (b.datetime||0) - (a.datetime||0))
          .slice(0, 8);
        newsFeedEl.innerHTML = top.map(a => `
          <a class="news-feed-item" href="${a.url}" target="_blank" rel="noopener noreferrer">
            <div class="nf-meta">${a.source || 'Unknown source'} · ${a.datetime ? fmtNewsDate(a.datetime) : ''}</div>
            <div class="nf-title">${(a.headline || '').replace(/</g,'&lt;')}</div>
            ${a.summary ? `<div class="nf-summary">${a.summary.slice(0,180).replace(/</g,'&lt;')}${a.summary.length>180?'…':''}</div>` : ''}
          </a>`).join('');
        newsStatusEl.textContent = top.length + ' recent articles';
      }catch(err){
        newsFeedEl.innerHTML = '<div class="news-feed-item"><div class="nf-title">News unavailable right now — try again shortly.</div></div>';
        newsStatusEl.textContent = 'Unavailable';
      }
    }

    function renderProfile(p){
      if (!p){ tickerProfileEl.style.display = 'none'; tickerProfileEl.innerHTML = ''; return; }
      const cap = fmtMarketCap(p.marketCapitalization);
      tickerProfileEl.innerHTML = `
        ${p.logo ? `<img src="${p.logo}" alt="">` : ''}
        <div>
          <div class="tp-name">${p.name} <span class="peer-ticker">${p.ticker || TICKER}</span></div>
          <div class="tp-meta">${[p.exchange, p.finnhubIndustry, p.country].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="tp-stats">
          ${cap ? `<div class="tp-stat"><div class="k">Market cap</div><div class="v">${cap}</div></div>` : ''}
          ${p.ipo ? `<div class="tp-stat"><div class="k">IPO date</div><div class="v">${p.ipo}</div></div>` : ''}
          ${p.currency ? `<div class="tp-stat"><div class="k">Currency</div><div class="v">${p.currency}</div></div>` : ''}
        </div>`;
      tickerProfileEl.style.display = 'flex';
    }

    function buildPeerCard(symbol){
      return `<div class="peer-card" data-symbol="${symbol}">
        <div class="peer-name">${symbol} <span class="peer-ticker">${symbol}</span></div>
        <div class="peer-price">$—.—</div>
        <div class="peer-change">—</div>
        <div class="peer-desc">Related ticker, suggested by Finnhub as a peer/comparable company.</div>
      </div>`;
    }

    let tickerSwitchToken = 0; // guards against an older, slower switch overwriting a newer one

    async function switchTicker(rawSymbol){
      const symbol = (rawSymbol || '').trim().toUpperCase().replace(/[^A-Z0-9.\^\-]/g, '').slice(0, 10);
      if (!symbol || symbol === TICKER) return;
      if (!finnhubKey && !serverlessAvailable){
        updatedEl.innerHTML = '<span class="warn">Ticker search needs a free Finnhub key first — paste one in the box above, then try again.</span>';
        return;
      }
      const myToken = ++tickerSwitchToken;

      TICKER = symbol;
      currentRange = '1d'; currentInterval = '15m';
      lastTickPrice = null;
      tickerSearchInput.value = symbol;
      tickerResetBtn.style.display = 'inline-block';
      tickerProfileEl.style.display = 'none';
      updatedEl.textContent = 'Looking up ' + symbol + '…';
      peersGrid.innerHTML = `<div class="peer-card"><div class="peer-name">Loading peers…</div></div>`;
      if (typeof switchDeepDive === 'function') switchDeepDive(symbol);

      // Profile + peers + news (best-effort — a bad/unknown ticker just skips these quietly)
      fetchFinnhubProfile(symbol).then(p => { if (myToken === tickerSwitchToken) renderProfile(p); }).catch(() => { if (myToken === tickerSwitchToken) renderProfile(null); });
      fetchFinnhubPeers(symbol).then(peers => {
        if (myToken !== tickerSwitchToken) return;
        peersGrid.innerHTML = peers.length ? peers.map(buildPeerCard).join('') : '<div class="peer-card"><div class="peer-name">No peers found</div></div>';
        loadPeers().catch(()=>{});
      }).catch(() => { if (myToken === tickerSwitchToken) peersGrid.innerHTML = '<div class="peer-card"><div class="peer-name">Peers unavailable</div></div>'; });
      loadNews(symbol).catch(()=>{});

      await connectFinnhub();
    }

    function resetToSPCX(){
      if (TICKER === 'SPCX') return;
      tickerSwitchToken++; // invalidate any in-flight switch
      TICKER = 'SPCX';
      currentRange = '1d'; currentInterval = '15m';
      lastTickPrice = null;
      tickerSearchInput.value = '';
      tickerResetBtn.style.display = 'none';
      tickerProfileEl.style.display = 'none';
      peersGrid.innerHTML = DEFAULT_PEERS_HTML;
      if (typeof switchDeepDive === 'function') switchDeepDive('SPCX');
      loadNews('SPCX').catch(()=>{});
      connectFinnhub();
    }

    tickerSearchBtn.addEventListener('click', () => switchTicker(tickerSearchInput.value));
    tickerSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchTicker(tickerSearchInput.value); });
    tickerResetBtn.addEventListener('click', resetToSPCX);

    // ================= DEEP-DIVE COMPANY SWITCHER =================
    const DD_HAS_CONTENT = ['SPCX', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA']; // all 8 now have full curated write-ups
    const ddTabsWrap = document.getElementById('dd-tabs');

    const HERO_CONTENT = {
      SPCX: {
        exchange: 'Nasdaq · SPCX · Space Exploration Technologies Corp.',
        h1: 'SpaceX went<br>public. Here\'s what<br>the <span class="accent">stock</span> actually is.',
        sub: 'SpaceX completed the largest IPO in history on June 12, 2026, ending 24 years as a private company. This page is a plain-English breakdown of SPCX — the price, the business behind it, and the risks — before you decide anything.',
        exchangeLabel: 'NASDAQ: SPCX',
        title: 'SPCX Stock — SpaceX Live Price, Research & Risks | Mission Board',
        description: 'Live SPCX price, chart, and plain-English research on SpaceX\'s business, valuation, and risks since its June 2026 Nasdaq IPO.'
      },
      TSLA: {
        exchange: 'Nasdaq · TSLA · Tesla, Inc.',
        h1: 'Tesla is more<br>than cars now.<br>Here\'s the <span class="accent">whole</span> picture.',
        sub: 'Auto, energy storage, and a growing autonomy/robotics bet all trade under one ticker. This page lays out TSLA\'s segments, the current bull/bear debate, and the real risks — in plain English.',
        exchangeLabel: 'NASDAQ: TSLA',
        title: 'TSLA Stock — Tesla Live Price, Research & Risks | Mission Board',
        description: 'Live TSLA price, chart, and plain-English research on Tesla\'s auto, energy, and robotics segments, valuation, and risks.'
      },
      AAPL: {
        exchange: 'Nasdaq · AAPL · Apple Inc.',
        h1: 'iPhone still<br>drives Apple.<br>Here\'s what <span class="accent">else</span> matters.',
        sub: 'Services growth, regulatory pressure, and the next upgrade cycle all shape AAPL right now. This page breaks down what you\'d actually own and why analysts are watching what they\'re watching.',
        exchangeLabel: 'NASDAQ: AAPL',
        title: 'AAPL Stock — Apple Live Price, Research & Risks | Mission Board',
        description: 'Live AAPL price, chart, and plain-English research on Apple\'s iPhone, Services growth, and the risks facing the stock.'
      },
      MSFT: {
        exchange: 'Nasdaq · MSFT · Microsoft Corporation.',
        h1: 'Azure, AI, and<br>a huge capex bet.<br>Here\'s the <span class="accent">real</span> setup.',
        sub: 'Strong fundamentals, a stock that has still lagged in 2026 — Microsoft is a genuine case study in the market pricing capex risk ahead of proof. This page breaks down both sides.',
        exchangeLabel: 'NASDAQ: MSFT',
        title: 'MSFT Stock — Microsoft Live Price, Research & Risks | Mission Board',
        description: 'Live MSFT price, chart, and plain-English research on Microsoft\'s Azure and AI capex bet, valuation, and risks.'
      },
      GOOGL: {
        exchange: 'Nasdaq · GOOGL · Alphabet Inc.',
        h1: 'Search still pays<br>the bills. AI is<br>the <span class="accent">open</span> question.',
        sub: 'Cloud acceleration, a DOJ antitrust overhang, and rising capex — Alphabet\'s setup right now has real tension in it. This page breaks down what\'s actually driving the stock.',
        exchangeLabel: 'NASDAQ: GOOGL',
        title: 'GOOGL Stock — Alphabet Live Price, Research & Risks | Mission Board',
        description: 'Live GOOGL price, chart, and plain-English research on Alphabet\'s Search, Cloud, and AI bet, plus antitrust risk.'
      },
      AMZN: {
        exchange: 'Nasdaq · AMZN · Amazon.com, Inc.',
        h1: 'AWS funds<br>everything else.<br>Here\'s the <span class="accent">full</span> business.',
        sub: 'Retail, advertising, and a reaccelerating AWS all live under one ticker, alongside a real AI-strategy reshuffle. This page breaks down what you\'d actually own.',
        exchangeLabel: 'NASDAQ: AMZN',
        title: 'AMZN Stock — Amazon Live Price, Research & Risks | Mission Board',
        description: 'Live AMZN price, chart, and plain-English research on Amazon\'s retail, advertising, AWS, and AI strategy.'
      },
      META: {
        exchange: 'Nasdaq · META · Meta Platforms, Inc.',
        h1: 'Ads fund the<br>AI bet. Here\'s<br>the <span class="accent">real</span> tradeoff.',
        sub: 'A dominant, highly profitable ad business is currently funding the heaviest AI capex ratio of any mega-cap here. This page breaks down both sides of that bet.',
        exchangeLabel: 'NASDAQ: META',
        title: 'META Stock — Meta Live Price, Research & Risks | Mission Board',
        description: 'Live META price, chart, and plain-English research on Meta\'s ad business, AI capex bet, and the risks facing the stock.'
      },
      NVDA: {
        exchange: 'Nasdaq · NVDA · NVIDIA Corporation.',
        h1: 'Everyone else\'s<br>AI capex ends<br>up <span class="accent">here</span>.',
        sub: 'Nvidia is the most concentrated pure-play on AI infrastructure demand of any stock on this page — which cuts both ways. This page breaks down the setup.',
        exchangeLabel: 'NASDAQ: NVDA',
        title: 'NVDA Stock — Nvidia Live Price, Research & Risks | Mission Board',
        description: 'Live NVDA price, chart, and plain-English research on Nvidia\'s AI infrastructure demand and the risks behind it.'
      }
    };

    function updateHero(ticker){
      const c = HERO_CONTENT[ticker];
      const brandTicker = document.getElementById('brand-ticker');
      if (brandTicker) brandTicker.textContent = '// ' + ticker;

      const pageTitle = c ? c.title : `${ticker} Stock — Live Price & Research | SPCX Mission Board`;
      const pageDesc = c ? c.description : `Live price, chart, news, and peer comparison for ${ticker} — part of the SPCX Mission Board live stock research dashboard.`;
      document.title = pageTitle;
      const descEl = document.getElementById('meta-description');
      const ogTitleEl = document.getElementById('og-title');
      const ogDescEl = document.getElementById('og-description');
      const twTitleEl = document.getElementById('twitter-title');
      const twDescEl = document.getElementById('twitter-description');
      if (descEl) descEl.setAttribute('content', pageDesc);
      if (ogTitleEl) ogTitleEl.setAttribute('content', pageTitle);
      if (ogDescEl) ogDescEl.setAttribute('content', pageDesc);
      if (twTitleEl) twTitleEl.setAttribute('content', pageTitle);
      if (twDescEl) twDescEl.setAttribute('content', pageDesc);

      if (!c) return; // no curated hero copy yet for this ticker — leave existing hero text as-is
      const exEl = document.getElementById('hero-exchange');
      const h1El = document.getElementById('hero-h1');
      const subEl = document.getElementById('hero-sub');
      if (exEl) exEl.textContent = c.exchange;
      if (h1El) h1El.innerHTML = c.h1;
      if (subEl) subEl.textContent = c.sub;
      const labelEl = document.querySelector('.price-panel .ticker-label span');
      if (labelEl) labelEl.textContent = c.exchangeLabel;
    }

    function switchDeepDive(ticker){
      document.querySelectorAll('[data-deepdive]').forEach(el => {
        el.style.display = el.dataset.deepdive === ticker ? '' : 'none';
      });
      const hasContent = DD_HAS_CONTENT.includes(ticker);
      document.querySelectorAll('[data-deepdive-placeholder]').forEach(el => {
        el.style.display = hasContent ? 'none' : '';
      });
      document.querySelectorAll('.dd-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.dd === ticker);
      });
      updateHero(ticker);
    }

    if (ddTabsWrap){
      ddTabsWrap.querySelectorAll('.dd-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          const ticker = btn.dataset.dd;
          switchDeepDive(ticker);
          // Keep the live chart/news/peers in sync with whichever company is selected here.
          if (ticker === 'SPCX') resetToSPCX();
          else switchTicker(ticker);
        });
      });
    }

    keySaveBtn.addEventListener('click', () => {
      const val = keyInput.value.trim();
      if (!val) return;
      finnhubKey = val;
      keyBanner.classList.add('connected');
      keyInput.disabled = true;
      keySaveBtn.textContent = 'Connected';
      applyFinnhubMode();
      connectFinnhub();
    });
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') keySaveBtn.click(); });

    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (finnhubKey) return; // range selection doesn't apply in Finnhub session mode
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        currentInterval = btn.dataset.interval;
        updatedEl.textContent = 'Loading…';
        loadAndRenderChart(currentRange, currentInterval).catch(()=>{});
      });
    });

    function updateTodayDate(){
      const el = document.getElementById('today-date');
      if (!el) return;
      el.textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    updateTodayDate();
    setInterval(updateTodayDate, 60 * 60 * 1000); // re-check hourly so it rolls over at midnight without needing a refresh

    async function startup(){
      await detectServerless(); // ~1-4s check for /.netlify/functions/finnhub — safe to fail silently

      if (!serverlessAvailable && finnhubKey){
        keyBanner.classList.add('connected');
        keyInput.value = finnhubKey;
        keyInput.disabled = true;
        keySaveBtn.textContent = 'Connected';
      }
      applyFinnhubMode();

      loadAndRenderChart(currentRange, currentInterval, true).catch(err => showFatalError('Startup error: ' + err.message));
      if (finnhubKey || serverlessAvailable){
        connectFinnhub();
        loadNews(TICKER).catch(()=>{});
      } else {
        scheduleAutoRefresh();
        newsStatusEl.textContent = 'Needs a Finnhub key';
        newsFeedEl.innerHTML = '<div class="news-feed-item"><div class="nf-title">Paste a free Finnhub key above to see live news.</div></div>';
      }
      loadPeers().catch(()=>{});
      schedulePeersRefresh();
      refreshWatchlistPrices().catch(()=>{});
      renderPaperAccount().catch(()=>{});
      refreshCompareChart().catch(()=>{});
      scheduleMediumRefresh();
    }
    startup();
  })();
