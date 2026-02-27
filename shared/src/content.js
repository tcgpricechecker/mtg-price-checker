// MTG Card Price Checker - Content Script
// Displays card prices from TCGCSV (TCGPlayer) when hovering over card links on MTG websites.
// All prices are in USD from TCGPlayer, converted to user's local currency.
// Scryfall trend prices used as fallback when TCGCSV data is unavailable.

(function () {
  'use strict';

  // ─── DEBUG LOGGING ───
  const log = (...a) => console.log('[MTG-PC]', ...a);

  // ─── SERVICE WORKER MESSAGING ───
  // Firefox MV3: background event page may be inactive when content script loads.
  // chrome.runtime.sendMessage() silently fails if nobody is listening.
  // Solution: Wake the background with a port connection + PING before first use.

  let backgroundReady = false;

  async function wakeBackground() {
    if (backgroundReady) return true;
    for (let i = 0; i < 5; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'PING' });
        if (res?.pong) {
          backgroundReady = true;
          log('Background ready');
          return true;
        }
      } catch (e) {
        // Connection failed — background not yet alive
      }
      // Open and close a port to force Firefox to start the background script
      try {
        const port = chrome.runtime.connect({ name: 'wake' });
        port.disconnect();
      } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
    log('Background failed to wake after retries');
    return false;
  }

  async function sendMessage(msg, retries = 2) {
    if (!backgroundReady) await wakeBackground();
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await chrome.runtime.sendMessage(msg);
        if (res === undefined && i < retries) {
          // Firefox may return undefined if background went back to sleep
          log('Empty response, retrying...', i + 1);
          backgroundReady = false;
          await wakeBackground();
          continue;
        }
        return res;
      } catch (e) {
        if (i < retries) {
          log('Background not ready, retrying...', i + 1);
          backgroundReady = false;
          await wakeBackground();
        } else {
          throw e;
        }
      }
    }
  }

  // ─── STATE ───
  let popup = null;              // The popup DOM element
  let currentCard = null;        // JSON key of the currently displayed card (prevents stale renders)
  let hoverTimeout = null;       // Delay before showing popup on hover
  let hideTimeout = null;        // Delay before hiding popup
  let attachedCount = 0;         // Total number of card elements we've attached listeners to
  let mouseX = 0, mouseY = 0;   // Current mouse position (used for hover-still-valid check)
  let activeTriggerEl = null;    // The DOM element that triggered the current popup
  let popupTouched = false;      // True once the user's mouse has entered the popup

  // ─── REQUEST GENERATION ───
  // Incremented on every new hover. Stale responses (where generation doesn't match) are discarded.
  let requestGeneration = 0;

  // ─── DRAG STATE ───
  let isDragging = false;
  let isResizing = false;
  let dragOffsetX = 0, dragOffsetY = 0;

  // ─── SAVED POSITION ───
  let savedPos = null; // { x, y, w, h } in viewport pixels

  // ─── ORACLE TEXT STATE ───
  let oracleExpanded = false;

  // ─── SHADOW DOM ROOT ───
  let shadowRoot = null;

  // ─── HOVER POPUP ENABLED ───
  let hoverEnabled = true; // Default: enabled. Loaded from chrome.storage on init.

  // ─── CURRENCY DETECTION ───
  const LOCALE_TO_CUR = {
    'de': 'EUR', 'fr': 'EUR', 'es': 'EUR', 'it': 'EUR', 'nl': 'EUR', 'pt': 'EUR',
    'el': 'EUR', 'fi': 'EUR', 'sk': 'EUR', 'sl': 'EUR', 'et': 'EUR', 'lv': 'EUR',
    'lt': 'EUR', 'mt': 'EUR', 'ga': 'EUR', 'be': 'EUR', 'ie': 'EUR',
    'en-GB': 'GBP', 'en-AU': 'AUD', 'en-CA': 'CAD', 'en-NZ': 'NZD',
    'ja': 'JPY', 'zh': 'CNY', 'ko': 'KRW',
    'sv': 'SEK', 'nb': 'NOK', 'nn': 'NOK', 'no': 'NOK', 'da': 'DKK',
    'pl': 'PLN', 'cs': 'CZK', 'hu': 'HUF', 'ro': 'RON', 'bg': 'BGN',
    'tr': 'TRY', 'ru': 'RUB', 'uk': 'UAH',
    'pt-BR': 'BRL', 'es-MX': 'MXN', 'en-IN': 'INR',
    'he': 'ILS', 'th': 'THB', 'zh-TW': 'TWD', 'zh-HK': 'HKD',
  };

  const CUR_SYM = {
    USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', CHF: 'CHF',
    SEK: 'kr', NOK: 'kr', DKK: 'kr', PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
    BRL: 'R$', MXN: 'MX$', CNY: '¥', KRW: '₩', TRY: '₺', INR: '₹',
    RON: 'lei', BGN: 'лв', RUB: '₽', UAH: '₴', ILS: '₪', THB: '฿',
    NZD: 'NZ$', TWD: 'NT$', HKD: 'HK$',
  };

  let userCurrency = 'USD';
  let exchangeRate = 1;
  let sellerCountry = '';

  function detectCurrency() {
    const lang = navigator.language || navigator.userLanguage || 'en-US';
    userCurrency = LOCALE_TO_CUR[lang] || LOCALE_TO_CUR[lang.split('-')[0]] || 'USD';
    log('Locale:', lang, '→', userCurrency);
  }

  function loadSellerCountry() {
    try {
      chrome.storage.local.get('sellerCountry', (data) => {
        if (data.sellerCountry) {
          sellerCountry = data.sellerCountry;
          log('Seller country:', sellerCountry);
        }
      });
      // Listen for changes from settings page
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.sellerCountry) {
          sellerCountry = changes.sellerCountry.newValue || '';
          log('Seller country updated:', sellerCountry);
        }
      });
    } catch (e) { /* extension context may be invalidated */ }
  }

  function applySellerCountry(url) {
    if (!url || !sellerCountry) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'sellerCountry=' + sellerCountry;
  }

  async function loadExchangeRate() {
    if (userCurrency === 'USD') return;
    try {
      const res = await sendMessage({ type: 'GET_EXCHANGE_RATE', currency: userCurrency });
      if (res?.rate) {
        exchangeRate = res.rate;
        log('Rate: 1 USD =', exchangeRate, userCurrency);
      }
    } catch (e) { log('Exchange rate error:', e); }
  }

  function getPrice(prices, type) {
    const eurVal = type === 'foil' ? prices.eurFoil : prices.eur;
    const usdVal = type === 'foil' ? prices.usdFoil : prices.usd;
    if (userCurrency === 'EUR') {
      if (eurVal != null) return eurVal;
      if (usdVal != null) return usdVal * exchangeRate;
      return null;
    }
    if (userCurrency === 'USD') return usdVal;
    if (usdVal != null) return usdVal * exchangeRate;
    return null;
  }

  function fmtPrice(val) {
    if (val == null) return null;
    const sym = CUR_SYM[userCurrency] || userCurrency;
    const noDecimals = userCurrency === 'JPY' || userCurrency === 'KRW';
    return sym + (noDecimals ? Math.round(val).toString() : val.toFixed(2));
  }

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }, { passive: true });

  // ═══════════════════════════════════════════════════
  // SITE CONFIGS
  // Each supported site defines:
  //   test(href): returns true if a link's href matches a card URL pattern
  //   selectors: CSS selectors for card elements (used if test alone isn't enough)
  //   extract(el): extracts card info { name, setHint, variant, ... } from an element
  //   spa: if true, enables periodic rescan for late-rendering React/SPA content
  //   findHoverTarget(el): optional — given a matched element, return the element to
  //                        actually attach hover listeners to (e.g., a visible parent container)
  // ═══════════════════════════════════════════════════
  const SITES = {

    // ─── CARDMARKET ───
    'www.cardmarket.com': {
      test: (href) => /\/Products\/Singles\/[^/]+\/.+/.test(href),
      extract: (el) => {
        const href = el.href || '';
        const m = href.match(/\/Singles\/([^/]+)\/([^/?#]+)/);
        if (m) {
          let setSlug = decodeURIComponent(m[1]).replace(/-/g, ' ').trim();
          // Remove "Magic The Gathering" prefix that Cardmarket adds to some sets
          setSlug = setSlug.replace(/^Magic\s+The\s+Gathering\s+/i, '').trim();
          let cardSlug = decodeURIComponent(m[2]).replace(/-/g, ' ').trim();
          let variant = null;
          const vMatch = cardSlug.match(/\s+V\s*\.?\s*(\d+)\s*$/i);
          if (vMatch) {
            variant = parseInt(vMatch[1]);
            cardSlug = cardSlug.replace(/\s+V\s*\.?\s*\d+\s*$/i, '').trim();
          }
          // Extract Cardmarket product ID from thumbnail image URL.
          // Pattern: product-images.s3.cardmarket.com/1/SET/{ID}/{ID}.jpg
          // Search: inside link → parent container → previous sibling
          let cardmarketProductId = null;
          const cmImgPattern = /product-images\.s3\.cardmarket\.com\/\d+\/\w+\/(\d+)\//;
          const findCmImage = (root) => {
            if (!root) return null;
            const img = root.querySelector('img[src*="product-images"]');
            return img ? img.src.match(cmImgPattern) : null;
          };
          let idMatch = findCmImage(el);
          if (!idMatch) {
            // Search parent container (table row, card tile, etc.)
            idMatch = findCmImage(el.closest('tr, .row, .col, [class*="card"], [class*="product"], [class*="result"]'));
          }
          if (!idMatch && el.previousElementSibling) {
            // Some layouts put the image in a sibling element before the link
            idMatch = findCmImage(el.previousElementSibling);
          }
          if (idMatch) cardmarketProductId = parseInt(idMatch[1]);
          if (cardSlug.length >= 2) {
            return { name: cardSlug, setHint: setSlug, variant, productUrl: href, cardmarketProductId };
          }
        }
        const text = cardText(el);
        if (text) return { name: text };
        return null;
      }
    },

    // ─── TCGPLAYER ───
    'www.tcgplayer.com': {
      test: (href) => /tcgplayer\.com\/product\/\d+/.test(href),
      selectors: ['a[href*="/product/"]'],
      extract: extractTcgPlayer
    },
    'shop.tcgplayer.com': {
      test: (href) => /tcgplayer\.com\/product\/\d+/.test(href),
      selectors: ['a[href*="/product/"]'],
      extract: extractTcgPlayer
    },

    // ─── EDHREC ───
    // Commander deck recommendations site (React SPA).
    //
    // DOM analysis (2025-02-13):
    //   - Card names: <span class="Card_name__XXXXX"> inside <div class="Card_nameWrapper__XXXXX">
    //   - Card tiles: parent containers hold both image and name
    //   - No data-card-name attributes exist
    //   - CSS module hashes change between deploys → match prefix only
    //   - Card images/overlays intercept mouse events ABOVE the name spans
    //
    // Strategy: EVENT DELEGATION
    //   Per-element listeners fail because card images cover the name spans.
    //   Instead: scan finds name spans → stamps card containers with data attrs →
    //   ONE document-level mouseover walks up from any hovered element to find stamped containers.
    'edhrec.com': {
      test: (href) => /edhrec\.com\/(cards|commanders)\//.test(href),
      spa: true,
      delegation: true,
      selectors: [
        '[class*="Card_name__"]',
        'a[href*="/cards/"]',
        'a[href*="/commanders/"]'
      ],
      extract: (el) => {
        if (el.tagName === 'A') {
          const href = el.href || '';
          const m = href.match(/\/(cards|commanders)\/([^/?#]+)/);
          if (m) {
            const name = decodeURIComponent(m[2]).replace(/-/g, ' ').trim();
            if (name.length >= 2) return { name };
          }
        }
        const text = cardText(el);
        if (!text) return null;
        if (/^(New|Top|High Synergy|Creatures|Instants|Sorceries|Artifacts|Enchantments|Planeswalkers|Lands|Mana Artifacts|View More|Budget|Expensive|Most Popular|Synergy|Commander|Theme|Tribe|Primer)$/i.test(text)) return null;
        return { name: text };
      }
    },

    // ─── SCRYFALL ───
    'scryfall.com': {
      test: (href) => /scryfall\.com\/card\/[a-z0-9]+\/[^/]/.test(href),
      selectors: ['a[data-card-name]'],
      extract: extractScryfall
    },

  };

  // ─── DOMAIN ALIASES ───
  SITES['www.scryfall.com'] = SITES['scryfall.com'];
  SITES['cardmarket.com'] = SITES['www.cardmarket.com'];
  SITES['www.edhrec.com'] = SITES['edhrec.com'];

  // ─── REDDIT ───
  const redditConfig = {
    test: (href) => /cards\.scryfall\.io\//.test(href) || /scryfall\.com\/card\//.test(href),
    selectors: ['a[href*="cards.scryfall.io"]', 'a[href*="scryfall.com/card/"]'],
    extract: (el) => {
      const href = el.href || '';
      const imgMatch = href.match(/cards\.scryfall\.io\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (imgMatch) return { name: cardText(el) || 'Unknown', scryfallId: imgMatch[1] };
      return extractScryfall(el);
    }
  };
  SITES['www.reddit.com'] = redditConfig;
  SITES['old.reddit.com'] = redditConfig;
  SITES['reddit.com'] = redditConfig;

  // ═══════════════════════════════════════════
  // EXTRACTORS
  // ═══════════════════════════════════════════

  function extractTcgPlayer(el) {
    const href = el.href || '';
    const m = href.match(/\/product\/(\d+)/);
    if (!m) return null;

    const slugInfo = parseTcgPlayerSlug(href);

    // Try multiple sources for card name (most to least reliable)
    const name = cardText(el)
      || tcgImageAlt(el)
      || slugInfo?.nameFallback
      || 'Unknown';

    // Derive setHint: strip card name from slug to isolate set name.
    // Generic approach — no hardcoded set prefixes needed.
    let setHint = null;
    if (slugInfo?.cleanSlug && name !== 'Unknown') {
      setHint = deriveSetHintFromSlug(slugInfo.cleanSlug, name);
    }

    return { name, tcgplayerId: m[1], setHint };
  }

  /** Extract card name from img alt text inside a TCGPlayer link element. */
  function tcgImageAlt(el) {
    const alt = el.querySelector('img[alt]')?.alt?.trim();
    if (!alt || alt.length < 2) return null;
    // TCGPlayer alt text often has format: "Card Name (1234) (Rainbow Foil) [Set Name]"
    // Strip collector number in parens, finish info in parens, and set name in brackets
    const cleaned = alt
      .replace(/\s*\([\d★]+\)\s*/g, '')               // (1234), (2289★)
      .replace(/\s*\((?:Rainbow )?(?:Foil|Etched|Nonfoil|Surge Foil|Confetti Foil|Galaxy Foil|Textured Foil|Gilded Foil|Step-and-Compleat Foil|Serialized|Halo Foil|Borderless)\)\s*/gi, '')
      .replace(/\s*\[.*?\]\s*/g, '')                   // [Set Name]
      .trim();
    return cleaned.length >= 2 ? cleaned : null;
  }

  /**
   * Parse TCGPlayer product URL slug.
   * Returns cleanSlug (for set derivation) and nameFallback (last-resort card name).
   */
  function parseTcgPlayerSlug(href) {
    const m = href.match(/\/product\/\d+\/([^?#]+)/);
    if (!m) return null;
    let slug = m[1];

    // Strip game prefix
    slug = slug.replace(/^magic-the-gathering-/, '').replace(/^magic-/, '');

    // Strip trailing finish/variant info
    slug = slug.replace(/-(?:rainbow-foil|surge-foil|confetti-foil|galaxy-foil|textured-foil|gilded-foil|halo-foil|step-and-compleat-foil|foil-etched|etched-foil|foil|etched|nonfoil|borderless)$/, '');
    // Strip trailing collector number
    slug = slug.replace(/-\d+$/, '');

    // nameFallback: last-resort name guess (just use the whole slug as-is)
    const nameFallback = slug.replace(/-/g, ' ').trim();

    return {
      cleanSlug: slug,
      nameFallback: nameFallback.length >= 2 ? nameFallback : null
    };
  }

  /**
   * Derive a set hint by stripping the card name from the TCGPlayer slug.
   * E.g. slug "art-series-strixhaven-lightning-bolt-art-card" + name "Lightning Bolt Art Card"
   *   → card as slug: "lightning-bolt-art-card"
   *   → strip from end: "art-series-strixhaven"
   *   → set hint: "art series strixhaven"
   */
  function deriveSetHintFromSlug(cleanSlug, cardName) {
    // Normalize card name to slug form
    const nameSlug = cardName.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!nameSlug || nameSlug.length < 2) return null;

    // Find rightmost occurrence of card name in slug
    const idx = cleanSlug.lastIndexOf(nameSlug);
    if (idx <= 0) return null;  // Not found, or at start (no set prefix)

    // Everything before it is the set slug
    const setSlug = cleanSlug.substring(0, idx).replace(/-+$/, '');
    if (setSlug.length < 2) return null;

    return setSlug.replace(/-/g, ' ').trim();
  }

  function extractScryfall(el) {
    const href = el.href || '';
    const m = href.match(/\/card\/([a-z0-9]+)\/([^/?#]+)/);
    if (m) {
      const collectorNumber = decodeURIComponent(m[2]);
      return {
        name: el.dataset?.cardName || cardText(el) || collectorNumber.replace(/-/g, ' '),
        setCode: m[1],
        collectorNumber: collectorNumber
      };
    }
    const name = el.dataset?.cardName || cardText(el);
    return name ? { name } : null;
  }

  /**
   * Extract clean card name text from a DOM element.
   * Only uses direct text content of the element itself (not deeply nested children)
   * to avoid picking up prices, quantities, or other unrelated text.
   */
  function cardText(el) {
    // Prefer direct/shallow text content for more precise extraction
    let text = '';
    // If the element has few children, use textContent directly
    if (el.childElementCount === 0) {
      text = (el.textContent || '').trim();
    } else {
      // For elements with children, try to get just the direct text nodes
      // plus any simple inline children (span, em, strong)
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag === 'SPAN' || tag === 'EM' || tag === 'STRONG' || tag === 'B' || tag === 'I') {
              walk(child);
            }
          }
        }
      };
      walk(el);
      text = text.trim();
    }

    if (text.length < 2 || text.length > 80) return null;
    if (/^\d+$/.test(text) || /^[^a-zA-Z]*$/.test(text)) return null;
    return text;
  }

  // ═══════════════════════════════════════════
  // INIT & SCAN
  // ═══════════════════════════════════════════

  function init() {
    const host = window.location.hostname;
    const config = SITES[host];
    if (!config) return;
    log('Init on', host);

    // Load hover-popup setting (default: enabled)
    try {
      chrome.storage.local.get('hoverEnabled', (data) => {
        if (data.hoverEnabled === false) {
          hoverEnabled = false;
          log('Hover popup disabled by user setting');
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.hoverEnabled) {
          hoverEnabled = changes.hoverEnabled.newValue !== false;
          log('Hover popup', hoverEnabled ? 'enabled' : 'disabled');
          if (!hoverEnabled) hidePopup();
        }
      });
    } catch (e) {
      // Extension context may not be available (e.g. during page unload)
    }    detectCurrency();
    loadSellerCountry();
    loadExchangeRate();
    createPopup();

    // ─── EVENT DELEGATION ───
    // For sites where card images/overlays intercept mouse events above
    // the card name elements (e.g., EDHREC), use document-level event delegation
    // instead of per-element listeners.
    if (config.delegation) {
      setupDelegation(config);
    }

    const scan = () => scanPage(config);

    // Immediate + delayed scans to catch content at different render stages
    setTimeout(scan, 300);
    setTimeout(scan, 1000);
    setTimeout(scan, 3000);
    setTimeout(scan, 8000);

    // ─── SPA PERIODIC RESCAN ───
    // For React/SPA sites, content may render at unpredictable times.
    // Run a periodic rescan every 3 seconds for the first 30 seconds.
    if (config.spa) {
      log('SPA mode: enabling periodic rescan');
      let spaScans = 0;
      const spaInterval = setInterval(() => {
        spaScans++;
        scan();
        if (spaScans >= 10) { // 10 × 3s = 30s
          clearInterval(spaInterval);
          log('SPA periodic rescan complete after', spaScans, 'scans');
        }
      }, 3000);
    }

    // Re-scan when DOM changes (SPA navigation, lazy loading, etc.)
    // 800ms debounce to avoid excessive scanning on React/SPA sites
    new MutationObserver(() => {
      clearTimeout(init._t);
      init._t = setTimeout(scan, 800);
    }).observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Scan the page for card elements and attach hover listeners.
   * For delegation sites, stamps data attributes instead of attaching per-element listeners.
   */
  function scanPage(config) {
    let n = 0;
    const seen = new Set();

    // ─── DELEGATION MODE ───
    // Stamp card containers with data-mtg-card-info instead of attaching listeners.
    // The document-level mouseover handler (setupDelegation) will find these.
    if (config.delegation) {

      // Shared walk-up logic: stamp parent containers so that hovering the card IMAGE
      // (a sibling branch of the name/link element) also triggers the popup.
      // Stops when hitting a container that holds multiple different cards.
      function stampParents(el, infoJson) {
        let parent = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!parent || parent === document.body) break;
          // If parent has a DIFFERENT card's stamp, this container is shared.
          // Remove the stale stamp (it would cause wrong popups) and stop.
          if (parent.dataset.mtgCardInfo && parent.dataset.mtgCardInfo !== infoJson) {
            delete parent.dataset.mtgCardInfo;
            break;
          }
          // Don't stamp containers that hold multiple card name elements
          // Count only DISTINCT card infos to allow multiple stamps for the SAME card
          const stamps = parent.querySelectorAll('[data-mtg-card-info]');
          const distinctCards = new Set();
          stamps.forEach(s => distinctCards.add(s.dataset.mtgCardInfo));
          if (distinctCards.size > 1) {
            delete parent.dataset.mtgCardInfo;
            break;
          }
          parent.dataset.mtgCardInfo = infoJson;
          parent = parent.parentElement;
        }
      }

      // Strategy 1: <a> links with card URLs
      if (config.test) {
        document.querySelectorAll('a[href]').forEach(el => {
          if (el.dataset.mtgCardInfo || seen.has(el)) return;
          seen.add(el);
          try {
            if (config.test(el.href)) {
              const info = config.extract(el);
              if (info && info.name) {
                const infoJson = JSON.stringify(info);
                el.dataset.mtgCardInfo = infoJson;
                el.dataset.mtgAttached = '1';
                stampParents(el, infoJson);
                n++;
              }
            }
          } catch (e) { /* skip individual element errors during scan */ }
        });
      }

      // Strategy 2: CSS selectors (Card_name__ spans etc.)
      if (config.selectors) {
        for (const sel of config.selectors) {
          document.querySelectorAll(sel).forEach(el => {
            if (el.dataset.mtgCardInfo || seen.has(el)) return;
            seen.add(el);
            const info = config.extract(el);
            if (!info || !info.name) return;

            const infoJson = JSON.stringify(info);
            el.dataset.mtgCardInfo = infoJson;
            el.dataset.mtgAttached = '1';
            stampParents(el, infoJson);
            n++;
          });
        }
      }

      // ─── POST-SCAN CLEANUP ───
      // During scanning, the first card in a section can over-stamp parent containers
      // before sibling cards are scanned. Now that ALL cards are stamped, remove stamps
      // from any container whose descendants contain stamps for multiple distinct cards.
      if (n > 0) {
        let cleaned = 0;
        document.querySelectorAll('[data-mtg-card-info]').forEach(el => {
          const ownInfo = el.dataset.mtgCardInfo;
          if (!ownInfo) return;
          const descendants = el.querySelectorAll('[data-mtg-card-info]');
          if (descendants.length === 0) return; // leaf stamp, always keep
          for (const desc of descendants) {
            if (desc.dataset.mtgCardInfo && desc.dataset.mtgCardInfo !== ownInfo) {
              delete el.dataset.mtgCardInfo;
              cleaned++;
              break;
            }
          }
        });
        if (cleaned > 0) log('Cleaned', cleaned, 'over-stamped containers');
      }

      if (n > 0) log('+' + n, 'cards stamped (total:', (attachedCount += n) + ')');
      return;
    }

    // ─── STANDARD MODE ───
    // Attach per-element mouseenter/mouseleave listeners.

    // Strategy 1: Test all <a> elements against the site's URL pattern
    if (config.test) {
      document.querySelectorAll('a[href]').forEach(el => {
        if (el.dataset.mtgAttached || seen.has(el)) return;
        seen.add(el);
        try { if (config.test(el.href) && attach(el, config)) n++; } catch (e) { /* skip individual element errors */ }
      });
    }

    // Strategy 2: Use CSS selectors specific to the site
    if (config.selectors) {
      for (const sel of config.selectors) {
        let matched = 0;
        document.querySelectorAll(sel).forEach(el => {
          if (el.dataset.mtgAttached || seen.has(el)) return;
          seen.add(el);

          // For sites with findHoverTarget, resolve the actual hover element
          // BEFORE checking mtgAttached — the hover target might already be attached
          // even if the matched span element is not.
          let hoverEl = el;
          if (config.findHoverTarget) {
            hoverEl = config.findHoverTarget(el);
            if (hoverEl !== el && hoverEl.dataset.mtgAttached) return;
          }

          if (attachWithTarget(el, hoverEl, config)) {
            n++;
            matched++;
          }
        });
        if (matched > 0) log('Selector', JSON.stringify(sel), '→', matched, 'new');
      }
    }

    if (n > 0) log('+' + n, 'cards (total:', (attachedCount += n) + ')');
  }

  // ═══════════════════════════════════════════
  // EVENT DELEGATION
  // For sites where card images/overlays block mouse events on name elements.
  // Uses stamped data-mtg-card-info attributes instead of per-element listeners.
  // ═══════════════════════════════════════════

  /**
   * Set up document-level event delegation for card hover detection.
   * Instead of per-element mouseenter/mouseleave, we listen for mouseover on
   * the document and walk up from e.target looking for stamped card containers.
   */
  function setupDelegation(config) {
    let delegateTimeout = null;
    let delegateKey = null;

    document.body.addEventListener('mouseover', (e) => {
      if (!hoverEnabled) return;
      if (isDragging) return;
      if (popup && popup.contains(e.target)) return;

      // Walk up from hovered element looking for a stamped card container
      const info = findStampedCard(e.target);
      if (!info) return;

      clearTimeout(hideTimeout);
      const key = JSON.stringify(info);

      // Already showing this card
      if (currentCard === key && popup.classList.contains('mtg-popup-visible')) return;

      clearTimeout(delegateTimeout);
      delegateKey = key;

      delegateTimeout = setTimeout(() => {
        // Verify mouse hasn't moved to a different card during the delay
        if (delegateKey !== key) return;
        showPopup(info, e, key);
      }, 200);
    }, { passive: true });

    document.body.addEventListener('mouseout', (e) => {
      if (isDragging) return;
      if (popup && popup.contains(e.relatedTarget)) return;

      // Only schedule hide if we're leaving a card area entirely
      const leaving = !findStampedCard(e.relatedTarget);
      if (leaving) {
        clearTimeout(delegateTimeout);
        delegateKey = null;
        scheduleHide();
      }
    }, { passive: true });

    log('Event delegation active');
  }

  /**
   * Walk up from a DOM element looking for a data-mtg-card-info attribute.
   * Returns parsed card info object or null.
   */
  function findStampedCard(el) {
    if (!el) return null;
    let current = el;
    for (let i = 0; i < 8; i++) {
      if (!current || current === document.body) return null;
      if (current === popup) return null;
      if (current.dataset?.mtgCardInfo) {
        try { return JSON.parse(current.dataset.mtgCardInfo); }
        catch (e) { return null; }
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * Attach hover listeners to a card element.
   * Uses `hoverEl` as the actual mouseenter/mouseleave target (may differ from `el`
   * when findHoverTarget returns a parent container).
   */
  function attachWithTarget(sourceEl, hoverEl, config) {
    if (popup && popup.contains(hoverEl)) return false;
    const info = config.extract(sourceEl);
    if (!info || !info.name) return false;

    // Mark both the source element and hover target as attached
    sourceEl.dataset.mtgAttached = '1';
    hoverEl.dataset.mtgAttached = '1';
    hoverEl.classList.add('mtg-price-hover');

    hoverEl.addEventListener('mouseenter', (e) => {
      if (!hoverEnabled) return;
      if (isDragging) return;
      clearTimeout(hideTimeout);
      const key = JSON.stringify(info);
      if (currentCard === key && popup.classList.contains('mtg-popup-visible')) return;

      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        const rect = hoverEl.getBoundingClientRect();
        const isStillHovering =
          mouseX >= rect.left && mouseX <= rect.right &&
          mouseY >= rect.top && mouseY <= rect.bottom;
        if (!isStillHovering) return;

        activeTriggerEl = hoverEl;
        showPopup(info, e, key);
      }, 200);
    });

    hoverEl.addEventListener('mouseleave', () => {
      if (isDragging) return;
      clearTimeout(hoverTimeout);
      scheduleHide();
    });

    return true;
  }

  /**
   * Attach hover listeners — simple version where source and hover target are the same.
   */
  function attach(el, config) {
    return attachWithTarget(el, el, config);
  }

  // ═══════════════════════════════════════════
  // POPUP LOGIC
  // ═══════════════════════════════════════════

  // Extract Cardmarket idProduct from product page (same-origin fetch, fast)
  async function fetchCardmarketProductId(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/idProduct[=:]\s*['"]?(\d+)/i);
      return m ? parseInt(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  async function showPopup(info, e, key) {
    currentCard = key;
    const gen = ++requestGeneration;
    positionPopup(e);
    setState('loading');

    // Late extraction: if cardmarketProductId was null at scan time (lazy-loaded images),
    // try again now — by hover time the image is guaranteed to be visible and loaded.
    if (!info.cardmarketProductId && activeTriggerEl) {
      const cmImgPattern = /product-images\.s3\.cardmarket\.com\/\d+\/\w+\/(\d+)\//;
      const img = activeTriggerEl.querySelector('img[src*="product-images"]');
      if (img) {
        const m = img.src.match(cmImgPattern);
        if (m) {
          info.cardmarketProductId = parseInt(m[1]);
          // Update the cached key so future hovers don't re-lookup
          key = JSON.stringify(info);
          currentCard = key;
        }
      }
    }

    log('Lookup:', info.name,
      info.setCode ? `[${info.setCode}${info.collectorNumber ? '/' + info.collectorNumber : ''}]` : '',
      info.setHint ? `[hint: ${info.setHint}]` : '',
      info.variant != null ? `[V${info.variant}]` : '',
      info.cardmarketProductId ? `[cmId: ${info.cardmarketProductId}]` : '');

    try {
      // If we have a Cardmarket product ID from the thumbnail, use it directly.
      // Otherwise fall back to scraping the product page (slow, causes 429s).
      const hasCmId = !!info.cardmarketProductId;
      const cmIdPromise = (!hasCmId && info.productUrl)
        ? fetchCardmarketProductId(info.productUrl)
        : Promise.resolve(null);

      // Send lookup — with cardmarketProductId if available for direct match
      const res = await sendMessage({
        type: 'FETCH_CARD_PRICE',
        cardName: info.name,
        tcgplayerId: info.tcgplayerId || null,
        setHint: info.setHint || null,
        setCode: info.setCode || null,
        collectorNumber: info.collectorNumber || null,
        scryfallId: info.scryfallId || null,
        variant: info.variant != null ? info.variant : null,
        cardmarketProductId: info.cardmarketProductId || null
      });

      if (requestGeneration !== gen) {
        log('Discarding stale response for:', info.name, '(gen', gen, 'vs', requestGeneration, ')');
        return;
      }

      if (!res.success) {
        shadowRoot.querySelector('.mtg-popup-error span').textContent = '❌ "' + info.name + '" not found';
        setState('error');
        return;
      }

      renderPrice(res.data);
      setState('content');

      // Refine with Cardmarket product ID only if we didn't already have one from thumbnail.
      // When hasCmId is true, the initial lookup already used the exact product ID.
      if (hasCmId) return;

      const cmProductId = await cmIdPromise;
      if (requestGeneration !== gen || !cmProductId) return;

      const refined = await sendMessage({
        type: 'FETCH_CARD_PRICE',
        cardName: info.name,
        cardmarketProductId: cmProductId
      });

      if (requestGeneration !== gen) return;
      if (refined.success) {
        // Only update if it's actually a different card
        if (refined.data.collectorNumber !== res.data?.collectorNumber || 
            refined.data.setCode !== res.data?.setCode) {
          log('Refined with Cardmarket product ID:', cmProductId, 
            `(${res.data?.setCode}#${res.data?.collectorNumber} → ${refined.data.setCode}#${refined.data.collectorNumber})`);
          renderPrice(refined.data);
        }
      }
    } catch (e) {
      if (requestGeneration !== gen) return;
      shadowRoot.querySelector('.mtg-popup-error span').textContent = '❌ Extension error';
      setState('error');
    }
  }

  function setState(s) {
    shadowRoot.querySelector('.mtg-popup-loading').style.display = s === 'loading' ? 'flex' : 'none';
    shadowRoot.querySelector('.mtg-popup-content').style.display = s === 'content' ? 'flex' : 'none';
    shadowRoot.querySelector('.mtg-popup-error').style.display = s === 'error' ? 'flex' : 'none';
    popup.style.height = '';
    popup.classList.add('mtg-popup-visible');
  }

  function renderPrice(data) {
    const $ = s => shadowRoot.querySelector(s);
    const img = $('.mtg-popup-image');
    if (data.imageSmall) { img.src = data.imageSmall; img.style.display = 'block'; }
    else img.style.display = 'none';

    // Show card name with variant info if available (e.g. "(2289) (Rainbow Foil)")
    const nameEl = $('.mtg-popup-name');
    const displayName = data.name + (data.variantName ? ' ' + data.variantName : '');

    // Detect foil status early (needed for card name styling)
    const p = data.prices || {};
    const hasTcgcsv = p.source === 'tcgcsv' && (
      p.low != null || p.mid != null || p.high != null ||
      p.lowFoil != null || p.midFoil != null || p.highFoil != null
    );
    const hasNormalPrices = p.low != null || p.mid != null || p.market != null;
    const hasFoilPrices = p.lowFoil != null || p.midFoil != null || p.marketFoil != null;
    const isFoilOnly = hasTcgcsv && !hasNormalPrices && hasFoilPrices;

    // Card name — rainbow shimmer for foil-only cards
    if (isFoilOnly) {
      nameEl.innerHTML = '<span class="mtg-foil-badge">' + displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>';
    } else {
      nameEl.textContent = displayName;
    }

    const setLine = data.set + (data.setCode ? ' (' + data.setCode + ')' : '');
    $('.mtg-popup-set').textContent = setLine;
    $('.mtg-popup-type').textContent = data.typeLine;

    const sym = CUR_SYM[userCurrency] || userCurrency;

    // Helper to convert USD to user currency
    const convert = (usdVal) => {
      if (usdVal == null) return null;
      if (userCurrency === 'USD') return usdVal;
      return usdVal * exchangeRate;
    };

    // Helper to set price in element with styling
    const setPrice = (el, row, val, label) => {
      if (val != null) {
        el.textContent = fmtPrice(val);
        el.className = 'mtg-price-value' + (val >= 10 ? ' mtg-price-high' : val >= 2 ? ' mtg-price-medium' : '');
        row.style.display = 'flex';
      } else {
        row.style.display = 'none';
      }
    };

    // Build source label
    let sourceLabel;
    if (hasTcgcsv) {
      sourceLabel = userCurrency === 'USD' ? 'TCGPlayer' : 'TCGPlayer USD';
    } else {
      sourceLabel = 'Scryfall (Trend)';
    }
    
    // Check for foil type from card data
    const isEtched = data.isEtched || (data.finishes && data.finishes.includes('etched') && !data.finishes.includes('nonfoil'));
    
    $('.mtg-section-title').textContent = sym + ' ' + userCurrency + ' (' + sourceLabel + ')';

    // ─── PRICE DISPLAY ───
    if (hasTcgcsv) {
      let low, mid, market, foil;

      if (isFoilOnly) {
        // Foil-only card: show foil prices as main prices
        low = convert(p.lowFoil);
        mid = convert(p.midFoil);
        market = convert(p.marketFoil);
        foil = null; // Don't show separate foil row

        // Update section title with foil badge
        const titleEl = $('.mtg-section-title');
        const foilType = isEtched ? 'Foil Etched' : 'Foil';
        titleEl.innerHTML = sym + ' ' + userCurrency + ' (' + sourceLabel + ' · <span class="mtg-foil-badge">' + foilType + '</span>)';
      } else {
        // Normal card with optional foil variant
        low = convert(p.low);
        mid = convert(p.mid);
        market = convert(p.market);
        foil = convert(p.midFoil);
      }

      // Reset mid label to "Avg" (might have been changed to "Trend" by fallback)
      const midLabel = $('.mtg-row-mid .mtg-price-label');
      if (midLabel) midLabel.textContent = 'Avg';

      setPrice($('[data-price="low"]'), $('.mtg-row-low'), low);
      setPrice($('[data-price="mid"]'), $('.mtg-row-mid'), mid);
      setPrice($('[data-price="market"]'), $('.mtg-row-market'), market);
      setPrice($('[data-price="foil"]'), $('.mtg-row-foil'), foil);
    } else {
      // Fallback to Scryfall trend prices
      const normal = getPrice(p, 'normal');
      const foil = getPrice(p, 'foil');

      // Check if this card has no TCGPlayer listings
      const noListings = p.source === 'tcgcsv-no-listings';

      if (noListings) {
        sourceLabel = 'No TCGPlayer listings';
      }

      $('.mtg-section-title').textContent = sym + ' ' + userCurrency + ' (' + sourceLabel + ')';

      // Hide Low/Market rows, only show as combined "normal" price
      $('.mtg-row-low').style.display = 'none';
      $('.mtg-row-market').style.display = 'none';
      
      // Use mid row for the trend price, relabel it
      const midLabel = $('.mtg-row-mid .mtg-price-label');
      if (midLabel) midLabel.textContent = 'Trend';
      setPrice($('[data-price="mid"]'), $('.mtg-row-mid'), normal);
      setPrice($('[data-price="foil"]'), $('.mtg-row-foil'), foil);
    }

    for (const [cls, key] of [['scryfall','scryfall'],['cardmarket','cardmarket'],['tcgplayer','tcgplayer'],['ebay','ebay']]) {
      const a = $('.mtg-link-' + cls);
      if (a) {
        let url = data.links[key] || '#';
        if (key === 'cardmarket' && url !== '#') url = applySellerCountry(url);
        a.href = url;
        a.style.display = data.links[key] ? '' : 'none';
      }
    }

    const oracleSection = $('.mtg-popup-oracle-section');
    const oracleEl = $('.mtg-popup-oracle');
    if (oracleSection && oracleEl) {
      if (data.oracleText) {
        oracleEl.textContent = data.oracleText;
        oracleEl.style.display = oracleExpanded ? 'block' : 'none';
        oracleSection.style.display = 'block';
        const toggleEl = $('.mtg-popup-oracle-toggle');
        if (toggleEl) toggleEl.textContent = oracleExpanded ? 'Card Text ▲' : 'Card Text ▼';
      } else {
        oracleSection.style.display = 'none';
      }
    }
  }

  // ═══════════════════════════════════════════
  // POSITIONING
  // ═══════════════════════════════════════════

  function positionPopup(e) {
    if (savedPos) {
      const x = Math.min(savedPos.x, window.innerWidth - 100);
      const y = Math.min(savedPos.y, window.innerHeight - 100);
      popup.style.left = Math.max(0, x) + 'px';
      popup.style.top = Math.max(0, y) + 'px';
      if (savedPos.w) popup.style.width = savedPos.w + 'px';
    } else {
      const pad = 15;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + 300 > window.innerWidth) x = e.clientX - 300 - pad;
      if (y + 400 > window.innerHeight) y = window.innerHeight - 400 - pad;
      if (y < 0) y = pad;
      popup.style.left = x + 'px';
      popup.style.top = y + 'px';
    }
  }

  function savePosition() {
    const rect = popup.getBoundingClientRect();
    savedPos = { x: rect.left, y: rect.top, w: rect.width };
    try { chrome.storage.local.set({ mtgPopupPos: savedPos }); } catch (e) { /* storage may be unavailable */ }
  }

  function loadPosition() {
    try {
      chrome.storage.local.get('mtgPopupPos', (data) => {
        if (data.mtgPopupPos) {
          savedPos = data.mtgPopupPos;
          log('Loaded saved position:', savedPos);
        }
      });
    } catch (e) { /* storage may be unavailable */ }
  }

  // ═══════════════════════════════════════════
  // DRAG
  // ═══════════════════════════════════════════

  function startDrag(e) {
    if (e.target.closest('a, input, button')) return;
    e.preventDefault();
    isDragging = true;
    const rect = popup.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    popup.style.cursor = 'grabbing';
    shadowRoot.querySelector('.mtg-popup-drag-handle').style.cursor = 'grabbing';
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
  }

  function onDrag(e) {
    if (!isDragging) return;
    let x = e.clientX - dragOffsetX;
    let y = e.clientY - dragOffsetY;
    x = Math.max(0, Math.min(x, window.innerWidth - 50));
    y = Math.max(0, Math.min(y, window.innerHeight - 30));
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  }

  function stopDrag() {
    isDragging = false;
    popup.style.cursor = '';
    shadowRoot.querySelector('.mtg-popup-drag-handle').style.cursor = 'grab';
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    savePosition();
  }

  // ═══════════════════════════════════════════
  // RESIZE (custom handle)
  // ═══════════════════════════════════════════

  let resizeStartX = 0;
  let resizeStartW = 0;

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartW = popup.offsetWidth;
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', stopResize);
  }

  function onResize(e) {
    if (!isResizing) return;
    const newW = Math.max(220, Math.min(500, resizeStartW + (e.clientX - resizeStartX)));
    popup.style.width = newW + 'px';
  }

  function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', stopResize);
    savePosition();
  }

  // ═══════════════════════════════════════════
  // RESIZE OBSERVER
  // ═══════════════════════════════════════════

  let resizeObserver = null;

  function watchResize() {
    if (resizeObserver) return;
    resizeObserver = new ResizeObserver(() => {
      if (popup.classList.contains('mtg-popup-visible')) {
        savePosition();
        const w = popup.offsetWidth;
        // Scale factor: 1.0 at 280px, up to ~1.6 at 500px
        const scale = w / 280;

        // Image scales with width
        const img = shadowRoot.querySelector('.mtg-popup-image');
        if (img) img.style.maxWidth = Math.min(200, 80 * scale) + 'px';

        // Card name font
        const nameEl = shadowRoot.querySelector('.mtg-popup-name');
        if (nameEl) nameEl.style.fontSize = Math.min(20, 14 * scale) + 'px';

        // Set + type fonts
        const setEl = shadowRoot.querySelector('.mtg-popup-set');
        const typeEl = shadowRoot.querySelector('.mtg-popup-type');
        const fontSize2 = Math.min(15, 11 * scale) + 'px';
        if (setEl) setEl.style.fontSize = fontSize2;
        if (typeEl) typeEl.style.fontSize = fontSize2;

        // Price values
        shadowRoot.querySelectorAll('.mtg-price-value').forEach(el => {
          el.style.fontSize = Math.min(18, 13 * scale) + 'px';
        });
        shadowRoot.querySelectorAll('.mtg-price-label').forEach(el => {
          el.style.fontSize = Math.min(15, 11 * scale) + 'px';
        });

        // Section title
        const sectionTitle = shadowRoot.querySelector('.mtg-section-title');
        if (sectionTitle) sectionTitle.style.fontSize = Math.min(16, 12 * scale) + 'px';

        // Oracle text
        const oracleEl = shadowRoot.querySelector('.mtg-popup-oracle');
        if (oracleEl) {
          oracleEl.style.fontSize = Math.min(16, 11 * scale) + 'px';
          oracleEl.style.lineHeight = '1.5';
        }

        // Link buttons
        shadowRoot.querySelectorAll('.mtg-popup-links a').forEach(el => {
          el.style.fontSize = Math.min(14, 11 * scale) + 'px';
          el.style.padding = Math.min(8, 5 * scale) + 'px ' + Math.min(10, 6 * scale) + 'px';
        });
      }
    });
    resizeObserver.observe(popup);
  }

  // ═══════════════════════════════════════════
  // HIDE LOGIC
  // ═══════════════════════════════════════════

  function scheduleHide() {
    clearTimeout(hideTimeout);
    if (popupTouched) {
      hideTimeout = setTimeout(hidePopup, 150);
    } else {
      hideTimeout = setTimeout(hidePopup, 2500);
    }
  }

  function hidePopup() {
    clearTimeout(hideTimeout);
    clearTimeout(hoverTimeout);
    popup.classList.remove('mtg-popup-visible');
    currentCard = null;
    activeTriggerEl = null;
    popupTouched = false;
  }

  // ═══════════════════════════════════════════
  // CREATE POPUP
  // ═══════════════════════════════════════════

  function createPopup() {
    // ─── INJECT @font-face INTO MAIN DOCUMENT ───
    // Shadow DOM inherits @font-face from the host document.
    // Font files must be declared here so they're available inside the shadow tree.
    try {
      const fontBoldUrl = chrome.runtime.getURL('fonts/CormorantGaramond-Bold.woff2');
      const fontMediumUrl = chrome.runtime.getURL('fonts/CormorantGaramond-Medium.woff2');
      const fontStyle = document.createElement('style');
      fontStyle.id = 'mtg-pc-fonts';
      fontStyle.textContent =
        '@font-face { font-family: "Cormorant Garamond"; font-weight: 700; font-style: normal; font-display: swap; src: url("' + fontBoldUrl + '") format("woff2"); }' +
        '@font-face { font-family: "Cormorant Garamond"; font-weight: 500; font-style: normal; font-display: swap; src: url("' + fontMediumUrl + '") format("woff2"); }';
      if (!document.getElementById('mtg-pc-fonts')) {
        document.head.appendChild(fontStyle);
      }
    } catch (e) {
      // Extension context may be unavailable – font falls back gracefully
    }

    popup = document.createElement('div');
    popup.id = 'mtg-price-popup';
    shadowRoot = popup.attachShadow({ mode: 'open' });

    // ─── ALL POPUP CSS ENCAPSULATED IN SHADOW DOM ───
    const style = document.createElement('style');
    style.textContent = `
      /* ─── Utility ─── */
      .hidden { display: none; }

      /* ─── Host Element (positioning, visibility) ─── */
      :host {
        position: fixed;
        z-index: 2147483647;
        width: 280px;
        min-width: 220px;
        max-width: 500px;
        min-height: 80px;
        max-height: 90vh;
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
        font-size: 13px;
        color: #c2ccd2;
        pointer-events: none;
        opacity: 0;
        transform: translateY(5px);
        transition: opacity 0.15s ease, transform 0.15s ease;
        resize: none;
        overflow: hidden;
      }

      :host(.mtg-popup-visible) {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      /* ─── Custom Resize Grip ─── */
      .mtg-popup-resize-grip {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0 0 10px 0;
      }

      .mtg-popup-resize-grip::after {
        content: '';
        width: 8px;
        height: 8px;
        border-right: 2px solid #3e5858;
        border-bottom: 2px solid #3e5858;
        margin-top: -2px;
        margin-left: -2px;
      }

      .mtg-popup-resize-grip:hover::after {
        border-color: #649090;
      }

      /* ─── Inner Container ─── */
      .mtg-popup-inner {
        position: relative;
        background: #161d21;
        border: 1px solid #24383c;
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
        color: #c2ccd2;
        line-height: 1.4;
        text-align: left;
        min-width: 220px;
        max-width: 500px;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* ─── Drag Handle ─── */
      .mtg-popup-drag-handle {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3px 0;
        cursor: grab;
        background: #1c282c;
        border-bottom: 1px solid #24383c;
        border-radius: 10px 10px 0 0;
        user-select: none;
        -webkit-user-select: none;
      }

      .mtg-popup-drag-handle:hover {
        background: #222e32;
      }

      .mtg-popup-drag-handle:active {
        cursor: grabbing;
      }

      .mtg-drag-dots {
        font-size: 12px;
        color: #4a6464;
        letter-spacing: 2px;
      }

      /* ─── Loading & Error ─── */
      .mtg-popup-loading,
      .mtg-popup-error {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 20px;
        font-size: 12px;
        color: #3e5858;
      }

      .mtg-popup-error span { color: #e06050; }

      .mtg-spinner {
        width: 16px; height: 16px;
        border: 2px solid #24383c;
        border-top: 2px solid #5a9ad0;
        border-radius: 50%;
        animation: mtg-spin 0.8s linear infinite;
      }
      @keyframes mtg-spin { to { transform: rotate(360deg); } }

      /* ─── Content Wrapper ─── */
      .mtg-popup-content {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }

      /* ─── Header ─── */
      .mtg-popup-header {
        display: flex;
        flex-direction: row;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid #24383c;
        flex-shrink: 0;
      }

      .mtg-popup-image {
        width: 25%;
        min-width: 50px;
        max-width: 120px;
        height: auto;
        border-radius: 4px;
        flex-shrink: 0;
      }

      .mtg-popup-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .mtg-popup-name {
        font-family: 'Cormorant Garamond', Georgia, 'Palatino Linotype', serif;
        font-weight: 700;
        font-size: 14px;
        color: #e8d5a3;
        line-height: 1.2;
      }

      .mtg-popup-set {
        font-family: 'Cormorant Garamond', Georgia, 'Palatino Linotype', serif;
        font-weight: 500;
        font-size: 11px;
        color: #5a9ad0;
      }

      .mtg-popup-type {
        font-family: 'Cormorant Garamond', Georgia, 'Palatino Linotype', serif;
        font-weight: 500;
        font-size: 11px;
        color: #90acb0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ─── Prices ─── */
      .mtg-popup-prices {
        padding: 8px 12px 6px;
        flex-shrink: 0;
      }

      .mtg-section-title {
        font-family: 'Cormorant Garamond', Georgia, 'Palatino Linotype', serif;
        font-weight: 500;
        font-size: 12px;
        color: #649090;
        padding: 4px 0 2px;
        margin-bottom: 2px;
        border-bottom: 1px solid #24383c;
      }

      .mtg-price-row {
        justify-content: space-between;
        align-items: center;
        padding: 3px 4px;
        border-radius: 4px;
        flex-direction: row;
      }

      .mtg-row-low,
      .mtg-row-mid,
      .mtg-row-market,
      .mtg-row-foil {
        display: flex;
      }

      .mtg-price-row:hover {
        background: rgba(200, 200, 210, 0.04);
      }

      .mtg-price-label {
        font-size: 11px;
        color: #587c82;
      }

      .mtg-price-value {
        font-weight: 600;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        color: #7ab648;
      }

      .mtg-price-value.mtg-price-medium { color: #d0b050; }
      .mtg-price-value.mtg-price-high { color: #e06050; }

      /* ─── Oracle Text ─── */
      .mtg-popup-oracle-section {
        border-top: 1px solid #24383c;
        flex-shrink: 0;
      }

      .mtg-popup-oracle-toggle {
        font-size: 12px;
        color: #90b0b0;
        padding: 6px 12px;
        cursor: pointer;
        text-align: center;
        user-select: none;
        transition: color 0.15s;
      }

      .mtg-popup-oracle-toggle:hover {
        color: #c2ccd2;
      }

      .mtg-popup-oracle {
        padding: 0 12px 8px;
        font-size: 11px;
        line-height: 1.4;
        color: #90acb0;
        white-space: pre-wrap;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }

      /* ─── Links ─── */
      .mtg-popup-links {
        display: flex;
        flex-wrap: wrap;
        flex-direction: row;
        gap: 5px;
        padding: 8px 12px 10px;
        border-top: 1px solid #24383c;
        flex-shrink: 0;
      }

      .mtg-popup-links a {
        flex: 1 1 calc(50% - 4px);
        min-width: 0;
        text-align: center;
        padding: 5px 6px;
        font-size: 11px;
        font-weight: 600;
        background: transparent;
        border-radius: 4px;
        text-decoration: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        box-sizing: border-box;
        margin: 0;
        line-height: normal;
        transition: all 0.15s ease;
        letter-spacing: 0.2px;
      }

      .mtg-popup-links a svg {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
      }

      /* Scryfall — Blue */
      .mtg-popup-links a.mtg-link-scryfall {
        color: #e0eef8;
        background: #1e5a8a;
        border: 1px solid #2a6a9e;
      }
      .mtg-popup-links a.mtg-link-scryfall:hover {
        background: #246ca0;
        color: #ffffff;
      }

      /* Cardmarket — White Mana */
      .mtg-popup-links a.mtg-link-cardmarket {
        color: #3a3530;
        background: #e8e0d0;
        border: 1px solid #d0c8b8;
      }
      .mtg-popup-links a.mtg-link-cardmarket:hover {
        background: #f0e8d8;
        color: #2a2520;
      }

      /* TCGPlayer — Red Mana */
      .mtg-popup-links a.mtg-link-tcgplayer {
        color: #ffffff;
        background: #8a3828;
        border: 1px solid #a04030;
      }
      .mtg-popup-links a.mtg-link-tcgplayer:hover {
        background: #a04030;
        color: #ffffff;
      }

      /* eBay — Black Mana */
      .mtg-popup-links a.mtg-link-ebay {
        color: #a8a0b0;
        background: #141018;
        border: 1px solid #241e2a;
      }
      .mtg-popup-links a.mtg-link-ebay:hover {
        background: #1e1824;
        color: #c8c0d0;
      }

      /* ─── Footer ─── */
      .mtg-popup-footer {
        padding: 6px 12px 8px;
        text-align: center;
        border-top: 1px solid #24383c;
        flex-shrink: 0;
      }

      .mtg-popup-footer a {
        font-size: 11px;
        color: #d0f0c0;
        text-decoration: none;
        transition: all 0.15s;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        padding: 6px 12px;
        background: #1a3c18;
        border: 1px solid #2a5426;
        border-radius: 4px;
      }

      .mtg-popup-footer a:hover {
        color: #e8ffe0;
        background: #244a20;
        border-color: #2a5426;
      }

      .mtg-popup-footer a svg {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
      }

      /* ─── Foil Badge with Rainbow Effect ─── */
      .mtg-foil-badge {
        display: inline-block;
        background: linear-gradient(90deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3, #54a0ff, #5f27cd, #ff6b6b);
        background-size: 200% 100%;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        animation: mtg-foil-shimmer 3s linear infinite;
        font-weight: 600;
        color: transparent;
      }

      @keyframes mtg-foil-shimmer {
        0% { background-position: 0% 50%; }
        100% { background-position: 200% 50%; }
      }

      /* ─── Scrollbar ─── */
      ::-webkit-scrollbar { width: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #2e4248; border-radius: 2px; }
    `;

    // ─── POPUP HTML ───
    const container = document.createElement('div');
    container.className = 'mtg-popup-inner';
    container.innerHTML =
        '<div class="mtg-popup-drag-handle">' +
          '<span class="mtg-drag-dots">☰</span>' +
        '</div>' +
        '<div class="mtg-popup-loading"><div class="mtg-spinner"></div><span>Loading...</span></div>' +
        '<div class="mtg-popup-content hidden">' +
          '<div class="mtg-popup-header">' +
            '<img class="mtg-popup-image" src="" alt="" />' +
            '<div class="mtg-popup-info">' +
              '<div class="mtg-popup-name"></div>' +
              '<div class="mtg-popup-type"></div>' +
              '<div class="mtg-popup-set"></div>' +
            '</div>' +
          '</div>' +
          '<div class="mtg-popup-prices">' +
            '<div class="mtg-section-title"></div>' +
            '<div class="mtg-price-row mtg-row-low"><span class="mtg-price-label">Min</span><span class="mtg-price-value" data-price="low"></span></div>' +
            '<div class="mtg-price-row mtg-row-mid"><span class="mtg-price-label">Avg</span><span class="mtg-price-value" data-price="mid"></span></div>' +
            '<div class="mtg-price-row mtg-row-market"><span class="mtg-price-label">Sold</span><span class="mtg-price-value" data-price="market"></span></div>' +
            '<div class="mtg-price-row mtg-row-foil"><span class="mtg-price-label"><span class="mtg-foil-badge">Foil</span></span><span class="mtg-price-value" data-price="foil"></span></div>' +
          '</div>' +
          '<div class="mtg-popup-oracle-section hidden">' +
            '<div class="mtg-popup-oracle-toggle">Card Text ▼</div>' +
            '<div class="mtg-popup-oracle"></div>' +
          '</div>' +
          '<div class="mtg-popup-links">' +
            '<a class="mtg-link-scryfall" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1 C6 1 2.5 5.5 2.5 7.5 C2.5 9.5 4 11 6 11 C8 11 9.5 9.5 9.5 7.5 C9.5 5.5 6 1 6 1Z"/></svg> Scryfall</a>' +
            '<a class="mtg-link-cardmarket" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 0.5L7 4.2L10.5 2.5L8 5.5L11.5 6L8 6.5L10.5 9.5L7 7.8L6 11.5L5 7.8L1.5 9.5L4 6.5L0.5 6L4 5.5L1.5 2.5L5 4.2Z"/></svg> Cardmarket</a>' +
            '<a class="mtg-link-tcgplayer" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1C6 1 3.5 3.5 4.5 6C3.5 5 2.5 6 3 8C3.5 10 5 11 6 11C7 11 8.5 10 9 8C9.5 6 8.5 5 7.5 6C8.5 3.5 6 1 6 1Z"/></svg> TCGPlayer</a>' +
            '<a class="mtg-link-ebay" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1C3.5 1 2 2.8 2 5C2 6.5 2.8 7.8 4 8.3L4 10.5L5 9.5L6 10.5L7 9.5L8 10.5L8 8.3C9.2 7.8 10 6.5 10 5C10 2.8 8.5 1 6 1ZM4.5 5.5C4.5 4.9 5 4.5 5 4.5C5 4.5 4 5 4 5.8C3.8 5.2 4.2 4.5 4.8 4.2C4.3 4.8 4.5 5.5 4.5 5.5ZM4 6C3.6 6 3.3 5.6 3.3 5.2C3.3 4.8 3.6 4.4 4 4.4C4.4 4.4 4.7 4.8 4.7 5.2C4.7 5.6 4.4 6 4 6ZM8 6C7.6 6 7.3 5.6 7.3 5.2C7.3 4.8 7.6 4.4 8 4.4C8.4 4.4 8.7 4.8 8.7 5.2C8.7 5.6 8.4 6 8 6Z"/></svg> eBay</a>' +
          '</div>' +
          '<div class="mtg-popup-footer">' +
            '<a href="https://ko-fi.com/tcgpricechecker" target="_blank" rel="noopener"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1C4 3 2 5 3.5 7L5.2 7L5.2 11L6.8 11L6.8 7L8.5 7C10 5 8 3 6 1Z"/></svg>Support this project</a>' +
          '</div>' +
        '</div>' +
        '<div class="mtg-popup-error hidden"><span></span></div>' +
        '<div class="mtg-popup-resize-grip"></div>';

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(container);
    document.body.appendChild(popup);

    shadowRoot.querySelector('.mtg-popup-drag-handle').addEventListener('mousedown', startDrag);
    shadowRoot.querySelector('.mtg-popup-resize-grip').addEventListener('mousedown', startResize);

    // Oracle text toggle (collapsible)
    shadowRoot.querySelector('.mtg-popup-oracle-toggle').addEventListener('click', () => {
      const oracleEl = shadowRoot.querySelector('.mtg-popup-oracle');
      const toggleEl = shadowRoot.querySelector('.mtg-popup-oracle-toggle');
      oracleExpanded = !oracleExpanded;
      oracleEl.style.display = oracleExpanded ? 'block' : 'none';
      toggleEl.textContent = oracleExpanded ? 'Card Text ▲' : 'Card Text ▼';
    });

    popup.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
      clearTimeout(hoverTimeout);
      popupTouched = true;
    });
    popup.addEventListener('mouseleave', () => {
      if (!isDragging && !isResizing) scheduleHide();
    });

    watchResize();
    loadPosition();
  }

  // ─── BOOTSTRAP ───
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
