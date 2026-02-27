// MTG Card Price Checker - Popup Script
// Search interface accessible via the extension icon.
// Uses the same FETCH_CARD_PRICE pipeline as the hover popup (TCGCSV prices).
// Supports keyboard navigation: Up/Down for suggestions, Left/Right for printings.

const searchInput = document.getElementById('searchInput');
const suggestionsEl = document.getElementById('suggestions');
const loadingEl = document.getElementById('loading');
const resultEl = document.getElementById('result');

let searchTimeout = null;
let selectedIndex = -1; // Currently highlighted suggestion (-1 = none)

// ─── Printing navigation state ───
let printings = [];      // All printings for the current card
let printingIndex = -1;  // Current printing index (-1 = initial result)
let currentCardName = ''; // Card name for printing lookup

// ─── Oracle text state ───
let oracleExpanded = false;

// ─── Set filter state ───
let setSelectedIndex = -1;  // Currently highlighted set suggestion

// ─── Currency state (same logic as content.js hover popup) ───
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
}

async function loadExchangeRate() {
  if (userCurrency === 'USD') return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_EXCHANGE_RATE', currency: userCurrency });
    if (res?.rate) {
      exchangeRate = res.rate;
    }
  } catch (e) {
    console.error('Exchange rate error:', e);
  }
}

/** Convert a USD value to the user's local currency */
function convert(usdVal) {
  if (usdVal == null) return null;
  if (userCurrency === 'USD') return usdVal;
  return usdVal * exchangeRate;
}

/** Format a price value with the user's currency symbol */
function fmtPrice(val) {
  if (val == null) return null;
  const sym = CUR_SYM[userCurrency] || userCurrency;
  const noDecimals = userCurrency === 'JPY' || userCurrency === 'KRW';
  return sym + (noDecimals ? Math.round(val).toString() : val.toFixed(2));
}

// ─── Initialize currency on popup open ───
detectCurrency();
loadExchangeRate();

// Focus input on open
searchInput.focus();

// ─── Oracle text toggle ───
document.getElementById('oracleToggle').addEventListener('click', () => {
  const textEl = document.getElementById('oracleText');
  const toggleEl = document.getElementById('oracleToggle');
  oracleExpanded = !oracleExpanded;
  textEl.classList.toggle('expanded', oracleExpanded);
  toggleEl.textContent = oracleExpanded ? 'Card Text ▲' : 'Card Text ▼';
});

// ─── Autocomplete search ───
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  selectedIndex = -1;
  const query = searchInput.value.trim();

  if (query.length < 2) {
    suggestionsEl.innerHTML = '';
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEARCH_CARDS',
        query: query,
      });

      if (response.success && response.data.length > 0) {
        renderSuggestions(response.data.slice(0, 6));
      } else {
        suggestionsEl.innerHTML = '';
      }
    } catch (err) {
      console.error(err);
    }
  }, 250);
});

// ─── Keyboard navigation ───
searchInput.addEventListener('keydown', (e) => {
  const items = suggestionsEl.querySelectorAll('li');
  const hasSuggestions = items.length > 0;
  const hasResult = resultEl.classList.contains('visible');

  // Up/Down: navigate suggestions
  if (e.key === 'ArrowDown' && hasSuggestions) {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    updateSelection(items);
  } else if (e.key === 'ArrowUp' && hasSuggestions) {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, -1);
    updateSelection(items);

  // Left/Right: navigate printings (only when result visible and no suggestions)
  } else if (e.key === 'ArrowLeft' && hasResult && !hasSuggestions) {
    e.preventDefault();
    navigatePrinting(-1);
  } else if (e.key === 'ArrowRight' && hasResult && !hasSuggestions) {
    e.preventDefault();
    navigatePrinting(1);

  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedIndex >= 0 && items[selectedIndex]) {
      const name = items[selectedIndex].dataset.name;
      searchInput.value = name;
      suggestionsEl.innerHTML = '';
      selectedIndex = -1;
      fetchCard(name);
    } else {
      const query = searchInput.value.trim();
      if (query) {
        suggestionsEl.innerHTML = '';
        selectedIndex = -1;
        fetchCard(query);
      }
    }
  } else if (e.key === 'Escape') {
    suggestionsEl.innerHTML = '';
    selectedIndex = -1;
  }
});

