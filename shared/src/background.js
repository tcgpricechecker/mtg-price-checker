// MTG Card Price Checker - Background Script
// Service worker that handles all API calls to Scryfall, TCGCSV, and exchange rate lookups.
//
// APIs used:
//   - api.scryfall.com: Card search, card images, tcgplayer_id (free, no auth, 10 req/s)
//   - tcgcsv.com:       Real TCGPlayer prices: low/mid/high/market (free, no auth, daily updates)
//   - open.er-api.com:  Exchange rates for non-USD currencies (free, no auth)
//
// Price strategy:
//   - TCGCSV provides real TCGPlayer prices (low, mid, high, market) in USD
//   - All users see TCGPlayer prices, converted to their local currency
//   - Scryfall prices used as fallback when TCGCSV unavailable

// ═══════════════════════════════════════════
// SENTRY ERROR TRACKING
// ═══════════════════════════════════════════
const SENTRY_DSN = 'https://688c325cc3bafb816f252807c6348269@o4510896101720064.ingest.de.sentry.io/4510896119218256';
const SENTRY_PROJECT_ID = '4510896119218256';
const SENTRY_KEY = '688c325cc3bafb816f252807c6348269';
const SENTRY_HOST = 'o4510896101720064.ingest.de.sentry.io';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// ═══════════════════════════════════════════
// UPDATE BADGE ("NEW" on extension icon)
// ═══════════════════════════════════════════
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update' || details.reason === 'install') {
    chrome.storage.local.get('lastSeenVersion', (data) => {
      if (data.lastSeenVersion !== EXTENSION_VERSION) {
        chrome.action.setBadgeText({ text: 'NEW' });
        chrome.action.setBadgeBackgroundColor({ color: '#5a9ad0' });
      }
    });
  }
});

// Ensure background is active on browser startup (Firefox event page needs this)
chrome.runtime.onStartup.addListener(() => {
  // No-op — registering this listener ensures Firefox starts the event page on browser launch.
  // The persistCache alarm (below) then keeps it alive.
});

// Opt-in guard: Sentry only active if user explicitly enabled it
async function isSentryEnabled() {
  const data = await chrome.storage.local.get('errorTrackingEnabled');
  return data.errorTrackingEnabled === true; // default: false (opt-in)
}

// Sanitize URLs before sending to Sentry — strip query params that may contain session tokens
function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return '[invalid url]'; }
}

// Rate limiting: max 3 same errors per day
const SENTRY_RATE_LIMIT = 3;
const SENTRY_RATE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const sentryRateMap = new Map(); // key -> { count, firstSeen }
const SENTRY_RATE_MAP_MAX = 100; // Max unique error keys to track

function checkSentryRateLimit(key) {
  const now = Date.now();
  const entry = sentryRateMap.get(key);
  
  if (!entry) {
    // Evict expired entries when map gets large
    if (sentryRateMap.size >= SENTRY_RATE_MAP_MAX) {
      for (const [k, v] of sentryRateMap) {
        if (now - v.firstSeen > SENTRY_RATE_WINDOW) sentryRateMap.delete(k);
      }
    }
    sentryRateMap.set(key, { count: 1, firstSeen: now });
    return true; // Allow
  }
  
  // Reset if window expired
  if (now - entry.firstSeen > SENTRY_RATE_WINDOW) {
    sentryRateMap.set(key, { count: 1, firstSeen: now });
    return true; // Allow
  }
  
  // Check limit
  if (entry.count >= SENTRY_RATE_LIMIT) {
    return false; // Block
  }
  
  entry.count++;
  return true; // Allow
}

// Send error to Sentry
async function sentryCaptureException(error, context = {}) {
  try {
    if (!(await isSentryEnabled())) return;
    
    const rateKey = `${error.name}:${error.message}`;
    if (!checkSentryRateLimit(rateKey)) {
      console.log('[Sentry] Rate limited:', rateKey);
      return;
    }
    
    const envelope = createSentryEnvelope(error, context);
    await fetch(`https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`, {
      method: 'POST',
      body: envelope
    });
  } catch (e) {
    // Silently fail - don't cause more errors
    console.error('[Sentry] Failed to send:', e);
  }
}

// Send message/warning to Sentry
async function sentryCaptureMessage(message, level = 'info', context = {}) {
  try {
    if (!(await isSentryEnabled())) return;
    
    const rateKey = `msg:${message}`;
    if (!checkSentryRateLimit(rateKey)) {
      console.log('[Sentry] Rate limited:', rateKey);
      return;
    }
    
    const envelope = createSentryEnvelope(new Error(message), { ...context, level });
    await fetch(`https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`, {
      method: 'POST',
      body: envelope
    });
  } catch (e) {
    console.error('[Sentry] Failed to send:', e);
  }
}

// Create Sentry envelope format
function createSentryEnvelope(error, context = {}) {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const timestamp = Date.now() / 1000;
  
  const event = {
    event_id: eventId,
    timestamp: timestamp,
    platform: 'javascript',
    level: context.level || 'error',
    release: `mtg-price-checker@${EXTENSION_VERSION}`,
    environment: 'production',
    tags: {
      extension_version: EXTENSION_VERSION,
      ...context.tags
    },
    exception: {
      values: [{
        type: error.name || 'Error',
        value: error.message || String(error),
        stacktrace: error.stack ? parseStackTrace(error.stack) : undefined
      }]
    },
    extra: {
      ...context.extra
    }
  };

  // Add browser info if available
  if (typeof navigator !== 'undefined') {
    event.contexts = {
      browser: {
        name: getBrowserName(),
        version: getBrowserVersion()
      }
    };
  }

  const header = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn: SENTRY_DSN
  });
  
  const itemHeader = JSON.stringify({
    type: 'event',
    content_type: 'application/json'
  });

  return `${header}\n${itemHeader}\n${JSON.stringify(event)}`;
}

// Parse stack trace into Sentry format
function parseStackTrace(stack) {
  if (!stack) return undefined;
  
  const frames = stack.split('\n').slice(1).map(line => {
    const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
    if (match) {
      return {
        function: match[1] || '?',
        filename: match[2],
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10)
      };
    }
    return { function: line.trim(), filename: '?' };
  }).filter(f => f.filename !== '?');
  
  return { frames: frames.reverse() };
}

// Get browser name
function getBrowserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return 'Unknown';
}

// Get browser version
function getBrowserVersion() {
  const ua = navigator.userAgent;
  const match = ua.match(/(Firefox|Edg|Chrome|Safari)\/(\d+)/);
  return match ? match[2] : 'Unknown';
}

// Global error handlers
self.addEventListener('error', (event) => {
  sentryCaptureException(event.error || new Error(event.message), {
    extra: { 
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno 
    }
  });
});

self.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error 
    ? event.reason 
    : new Error(String(event.reason));
  sentryCaptureException(error, {
    tags: { type: 'unhandledrejection' }
  });
});

isSentryEnabled().then(enabled => {
  console.log(`[MTG Price Checker] v${EXTENSION_VERSION} - Error tracking: ${enabled ? 'enabled (opt-in)' : 'disabled (default)'}`);
});

// ═══════════════════════════════════════════
// END SENTRY
// ═══════════════════════════════════════════

// ─── CACHE ───
const SCRYFALL_CACHE = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 500;
const CACHE_PERSIST_INTERVAL = 60 * 1000;
let cacheDirty = false;

