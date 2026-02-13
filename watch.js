#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ─── CONFIGURATION ───
const SHARED_SRC = path.join(__dirname, 'shared', 'src');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const RELOAD_FILE = path.join(__dirname, 'dist', 'chrome', '.reload');

// Files to watch for in Downloads folder
const WATCH_FILES = ['content.js', 'content.css', 'background.js', 'popup.html', 'popup.js'];

// Debounce timer
let buildTimeout = null;
const DEBOUNCE_MS = 300;

// ─── HELPERS ───
function log(msg) {
  const time = new Date().toLocaleTimeString('de-DE');
  console.log(`[${time}] ${msg}`);
}

function build() {
  try {
    log('🔨 Building...');
    execSync('node build.js all', { stdio: 'inherit', cwd: __dirname });
    
    // Touch reload file to trigger extension reload
    const reloadDir = path.dirname(RELOAD_FILE);
    if (fs.existsSync(reloadDir)) {
      fs.writeFileSync(RELOAD_FILE, Date.now().toString());
      log('🔄 Reload signal sent');
    }
  } catch (err) {
    log('❌ Build failed: ' + err.message);
  }
}

function scheduleBuild() {
  if (buildTimeout) clearTimeout(buildTimeout);
  buildTimeout = setTimeout(build, DEBOUNCE_MS);
}

function copyFromDownloads(filename) {
  const src = path.join(DOWNLOADS_DIR, filename);
  const dest = path.join(SHARED_SRC, filename);
  
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    log(`📥 Copied ${filename} from Downloads → shared/src/`);
    
    // Delete from Downloads after copy
    fs.unlinkSync(src);
    log(`🗑️  Deleted ${filename} from Downloads`);
    
    scheduleBuild();
  }
}

// ─── WATCH SHARED/SRC ───
function watchShared() {
  log('👀 Watching shared/src/ for changes...');
  
  fs.watch(SHARED_SRC, { recursive: true }, (eventType, filename) => {
    if (filename && !filename.startsWith('.')) {
      log(`📝 Changed: ${filename}`);
      scheduleBuild();
    }
  });
}

// ─── WATCH DOWNLOADS ───
function watchDownloads() {
  log(`👀 Watching Downloads for: ${WATCH_FILES.join(', ')}`);
  
  fs.watch(DOWNLOADS_DIR, (eventType, filename) => {
    if (filename && WATCH_FILES.includes(filename)) {
      // Wait a moment for file to finish writing
      setTimeout(() => copyFromDownloads(filename), 500);
    }
  });
}

// ─── INITIAL CHECK ───
function checkDownloadsOnStart() {
  log('🔍 Checking Downloads for existing files...');
  let found = false;
  
  for (const file of WATCH_FILES) {
    const src = path.join(DOWNLOADS_DIR, file);
    if (fs.existsSync(src)) {
      copyFromDownloads(file);
      found = true;
    }
  }
  
  if (!found) {
    log('✓ No pending files in Downloads');
  }
}

// ─── MAIN ───
console.log('');
console.log('🚀 MTG Price Checker - Watch Mode');
console.log('═══════════════════════════════════════════');
console.log('');
console.log('  Downloads → shared/src/ → Build → Reload');
console.log('');
console.log('  Just download files from Claude,');
console.log('  everything else happens automatically!');
console.log('');
console.log('  Press Ctrl+C to stop');
console.log('');
console.log('═══════════════════════════════════════════');
console.log('');

// Initial build
build();

// Check for existing files in Downloads
checkDownloadsOnStart();

// Start watchers
watchShared();
watchDownloads();

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n\n👋 Watch mode stopped\n');
  process.exit(0);
});
