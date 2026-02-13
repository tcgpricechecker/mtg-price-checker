// MTG Card Price Checker - Popup Script

const searchInput = document.getElementById('searchInput');
const suggestionsEl = document.getElementById('suggestions');
const loadingEl = document.getElementById('loading');
const resultEl = document.getElementById('result');

let searchTimeout = null;

// Focus input on open
searchInput.focus();

// ─── Autocomplete search ───
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
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

// ─── Enter key to search ───
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const query = searchInput.value.trim();
    if (query) {
      suggestionsEl.innerHTML = '';
      fetchCard(query);
    }
  }
});

// ─── Render autocomplete suggestions ───
function renderSuggestions(cards) {
  suggestionsEl.innerHTML = cards
    .map(name => `<li data-name="${escapeHtml(name)}">${escapeHtml(name)}</li>`)
    .join('');

  suggestionsEl.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      const name = li.dataset.name;
      searchInput.value = name;
      suggestionsEl.innerHTML = '';
      fetchCard(name);
    });
  });
}

// ─── Fetch and display card data ───
async function fetchCard(cardName) {
  loadingEl.classList.add('visible');
  resultEl.classList.remove('visible');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CARD_PRICE',
      cardName: cardName,
    });

    loadingEl.classList.remove('visible');

    if (response.success) {
      renderResult(response.data);
    } else {
      resultEl.innerHTML = '<p style="color:#f7768e;text-align:center;padding:16px;">Card not found. Try a different name.</p>';
      resultEl.classList.add('visible');
    }
  } catch (err) {
    loadingEl.classList.remove('visible');
    console.error(err);
  }
}

// ─── Render card result ───
function renderResult(data) {
  // Image
  const img = document.getElementById('cardImage');
  if (data.image) {
    img.src = data.image;
    img.alt = data.name;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
  }

  // Info
  document.getElementById('cardName').textContent = data.name;
  document.getElementById('cardSet').textContent = `${data.set} (${data.setCode}) · ${capitalize(data.rarity)}`;

  // Prices
  const priceGrid = document.getElementById('priceGrid');
  const prices = [
    { label: 'EUR', value: data.prices.eur, symbol: '€' },
    { label: 'EUR Foil', value: data.prices.eurFoil, symbol: '€' },
    { label: 'USD', value: data.prices.usd, symbol: '$' },
    { label: 'USD Foil', value: data.prices.usdFoil, symbol: '$' },
  ].filter(p => p.value !== null);

  priceGrid.innerHTML = prices.map(p => {
    const cls = p.value >= 10 ? 'high' : p.value >= 2 ? 'medium' : '';
    return `
      <div class="price-box">
        <div class="label">${p.label}</div>
        <div class="value ${cls}">${p.symbol}${p.value.toFixed(2)}</div>
      </div>
    `;
  }).join('');

  // Links
  const linksEl = document.getElementById('links');
  const links = [];
  if (data.links.scryfall) links.push(`<a href="${data.links.scryfall}" target="_blank">Scryfall</a>`);
  if (data.links.cardmarket) links.push(`<a href="${data.links.cardmarket}" target="_blank">Cardmarket</a>`);
  if (data.links.tcgplayer) links.push(`<a href="${data.links.tcgplayer}" target="_blank">TCGPlayer</a>`);
  linksEl.innerHTML = links.join('');

  resultEl.classList.add('visible');
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