// ─── TCGCSV CACHE ───
const TCGCSV_CACHE = new Map();
const TCGCSV_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours (prices don't change often)
const TCGCSV_CACHE_MAX = 30; // Max sets to keep in memory
const MTG_CATEGORY_ID = 1;
let tcgcsvCacheDirty = false;

// ─── GLOBAL REQUEST QUEUE ───
const REQUEST_QUEUE = [];
const RATE_MS = 100; // 10 req/s — Scryfall rate limit
let lastRequest = 0;
let queueProcessing = false;
let activeLookupGen = 0;

// ─── IN-FLIGHT DEDUPLICATION ───
const inFlight = new Map();

// ─── EXCHANGE RATES ───
let exchangeRates = null;
const EXCHANGE_RATE_TTL = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
(async function loadPersistentCache() {
  try {
    // Load Scryfall cache
    const data = await chrome.storage.local.get(['mtgCache', 'tcgcsvCache']);
    const now = Date.now();
    
    if (data.mtgCache && Array.isArray(data.mtgCache)) {
      let loaded = 0;
      for (const [key, entry] of data.mtgCache) {
        if (entry.ts && (now - entry.ts) < CACHE_TTL) {
          SCRYFALL_CACHE.set(key, entry);
          loaded++;
        }
      }
      if (loaded > 0) console.log('[MTG-PC] Loaded', loaded, 'Scryfall cache entries');
    }
    
    // Load TCGCSV cache
    if (data.tcgcsvCache && Array.isArray(data.tcgcsvCache)) {
      let loaded = 0;
      for (const [groupId, entry] of data.tcgcsvCache) {
        if (entry.ts && (now - entry.ts) < TCGCSV_CACHE_TTL) {
          // Reconstruct the Map for prices
          const priceMap = new Map(entry.priceEntries || []);
          TCGCSV_CACHE.set(groupId, {
            ts: entry.ts,
            prices: priceMap,
            products: entry.products || []
          });
          loaded++;
        }
      }
      if (loaded > 0) console.log('[MTG-PC] Loaded', loaded, 'TCGCSV cache entries');
    }
  } catch (e) {
    console.warn('[MTG-PC] Failed to load persistent cache:', e.message);
  }
  // Prefetch TCGCSV groups so first lookup doesn't pay the ~300ms penalty
  getTcgcsvGroups();
})();

// MV3: chrome.alarms survives service worker termination (setInterval does not)
chrome.alarms.create('persistCache', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'persistCache') persistCache();
});

async function persistCache() {
  try {
    const updates = {};
    
    if (cacheDirty) {
      updates.mtgCache = [...SCRYFALL_CACHE.entries()];
      cacheDirty = false;
    }
    
    if (tcgcsvCacheDirty) {
      // Convert TCGCSV cache - need to serialize the price Map
      const tcgcsvEntries = [];
      for (const [groupId, entry] of TCGCSV_CACHE.entries()) {
        tcgcsvEntries.push([groupId, {
          ts: entry.ts,
          priceEntries: [...entry.prices.entries()],
          products: entry.products
        }]);
      }
      updates.tcgcsvCache = tcgcsvEntries;
      tcgcsvCacheDirty = false;
    }
    
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  } catch (e) {
    console.warn('[MTG-PC] Failed to persist cache:', e.message);
  }
}

// ═══════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'PING') {
    sendResponse({ pong: true });
    return;
  }
  if (msg.type === 'FETCH_CARD_PRICE') {
    handleLookup(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'SEARCH_CARDS') {
    handleSearch(msg.query).then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_EXCHANGE_RATE') {
    getExchangeRate(msg.currency).then(sendResponse);
    return true;
  }
  if (msg.type === 'FETCH_PRINTINGS') {
    handleFetchPrintings(msg.cardName).then(sendResponse);
    return true;
  }
});

/**
 * Fetch all printings of a card from Scryfall.
 * Returns a compact list for the popup printing navigator.
 */
async function handleFetchPrintings(cardName) {
  if (!cardName) return { success: false, data: [] };
  try {
    const data = await queuedFetch(
      `https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=released&dir=desc`
    );
    if (!data?.data?.length) return { success: false, data: [] };

    let printings = data.data;

    // Paginate for cards with many printings (basic lands, etc.)
    if (data.has_more && data.next_page) {
      let nextUrl = data.next_page;
      for (let page = 1; page < 5 && nextUrl; page++) {
        const pageData = await queuedFetch(nextUrl);
        if (!pageData?.data?.length) break;
        printings = printings.concat(pageData.data);
        nextUrl = pageData.has_more ? pageData.next_page : null;
      }
    }

    // Filter out digital-only printings (MTGO, Arena) — no physical cards, no prices
    printings = printings.filter(c => !c.digital);

    // Return compact printing info
    const results = printings.map(c => {
      const imgs = c.image_uris || c.card_faces?.[0]?.image_uris || {};
      return {
        setCode: (c.set || '').toUpperCase(),
        setName: c.set_name || '',
        collectorNumber: c.collector_number || '',
        rarity: c.rarity || '',
        imageSmall: imgs.small || imgs.normal || '',
      };
    });

    return { success: true, data: results };
  } catch (e) {
    return { success: false, data: [] };
  }
}

async function handleSearch(query) {
  if (!query || query.length < 2) return { success: false, data: [] };
  try {
    const data = await queuedFetch(`https://api.scryfall.com/cards/autocomplete?q=${enc(query)}`);
    if (data) return { success: true, data: data.data || [] };
  } catch (e) {
    console.warn('[handleSearch] Autocomplete error:', e.message);
  }
}

// ═══════════════════════════════════════════
// EXCHANGE RATES
// ═══════════════════════════════════════════
async function fetchExchangeRates() {
  if (exchangeRates && Date.now() - exchangeRates.ts < EXCHANGE_RATE_TTL) {
    return exchangeRates.rates;
  }
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) {
      sentryCaptureMessage(`Exchange Rate API Error: ${r.status}`, 'warning', {
        extra: { status: r.status }
      });
      return { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.53, JPY: 149, CHF: 0.88 };
    }
    const data = await r.json();
    if (data.result === 'success' && data.rates) {
      exchangeRates = { rates: data.rates, ts: Date.now() };
      console.log('[MTG-PC] Exchange rates loaded');
      return data.rates;
    }
  } catch (e) {
    sentryCaptureException(e, {
      tags: { type: 'exchange_rate_error' }
    });
  }
  return { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.53, JPY: 149, CHF: 0.88 };
}

async function getExchangeRate(currency) {
  const rates = await fetchExchangeRates();
  return { currency, rate: rates[currency] || null };
}

// ═══════════════════════════════════════════
// TCGCSV SERVICE
// ═══════════════════════════════════════════

let tcgcsvGroups = null;
let tcgcsvGroupsPromise = null;

