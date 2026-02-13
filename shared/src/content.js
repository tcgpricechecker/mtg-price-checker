// MTG Card Price Checker - Content Script v18
// Displays card prices from Scryfall when hovering over card links on MTG websites.
// EUR prices come natively from Scryfall; other currencies are converted from USD.
//
// v18 changes:
//   - EDHREC: Added post-scan cleanup pass to remove over-stamped containers.
//     First-card-in-section could stamp all the way up to layout containers before
//     sibling cards existed to stop it. Cleanup now removes stamps from any element
//     whose descendants contain stamps for multiple distinct cards.

(function () {
  'use strict';

  // ─── DEBUG LOGGING ───
  const log = (...a) => console.log('[MTG-PC]', ...a);

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
  let dragOffsetX = 0, dragOffsetY = 0;

  // ─── SAVED POSITION ───
  let savedPos = null; // { x, y, w, h } in viewport pixels

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

  function detectCurrency() {
    const lang = navigator.language || navigator.userLanguage || 'en-US';
    userCurrency = LOCALE_TO_CUR[lang] || LOCALE_TO_CUR[lang.split('-')[0]] || 'USD';
    log('Locale:', lang, '→', userCurrency);
  }

  async function loadExchangeRate() {
    if (userCurrency === 'USD') return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_EXCHANGE_RATE', currency: userCurrency });
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
  //   extract(el): extracts card info { name, lang, setHint, variant, ... } from an element
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
          const setSlug = decodeURIComponent(m[1]).replace(/-/g, ' ').trim();
          let cardSlug = decodeURIComponent(m[2]).replace(/-/g, ' ').trim();
          let variant = null;
          const vMatch = cardSlug.match(/\s+V\s*\.?\s*(\d+)\s*$/i);
          if (vMatch) {
            variant = parseInt(vMatch[1]);
            cardSlug = cardSlug.replace(/\s+V\s*\.?\s*\d+\s*$/i, '').trim();
          }
          const langMatch = href.match(/cardmarket\.com\/(\w{2})\//);
          const lang = langMatch ? langMatch[1] : 'en';
          if (cardSlug.length >= 2) {
            return { name: cardSlug, lang, setHint: setSlug, variant };
          }
        }
        const text = cardText(el);
        if (text) return { name: text, lang: 'de' };
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
            if (name.length >= 2) return { name, lang: 'en' };
          }
        }
        const text = cardText(el);
        if (!text) return null;
        if (/^(New|Top|High Synergy|Creatures|Instants|Sorceries|Artifacts|Enchantments|Planeswalkers|Lands|Mana Artifacts|View More|Budget|Expensive|Most Popular|Synergy|Commander|Theme|Tribe|Primer)$/i.test(text)) return null;
        return { name: text, lang: 'en' };
      }
    },

    // ─── SCRYFALL ───
    'scryfall.com': {
      test: (href) => /scryfall\.com\/card\/[a-z0-9]+\/[^/]/.test(href),
      selectors: ['a[data-card-name]'],
      extract: extractScryfall
    },

    // ─── MTG FANDOM WIKI ───
    'mtg.fandom.com': {
      test: (href) => {
        if (!/mtg\.fandom\.com\/wiki\/[A-Z]/.test(href)) return false;
        if (/\/(Category:|Special:|Template:|File:|List_of_|Glossary|Rules|Comprehensive_Rules)/.test(href)) return false;
        return true;
      },
      selectors: [
        '.mw-parser-output a[href*="/wiki/"]'
      ],
      extract: (el) => {
        const href = el.href || '';
        const wikiMatch = href.match(/\/wiki\/([^#?]+)/);
        if (wikiMatch) {
          const slug = decodeURIComponent(wikiMatch[1]).replace(/_/g, ' ').trim();
          if (slug.length < 2) return null;
          if (/^(List of|Glossary|Rules|Category|Template|Magic:|Dungeons)/.test(slug)) return null;
          if (slug.includes('/')) return null;
          const text = cardText(el) || slug;
          return { name: text, lang: 'en' };
        }
        return null;
      }
    },

    // ─── TAPPEDOUT ───
    'tappedout.net': {
      test: (href) => /tappedout\.net\/mtg-card\//.test(href),
      selectors: [
        'a[data-name]',
        'span[data-name]',
        'a.card-link',
        'a[href*="/mtg-card/"]'
      ],
      extract: (el) => {
        if (el.dataset?.name) {
          return { name: el.dataset.name, lang: 'en' };
        }
        const href = el.href || '';
        const m = href.match(/\/mtg-card\/([^/?#]+)/);
        if (m) {
          const name = decodeURIComponent(m[1]).replace(/-/g, ' ').trim();
          if (name.length >= 2) return { name, lang: 'en' };
        }
        const text = cardText(el);
        return text ? { name: text, lang: 'en' } : null;
      }
    }
  };

  // ─── DOMAIN ALIASES ───
  SITES['www.scryfall.com'] = SITES['scryfall.com'];
  SITES['cardmarket.com'] = SITES['www.cardmarket.com'];
  SITES['www.edhrec.com'] = SITES['edhrec.com'];
  SITES['www.tappedout.net'] = SITES['tappedout.net'];

  // ─── REDDIT ───
  const redditConfig = {
    test: (href) => /cards\.scryfall\.io\//.test(href) || /scryfall\.com\/card\//.test(href),
    selectors: ['a[href*="cards.scryfall.io"]', 'a[href*="scryfall.com/card/"]'],
    extract: (el) => {
      const href = el.href || '';
      const imgMatch = href.match(/cards\.scryfall\.io\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (imgMatch) return { name: cardText(el) || 'Unknown', scryfallId: imgMatch[1], lang: 'en' };
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
    if (m) return { name: cardText(el) || 'Unknown', tcgplayerId: m[1], lang: 'en' };
    return null;
  }

  function extractScryfall(el) {
    const href = el.href || '';
    const m = href.match(/\/card\/([a-z0-9]+)\/([^/?#]+)/);
    if (m) {
      return {
        name: el.dataset?.cardName || cardText(el) || decodeURIComponent(m[2]).replace(/-/g, ' '),
        setCode: m[1],
        collectorNumber: m[2],
        lang: 'en'
      };
    }
    const name = el.dataset?.cardName || cardText(el);
    return name ? { name, lang: 'en' } : null;
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

    detectCurrency();
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
          } catch (e) {}
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
        try { if (config.test(el.href) && attach(el, config)) n++; } catch (e) {}
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

  async function showPopup(info, e, key) {
    currentCard = key;
    const gen = ++requestGeneration;
    positionPopup(e);
    setState('loading');

    log('Lookup:', info.name,
      info.setCode ? `[${info.setCode}${info.collectorNumber ? '/' + info.collectorNumber : ''}]` : '',
      info.setHint ? `[hint: ${info.setHint}]` : '',
      info.variant != null ? `[V${info.variant}]` : '');

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'FETCH_CARD_PRICE',
        cardName: info.name,
        lang: info.lang || 'en',
        tcgplayerId: info.tcgplayerId || null,
        setHint: info.setHint || null,
        setCode: info.setCode || null,
        collectorNumber: info.collectorNumber || null,
        scryfallId: info.scryfallId || null,
        variant: info.variant != null ? info.variant : null
      });

      if (requestGeneration !== gen) {
        log('Discarding stale response for:', info.name, '(gen', gen, 'vs', requestGeneration, ')');
        return;
      }

      if (res.success) {
        renderPrice(res.data);
        setState('content');
      } else {
        popup.querySelector('.mtg-popup-error span').textContent = '❌ "' + info.name + '" not found';
        setState('error');
      }
    } catch (e) {
      if (requestGeneration !== gen) return;
      popup.querySelector('.mtg-popup-error span').textContent = '❌ Extension error';
      setState('error');
    }
  }

  function setState(s) {
    popup.querySelector('.mtg-popup-loading').style.display = s === 'loading' ? 'flex' : 'none';
    popup.querySelector('.mtg-popup-content').style.display = s === 'content' ? 'flex' : 'none';
    popup.querySelector('.mtg-popup-error').style.display = s === 'error' ? 'flex' : 'none';
    popup.classList.add('mtg-popup-visible');
  }

  function renderPrice(data) {
    const $ = s => popup.querySelector(s);
    const img = $('.mtg-popup-image');
    if (data.imageSmall) { img.src = data.imageSmall; img.style.display = 'block'; }
    else img.style.display = 'none';

    $('.mtg-popup-name').textContent = data.name;
    $('.mtg-popup-set').textContent = data.set + ' (' + data.setCode + ')';
    $('.mtg-popup-type').textContent = data.typeLine;

    const normal = getPrice(data.prices, 'normal');
    const foil = getPrice(data.prices, 'foil');
    const sym = CUR_SYM[userCurrency] || userCurrency;

    const hasNativeEur = userCurrency === 'EUR' && (data.prices.eur != null || data.prices.eurFoil != null);
    const source = hasNativeEur ? 'Scryfall (EUR)' : (userCurrency === 'USD' ? 'TCGPlayer' : 'TCGPlayer ≈');
    $('.mtg-section-title').textContent = sym + ' ' + userCurrency + ' (' + source + ')';

    const normalEl = $('[data-price="normal"]');
    const normalRow = $('.mtg-row-normal');
    if (normal != null) {
      normalEl.textContent = fmtPrice(normal);
      normalEl.className = 'mtg-price-value' + (normal >= 10 ? ' mtg-price-high' : normal >= 2 ? ' mtg-price-medium' : '');
      normalRow.style.display = '';
    } else {
      normalRow.style.display = 'none';
    }

    const foilEl = $('[data-price="foil"]');
    const foilRow = $('.mtg-row-foil');
    if (foil != null) {
      foilEl.textContent = fmtPrice(foil);
      foilEl.className = 'mtg-price-value' + (foil >= 10 ? ' mtg-price-high' : foil >= 2 ? ' mtg-price-medium' : '');
      foilRow.style.display = '';
    } else {
      foilRow.style.display = 'none';
    }

    for (const [cls, key] of [['scryfall','scryfall'],['cardmarket','cardmarket'],['tcgplayer','tcgplayer'],['ebay','ebay']]) {
      const a = $('.mtg-link-' + cls);
      if (a) {
        a.href = data.links[key] || '#';
        a.style.display = data.links[key] ? '' : 'none';
      }
    }

    const oracleEl = $('.mtg-popup-oracle');
    if (oracleEl) {
      if (data.oracleText) {
        oracleEl.textContent = data.oracleText;
        oracleEl.style.display = 'block';
      } else {
        oracleEl.style.display = 'none';
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
      if (savedPos.h) popup.style.height = savedPos.h + 'px';
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
    savedPos = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    try { chrome.storage.local.set({ mtgPopupPos: savedPos }); } catch (e) {}
  }

  function loadPosition() {
    try {
      chrome.storage.local.get('mtgPopupPos', (data) => {
        if (data.mtgPopupPos) {
          savedPos = data.mtgPopupPos;
          log('Loaded saved position:', savedPos);
        }
      });
    } catch (e) {}
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
    popup.querySelector('.mtg-popup-drag-handle').style.cursor = 'grabbing';
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
    popup.querySelector('.mtg-popup-drag-handle').style.cursor = 'grab';
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
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
        const oracleEl = popup.querySelector('.mtg-popup-oracle');
        if (oracleEl) {
          const w = popup.offsetWidth;
          const fontSize = Math.min(16, Math.max(11, 11 + (w - 280) * 5 / 220));
          oracleEl.style.fontSize = fontSize + 'px';
          oracleEl.style.lineHeight = '1.5';
        }
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
    popup = document.createElement('div');
    popup.id = 'mtg-price-popup';
    popup.innerHTML =
      '<div class="mtg-popup-inner">' +
        '<div class="mtg-popup-drag-handle">' +
          '<span class="mtg-drag-dots">☰</span>' +
        '</div>' +
        '<div class="mtg-popup-loading"><div class="mtg-spinner"></div><span>Loading...</span></div>' +
        '<div class="mtg-popup-content" style="display:none;">' +
          '<div class="mtg-popup-header">' +
            '<img class="mtg-popup-image" src="" alt="" />' +
            '<div class="mtg-popup-info">' +
              '<div class="mtg-popup-name"></div>' +
              '<div class="mtg-popup-set"></div>' +
              '<div class="mtg-popup-type"></div>' +
            '</div>' +
          '</div>' +
          '<div class="mtg-popup-prices">' +
            '<div class="mtg-section-title"></div>' +
            '<div class="mtg-price-row mtg-row-normal"><span class="mtg-price-label">Trend</span><span class="mtg-price-value" data-price="normal"></span></div>' +
            '<div class="mtg-price-row mtg-row-foil"><span class="mtg-price-label">Foil</span><span class="mtg-price-value" data-price="foil"></span></div>' +
          '</div>' +
          '<div class="mtg-popup-oracle" style="display:none;"></div>' +
          '<div class="mtg-popup-links">' +
            '<a class="mtg-link-scryfall" href="#" target="_blank" rel="noopener">Scryfall</a>' +
            '<a class="mtg-link-cardmarket" href="#" target="_blank" rel="noopener">Cardmarket</a>' +
            '<a class="mtg-link-tcgplayer" href="#" target="_blank" rel="noopener">TCGPlayer</a>' +
            '<a class="mtg-link-ebay" href="#" target="_blank" rel="noopener">🔨 eBay</a>' +
          '</div>' +
          '<div class="mtg-popup-footer">' +
            '<a href="https://ko-fi.com/tcgpricechecker" target="_blank" rel="noopener">☕ Support this project</a>' +
          '</div>' +
        '</div>' +
        '<div class="mtg-popup-error" style="display:none;"><span></span></div>' +
      '</div>';
    document.body.appendChild(popup);

    popup.querySelector('.mtg-popup-drag-handle').addEventListener('mousedown', startDrag);

    popup.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
      clearTimeout(hoverTimeout);
      popupTouched = true;
    });
    popup.addEventListener('mouseleave', () => {
      if (!isDragging) scheduleHide();
    });

    watchResize();
    loadPosition();
  }

  // ─── BOOTSTRAP ───
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