// ─── Document-level printing navigation (works when no input has focus) ───
document.addEventListener('keydown', (e) => {
  // Skip if user is typing in an input
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const hasResult = resultEl.classList.contains('visible');
  if (!hasResult) return;

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigatePrinting(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigatePrinting(1);
  }
});

function updateSelection(items) {
  items.forEach((li, i) => {
    li.classList.toggle('selected', i === selectedIndex);
  });
  if (selectedIndex >= 0 && items[selectedIndex]) {
    searchInput.value = items[selectedIndex].dataset.name;
  }
}

// ─── Render autocomplete suggestions ───
function renderSuggestions(cards) {
  selectedIndex = -1;
  suggestionsEl.innerHTML = cards
    .map(name => `<li data-name="${escapeHtml(name)}">${escapeHtml(name)}</li>`)
    .join('');

  suggestionsEl.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      const name = li.dataset.name;
      searchInput.value = name;
      suggestionsEl.innerHTML = '';
      selectedIndex = -1;
      fetchCard(name);
    });
  });
}

// ─── Fetch and display card data ───
async function fetchCard(cardName) {
  loadingEl.classList.add('visible');
  resultEl.classList.remove('visible');
  printings = [];
  printingIndex = -1;
  currentCardName = cardName;
  resetSetField();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CARD_PRICE',
      cardName: cardName,
    });

    loadingEl.classList.remove('visible');

    if (response.success) {
      renderResult(response.data);
      // Load printings in background
      loadPrintings(response.data.name);
    } else {
      resultEl.innerHTML = '<p style="color:#d06050;text-align:center;padding:16px;background:#161619;">Card not found. Try a different name.</p>';
      resultEl.classList.add('visible');
    }
  } catch (err) {
    loadingEl.classList.remove('visible');
    console.error(err);
  }
}

// ─── Fetch specific printing by set/number ───
async function fetchPrinting(setCode, collectorNumber) {
  loadingEl.classList.add('visible');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CARD_PRICE',
      cardName: currentCardName,
      setCode: setCode.toLowerCase(),
      collectorNumber: collectorNumber,
    });

    loadingEl.classList.remove('visible');

    if (response.success) {
      renderResult(response.data);
    }
  } catch (err) {
    loadingEl.classList.remove('visible');
    console.error(err);
  }
}

// ─── Load all printings for a card ───
async function loadPrintings(cardName) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_PRINTINGS',
      cardName: cardName,
    });

    if (response.success && response.data.length > 0) {
      printings = response.data;
      printingIndex = 0;
      updatePrintingIndicator();
      enableSetField();
    }
  } catch (err) {
    console.error(err);
  }
}

// ─── Navigate through printings ───
function navigatePrinting(direction) {
  if (printings.length <= 1) return;

  const newIndex = printingIndex + direction;
  if (newIndex < 0 || newIndex >= printings.length) return;

  printingIndex = newIndex;
  const p = printings[printingIndex];

  // Reset set filter when navigating to a different printing
  if (setInput) {
    setInput.value = '';
    setInput.classList.remove('active');
    setClear.style.display = 'none';
    setSuggestions.innerHTML = '';
    setSelectedIndex = -1;
  }

  updatePrintingIndicator();
  fetchPrinting(p.setCode, p.collectorNumber);
}

// ─── Update printing counter display ───
function updatePrintingIndicator() {
  let indicator = document.getElementById('printingIndicator');
  if (!indicator) return;

  if (printings.length > 1) {
    indicator.innerHTML =
      '<span class="printing-nav printing-prev" id="printingPrev">◀</span>' +
      ' ' + (printingIndex + 1) + ' / ' + printings.length + ' ' +
      '<span class="printing-nav printing-next" id="printingNext">▶</span>';
    indicator.style.display = 'block';

    document.getElementById('printingPrev').addEventListener('click', () => navigatePrinting(-1));
    document.getElementById('printingNext').addEventListener('click', () => navigatePrinting(1));
  } else {
    indicator.style.display = 'none';
  }
}

