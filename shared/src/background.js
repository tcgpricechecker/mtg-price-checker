// MTG Card Price Checker - Background Script v14
// Service worker that handles all API calls to Scryfall and exchange rate lookups.
// Scryfall provides USD and EUR prices natively; other currencies are converted from USD.
//
// APIs used:
//   - api.scryfall.com: Card search, price data, card images (free, no auth, 10 req/s)
//   - open.er-api.com:  Exchange rates for non-USD/EUR currencies (free, no auth)
//
// v14 changes:
//   - Global request queue with max 10 req/s across all tabs (FIFO)
//   - Cache persistence to chrome.storage.local (survives service worker restarts)
//   - Request deduplication (identical in-flight URLs share one fetch)
//   - Expired cache entries actively cleaned on read

// ─── CACHE ───
const SCRYFALL_CACHE = new Map();    // In-memory cache: key → { val, ts }
const CACHE_TTL = 30 * 60 * 1000;    // Cache lifetime: 30 minutes
const CACHE_MAX = 500;                // Max entries before eviction
const CACHE_PERSIST_INTERVAL = 60 * 1000; // Write cache to storage every 60s
let cacheDirty = false;               // True when in-memory cache has unsaved changes

// ─── GLOBAL REQUEST QUEUE ───
// Enforces Scryfall's rate limit across ALL tabs and concurrent lookups.
// Requests are processed FIFO with a minimum 100ms gap between requests.
const REQUEST_QUEUE = [];             // Queue of { url, resolve, reject }
const RATE_MS = 100;                  // Minimum ms between requests (10 req/s)
let lastRequest = 0;                  // Timestamp of last completed request
let queueProcessing = false;          // True when the queue processor loop is active

// ─── IN-FLIGHT DEDUPLICATION ───
// Prevents duplicate fetch() calls for the same URL when multiple tabs hover simultaneously.
const inFlight = new Map();           // url → Promise<json|null>

// ─── EXCHANGE RATES ───
let exchangeRates = null;                      // Cached rates: { rates: {...}, ts: timestamp }
const EXCHANGE_RATE_TTL = 24 * 60 * 60 * 1000;  // Refresh rates every 24 hours

// ═══════════════════════════════════════════
// STARTUP: Load persistent cache from chrome.storage.local
// ═══════════════════════════════════════════
(async function loadPersistentCache() {
  try {
    const data = await chrome.storage.local.get('mtgCache');
    if (data.mtgCache && Array.isArray(data.mtgCache)) {
      const now = Date.now();
      let loaded = 0;
      for (const [key, entry] of data.mtgCache) {
        if (entry.ts && (now - entry.ts) < CACHE_TTL) {
          SCRYFALL_CACHE.set(key, entry);
          loaded++;
        }
      }
      console.log('[MTG-PC] Loaded', loaded, 'cached entries from storage');
    }
  } catch (e) {
    console.log('[MTG-PC] Cache load error:', e.message);
  }
})();

// Periodically persist dirty cache to chrome.storage.local
setInterval(persistCache, CACHE_PERSIST_INTERVAL);

async function persistCache() {
  if (!cacheDirty) return;
  try {
    const entries = [...SCRYFALL_CACHE.entries()];
    await chrome.storage.local.set({ mtgCache: entries });
    cacheDirty = false;
    console.log('[MTG-PC] Persisted', entries.length, 'cache entries');
  } catch (e) {
    console.log('[MTG-PC] Cache persist error:', e.message);
  }
}

// ═══════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
});

async function handleSearch(query) {
  if (!query || query.length < 2) return { success: false, data: [] };
  try {
    const data = await queuedFetch(`https://api.scryfall.com/cards/autocomplete?q=${enc(query)}`);
    if (data) return { success: true, data: data.data || [] };
  } catch (e) {
    console.log('[MTG-PC] Autocomplete error:', e.message);
  }
  return { success: false, data: [] };
}

// ═══════════════════════════════════════════
// EXCHANGE RATES
// ═══════════════════════════════════════════
async function fetchExchangeRates() {
  if (exchangeRates && Date.now() - exchangeRates.ts < EXCHANGE_RATE_TTL) {
    return exchangeRates.rates;
  }
  try {
    console.log('[MTG-PC] Fetching exchange rates...');
    // Exchange rate API is NOT Scryfall — fetch directly without queue
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    if (data.result === 'success' && data.rates) {
      exchangeRates = { rates: data.rates, ts: Date.now() };
      console.log('[MTG-PC] Exchange rates loaded:', Object.keys(data.rates).length, 'currencies');
      return data.rates;
    }
  } catch (e) {
    console.log('[MTG-PC] Exchange rate fetch failed:', e.message);
  }
  return { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.53, JPY: 149, CHF: 0.88 };
}

