# MTG Card Price Checker - Monorepo

Multi-browser extension for Magic: The Gathering card price checking.

## Struktur

```
mtg-price-checker/
├── shared/              # Browser-agnostischer Code
│   ├── src/
│   │   ├── background.js
│   │   ├── content.js
│   │   ├── content.css
│   │   ├── popup.js
│   │   └── popup.html
│   ├── icons/
│   └── README.md
│
├── chrome/
│   └── manifest.json    # Chrome Manifest v3
│
├── firefox/
│   └── manifest.json    # Firefox Manifest v3 + browser_specific_settings
│
├── edge/
│   └── manifest.json    # Edge Manifest v3
│
├── dist/                # Build-Output (gitignore)
│   ├── chrome/
│   ├── firefox/
│   └── edge/
│
├── build.js             # Build-Script
├── package.json         # Version-Management
└── scripts/
    └── sync-version.js  # Version synchronisieren
```

## Build

**Alle Browser bauen:**
```bash
npm run build
# oder
node build.js all
```

**Einzelner Browser:**
```bash
npm run build:chrome
npm run build:firefox
npm run build:edge
```

**Output:** `dist/{browser}/` bereit zum Laden in Browser.

## Version aktualisieren

1. Version in `package.json` ändern
2. Sync ausführen:
```bash
npm run version:sync
```
3. Rebuild:
```bash
npm run build
```

## Browser-spezifische Unterschiede

### Chrome
- Manifest v3
- Service Worker für Background

### Firefox
- Manifest v3 mit `browser_specific_settings`
- Add-on ID: `mtg-price-checker@tcgpricechecker.com`
- Min Version: Firefox 109+

### Edge
- Identisch zu Chrome (Chromium-basiert)

## Testing

**Chrome:**
1. `chrome://extensions/` → Developer mode
2. Load unpacked → `dist/chrome/`

**Firefox:**
1. `about:debugging#/runtime/this-firefox`
2. Load Temporary Add-on → `dist/firefox/manifest.json`

**Edge:**
1. `edge://extensions/` → Developer mode
2. Load unpacked → `dist/edge/`

## Ko-Fi

Support: [ko-fi.com/tcgpricechecker](https://ko-fi.com/tcgpricechecker)

## License

MIT