// ─── Render card result ───
function renderResult(data) {
  const img = document.getElementById('cardImage');
  if (data.imageSmall) {
    img.src = data.imageSmall;
    img.alt = data.name;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }

  // Detect foil status early (needed for card name styling)
  const p = data.prices || {};
  const hasTcgcsv = p.source === 'tcgcsv' && (
    p.low != null || p.mid != null || p.high != null ||
    p.lowFoil != null || p.midFoil != null || p.highFoil != null
  );
  const hasNormal = p.low != null || p.mid != null || p.market != null;
  const hasFoil = p.lowFoil != null || p.midFoil != null || p.marketFoil != null;
  const isFoilOnly = hasTcgcsv && !hasNormal && hasFoil;
  const isEtched = data.isEtched || (data.finishes && data.finishes.includes('etched') && !data.finishes.includes('nonfoil'));

  // Card name — rainbow shimmer for foil-only cards
  const cardNameEl = document.getElementById('cardName');
  const displayName = escapeHtml(data.name) + (data.variantName ? ' ' + escapeHtml(data.variantName) : '');
  if (isFoilOnly) {
    cardNameEl.innerHTML = '<span class="mtg-foil-badge">' + displayName + '</span>';
  } else {
    cardNameEl.textContent = data.name + (data.variantName ? ' ' + data.variantName : '');
  }

  document.getElementById('cardSet').textContent = `${data.set} (${data.setCode})`;
  document.getElementById('cardType').textContent = data.typeLine || '';

  // Prices — prefer TCGCSV (low/mid/market/foil), fall back to Scryfall
  const priceGrid = document.getElementById('priceGrid');

  const sym = CUR_SYM[userCurrency] || userCurrency;
  let prices = [];
  let sourceLabel = '';
  const foilType = isEtched ? 'Foil Etched' : 'Foil';
  const foilBadge = '<span class="mtg-foil-badge">' + foilType + '</span>';

  if (hasTcgcsv) {
    sourceLabel = userCurrency === 'USD' ? 'TCGPlayer' : 'TCGPlayer USD';

    if (isFoilOnly) {
      // Foil-only: rainbow name + rainbow badge in source label
      sourceLabel = sourceLabel + ' · ' + foilBadge;
      prices = [
        { label: 'Min', value: convert(p.lowFoil) },
        { label: 'Avg', value: convert(p.midFoil) },
        { label: 'Sold', value: convert(p.marketFoil) },
      ];
    } else {
      prices = [
        { label: 'Min', value: convert(p.low) },
        { label: 'Avg', value: convert(p.mid) },
        { label: 'Sold', value: convert(p.market) },
        { label: foilBadge, value: convert(p.midFoil) },
      ];
    }
  } else {
    // Scryfall fallback — convert to user currency using same logic as content.js
    const noListings = p.source === 'tcgcsv-no-listings';

    let normal = null;
    let foil = null;

    if (userCurrency === 'EUR') {
      // Prefer native EUR prices from Scryfall, fall back to converted USD
      normal = p.eur != null ? p.eur : (p.usd != null ? p.usd * exchangeRate : null);
      foil = p.eurFoil != null ? p.eurFoil : (p.usdFoil != null ? p.usdFoil * exchangeRate : null);
    } else if (userCurrency === 'USD') {
      normal = p.usd ?? null;
      foil = p.usdFoil ?? null;
    } else {
      // Other currencies: convert from USD
      normal = p.usd != null ? p.usd * exchangeRate : null;
      foil = p.usdFoil != null ? p.usdFoil * exchangeRate : null;
    }

    prices = [
      { label: 'Trend', value: normal },
      { label: foilBadge, value: foil },
    ];
    sourceLabel = noListings ? 'No TCGPlayer listings' : 'Scryfall (Trend)';
  }

  prices = prices.filter(pr => pr.value != null);

  if (prices.length === 0) {
    priceGrid.innerHTML = '<div class="no-prices">No prices available for this printing</div>';
  } else {
    priceGrid.innerHTML =
      `<div class="price-source">${sym} ${userCurrency} (${sourceLabel})</div>` +
      prices.map(pr => {
        const cls = pr.value >= 10 ? 'high' : pr.value >= 2 ? 'medium' : '';
        return `
          <div class="price-box">
            <div class="label">${pr.label}</div>
            <div class="value ${cls}">${fmtPrice(pr.value)}</div>
          </div>
        `;
      }).join('');
  }

  // Oracle text (collapsible)
  const oracleSection = document.getElementById('oracleSection');
  const oracleTextEl = document.getElementById('oracleText');
  const oracleToggle = document.getElementById('oracleToggle');
  if (data.oracleText) {
    oracleTextEl.textContent = data.oracleText;
    oracleTextEl.classList.toggle('expanded', oracleExpanded);
    oracleToggle.textContent = oracleExpanded ? 'Card Text ▲' : 'Card Text ▼';
    oracleSection.style.display = 'block';
  } else {
    oracleSection.style.display = 'none';
  }

  // Links with mana-inspired SVG icons
  // Designs are original/stylized — inspired by but legally distinct from MTG mana symbols
  const MANA_ICONS = {
    // Blue {U} — stylized water droplet (rounder, less pointed than MTG)
    droplet: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1 C6 1 2.5 5.5 2.5 7.5 C2.5 9.5 4 11 6 11 C8 11 9.5 9.5 9.5 7.5 C9.5 5.5 6 1 6 1Z"/></svg>',
    // White {W} — six-pointed starburst (geometric, not MTG sun)
    star: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 0.5L7 4.2L10.5 2.5L8 5.5L11.5 6L8 6.5L10.5 9.5L7 7.8L6 11.5L5 7.8L1.5 9.5L4 6.5L0.5 6L4 5.5L1.5 2.5L5 4.2Z"/></svg>',
    // Red {R} — angular blaze (sharper, more geometric than MTG flame)
    flame: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 0.5 C6 0.5 4 3 4.5 5 C3 4 2 5.5 2.5 7.5 C3 9.5 4.5 11 6 11 C7.5 11 9 9.5 9.5 7.5 C10 5.5 9 4 7.5 5 C8 3 6 0.5 6 0.5Z"/></svg>',
    // Black {B} — abstract skull motif (simplified, geometric)
    skull: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1C3.5 1 2 2.8 2 5C2 6.5 2.8 7.8 4 8.3L4 10.5L5 9.5L6 10.5L7 9.5L8 10.5L8 8.3C9.2 7.8 10 6.5 10 5C10 2.8 8.5 1 6 1ZM4.5 5.5C4.5 4.9 5 4.5 5 4.5C5 4.5 4 5 4 5.8C3.8 5.2 4.2 4.5 4.8 4.2C4.3 4.8 4.5 5.5 4.5 5.5ZM4 6C3.6 6 3.3 5.6 3.3 5.2C3.3 4.8 3.6 4.4 4 4.4C4.4 4.4 4.7 4.8 4.7 5.2C4.7 5.6 4.4 6 4 6ZM8 6C7.6 6 7.3 5.6 7.3 5.2C7.3 4.8 7.6 4.4 8 4.4C8.4 4.4 8.7 4.8 8.7 5.2C8.7 5.6 8.4 6 8 6Z"/></svg>',
  };

  const linksEl = document.getElementById('links');
  const links = [];
  if (data.links.scryfall) links.push(`<a href="${escapeHtml(data.links.scryfall)}" target="_blank" class="link-scryfall">${MANA_ICONS.droplet} Scryfall</a>`);
  if (data.links.cardmarket) links.push(`<a href="${escapeHtml(applySellerCountry(data.links.cardmarket))}" target="_blank" class="link-cardmarket">${MANA_ICONS.star} Cardmarket</a>`);
  if (data.links.tcgplayer) links.push(`<a href="${escapeHtml(data.links.tcgplayer)}" target="_blank" class="link-tcgplayer">${MANA_ICONS.flame} TCGPlayer</a>`);
  if (data.links.ebay) links.push(`<a href="${escapeHtml(data.links.ebay)}" target="_blank" class="link-ebay">${MANA_ICONS.skull} eBay</a>`);
  linksEl.innerHTML = links.join('');

  resultEl.classList.add('visible');
  updatePrintingIndicator();
}

