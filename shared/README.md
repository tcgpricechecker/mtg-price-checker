# ⚔️ MTG Card Price Checker - Chrome Extension

A Chrome Extension that shows Magic: The Gathering card prices when browsing popular MTG websites.

## Features

### Free Version (v1.0)
- **Hover Price Popup**: Hover over card names on supported sites to see current prices
- **Quick Search**: Click the extension icon to search any card manually
- **Multi-Currency**: Shows EUR (Cardmarket) and USD (TCGPlayer) prices
- **Card Preview**: See card image, set info, and rarity at a glance
- **Direct Links**: Jump to Scryfall, Cardmarket, or TCGPlayer with one click
- **Smart Caching**: Prices are cached for 30 minutes to reduce API calls

### Supported Sites
- [Cardmarket](https://www.cardmarket.com)
- [TCGPlayer](https://www.tcgplayer.com)
- [EDHREC](https://edhrec.com)
- [Moxfield](https://www.moxfield.com)
- [Archidekt](https://archidekt.com)
- [MTGGoldfish](https://www.mtggoldfish.com)
- [Scryfall](https://scryfall.com)

## Installation (Development Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `mtg-price-checker` folder
6. The extension icon should appear in your toolbar

## Project Structure

```
mtg-price-checker/
├── manifest.json          # Extension manifest (v3)
├── icons/                 # Extension icons (16/48/128px)
│   └── generate.html      # Open in browser to generate icons
├── src/
│   ├── background.js      # Service worker - API calls & caching
│   ├── content.js         # Content script - card detection & popup
│   ├── content.css        # Popup styles
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup search functionality
└── README.md
```

## How It Works

1. **Content Script** scans supported MTG websites for card name elements
2. On **hover**, it sends the card name to the background service worker
3. **Background Script** queries the [Scryfall API](https://scryfall.com/docs/api) (free, no auth needed)
4. Results are **cached** for 30 minutes and displayed in a styled popup
5. The **popup** (click extension icon) provides a manual search for any card

## API

This extension uses the **Scryfall API** which is:
- ✅ Free to use
- ✅ No API key required
- ✅ Comprehensive price data (EUR, USD, MTGO Tix)
- ✅ Card images included
- ⚠️ Rate limited to ~10 requests/second (handled automatically)

## Future Plans (Pro Version Ideas)

- 📈 **Price History Charts**: See 30/90/365 day price trends
- 🔔 **Price Alerts**: Get notified when a card drops below your target price
- 📋 **Collection Tracker**: Track your collection value over time
- 💱 **More Currencies**: GBP, CHF, etc.
- 📊 **Deck Price Calculator**: Total deck value while browsing decklists
- 🔄 **Cross-Site Comparison**: Side-by-side prices from multiple stores

## Icons

Open `icons/generate.html` in a browser to generate the required icon files, then save them as PNG.

Alternatively, replace the icons in the `icons/` folder with your own 16x16, 48x48, and 128x128 PNG files.

## License

MIT