async function getTcgcsvGroups() {
  if (tcgcsvGroups) return tcgcsvGroups;
  if (tcgcsvGroupsPromise) return tcgcsvGroupsPromise;

  tcgcsvGroupsPromise = (async () => {
    try {
      const res = await fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/groups`);
      if (!res.ok) {
        sentryCaptureMessage(`TCGCSV Groups API Error: ${res.status}`, 'warning', {
          extra: { status: res.status }
        });
        tcgcsvGroupsPromise = null; // Allow retry on next call
        return null;
      }
      const data = await res.json();
      if (!data.success || !data.results) {
        tcgcsvGroupsPromise = null; // Allow retry on next call
        return null;
      }
      tcgcsvGroups = data.results;
      return tcgcsvGroups;
    } catch (e) {
      sentryCaptureException(e, {
        tags: { type: 'tcgcsv_error', endpoint: 'groups' }
      });
      tcgcsvGroupsPromise = null;
      return null;
    }
  })();

  return tcgcsvGroupsPromise;
}

/**
 * Match a Scryfall set name to a TCGCSV groupId.
 * Uses multi-tier matching: alias → exact → word-overlap scoring.
 */
function matchGroup(groups, scryfallSetName) {
  if (!scryfallSetName || !groups) return null;

  const target = normSetName(scryfallSetName);
  const targetWords = getSetWords(scryfallSetName);

  // Scryfall → TCGPlayer name mappings
  const ALIASES = {
    'bloomburrow commander': ['commander bloomburrow', 'commander: bloomburrow'],
    'duskmourn commander': ['commander duskmourn', 'commander: duskmourn', 'commander duskmourn house of horror', 'commander: duskmourn house of horror'],
    'modern horizons 3 commander': ['commander modern horizons 3', 'commander: modern horizons 3'],
    'outlaws of thunder junction commander': ['commander outlaws of thunder junction', 'commander: outlaws of thunder junction'],
    'murders at karlov manor commander': ['commander murders at karlov manor', 'commander: murders at karlov manor'],
    'tales of middle-earth commander': ['commander tales of middle-earth', 'commander: tales of middle-earth', 'commander the lord of the rings tales of middle-earth'],
    'dominaria united commander': ['commander dominaria united', 'commander: dominaria united'],
    'streets of new capenna commander': ['commander streets of new capenna', 'commander: streets of new capenna'],
    'kamigawa neon dynasty commander': ['commander kamigawa neon dynasty', 'commander: kamigawa neon dynasty'],
    'innistrad crimson vow commander': ['commander innistrad crimson vow', 'commander: innistrad crimson vow'],
    'innistrad midnight hunt commander': ['commander innistrad midnight hunt', 'commander: innistrad midnight hunt'],
    'foundations jumpstart': ['magic the gathering foundations jumpstart'],
    'core set 2021': ['core set 2021', 'core 2021', 'm21'],
    'core set 2020': ['core set 2020', 'core 2020', 'm20'],
    'core set 2019': ['core set 2019', 'core 2019', 'm19'],
  };

  // TIER 1: Alias lookup
  const aliasKey = target.replace(/\s+/g, ' ');
  if (ALIASES[aliasKey]) {
    for (const alias of ALIASES[aliasKey]) {
      const aliasNorm = normSetName(alias);
      for (const g of groups) {
        if (normSetName(g.name) === aliasNorm) {
          return g.groupId;
        }
      }
    }
  }

  // TIER 2: Exact normalized match
  for (const g of groups) {
    if (normSetName(g.name) === target) return g.groupId;
  }

  // TIER 3: Bidirectional word-overlap scoring
  let bestMatch = null;
  let bestScore = 0;
  const MIN_SCORE = 0.5;

  for (const g of groups) {
    const gn = normSetName(g.name);
    const groupWords = getSetWords(g.name);
    if (groupWords.length === 0) continue;

    let targetInGroup = 0;
    for (const tw of targetWords) {
      if (groupWords.some(gw => gw === tw || gw.includes(tw) || tw.includes(gw))) {
        targetInGroup++;
      }
    }

    let groupInTarget = 0;
    for (const gw of groupWords) {
      if (targetWords.some(tw => tw === gw || tw.includes(gw) || gw.includes(tw))) {
        groupInTarget++;
      }
    }

    const targetCoverage = targetInGroup / targetWords.length;
    const groupPrecision = groupInTarget / groupWords.length;
    const score = (targetCoverage + groupPrecision) / 2;
    const substringBonus = (gn.includes(target) || target.includes(gn)) ? 0.1 : 0;
    const finalScore = score + substringBonus;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = g.groupId;
    }
  }

  if (bestScore >= MIN_SCORE) return bestMatch;
  return null;
}

/**
 * Like matchGroup, but returns ALL groups above the minimum score threshold.
 * Used when a specific product ID must be found across potentially multiple groups.
 */
function matchAllGroups(groups, setName) {
  if (!setName || !groups) return [];

  const target = normSetName(setName);
  const targetWords = getSetWords(setName);
  if (targetWords.length === 0) return [];

  const MIN_SCORE = 0.5;
  const results = [];

  for (const g of groups) {
    const gn = normSetName(g.name);
    const groupWords = getSetWords(g.name);
    if (groupWords.length === 0) continue;

    let targetInGroup = 0;
    for (const tw of targetWords) {
      if (groupWords.some(gw => gw === tw || gw.includes(tw) || tw.includes(gw))) targetInGroup++;
    }
    let groupInTarget = 0;
    for (const gw of groupWords) {
      if (targetWords.some(tw => tw === gw || tw.includes(gw) || gw.includes(tw))) groupInTarget++;
    }

    const score = (targetInGroup / targetWords.length + groupInTarget / groupWords.length) / 2;
    const substringBonus = (gn.includes(target) || target.includes(gn)) ? 0.1 : 0;
    const finalScore = score + substringBonus;

    if (finalScore >= MIN_SCORE) {
      results.push({ groupId: g.groupId, score: finalScore, name: g.name });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Fetch TCGCSV prices for a specific TCGPlayer productId.
 */
async function fetchTcgcsvPrices(productId, setName, cardName = null) {
  productId = parseInt(productId);
  if (!productId || !setName) return null;

  // Check cache
  for (const [gid, cached] of TCGCSV_CACHE.entries()) {
    if (Date.now() - cached.ts < TCGCSV_CACHE_TTL && cached.prices.has(productId)) {
      return cached.prices.get(productId);
    }
  }

  const groups = await getTcgcsvGroups();
  if (!groups) return null;

  const groupId = matchGroup(groups, setName);
  if (!groupId) return null;

  // Check group cache
  const cached = TCGCSV_CACHE.get(groupId);
  if (cached && Date.now() - cached.ts < TCGCSV_CACHE_TTL) {
    const directMatch = cached.prices.get(productId);
    if (directMatch) return directMatch;
    
    // Check if product exists but has no prices
    if (cached.products) {
      const productExists = cached.products.some(p => p.productId === productId);
      if (productExists) {
        return { low: null, mid: null, high: null, market: null,
                 lowFoil: null, midFoil: null, highFoil: null, marketFoil: null };
      }
      
      // Name fallback
      if (cardName) {
        const altProduct = findProductByName(cached.products, cardName);
        if (altProduct) {
          const altPrices = cached.prices.get(altProduct.productId);
          if (altPrices) return altPrices;
          return { low: null, mid: null, high: null, market: null,
                   lowFoil: null, midFoil: null, highFoil: null, marketFoil: null };
        }
      }
    }
    return null;
  }

  // Fetch prices and products
  try {
    const [pricesRes, productsRes] = await Promise.all([
      fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/prices`),
      fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/products`)
    ]);
    
    if (!pricesRes.ok) return null;
    
    const pricesData = await pricesRes.json();
    if (!pricesData.success || !pricesData.results) return null;

    let products = [];
    if (productsRes.ok) {
      const productsData = await productsRes.json();
      if (productsData.success && productsData.results) {
        products = productsData.results;
      }
    }

    // Build price map
    const priceMap = buildPriceMap(pricesData.results);

    // Cache
    TCGCSV_CACHE.set(groupId, { ts: Date.now(), prices: priceMap, products: products });
    tcgcsvCacheDirty = true;

    if (TCGCSV_CACHE.size > TCGCSV_CACHE_MAX) {
      const oldest = TCGCSV_CACHE.keys().next().value;
      TCGCSV_CACHE.delete(oldest);
    }

    // Try direct match first
    const directMatch = priceMap.get(productId);
    if (directMatch) return directMatch;
    
    // Check if product exists but has no prices (no active listings)
    const productExists = products.some(p => p.productId === productId);
    if (productExists) {
      // Return empty price object to indicate "found but no listings"
      return { low: null, mid: null, high: null, market: null,
               lowFoil: null, midFoil: null, highFoil: null, marketFoil: null };
    }
    
    // Name fallback
    if (cardName && products.length > 0) {
      const altProduct = findProductByName(products, cardName);
      if (altProduct) {
        const altPrices = priceMap.get(altProduct.productId);
        if (altPrices) return altPrices;
        // Product found by name but no prices
        return { low: null, mid: null, high: null, market: null,
                 lowFoil: null, midFoil: null, highFoil: null, marketFoil: null };
      }
    }
    
    return null;
  } catch (e) {
    console.warn('[fetchTcgcsvPrices] Error:', e.message);
    return null;
  }
}

/**
 * Search for a specific TCGPlayer product ID across multiple TCGCSV groups.
 * Unlike fetchTcgcsvPrices, this NEVER falls back to name matching.
 * Used when Scryfall doesn't know a TCG ID (e.g. Rainbow Foil variants).
 *
 * @param {number} productId - TCGPlayer product ID
 * @param {string[]} setHints - Set names to try (e.g. ["Secret Lair Drop Series", "Secret Lair Drop"])
 * @returns {object|null} Price data or null
 */
async function fetchTcgcsvPricesDirectByProductId(productId, setHints) {
  productId = parseInt(productId);
  if (!productId) return null;

  // Helper to find product object in products array
  const findProduct = (products) => products?.find(p => p.productId === productId) || null;

  // Check all cached groups first
  for (const [gid, cached] of TCGCSV_CACHE.entries()) {
    if (Date.now() - cached.ts < TCGCSV_CACHE_TTL && cached.prices.has(productId)) {
      const product = findProduct(cached.products);
      return { prices: cached.prices.get(productId), product, groupName: null };
    }
  }

  const groups = await getTcgcsvGroups();
  if (!groups) return null;

  // Collect candidate groups from all hints (deduplicated)
  const triedGroups = new Set();

  for (const hint of setHints) {
    if (!hint) continue;
    const candidates = matchAllGroups(groups, hint);

    for (const { groupId, name: groupName } of candidates) {
      if (triedGroups.has(groupId)) continue;
      triedGroups.add(groupId);

      // Check cache for this group
      const cached = TCGCSV_CACHE.get(groupId);
      if (cached && Date.now() - cached.ts < TCGCSV_CACHE_TTL) {
        if (cached.prices.has(productId)) {
          const product = findProduct(cached.products);
          return { prices: cached.prices.get(productId), product, groupName };
        }
        continue;
      }

      // Fetch this group
      try {
        const [pricesRes, productsRes] = await Promise.all([
          fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/prices`),
          fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/products`)
        ]);

        if (!pricesRes.ok) continue;
        const pricesData = await pricesRes.json();
        if (!pricesData.success || !pricesData.results) continue;

        let products = [];
        if (productsRes.ok) {
          const productsData = await productsRes.json();
          if (productsData.success && productsData.results) products = productsData.results;
        }

        // Build price map
        const priceMap = buildPriceMap(pricesData.results);

        // Cache this group
        TCGCSV_CACHE.set(groupId, { ts: Date.now(), prices: priceMap, products });
        tcgcsvCacheDirty = true;
        if (TCGCSV_CACHE.size > TCGCSV_CACHE_MAX) {
          TCGCSV_CACHE.delete(TCGCSV_CACHE.keys().next().value);
        }

        // Check for our product
        if (priceMap.has(productId)) {
          const product = findProduct(products);
          return { prices: priceMap.get(productId), product, groupName };
        }
      } catch (e) {
      }
    }
  }

  return null;
}

/**
 * Find a product by card name (fuzzy match).
 */
function findProductByName(products, cardName) {
  if (!products || !cardName) return null;
  
  const targetName = normCardName(cardName);
  
  // Exact match
  for (const p of products) {
    if (normCardName(p.name) === targetName) return p;
  }
  
  // Starts-with match
  for (const p of products) {
    if (normCardName(p.name).startsWith(targetName)) return p;
  }
  
  // Reverse starts-with
  for (const p of products) {
    if (targetName.startsWith(normCardName(p.name))) return p;
  }
  
  // Contains match
  for (const p of products) {
    const pn = normCardName(p.name);
    if (pn.includes(targetName) || targetName.includes(pn)) return p;
  }
  
  return null;
}

/**
 * Find a product by card name AND variant info (etched, borderless, etc.)
 * This is more specific than findProductByName - it considers finishes/frames.
 */
function findProductByNameAndVariant(products, cardName, frameEffects = [], finishes = [], borderColor = 'black') {
  if (!products || !cardName) return null;
  
  const baseName = normCardName(cardName);
  
  // Build variant keywords from Scryfall data
  const variantKeywords = [];
  if (frameEffects.includes('etched')) variantKeywords.push('foil etched', 'etched');
  if (frameEffects.includes('showcase')) variantKeywords.push('showcase');
  if (frameEffects.includes('extendedart')) variantKeywords.push('extended art');
  if (borderColor === 'borderless') variantKeywords.push('borderless');
  if (finishes.includes('etched')) variantKeywords.push('foil etched', 'etched');
  
  // If no special variant, return null - caller should use regular findProductByName
  if (variantKeywords.length === 0) return null;
  
  // Search for products matching name + variant
  for (const p of products) {
    const pn = normCardName(p.name);
    
    // Must contain the card name
    if (!pn.includes(baseName) && !baseName.includes(pn.split('(')[0].trim())) continue;
    
    // Must contain at least one variant keyword
    const hasVariant = variantKeywords.some(kw => pn.includes(kw));
    if (hasVariant) {
      return p;
    }
  }
  
  return null;
}

/**
 * Fetch TCGCSV prices by card name when no tcgplayerId is available.
 * Uses variant info to find the correct product.
 */
async function fetchTcgcsvPricesByName(cardName, setName, frameEffects = [], finishes = [], borderColor = 'black') {
  if (!cardName || !setName) return null;
  
  const groups = await getTcgcsvGroups();
  if (!groups) return null;
  
  const groupId = matchGroup(groups, setName);
  if (!groupId) return null;
  
  // Check if we have cached data for this group
  let cached = TCGCSV_CACHE.get(groupId);
  
  if (!cached || Date.now() - cached.ts >= TCGCSV_CACHE_TTL) {
    // Fetch products and prices
    try {
      const [pricesRes, productsRes] = await Promise.all([
        fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/prices`),
        fetch(`https://tcgcsv.com/tcgplayer/${MTG_CATEGORY_ID}/${groupId}/products`)
      ]);
      
      if (!pricesRes.ok || !productsRes.ok) return null;
      
      const pricesData = await pricesRes.json();
      const productsData = await productsRes.json();
      
      if (!pricesData.success || !productsData.success) return null;
      
      // Build price map
      const priceMap = buildPriceMap(pricesData.results);
      
      // Cache
      cached = { ts: Date.now(), prices: priceMap, products: productsData.results };
      TCGCSV_CACHE.set(groupId, cached);
      tcgcsvCacheDirty = true;
      if (TCGCSV_CACHE.size > TCGCSV_CACHE_MAX) {
        TCGCSV_CACHE.delete(TCGCSV_CACHE.keys().next().value);
      }
    } catch (e) {
      console.warn('[fetchTcgcsvPricesByName] Error:', e.message);
      return null;
    }
  }
  
  if (!cached.products || cached.products.length === 0) return null;
  
  // Try variant-specific match first
  let product = findProductByNameAndVariant(cached.products, cardName, frameEffects, finishes, borderColor);
  
  // Fall back to basic name match if no variant match
  if (!product) {
    product = findProductByName(cached.products, cardName);
  }
  
  if (!product) return null;
  
  const prices = cached.prices.get(product.productId);
  if (prices) {
    return { ...prices, _productId: product.productId, _productName: product.name };
  }
  
  // Product exists but no prices
  return { low: null, mid: null, high: null, market: null,
           lowFoil: null, midFoil: null, highFoil: null, marketFoil: null,
           _productId: product.productId, _productName: product.name };
}