async function getExchangeRate(currency) {
  const rates = await fetchExchangeRates();
  return { currency, rate: rates[currency] || null };
}

// ═══════════════════════════════════════════
// GLOBAL REQUEST QUEUE
// ═══════════════════════════════════════════

/**
 * Queue a fetch request to Scryfall. Returns parsed JSON or null on error/404.
 * Enforces global 100ms minimum gap between requests (≤10 req/s).
 * Deduplicates: identical in-flight URLs share a single fetch.
 */
function queuedFetch(url) {
  // Deduplication: piggyback on an identical in-flight request
  if (inFlight.has(url)) {
    return inFlight.get(url);
  }

  const promise = new Promise((resolve) => {
    REQUEST_QUEUE.push({ url, resolve });
    processQueue();
  });

  inFlight.set(url, promise);
  promise.finally(() => inFlight.delete(url));

  return promise;
}

/** Process the request queue FIFO, enforcing rate limits. */
async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (REQUEST_QUEUE.length > 0) {
    const req = REQUEST_QUEUE.shift();

    // Enforce minimum gap between requests
    const wait = RATE_MS - (Date.now() - lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();

    try {
      const r = await fetch(req.url);
      if (r.ok) {
        req.resolve(await r.json());
      } else {
        if (r.status !== 404) console.log('[MTG-PC] API', r.status, req.url.substring(0, 80));
        req.resolve(null);
      }
    } catch (e) {
      console.log('[MTG-PC] Fetch error:', e.message, req.url.substring(0, 60));
      req.resolve(null);
    }
  }

  queueProcessing = false;
}

// ═══════════════════════════════════════════
// MAIN LOOKUP
// ═══════════════════════════════════════════
async function handleLookup(msg) {
  const { cardName, lang, tcgplayerId, setHint, setCode, collectorNumber, scryfallId, variant } = msg;
  console.log('[MTG-PC] === LOOKUP ===', JSON.stringify({ cardName, tcgplayerId, scryfallId, setCode, collectorNumber, setHint, variant, lang }));

  let result;

  if (scryfallId) {
    result = await lookupByScryfallId(scryfallId);
  } else if (tcgplayerId) {
    result = await lookupByTcgId(tcgplayerId);
  } else if (setCode && collectorNumber) {
    result = await lookupByCollector(setCode, collectorNumber);
  } else if (setCode && cardName) {
    result = await lookupByNameAndSet(cardName, setCode);
  } else {
    result = await lookupByName(cardName, lang, setHint, variant);
  }

  if (!result.success) return result;

  const card = JSON.parse(JSON.stringify(result.data));
  card.links.ebay = buildEbayLink(card.name, card.set);

  console.log('[MTG-PC] === RESULT ===', card.name, '|', card.set, '(' + card.setCode + ')',
    'USD:', card.prices.usd, '/ EUR:', card.prices.eur);
  return { success: true, data: card };
}

/** Generate an eBay search URL for a card. */
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

async function lookupByName(name, lang, setHint, variant) {
  const cleaned = simplify(name);
  const key = `name:${cleaned}:${setHint || ''}:${variant || ''}`;
  const cached = getCache(key);
  if (cached) {
    console.log('[MTG-PC] Cache HIT for', key);
    return cached;
  }

  console.log('[MTG-PC] Cache MISS, fetching:', cleaned, 'setHint:', setHint, 'variant:', variant);
  const card = await queuedFetch(`https://api.scryfall.com/cards/named?fuzzy=${enc(cleaned)}`);
  if (!card) {
    const result = { success: false, error: `"${cleaned}" not found` };
    setCache(key, result);
    return result;
  }

  console.log('[MTG-PC] Fuzzy found:', card.name, card.set_name, '#' + card.collector_number);
  let match = card;
  if (setHint) {
    console.log('[MTG-PC] Calling findPrinting with setHint:', setHint, 'variant:', variant);
    const printing = await findPrinting(card.name, setHint, variant);
    if (printing) {
      console.log('[MTG-PC] findPrinting returned:', printing.set_name, '#' + printing.collector_number);
      match = printing;
    } else {
      console.log('[MTG-PC] findPrinting returned NULL, using fuzzy result');
    }
  }

  const result = { success: true, data: formatCard(match) };
  setCache(key, result);
  return result;
}

