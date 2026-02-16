#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ─── CONFIGURATION ───
const SHARED_SRC = path.join(__dirname, 'shared', 'src');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const RELOAD_FILE = path.join(__dirname, 'dist', 'chrome', '.reload');

// Files to watch for in Downloads folder (with and without extension)
const WATCH_FILES = {
  'content.js': 'content.js',
  'content': 'content.js',
  'content.css': 'content.css',
  'background.js': 'background.js',
  'background': 'background.js',
  'popup.html': 'popup.html',
  'popup.js': 'popup.js',
  'popup': 'popup.js'
};

// ZIP patterns to watch for
const ZIP_PATTERNS = ['mtg-price-checker', 'mtg-price-checker-monorepo'];

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
  const targetName = WATCH_FILES[filename];
  if (!targetName) return;
  
  const src = path.join(DOWNLOADS_DIR, filename);
  const dest = path.join(SHARED_SRC, targetName);
  
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    log(`📥 Copied ${filename} → shared/src/${targetName}`);
    
    // Delete from Downloads after copy
    fs.unlinkSync(src);
    log(`🗑️  Deleted ${filename} from Downloads`);
    
    scheduleBuild();
  }
}

// ─── ZIP HANDLING ───
function extractZip(zipPath) {
  const filename = path.basename(zipPath);
  log(`📦 Found ZIP: ${filename}`);
  
  // Create temp extraction dir
  const tempDir = path.join(os.tmpdir(), 'mtg-pc-extract-' + Date.now());
  
  try {
    // Extract ZIP
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Use PowerShell on Windows, unzip on Mac/Linux
    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'pipe' });
    } else {
      execSync(`unzip -o "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
    }
    
    log(`📂 Extracted to temp folder`);
    
    // Find shared/src in the extracted content
    const sharedSrcPath = findSharedSrc(tempDir);
    
    if (sharedSrcPath) {
      // Copy all files from extracted shared/src to our shared/src
      const files = fs.readdirSync(sharedSrcPath);
      let copied = 0;
      
      for (const file of files) {
        const srcFile = path.join(sharedSrcPath, file);
        const destFile = path.join(SHARED_SRC, file);
        
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, destFile);
          copied++;
        }
      }
      
      log(`✅ Copied ${copied} files from ZIP → shared/src/`);
      
      // Also check for package.json to sync version
      const pkgPath = findPackageJson(tempDir);
      if (pkgPath) {
        const localPkg = path.join(__dirname, 'package.json');
        fs.copyFileSync(pkgPath, localPkg);
        log(`📋 Updated package.json`);
        
        // Sync version to manifests
        try {
          execSync('node scripts/sync-version.js', { stdio: 'pipe', cwd: __dirname });
          log(`🔄 Synced version to manifests`);
        } catch (e) {
          // Ignore sync errors
        }
      }
      
      // Delete ZIP from Downloads
      fs.unlinkSync(zipPath);
      log(`🗑️  Deleted ${filename} from Downloads`);
      
      // Trigger build
      scheduleBuild();
    } else {
      log(`⚠️  No shared/src/ found in ZIP`);
    }
    
    // Cleanup temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
    
  } catch (err) {
    log(`❌ ZIP extraction failed: ${err.message}`);
    // Cleanup temp dir on error
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
}

function findSharedSrc(dir) {
  // Recursively find shared/src directory
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      if (entry.name === 'src') {
        // Check if parent is 'shared'
        const parent = path.basename(dir);
        if (parent === 'shared') {
          return fullPath;
        }
      }
      
      // Recurse into subdirectories
      const found = findSharedSrc(fullPath);
      if (found) return found;
    }
  }
  
  return null;
}

function findPackageJson(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isFile() && entry.name === 'package.json') {
      return fullPath;
    }
    
    if (entry.isDirectory()) {
      const found = findPackageJson(fullPath);
      if (found) return found;
    }
  }
  
  return null;
}

function isRelevantZip(filename) {
  if (!filename.endsWith('.zip')) return false;
  const lower = filename.toLowerCase();
  return ZIP_PATTERNS.some(pattern => lower.includes(pattern));
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
  log(`👀 Watching Downloads for files and ZIPs...`);
  
  fs.watch(DOWNLOADS_DIR, (eventType, filename) => {
    if (!filename) return;
    
    // Check for individual files (with or without extension)
    if (WATCH_FILES[filename]) {
      setTimeout(() => copyFromDownloads(filename), 500);
      return;
    }
    
    // Check for ZIP files
    if (isRelevantZip(filename)) {
      const zipPath = path.join(DOWNLOADS_DIR, filename);
      // Wait for ZIP to finish downloading
      setTimeout(() => {
        if (fs.existsSync(zipPath)) {
          extractZip(zipPath);
        }
      }, 1000);
    }
  });
}

// ─── INITIAL CHECK ───
function checkDownloadsOnStart() {
  log('🔍 Checking Downloads for existing files...');
  let found = false;
  
  const files = fs.readdirSync(DOWNLOADS_DIR);
  
  for (const file of files) {
    // Check individual files
    if (WATCH_FILES[file]) {
      copyFromDownloads(file);
      found = true;
    }
    
    // Check ZIPs
    if (isRelevantZip(file)) {
      extractZip(path.join(DOWNLOADS_DIR, file));
      found = true;
    }
  }
  
  if (!found) {
    log('✓ No pending files in Downloads');
  }
}

// ─── MAIN ───
console.log('');
console.log('🚀 MTG Price Checker - Watch Mode v2');
console.log('═══════════════════════════════════════════');
console.log('');
console.log('  Supported inputs:');
console.log('    • background.js / background');
console.log('    • content.js / content');
console.log('    • content.css');
console.log('    • popup.js / popup.html');
console.log('    • mtg-price-checker*.zip');
console.log('');
console.log('  Just download from Claude,');
console.log('  everything else is automatic!');
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