// ═══════════════════════════════════════════
// GLOBAL REQUEST QUEUE
// ═══════════════════════════════════════════

function queuedFetch(url) {
  if (inFlight.has(url)) return inFlight.get(url);

  const promise = new Promise((resolve) => {
    REQUEST_QUEUE.push({ url, resolve });
    processQueue();
  });

  inFlight.set(url, promise);
  promise.finally(() => inFlight.delete(url));

  return promise;
}

// Flush all pending (not-yet-started) queue entries.
// Called when a new user-initiated lookup starts to prevent stale requests from blocking the queue.
function flushPendingQueue() {
  let flushed = 0;
  while (REQUEST_QUEUE.length > 0) {
    const req = REQUEST_QUEUE.shift();
    req.resolve(null);
    flushed++;
  }
  if (flushed > 0) console.log(`[Queue] Flushed ${flushed} pending requests`);
}

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (REQUEST_QUEUE.length > 0) {
    const req = REQUEST_QUEUE.shift();

    const wait = RATE_MS - (Date.now() - lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();

    try {
      let result = null;
      let lastStatus = 0;
      let lastStatusText = '';

      for (let attempt = 0; attempt <= 2; attempt++) {
        const r = await fetch(req.url);
        if (r.ok) {
          result = await r.json();
          break;
        }
        lastStatus = r.status;
        lastStatusText = r.statusText;
        // Retry on 429 (rate limited) or 5xx (server error), but not on last attempt
        if ((r.status === 429 || r.status >= 500) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        break; // Non-retryable error (4xx)
      }

      if (result) {
        req.resolve(result);
      } else {
        // Log server errors (5xx) to Sentry - not 404s (those are normal)
        if (lastStatus >= 500 || lastStatus === 429) {
          sentryCaptureMessage(`API Error: ${lastStatus} from ${new URL(req.url).hostname}`, 'error', {
            extra: { url: sanitizeUrl(req.url), status: lastStatus, statusText: lastStatusText }
          });
        }
        req.resolve(null);
      }
    } catch (e) {
      // Network errors - log to Sentry
      sentryCaptureException(e, {
        tags: { type: 'network_error' },
        extra: { url: sanitizeUrl(req.url) }
      });
      req.resolve(null);
    }
  }

  queueProcessing = false;
}

// ═══════════════════════════════════════════
// MAIN LOOKUP
// ═══════════════════════════════════════════
async function handleLookup(msg) {
  const { cardName, tcgplayerId, setHint, setCode, collectorNumber, scryfallId, variant, cardmarketProductId } = msg;
  
  // Refinement requests (cardmarketProductId only) should not flush the queue
  const isRefinement = cardmarketProductId && !setHint && !setCode && !scryfallId && !tcgplayerId;
  if (!isRefinement) {
    ++activeLookupGen;
    flushPendingQueue();
  }
  const gen = activeLookupGen;

  let result;
  let overrideTcgPlayerId = null;

  if (scryfallId) {
    result = await lookupByScryfallId(scryfallId);
  } else if (tcgplayerId) {
    result = await lookupByTcgId(tcgplayerId);
    // Fallback: Scryfall doesn't know all TCGPlayer IDs (e.g. Rainbow Foil variants).
    // Find the card by name (for image/info), then override tcgplayerId for correct TCGCSV pricing.
    if (!result.success && cardName && cardName !== 'Unknown') {
      console.log(`[handleLookup] TCG ID ${tcgplayerId} not found at Scryfall, falling back to name search: "${cardName}"${setHint ? ` [hint: ${setHint}]` : ''}`);
      result = await lookupByName(cardName, setHint, variant, null);
      if (result.success) {
        overrideTcgPlayerId = parseInt(tcgplayerId);
      }
    }
  } else if (setCode && collectorNumber) {
    result = await lookupByCollector(setCode, collectorNumber);
  } else if (setCode && cardName) {
    result = await lookupByNameAndSet(cardName, setCode);
  } else {
    result = await lookupByName(cardName, setHint, variant, cardmarketProductId);
  }

  if (!result.success) return result;

  // Bail out if a newer lookup has started (don't waste time on TCGCSV enrichment)
  if (gen < activeLookupGen) return { success: false, error: 'stale' };

  const card = JSON.parse(JSON.stringify(result.data));
  card.links.ebay = buildEbayLink(card.name, card.set);

  // Apply tcgplayerId override (from TCG ID fallback - card info from Scryfall, price ID from URL)
  if (overrideTcgPlayerId) {
    card.tcgplayerId = overrideTcgPlayerId;
  }

  // TCGCSV Price Enrichment
  let tcgPrices = null;

  if (overrideTcgPlayerId) {
    // Override path: Scryfall doesn't know this TCG ID.
    // Get prices AND product info from TCGCSV directly.
    try {
      const tcgcsvResult = await fetchTcgcsvPricesDirectByProductId(
        overrideTcgPlayerId,
        [setHint, card.set].filter(Boolean)
      );
      if (tcgcsvResult) {
        tcgPrices = tcgcsvResult.prices;
        // Enhance card with TCGCSV product info (more accurate than Scryfall fallback)
        const product = tcgcsvResult.product;
        if (product) {
          card.name = product.cleanName || card.name;
          card.set = tcgcsvResult.groupName || card.set;
          // Parse variant details from full product name
          const variantSuffix = (product.name || '').replace(product.cleanName || '', '').trim();
          if (variantSuffix) card.variantName = variantSuffix;
          // Use TCGCSV product image if available
          if (product.imageUrl) card.imageSmall = product.imageUrl;
          // Extract collector number from product name if present, e.g. "(2289)"
          const numMatch = (product.name || '').match(/\((\d+)\)/);
          if (numMatch) card.collectorNumber = numMatch[1];
          // Detect finish from product name
          const nameLower = (product.name || '').toLowerCase();
          if (nameLower.includes('rainbow foil')) card.finishes = ['foil'];
          else if (nameLower.includes('foil etched') || nameLower.includes('etched foil')) card.finishes = ['etched'];
          else if (nameLower.includes('foil') && !nameLower.includes('nonfoil')) card.finishes = ['foil'];
          // Fix TCGPlayer link to point to the actual product page
          card.links.tcgplayer = `https://www.tcgplayer.com/product/${overrideTcgPlayerId}`;
        }
      }
    } catch (e) {
      console.warn('[handleLookup] TCGCSV override enrichment error:', e.message);
    }
  } else if (card.tcgplayerId && card.set) {
    try {
      // Step 1: Try primary group by productId only (no name fallback).
      // Passing null for cardName prevents fetchTcgcsvPrices from falling back to
      // name matching, which could return prices for the wrong variant (e.g. regular
      // instead of promo).
      tcgPrices = await fetchTcgcsvPrices(card.tcgplayerId, card.set, null);

      // Step 2: Multi-group search. Promo cards often live in a different TCGCSV group
      // than matchGroup selects (e.g. Scryfall "Modern Horizons 2 Promos" vs TCGPlayer
      // "Modern Horizons 2"). Search across all matching groups by productId.
      if (!tcgPrices) {
        const directResult = await fetchTcgcsvPricesDirectByProductId(
          card.tcgplayerId,
          [card.set]
        );
        if (directResult) {
          tcgPrices = directResult.prices;
        }
      }

      // Step 3: Name fallback as last resort. If the productId doesn't exist in any
      // TCGCSV group, try matching by card name. This gives "close enough" prices
      // (e.g. regular version prices for a promo) rather than nothing.
      if (!tcgPrices) {
        tcgPrices = await fetchTcgcsvPrices(card.tcgplayerId, card.set, card.name);
      }
    } catch (e) {
      console.warn('[handleLookup] TCGCSV price enrichment error:', e.message);
    }
  } else if (card.set) {
    try {
      tcgPrices = await fetchTcgcsvPricesByName(
        card.name, card.set,
        card.frameEffects || [], card.finishes || [],
        card.borderColor || 'black'
      );
    } catch (e) {
      console.warn('[handleLookup] TCGCSV name-based price lookup error:', e.message);
    }
  }

  if (tcgPrices) {
    card.prices.low = tcgPrices.low;
    card.prices.mid = tcgPrices.mid;
    card.prices.high = tcgPrices.high;
    card.prices.market = tcgPrices.market;
    card.prices.lowFoil = tcgPrices.lowFoil;
    card.prices.midFoil = tcgPrices.midFoil;
    card.prices.highFoil = tcgPrices.highFoil;
    card.prices.marketFoil = tcgPrices.marketFoil;

    const hasAnyPrice = tcgPrices.low != null || tcgPrices.mid != null ||
      tcgPrices.market != null || tcgPrices.lowFoil != null ||
      tcgPrices.midFoil != null || tcgPrices.marketFoil != null;

    card.prices.source = hasAnyPrice ? 'tcgcsv' : 'tcgcsv-no-listings';
  }

  // Rebuild eBay link with potentially enhanced card name/set
  card.links.ebay = buildEbayLink(card.name, card.set);

  return { success: true, data: card, printingMatched: result.printingMatched ?? true };
}

function buildEbayLink(name, set) {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`mtg "${name}" "${set}"`)}&_sacat=38292&LH_Auction=1`;
}

// ═══════════════════════════════════════════
// LOOKUP STRATEGIES
// ═══════════════════════════════════════════

async function lookupByTcgId(id) {
  const key = `tcg:${id}`;
  const cached = getCache(key);
  if (cached) return cached;
  const card = await queuedFetch(`https://api.scryfall.com/cards/tcgplayer/${id}`);
  const result = card
    ? { success: true, data: formatCard(card) }
    : { success: false, error: `TCG ID ${id} not found` };
  setCache(key, result);
  return result;
}

