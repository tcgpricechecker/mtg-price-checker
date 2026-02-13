#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BROWSERS = ['chrome', 'firefox', 'edge'];
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
const version = pkg.version;

console.log(`🔄 Syncing version ${version} to all manifests...\n`);

// Update each browser manifest
for (const browser of BROWSERS) {
  const manifestPath = path.join(__dirname, '..', browser, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  const oldVersion = manifest.version;
  manifest.version = version;
  
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✅ ${browser}: ${oldVersion} → ${version}`);
}

console.log(`\n✨ Version sync complete!`);
console.log(`💡 Run 'npm run build' to rebuild with new version`);
