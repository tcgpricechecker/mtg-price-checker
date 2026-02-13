#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BROWSERS = ['chrome', 'firefox', 'edge'];
const DIST_DIR = path.join(__dirname, 'dist');
const SHARED_DIR = path.join(__dirname, 'shared');

// Parse arguments
const args = process.argv.slice(2);
const target = args[0] || 'all';

if (target !== 'all' && !BROWSERS.includes(target)) {
  console.error(`❌ Invalid target: ${target}`);
  console.error(`Usage: node build.js [chrome|firefox|edge|all]`);
  process.exit(1);
}

const targetBrowsers = target === 'all' ? BROWSERS : [target];

// Helper: recursively copy directory
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Helper: clean dist directory
function cleanDist() {
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// Main build function
function build(browser) {
  console.log(`🔨 Building ${browser}...`);
  
  const browserDist = path.join(DIST_DIR, browser);
  const manifestSrc = path.join(__dirname, browser, 'manifest.json');
  
  // Copy shared files
  copyDir(SHARED_DIR, browserDist);
  
  // Copy browser-specific manifest
  fs.copyFileSync(manifestSrc, path.join(browserDist, 'manifest.json'));
  
  // Read version from manifest for display
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  console.log(`✅ ${browser} v${manifest.version} built successfully → dist/${browser}/`);
}

// Execute build
console.log('🚀 MTG Price Checker - Build Script\n');
cleanDist();

for (const browser of targetBrowsers) {
  build(browser);
}

console.log(`\n✨ Build complete! (${targetBrowsers.join(', ')})`);