async function lookupByScryfallId(id) {
  const key = `sf:${id}`;
  const cached = getCache(key);
  if (cached) return cached;
  const card = await queuedFetch(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`);
  const result = card
    ? { success: true, data: formatCard(card) }
    : { success: false, error: `Scryfall ID ${id} not found` };
  setCache(key, result);
  return result;
}

async function lookupByCollector(setCode, number) {
  const key = `col:${setCode}:${number}`;
  const cached = getCache(key);
  if (cached) return cached;
  const card = await queuedFetch(`https://api.scryfall.com/cards/${encodeURIComponent(setCode)}/${encodeURIComponent(number)}`);
  const result = card
    ? { success: true, data: formatCard(card) }
    : { success: false, error: `${setCode}/${number} not found` };
  setCache(key, result);
  return result;
}

async function lookupByNameAndSet(name, setCode) {
  const key = `set:${setCode}:${name}`;
  const cached = getCache(key);
  if (cached) return cached;
  let card = await queuedFetch(`https://api.scryfall.com/cards/named?fuzzy=${enc(name)}&set=${enc(setCode)}`);
  if (!card) {
    const searchData = await queuedFetch(`https://api.scryfall.com/cards/search?q=${enc(`!"${name}" e:${setCode}`)}&order=released&dir=desc`);
    card = searchData?.data?.[0] || null;
  }
  if (!card) {
    const searchData = await queuedFetch(`https://api.scryfall.com/cards/search?q=${enc(`${name} e:${setCode}`)}&order=released&dir=desc`);
    card = searchData?.data?.[0] || null;
  }
  if (!card) card = await queuedFetch(`https://api.scryfall.com/cards/named?fuzzy=${enc(name)}`);
  const result = card
    ? { success: true, data: formatCard(card) }
    : { success: false, error: `"${name}" not found in ${setCode}` };
  setCache(key, result);
  return result;
}

async function lookupByName(name, setHint, variant, cardmarketProductId) {
  const cleaned = simplify(name);
  
  // If we have a Cardmarket product ID, try direct lookup first (most precise)
  if (cardmarketProductId) {
    const key = `cm:${cardmarketProductId}`;
    const cached = getCache(key);
    if (cached) return cached;
    
    try {
      const r = await fetch(`https://api.scryfall.com/cards/cardmarket/${cardmarketProductId}`);
      if (r.ok) {
        const cmCard = await r.json();
        console.log(`[lookupByName] Exact match via Cardmarket product ID ${cardmarketProductId}: "${cmCard.set_name}" #${cmCard.collector_number}`);
        const result = { success: true, data: formatCard(cmCard) };
        setCache(key, result);
        return result;
      }
    } catch (e) {
      console.warn('[lookupByName] Cardmarket product ID lookup error:', e.message);
    }
  }
  
  const key = `name:${cleaned}:${setHint || ''}:${variant || ''}`;
  const cached = getCache(key);
  if (cached) return cached;

  const card = await queuedFetch(`https://api.scryfall.com/cards/named?fuzzy=${enc(cleaned)}`);
  if (!card) {
    const result = { success: false, error: `"${cleaned}" not found` };
    setCache(key, result);
    return result;
  }

  let match = card;
  let printingMatched = false;
  if (setHint) {
    const printing = await findPrinting(card.name, setHint, variant);
    if (printing) {
      match = printing;
      printingMatched = true;
    }
  }

  const result = { success: true, data: formatCard(match), printingMatched };
  setCache(key, result);
  return result;
}

// ═══════════════════════════════════════════
// FIND SPECIFIC PRINTING
// ═══════════════════════════════════════════
async function findPrinting(cardName, setHint, variant) {
  try {
    const data = await queuedFetch(`https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=set`);
    if (!data?.data?.length) {
      console.log('[findPrinting] No printings found for:', cardName);
      return null;
    }

    let printings = data.data;

    // Paginate if first page didn't contain all results.
    // Only relevant for cards with 175+ printings (basic lands, Lightning Bolt, etc.)
    if (data.has_more && data.next_page) {
      let nextUrl = data.next_page;
      const MAX_PAGES = 5;
      for (let page = 1; page < MAX_PAGES && nextUrl; page++) {
        const pageData = await queuedFetch(nextUrl);
        if (!pageData?.data?.length) break;
        printings = printings.concat(pageData.data);
        nextUrl = pageData.has_more ? pageData.next_page : null;
      }
    }

    console.log(`[findPrinting] Found ${printings.length} printings for "${cardName}", hint: "${setHint}"`);
    
    // Basic normalization: remove punctuation, lowercase, collapse spaces
    const norm = s => s.replace(/[:\-–—''",\.!?()®™]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
    
    // Advanced normalization: remove Cardmarket-specific noise
    const normDeep = s => {
      let r = norm(s);
      // Remove common Cardmarket additions
      r = r.replace(/\b(drop series|superdrop|winter|summer|fall|spring)\b/gi, '');
      // Remove year patterns like "2024" or "2025" (but keep in player names)
      r = r.replace(/\b(19|20)\d{2}\b/g, '');
      // Remove "magic the gathering" prefix
      r = r.replace(/^magic the gathering\s*/i, '');
      // Collapse multiple spaces
      r = r.replace(/\s+/g, ' ').trim();
      return r;
    };
    
    // Normalize Cardmarket hint: "Commander Bloomburrow" → "Bloomburrow Commander"
    let normalizedHint = setHint;
    const commanderPrefixMatch = setHint.match(/^Commander\s+(.+?)(\s+(?:Extras|Promos|Special|Tokens))?$/i);
    if (commanderPrefixMatch) {
      const setNamePart = commanderPrefixMatch[1];
      const suffix = commanderPrefixMatch[2] || '';
      if (!/\b(decks?|legends?|masters?)\b/i.test(setNamePart)) {
        normalizedHint = setNamePart + ' Commander' + suffix;
      }
    }
    
    const target = norm(normalizedHint);
    const targetDeep = normDeep(normalizedHint);
    
    // Extract key identifying words (filter out common/noise words)
    const NOISE_WORDS = new Set(['the', 'of', 'and', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'series', 'drop', 'superdrop', 'edition', 'set']);
    const extractKeyWords = s => s.split(' ').filter(w => w.length > 2 && !NOISE_WORDS.has(w));
    
    const targetKeyWords = extractKeyWords(targetDeep);
    console.log('[findPrinting] Target normalized:', targetDeep, '| Keywords:', targetKeyWords.join(', '));
    
    // Score-based matching
    const scored = printings.map(c => {
      const n = norm(c.set_name);
      const nDeep = normDeep(c.set_name);
      const nKeyWords = extractKeyWords(nDeep);
      
      let score = 0;
      let matchType = 'none';
      
      // Exact match (highest priority)
      if (n === target || nDeep === targetDeep) {
        score = 1000;
        matchType = 'exact';
      }
      // Core match (strip extras/special/tokens)
      else {
        const targetCore = target.replace(/\b(extras|special|tokens|promos)\b/gi, '').replace(/\s+/g, ' ').trim();
        const nCore = n.replace(/\b(extras|special|tokens|promos)\b/gi, '').replace(/\s+/g, ' ').trim();
        
        if (nCore === targetCore) {
          score = 900;
          matchType = 'core-exact';
        }
        // Substring containment
        else if (nDeep.length >= 4 && targetDeep.length >= 4) {
          if (nDeep === targetDeep) {
            score = 850;
            matchType = 'deep-exact';
          } else if (nDeep.includes(targetDeep) || targetDeep.includes(nDeep)) {
            score = 500;
            matchType = 'substring';
          }
        }
      }
      
      // Keyword overlap scoring (additive)
      if (score < 500 && targetKeyWords.length > 0 && nKeyWords.length > 0) {
        const overlap = targetKeyWords.filter(w => nKeyWords.includes(w)).length;
        const overlapRatio = overlap / Math.max(targetKeyWords.length, nKeyWords.length);
        
        // Require at least 50% keyword overlap for a match
        if (overlapRatio >= 0.5 && overlap >= 2) {
          score = Math.max(score, 100 + Math.round(overlapRatio * 300));
          matchType = matchType === 'none' ? `keyword-${overlap}/${targetKeyWords.length}` : matchType;
        }
        // Special case: if Scryfall set is short (like "Secret Lair") and ALL its keywords are in target
        else if (nKeyWords.length <= 3 && nKeyWords.every(w => targetKeyWords.includes(w))) {
          score = Math.max(score, 200);
          matchType = matchType === 'none' ? 'scryfall-subset' : matchType;
        }
      }
      
      return { card: c, score, matchType, setName: c.set_name, nDeep };
    });
    
    // Filter to matches with score > 0
    const matches = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    
    // Debug: log top matches
    if (matches.length > 0) {
      console.log('[findPrinting] Top matches:');
      matches.slice(0, 5).forEach(m => {
        console.log(`  [${m.score}] ${m.matchType}: "${m.setName}" (${m.card.set})`);
      });
    } else {
      // Log available sets for debugging
      const availableSets = [...new Set(printings.map(p => p.set_name))].slice(0, 10);
      console.log('[findPrinting] NO MATCH! Available sets:', availableSets.join(' | '));
    }
    
    // Get best matches (all with same top score)
    const topScore = matches[0]?.score || 0;
    let setMatches = matches.filter(m => m.score === topScore).map(m => m.card);

    // Tie-breaker: When multiple cards score equally (e.g. all SLD printings),
    // find keywords from setHint that are NOT in the matched set_name,
    // then check each card's cardmarket URL for those distinguishing keywords.
    if (setMatches.length > 1) {
      const matchedSetName = setMatches[0].set_name || '';
      const matchedKeyWords = extractKeyWords(normDeep(matchedSetName));
      const extraKeyWords = targetKeyWords.filter(w => !matchedKeyWords.includes(w));
      
      if (extraKeyWords.length > 0) {
        const cmMatches = setMatches.filter(c => {
          const cmUrl = (c.purchase_uris?.cardmarket || '').toLowerCase();
          return extraKeyWords.every(kw => cmUrl.includes(kw));
        });
        if (cmMatches.length > 0 && cmMatches.length < setMatches.length) {
          setMatches = cmMatches;
        }
      }
    }

    if (setMatches.length > 0) {
      const sortByNum = (a, b) => safeParseCollectorNum(a.collector_number) - safeParseCollectorNum(b.collector_number);
      
      const isExtrasUrl = /\b(extras|special|tokens|promos)\b/i.test(setHint);
      const isPromosUrl = /\b(promos)\b/i.test(setHint);

      if (setMatches.length > 1) {
        const SPECIAL_FRAMES = ['extendedart', 'showcase', 'borderless', 'inverted', 'etched', 'textured'];
        
        const rawAnnotated = setMatches.map(c => ({
          card: c,
          num: safeParseCollectorNum(c.collector_number),
          numStr: c.collector_number,
          isPromo: c.promo === true || /[a-z]$/i.test(c.collector_number),
          isSpecial: (c.frame_effects || []).some(f => SPECIAL_FRAMES.includes(f)) ||
                     c.border_color === 'borderless'
        }));
        
        // Expand cards with mixed finishes (etched + nonfoil/foil) into separate entries.
        // Cardmarket lists each finish as a separate variant (e.g. V2 = retro frame, V3 = retro frame etched),
        // but Scryfall combines them into one entry with finishes: ['nonfoil', 'foil', 'etched'].
        const annotated = [];
        for (const entry of rawAnnotated) {
          const finishes = entry.card.finishes || [];
          const hasEtched = finishes.includes('etched');
          const hasOtherFinishes = finishes.includes('nonfoil') || finishes.includes('foil');
          
          if (hasEtched && hasOtherFinishes) {
            // Regular version (without etched)
            const regularCard = Object.assign({}, entry.card, { finishes: finishes.filter(f => f !== 'etched') });
            annotated.push(Object.assign({}, entry, { card: regularCard }));
            // Etched version (etched only) - sorts directly after regular via num + 0.5
            const etchedCard = Object.assign({}, entry.card, { finishes: ['etched'] });
            annotated.push(Object.assign({}, entry, { card: etchedCard, num: entry.num + 0.5, isSpecial: true }));
            console.log(`[findPrinting] Expanded "${entry.card.set_name}" #${entry.numStr} into regular + etched entries`);
          } else {
            annotated.push(entry);
          }
        }
        
        const baseCandidates = annotated
          .filter(c => !c.isPromo && !c.isSpecial)
          .sort((a, b) => a.num - b.num);
        const base = baseCandidates[0] || null;
        
        const extras = annotated
          .filter(c => c !== base && !c.isPromo)
          .sort((a, b) => a.num - b.num);
        
        const promos = annotated.filter(c => c.isPromo).sort((a, b) => a.num - b.num);

        if (isPromosUrl) {
          if (promos.length > 0) {
            const idx = (variant != null && variant >= 1) ? Math.min(variant - 1, promos.length - 1) : 0;
            return promos[idx].card;
          }
        } else if (isExtrasUrl && variant != null && variant >= 1) {
          if (extras.length > 0) {
            const idx = Math.min(variant - 1, extras.length - 1);
            return extras[idx].card;
          }
        } else if (isExtrasUrl) {
          if (extras.length > 0) {
            return extras[0].card;
          }
        } else if (variant != null && variant >= 1) {
          const sorted = [...setMatches].sort(sortByNum);
          const idx = Math.min(variant - 1, sorted.length - 1);
          return sorted[idx];
        } else {
          if (base) {
            return base.card;
          }
        }
      }

      console.log('[findPrinting] Selected:', setMatches[0].set_name, `(${setMatches[0].set})`);
      return setMatches[0];
    }

    // Last resort: set code match
    const shortHint = setHint.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (shortHint.length <= 6) {
      const codeMatch = printings.find(c => c.set === shortHint);
      if (codeMatch) {
        console.log('[findPrinting] Set code match:', codeMatch.set_name);
        return codeMatch;
      }
    }
    
    console.log('[findPrinting] No match found for hint:', setHint);
  } catch (e) {
    console.error('[findPrinting] Error:', e);
  }
  return null;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

// ─── SHARED NORMALIZATION ───
// Two distinct normalizers:
//   normSetName  → for set name matching (punctuation → spaces, preserves word boundaries)
//   normCardName → for card name matching (punctuation removed entirely)
function normSetName(s) {
  return s.toLowerCase()
    .replace(/[:\-–—''",\.!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normCardName(s) {
  return s.toLowerCase()
    .replace(/[,.'":!?\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SET_STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'for', 'to', 'with']);

function getSetWords(s) {
  return normSetName(s).split(' ').filter(w => w.length > 1 && !SET_STOP_WORDS.has(w));
}

// ─── SHARED PRICE MAP BUILDER ───
// Builds a Map<productId, {low,mid,high,market,lowFoil,...}> from TCGCSV price results.
// Used by fetchTcgcsvPrices, fetchTcgcsvPricesDirectByProductId, fetchTcgcsvPricesByName.
function buildPriceMap(priceResults) {
  const priceMap = new Map();
  for (const p of priceResults) {
    const pid = p.productId;
    if (!pid) continue;

    const isFoil = (p.subTypeName || '').toLowerCase().includes('foil');

    let entry = priceMap.get(pid);
    if (!entry) {
      entry = { low: null, mid: null, high: null, market: null,
                lowFoil: null, midFoil: null, highFoil: null, marketFoil: null };
      priceMap.set(pid, entry);
    }

    if (isFoil) {
      entry.lowFoil = p.lowPrice ?? null;
      entry.midFoil = p.midPrice ?? null;
      entry.highFoil = p.highPrice ?? null;
      entry.marketFoil = p.marketPrice ?? null;
    } else {
      entry.low = p.lowPrice ?? null;
      entry.mid = p.midPrice ?? null;
      entry.high = p.highPrice ?? null;
      entry.market = p.marketPrice ?? null;
    }
  }
  return priceMap;
}

// ─── URL VALIDATION ───
// Only allow https:// URLs in links shown to users. Prevents javascript: injection
// from compromised API responses.
function safeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.startsWith('https://') || url.startsWith('http://') ? url : '';
}

// ─── SAFE COLLECTOR NUMBER PARSING ───
// Collector numbers can be non-numeric ("12a", "GR8", "★"). parseInt returns NaN
// for non-numeric prefixes, which breaks sort comparisons. Default to Infinity
// so non-numeric entries sort to the end.
function safeParseCollectorNum(cn) {
  const n = parseInt(cn);
  return Number.isNaN(n) ? Infinity : n;
}

function simplify(name) {
  return name
    .replace(/\s*\(.*?\)/g, '')
    .replace(/\s*\[.*?\]/g, '')
    .replace(/\s*[-–]\s*(Foil|Etched|Extended|Borderless|Showcase|Full Art|Retro|Surge|Promo|V\.\d+).*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

function getCache(key) {
  const c = SCRYFALL_CACHE.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.val;
  if (c) SCRYFALL_CACHE.delete(key);
  return null;
}

function setCache(key, val) {
  SCRYFALL_CACHE.set(key, { val, ts: Date.now() });
  cacheDirty = true;
  if (SCRYFALL_CACHE.size > CACHE_MAX) {
    const firstKey = SCRYFALL_CACHE.keys().next().value;
    SCRYFALL_CACHE.delete(firstKey);
  }
}

function enc(s) { return encodeURIComponent(s); }

// ═══════════════════════════════════════════
// FORMAT
// ═══════════════════════════════════════════
function formatCard(card) {
  const p = card.prices || {};
  const faces = card.card_faces || [];
  const imgs = card.image_uris || faces[0]?.image_uris || {};

  let oracleText = card.oracle_text || '';
  if (!oracleText && faces.length > 0) {
    oracleText = faces.map(f => f.oracle_text || '').filter(Boolean).join('\n// \n');
  }

  // Extract tcgplayer_id - prefer etched_id for etched cards
  let tcgplayerId = card.tcgplayer_id || null;
  const finishes = card.finishes || [];
  const isEtched = finishes.includes('etched') && !finishes.includes('nonfoil');
  
  // Use tcgplayer_etched_id if this is an etched-only card
  if (isEtched && card.tcgplayer_etched_id) {
    tcgplayerId = card.tcgplayer_etched_id;
  }
  
  // Fallback to purchase_uris
  if (!tcgplayerId && card.purchase_uris?.tcgplayer) {
    const m = card.purchase_uris.tcgplayer.match(/\/product\/(\d+)/);
    if (m) tcgplayerId = parseInt(m[1]);
  }

  // Extract variant info for TCGCSV name matching
  const frameEffects = card.frame_effects || [];
  const borderColor = card.border_color || 'black';

  // Card colors for frame theming (W, U, B, R, G)
  let colors = card.colors || [];
  // Double-faced cards: use front face colors
  if (colors.length === 0 && faces.length > 0 && faces[0].colors) {
    colors = faces[0].colors;
  }

  return {
    name: card.name,
    set: card.set_name,
    setCode: (card.set || '').toUpperCase(),
    collectorNumber: card.collector_number || '',
    rarity: card.rarity || '',
    typeLine: card.type_line || '',
    oracleText: oracleText,
    colors: colors,
    imageSmall: imgs.small || imgs.normal || '',
    tcgplayerId: tcgplayerId,
    // Variant info for TCGCSV fallback
    finishes: finishes,
    frameEffects: frameEffects,
    borderColor: borderColor,
    isEtched: isEtched,
    prices: {
      low: null, mid: null, high: null, market: null,
      lowFoil: null, midFoil: null, highFoil: null, marketFoil: null,
      usd: p.usd ? parseFloat(p.usd) : null,
      usdFoil: p.usd_foil ? parseFloat(p.usd_foil) : null,
      usdEtched: p.usd_etched ? parseFloat(p.usd_etched) : null,
      eur: p.eur ? parseFloat(p.eur) : null,
      eurFoil: p.eur_foil ? parseFloat(p.eur_foil) : null,
      source: 'scryfall'
    },
    links: {
      scryfall: safeUrl(card.scryfall_uri),
      cardmarket: safeUrl(card.purchase_uris?.cardmarket),
      tcgplayer: safeUrl(card.purchase_uris?.tcgplayer),
      ebay: '',
    }
  };
}
