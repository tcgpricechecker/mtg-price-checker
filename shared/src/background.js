// MTG Card Price Checker - Background Script v16
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
const RATE_MS = 100;
let lastRequest = 0;
let queueProcessing = false;

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
  } catch (e) {}
})();

setInterval(persistCache, CACHE_PERSIST_INTERVAL);

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
  } catch (e) {}
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
  } catch (e) {}
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
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    if (data.result === 'success' && data.rates) {
      exchangeRates = { rates: data.rates, ts: Date.now() };
      console.log('[MTG-PC] Exchange rates loaded');
      return data.rates;
    }
  } catch (e) {}
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
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.success || !data.results) return null;
      tcgcsvGroups = data.results;
      return tcgcsvGroups;
    } catch (e) {
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

  const normalize = s => s.toLowerCase()
    .replace(/[:\-–—''",\.!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'for', 'to', 'with']);
  const getWords = s => normalize(s).split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));

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

  const target = normalize(scryfallSetName);
  const targetWords = getWords(scryfallSetName);

  // TIER 1: Alias lookup
  const aliasKey = target.replace(/\s+/g, ' ');
  if (ALIASES[aliasKey]) {
    for (const alias of ALIASES[aliasKey]) {
      const aliasNorm = normalize(alias);
      for (const g of groups) {
        if (normalize(g.name) === aliasNorm) {
          return g.groupId;
        }
      }
    }
  }

  // TIER 2: Exact normalized match
  for (const g of groups) {
    if (normalize(g.name) === target) return g.groupId;
  }

  // TIER 3: Bidirectional word-overlap scoring
  let bestMatch = null;
  let bestScore = 0;
  const MIN_SCORE = 0.5;

  for (const g of groups) {
    const gn = normalize(g.name);
    const groupWords = getWords(g.name);
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
    const priceMap = new Map();
    for (const p of pricesData.results) {
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
    return null;
  }
}

/**
 * Find a product by card name (fuzzy match).
 */
function findProductByName(products, cardName) {
  if (!products || !cardName) return null;
  
  const normalize = s => s.toLowerCase()
    .replace(/[,.'":!?-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const targetName = normalize(cardName);
  
  // Exact match
  for (const p of products) {
    if (normalize(p.name) === targetName) return p;
  }
  
  // Starts-with match
  for (const p of products) {
    if (normalize(p.name).startsWith(targetName)) return p;
  }
  
  // Reverse starts-with
  for (const p of products) {
    if (targetName.startsWith(normalize(p.name))) return p;
  }
  
  // Contains match
  for (const p of products) {
    const pn = normalize(p.name);
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
  
  const normalize = s => s.toLowerCase()
    .replace(/[,.'":!?-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const baseName = normalize(cardName);
  
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
    const pn = normalize(p.name);
    
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
      const priceMap = new Map();
      for (const p of pricesData.results) {
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
      
      // Cache
      cached = { ts: Date.now(), prices: priceMap, products: productsData.results };
      TCGCSV_CACHE.set(groupId, cached);
      tcgcsvCacheDirty = true;
    } catch (e) {
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

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (REQUEST_QUEUE.length > 0) {
    const req = REQUEST_QUEUE.shift();

    const wait = RATE_MS - (Date.now() - lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();

    try {
      const r = await fetch(req.url);
      if (r.ok) {
        req.resolve(await r.json());
      } else {
        req.resolve(null);
      }
    } catch (e) {
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

  // TCGCSV Price Enrichment
  if (card.tcgplayerId && card.set) {
    try {
      const tcgPrices = await fetchTcgcsvPrices(card.tcgplayerId, card.set, card.name);
      
      if (tcgPrices) {
        card.prices.low = tcgPrices.low;
        card.prices.mid = tcgPrices.mid;
        card.prices.high = tcgPrices.high;
        card.prices.market = tcgPrices.market;
        card.prices.lowFoil = tcgPrices.lowFoil;
        card.prices.midFoil = tcgPrices.midFoil;
        card.prices.highFoil = tcgPrices.highFoil;
        card.prices.marketFoil = tcgPrices.marketFoil;
        
        // Check if we got any actual prices
        const hasAnyPrice = tcgPrices.low != null || tcgPrices.mid != null || 
          tcgPrices.market != null || tcgPrices.lowFoil != null || 
          tcgPrices.midFoil != null || tcgPrices.marketFoil != null;
        
        if (hasAnyPrice) {
          card.prices.source = 'tcgcsv';
        } else {
          // Product exists but no active listings
          card.prices.source = 'tcgcsv-no-listings';
        }
      }
    } catch (e) {}
  } else if (card.set) {
    // No tcgplayerId - try name-based lookup with variant info
    try {
      const tcgPrices = await fetchTcgcsvPricesByName(
        card.name, 
        card.set, 
        card.frameEffects || [], 
        card.finishes || [],
        card.borderColor || 'black'
      );
      
      if (tcgPrices) {
        card.prices.low = tcgPrices.low;
        card.prices.mid = tcgPrices.mid;
        card.prices.high = tcgPrices.high;
        card.prices.market = tcgPrices.market;
        card.prices.lowFoil = tcgPrices.lowFoil;
        card.prices.midFoil = tcgPrices.midFoil;
        card.prices.highFoil = tcgPrices.highFoil;
        card.prices.marketFoil = tcgPrices.marketFoil;
        
        // Check if we got any actual prices
        const hasAnyPrice = tcgPrices.low != null || tcgPrices.mid != null || 
          tcgPrices.market != null || tcgPrices.lowFoil != null || 
          tcgPrices.midFoil != null || tcgPrices.marketFoil != null;
        
        if (hasAnyPrice) {
          card.prices.source = 'tcgcsv';
        } else {
          card.prices.source = 'tcgcsv-no-listings';
        }
      }
    } catch (e) {}
  }

  return { success: true, data: card };
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

async function lookupByName(name, lang, setHint, variant) {
  const cleaned = simplify(name);
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
  if (setHint) {
    const printing = await findPrinting(card.name, setHint, variant);
    if (printing) match = printing;
  }

  const result = { success: true, data: formatCard(match) };
  setCache(key, result);
  return result;
}

// ═══════════════════════════════════════════
// FIND SPECIFIC PRINTING
// ═══════════════════════════════════════════
async function findPrinting(cardName, setHint, variant) {
  try {
    const data = await queuedFetch(`https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=set`);
    if (!data?.data?.length) return null;

    const printings = data.data;
    
    const norm = s => s.replace(/[:\-–—''",\.!?()]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
    
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
    
    // Tiered matching
    const exactMatches = [];
    const fuzzyMatches = [];
    
    printings.forEach(c => {
      const n = norm(c.set_name);
      
      // Exact match
      if (n === target) {
        exactMatches.push(c);
        return;
      }
      
      // Core match (strip extras/special/tokens)
      const targetCore = target.replace(/\b(extras|special|tokens)\b/gi, '').replace(/\s+/g, ' ').trim();
      const nCore = n.replace(/\b(extras|special|tokens)\b/gi, '').replace(/\s+/g, ' ').trim();
      
      if (nCore === targetCore) {
        exactMatches.push(c);
        return;
      }
      
      // Substring match
      if (nCore.length >= 4 && targetCore.length >= 4 &&
          (nCore.includes(targetCore) || targetCore.includes(nCore))) {
        fuzzyMatches.push(c);
        return;
      }
      
      // Word overlap
      const targetWords = targetCore.split(' ').filter(w => w.length > 2);
      const nWords = nCore.split(' ').filter(w => w.length > 2);
      const overlap = targetWords.filter(w => nWords.includes(w)).length;
      const minRequired = Math.min(targetWords.length, nWords.length);
      if (overlap >= minRequired && overlap >= 1 && minRequired >= 1) {
        fuzzyMatches.push(c);
      }
    });
    
    const setMatches = exactMatches.length > 0 ? exactMatches : fuzzyMatches;

    if (setMatches.length > 0) {
      const sortByNum = (a, b) => parseInt(a.collector_number) - parseInt(b.collector_number);
      
      const isExtrasUrl = /\b(extras|special|tokens|promos)\b/i.test(setHint);
      const isPromosUrl = /\b(promos)\b/i.test(setHint);

      if (setMatches.length > 1) {
        const SPECIAL_FRAMES = ['extendedart', 'showcase', 'borderless', 'inverted', 'etched', 'textured'];
        
        const annotated = setMatches.map(c => ({
          card: c,
          num: parseInt(c.collector_number),
          numStr: c.collector_number,
          isPromo: c.promo === true || /[a-z]$/i.test(c.collector_number),
          isSpecial: (c.frame_effects || []).some(f => SPECIAL_FRAMES.includes(f)) ||
                     c.border_color === 'borderless'
        }));
        
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

      return setMatches[0];
    }

    // Last resort: set code match
    const shortHint = setHint.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (shortHint.length <= 6) {
      const codeMatch = printings.find(c => c.set === shortHint);
      if (codeMatch) return codeMatch;
    }
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

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

  return {
    name: card.name,
    set: card.set_name,
    setCode: (card.set || '').toUpperCase(),
    collectorNumber: card.collector_number || '',
    rarity: card.rarity || '',
    typeLine: card.type_line || '',
    oracleText: oracleText,
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
      scryfall: card.scryfall_uri || '',
      cardmarket: card.purchase_uris?.cardmarket || '',
      tcgplayer: card.purchase_uris?.tcgplayer || '',
      ebay: '',
    }
  };
}