// ─── Helpers ───
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── HOVER TOGGLE ───
(function initHoverToggle() {
  const toggle = document.getElementById('hoverToggle');
  if (!toggle) return;

  // Load saved state
  chrome.storage.local.get('hoverEnabled', (data) => {
    toggle.checked = data.hoverEnabled !== false; // default: enabled
  });

  // Save on change
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ hoverEnabled: toggle.checked });
  });
})();

// ─── ERROR TRACKING TOGGLE (opt-in, default: off) ───
(function initErrorTrackingToggle() {
  const toggle = document.getElementById('errorTrackingToggle');
  if (!toggle) return;

  // Load saved state (default: false = opt-in)
  chrome.storage.local.get('errorTrackingEnabled', (data) => {
    toggle.checked = data.errorTrackingEnabled === true;
  });

  // Save on change
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ errorTrackingEnabled: toggle.checked });
  });
})();

// ─── SELLER COUNTRY (Cardmarket filter) ───
let sellerCountry = '';

function applySellerCountry(url) {
  if (!url || !sellerCountry) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'sellerCountry=' + sellerCountry;
}

(function initSellerCountry() {
  const select = document.getElementById('sellerCountrySelect');
  if (!select) return;

  chrome.storage.local.get('sellerCountry', (data) => {
    if (data.sellerCountry) {
      sellerCountry = data.sellerCountry;
      select.value = sellerCountry;
    }
  });

  select.addEventListener('change', () => {
    sellerCountry = select.value;
    chrome.storage.local.set({ sellerCountry: sellerCountry });
  });
})();