// ═══════════════════════════════════════════
// FIND SPECIFIC PRINTING
// Uses base-vs-extras approach for Cardmarket variant detection.
// See v1.3.0 changelog for rationale.
// ═══════════════════════════════════════════
async function findPrinting(cardName, setHint, variant) {
  try {
    const data = await queuedFetch(`https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=set`);
    if (!data?.data?.length) return null;

    const printings = data.data;
    const norm = s => s.replace(/[:\-–—''",\.!?()]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
    const target = norm(setHint);
    
    console.log('[MTG-PC] Searching', printings.length, 'printings for:', cardName);
    console.log('[MTG-PC] All sets:', printings.map((c, i) => `${i + 1}. ${c.set_name} #${c.collector_number}`).join(' | '));
    console.log('[MTG-PC] Looking for setHint:', setHint, '(normalized:', target + ')');
    
    // ── TIERED SET MATCHING ──
    // TIER 1: Exact name match or core match (strip Cardmarket-specific suffixes)
    // TIER 2: Substring or word-overlap match (fallback only if no Tier 1 hits)
    const exactMatches = [];
    const fuzzyMatches = [];
    
    printings.forEach(c => {
      const n = norm(c.set_name);
      
      // TIER 1: Exact match
      if (n === target) {
        console.log('[MTG-PC]   ✓ Exact match:', c.set_name, '#' + c.collector_number);
        exactMatches.push(c);
        return;
      }
      
      // TIER 1: Core match (strip Cardmarket hints: extras/special/tokens, NOT promos)
      const targetCore = target.replace(/\b(extras|special|tokens)\b/gi, '').replace(/\s+/g, ' ').trim();
      const nCore = n.replace(/\b(extras|special|tokens)\b/gi, '').replace(/\s+/g, ' ').trim();
      
      if (nCore === targetCore) {
        console.log('[MTG-PC]   ✓ Core match:', c.set_name, '#' + c.collector_number, '(core:', nCore, ')');
        exactMatches.push(c);
        return;
      }
      
      // TIER 2: Substring match
      if (nCore.length >= 4 && targetCore.length >= 4 &&
          (nCore.includes(targetCore) || targetCore.includes(nCore))) {
        console.log('[MTG-PC]   ~ Substring match:', c.set_name, '#' + c.collector_number);
        fuzzyMatches.push(c);
        return;
      }
      
      // TIER 2: Word overlap for reordered words
      const targetWords = targetCore.split(' ').filter(w => w.length > 2);
      const nWords = nCore.split(' ').filter(w => w.length > 2);
      const overlap = targetWords.filter(w => nWords.includes(w)).length;
      const minRequired = Math.min(targetWords.length, nWords.length);
      if (overlap >= minRequired && overlap >= 1 && minRequired >= 1) {
        console.log('[MTG-PC]   ~ Word match:', c.set_name, '#' + c.collector_number, `(${overlap}/${targetWords.length} words)`);
        fuzzyMatches.push(c);
      }
    });
    
    // Prefer exact matches; fall back to fuzzy only when no exact matches exist
    const setMatches = exactMatches.length > 0 ? exactMatches : fuzzyMatches;
    if (exactMatches.length > 0 && fuzzyMatches.length > 0) {
      console.log('[MTG-PC] Discarding', fuzzyMatches.length, 'fuzzy matches in favor of', exactMatches.length, 'exact matches');
    }
    
    console.log('[MTG-PC] Final matches:', setMatches.length, '→', setMatches.map(c => c.set_name + ' #' + c.collector_number).join(', '));

    if (setMatches.length > 0) {
      const sortByNum = (a, b) => parseInt(a.collector_number) - parseInt(b.collector_number);
      
      // ── BASE-VS-EXTRAS VARIANT DETECTION ──
      // isExtrasUrl: true when Cardmarket URL contains "Extras", "Special", "Tokens", or "Promos"
      // CRITICAL: "Commander" is a real set name prefix, NOT an extras indicator!
      const isExtrasUrl = /\b(extras|special|tokens|promos)\b/i.test(setHint);
      const isPromosUrl = /\b(promos)\b/i.test(setHint);

      console.log('[MTG-PC] Set matches in', setHint + ':', setMatches.length, 
        'cards, isExtrasUrl:', isExtrasUrl, 'isPromosUrl:', isPromosUrl, 'variant:', variant);
      
      // Debug: log all matches with frame effects and border
      if (setMatches.length <= 10) {
        setMatches.forEach(c => {
          console.log('[MTG-PC]   →', '#' + c.collector_number, c.name, 
            'frame:', JSON.stringify(c.frame_effects || []),
            'border:', c.border_color || 'black',
            'promo:', c.promo || false);
        });
      }

      // When multiple printings exist in the same set, categorize them
      if (setMatches.length > 1) {
        // CRITICAL: Use exact includes() matching for frame effects, NOT regex/substring!
        const SPECIAL_FRAMES = ['extendedart', 'showcase', 'borderless', 'inverted', 'etched', 'textured'];
        
        // Annotate each card with its category
        // CRITICAL: Access properties on the card object itself, not on the annotated wrapper
        const annotated = setMatches.map(c => ({
          card: c,
          num: parseInt(c.collector_number),
          numStr: c.collector_number,
          isPromo: c.promo === true || /[a-z]$/i.test(c.collector_number),
          isSpecial: (c.frame_effects || []).some(f => SPECIAL_FRAMES.includes(f)) ||
                     c.border_color === 'borderless'
        }));
        
        // Base = not promo, not special frame/border, lowest collector number
        // CRITICAL: Sort annotated objects by .num, NOT by .collector_number
        const baseCandidates = annotated
          .filter(c => !c.isPromo && !c.isSpecial)
          .sort((a, b) => a.num - b.num);
        const base = baseCandidates[0] || null;
        
        // Extras = everything that is NOT the base and NOT a promo
        const extras = annotated
          .filter(c => c !== base && !c.isPromo)
          .sort((a, b) => a.num - b.num);
        
        // Promos = promo cards only
        const promos = annotated.filter(c => c.isPromo).sort((a, b) => a.num - b.num);
        
        console.log('[MTG-PC] → Base:', base ? '#' + base.numStr : 'none',
          '| Extras:', extras.map(c => '#' + c.numStr).join(', '),
          '| Promos:', promos.map(c => '#' + c.numStr).join(', '));

        if (isPromosUrl) {
          if (promos.length > 0) {
            const idx = (variant != null && variant >= 1) ? Math.min(variant - 1, promos.length - 1) : 0;
            console.log('[MTG-PC] → Promos: picking #' + promos[idx].numStr);
            return promos[idx].card;
          }
        } else if (isExtrasUrl && variant != null && variant >= 1) {
          if (extras.length > 0) {
            const idx = Math.min(variant - 1, extras.length - 1);
            console.log('[MTG-PC] → Extras V' + variant + ': picking', (idx + 1), 'of', extras.length,
              '#' + extras[idx].numStr);
            return extras[idx].card;
          }
        } else if (isExtrasUrl) {
          if (extras.length > 0) {
            console.log('[MTG-PC] → Extras (no variant): picking first #' + extras[0].numStr);
            return extras[0].card;
          }
        } else if (variant != null && variant >= 1) {
          const sorted = [...setMatches].sort(sortByNum);
          const idx = Math.min(variant - 1, sorted.length - 1);
          console.log('[MTG-PC] → Non-extras V' + variant + ': picking #' + sorted[idx].collector_number);
          return sorted[idx];
        } else {
          // Non-extras, no variant → PREFER the base version
          if (base) {
            console.log('[MTG-PC] → Non-extras: preferring base #' + base.numStr);
            return base.card;
          }
          console.log('[MTG-PC] → Non-extras: no base found, using first match');
        }
      }

      return setMatches[0];
    }

    // Last resort: set code match (e.g., "mh2" directly)
    const shortHint = setHint.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (shortHint.length <= 6) {
      const codeMatch = printings.find(c => c.set === shortHint);
      if (codeMatch) return codeMatch;
    }
  } catch (e) {
    console.log('[MTG-PC] findPrinting error:', e.message || e);
  }
  return null;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

/** Clean card name by removing set info, foil suffixes, and variant markers. */
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
  // Expired entry: actively clean up
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
// FORMAT (Scryfall → our format)
// ═══════════════════════════════════════════
/** Convert a Scryfall card object into our internal format. */
function formatCard(card) {
  const p = card.prices || {};
  const faces = card.card_faces || [];
  const imgs = card.image_uris || faces[0]?.image_uris || {};

  // Oracle text: for multi-face cards, combine both faces
  let oracleText = card.oracle_text || '';
  if (!oracleText && faces.length > 0) {
    oracleText = faces.map(f => f.oracle_text || '').filter(Boolean).join('\n// \n');
  }

  return {
    name: card.name,
    set: card.set_name,
    setCode: (card.set || '').toUpperCase(),
    rarity: card.rarity || '',
    typeLine: card.type_line || '',
    oracleText: oracleText,
    imageSmall: imgs.small || imgs.normal || '',
    prices: {
      usd:      p.usd      ? parseFloat(p.usd)      : null,
      usdFoil:  p.usd_foil ? parseFloat(p.usd_foil)  : null,
      eur:      p.eur      ? parseFloat(p.eur)       : null,
      eurFoil:  p.eur_foil ? parseFloat(p.eur_foil)  : null,
    },
    links: {
      scryfall: card.scryfall_uri || '',
      cardmarket: card.purchase_uris?.cardmarket || '',
      tcgplayer: card.purchase_uris?.tcgplayer || '',
      ebay: '',
    }
  };
}