// ─── SETTINGS FLIP ANIMATION ───
(function initSettingsFlip() {
  const container = document.getElementById('flipContainer');
  const inner = document.getElementById('flipInner');
  const settingsBtn = document.getElementById('settingsBtn');
  const backBtn = document.getElementById('backBtn');
  if (!container || !inner || !settingsBtn || !backBtn) return;

  const front = container.querySelector('.flip-front');
  const back = container.querySelector('.flip-back');

  function flipTo(side) {
    if (side === 'back') {
      // Show back face before measuring
      back.style.display = '';

      const frontHeight = front.offsetHeight;
      inner.style.height = frontHeight + 'px';
      inner.offsetHeight; // force reflow

      container.classList.add('flipped');

      requestAnimationFrame(() => {
        const backPage = back.querySelector('.settings-page');
        inner.style.height = (backPage ? backPage.offsetHeight : 200) + 'px';
      });
    } else {
      const frontHeight = front.offsetHeight;

      container.classList.remove('flipped');

      requestAnimationFrame(() => {
        inner.style.height = frontHeight + 'px';
      });

      inner.addEventListener('transitionend', function handler(e) {
        if (e.propertyName === 'transform') {
          inner.style.height = '';
          back.style.display = 'none'; // hide back so it doesn't affect popup sizing
          inner.removeEventListener('transitionend', handler);
        }
      });
    }
  }

  settingsBtn.addEventListener('click', () => flipTo('back'));
  backBtn.addEventListener('click', () => flipTo('front'));

  // Hide back face initially so Chrome sizes popup only for front content
  back.style.display = 'none';

  // Set version dynamically from manifest
  const versionEl = document.querySelector('.settings-version');
  if (versionEl && chrome.runtime.getManifest) {
    const version = chrome.runtime.getManifest().version;
    versionEl.textContent = 'MTG Price Checker v' + version;
  }
})();

// ─── WHAT'S NEW / SUPPORT FOOTER ───
(function initFooter() {
  const link = document.getElementById('footerLink');
  if (!link || !chrome.runtime.getManifest) return;

  const WHATS_NEW_DAYS = 7;
  const version = chrome.runtime.getManifest().version;
  const kofiUrl = 'https://ko-fi.com/tcgpricechecker';
  const supportIcon = '<svg viewBox="0 0 12 12" fill="currentColor" style="width:12px;height:12px;vertical-align:-1px;margin-right:2px;"><path d="M6 1C4 3 2 5 3.5 7L5.2 7L5.2 11L6.8 11L6.8 7L8.5 7C10 5 8 3 6 1Z"/></svg>';
  // Sparkle icon for "What's new"
  const sparkleIcon = '<svg viewBox="0 0 12 12" fill="currentColor" style="width:12px;height:12px;vertical-align:-1px;margin-right:2px;"><path d="M6 0L7.2 4.2L11.5 4.5L8.1 7.2L9.2 11.5L6 9L2.8 11.5L3.9 7.2L0.5 4.5L4.8 4.2Z"/></svg>';

  function showSupport() {
    link.innerHTML = supportIcon + 'Support this project';
    link.href = kofiUrl;
    link.classList.remove('whats-new');
  }

  function showWhatsNew() {
    link.innerHTML = sparkleIcon + "What's new in v" + version;
    link.href = kofiUrl;
    link.classList.add('whats-new');
  }

  chrome.storage.local.get(['lastSeenVersion', 'updateDetectedAt'], (data) => {
    const now = Date.now();

    // Clear badge whenever popup is opened
    try { chrome.action.setBadgeText({ text: '' }); } catch (e) { /* Firefox compat */ }

    if (data.lastSeenVersion !== version) {
      // New version detected
      chrome.storage.local.set({
        lastSeenVersion: version,
        updateDetectedAt: now,
      });
      showWhatsNew();
    } else if (data.updateDetectedAt) {
      const daysSince = (now - data.updateDetectedAt) / (1000 * 60 * 60 * 24);
      if (daysSince < WHATS_NEW_DAYS) {
        showWhatsNew();
      } else {
        showSupport();
      }
    } else {
      showSupport();
    }
  });
})();

// ─── SET FILTER (printing-based) ───
const setInput = document.getElementById('setInput');
const setSuggestions = document.getElementById('setSuggestions');
const setClear = document.getElementById('setClear');

// Disable set field initially (no card loaded yet)
if (setInput) setInput.disabled = true;

function resetSetField() {
  if (!setInput) return;
  setInput.value = '';
  setInput.disabled = true;
  setInput.classList.remove('active');
  setInput.placeholder = 'Filter by set (optional)';
  setClear.style.display = 'none';
  setSuggestions.innerHTML = '';
  setSelectedIndex = -1;
}

function enableSetField() {
  if (!setInput || printings.length === 0) return;
  setInput.disabled = false;
  setInput.placeholder = printings.length + ' printings — type to filter';
}


if (setInput) {
  // Filter printings as user types
  setInput.addEventListener('input', () => {
    const query = setInput.value.trim().toLowerCase();
    setSelectedIndex = -1;
    setInput.classList.remove('active');
    setClear.style.display = 'none';

    if (query.length < 1 || printings.length === 0) {
      // Show all printings when field is cleared
      if (printings.length > 0 && query.length === 0) {
        renderSetSuggestions(printings);
      } else {
        setSuggestions.innerHTML = '';
      }
      return;
    }

    // Match against set name or set code
    const matches = printings.filter(p =>
      p.setName.toLowerCase().includes(query) ||
      p.setCode.toLowerCase().includes(query)
    );

    renderSetSuggestions(matches);
  });

  // Show all printings on focus (if card loaded)
  setInput.addEventListener('focus', () => {
    if (printings.length > 0 && setSuggestions.innerHTML === '') {
      renderSetSuggestions(printings);
    }
  });

  // Keyboard navigation for set suggestions
  setInput.addEventListener('keydown', (e) => {
    const items = setSuggestions.querySelectorAll('li');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex = Math.min(setSelectedIndex + 1, items.length - 1);
      updateSetSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex = Math.max(setSelectedIndex - 1, -1);
      updateSetSelection(items);
    } else if (e.key === 'Enter' && setSelectedIndex >= 0 && items[setSelectedIndex]) {
      e.preventDefault();
      const li = items[setSelectedIndex];
      selectSetPrinting(li.dataset.code, li.dataset.cn, li.dataset.name);
    } else if (e.key === 'Escape') {
      setSuggestions.innerHTML = '';
      setSelectedIndex = -1;
    }
  });

  setClear.addEventListener('click', () => {
    setInput.value = '';
    setInput.classList.remove('active');
    setClear.style.display = 'none';
    setSuggestions.innerHTML = '';
    setSelectedIndex = -1;
    setInput.blur();
  });

  // Clear suggestions when clicking elsewhere
  setInput.addEventListener('blur', () => {
    setTimeout(() => { setSuggestions.innerHTML = ''; }, 150);
  });
}

function updateSetSelection(items) {
  items.forEach((li, i) => li.classList.toggle('selected', i === setSelectedIndex));
}

function renderSetSuggestions(sets) {
  setSuggestions.innerHTML = sets
    .map(s => {
      const label = escapeHtml(s.setName) + ' <span class="set-code">(' + escapeHtml(s.setCode) + ' #' + escapeHtml(s.collectorNumber) + ')</span>';
      return `<li data-code="${escapeHtml(s.setCode)}" data-cn="${escapeHtml(s.collectorNumber)}" data-name="${escapeHtml(s.setName)}">${label}</li>`;
    })
    .join('');

  setSuggestions.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      selectSetPrinting(li.dataset.code, li.dataset.cn, li.dataset.name);
    });
  });
}

function selectSetPrinting(setCode, collectorNumber, setName) {
  // Find matching printing index
  const idx = printings.findIndex(p =>
    p.setCode === setCode && p.collectorNumber === collectorNumber
  );
  if (idx >= 0) printingIndex = idx;

  setInput.value = setName + ' (' + setCode + ')';
  setInput.classList.add('active');
  setSuggestions.innerHTML = '';
  setClear.style.display = 'block';
  setSelectedIndex = -1;
  setInput.blur();
  updatePrintingIndicator();
  fetchPrinting(setCode, collectorNumber);
}
