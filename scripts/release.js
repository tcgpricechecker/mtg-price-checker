#!/usr/bin/env node

/**
 * MTG Price Checker - Release Script
 *
 * Usage:
 *   npm run release              → patch bump (1.5.4 → 1.5.5)
 *   npm run release -- minor     → minor bump (1.5.4 → 1.6.0)
 *   npm run release -- major     → major bump (1.5.4 → 2.0.0)
 *   npm run release -- 1.6.0     → explicit version
 *
 * Steps:
 *   1. Validate clean working tree (no uncommitted non-release changes)
 *   2. Remove debug logs from shared/src/background.js
 *   3. Bump version in package.json + all manifests
 *   4. Build all browsers
 *   5. Package ZIPs
 *   6. Git add + commit + push
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BROWSERS = ['chrome', 'firefox', 'edge'];
const BACKGROUND_JS = path.join(ROOT, 'shared', 'src', 'background.js');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

// ─── UTILITIES ───

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function step(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

// ─── VERSION PARSING ───

function parseVersion(versionStr) {
  const match = versionStr.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

function bumpVersion(currentVersion, bumpType) {
  const v = parseVersion(currentVersion);
  if (!v) fail(`Invalid current version: ${currentVersion}`);

  switch (bumpType) {
    case 'major': return `${v.major + 1}.0.0`;
    case 'minor': return `${v.major}.${v.minor + 1}.0`;
    case 'patch': return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      // Check if bumpType is an explicit version string
      if (parseVersion(bumpType)) return bumpType;
      fail(`Invalid bump type: "${bumpType}". Use: patch, minor, major, or X.Y.Z`);
  }
}

// ─── GIT CHECKS ───

function checkGitClean() {
  try {
    const status = run('git status --porcelain');
    if (status) {
      // Only warn, don't block - the user might have uncommitted work they want in this release
      console.log('\n⚠️  Uncommitted changes detected:\n');
      console.log(status.split('\n').map(l => `   ${l}`).join('\n'));
      console.log('\n   These changes will be included in the release commit.\n');
    }
  } catch (e) {
    fail('Not a git repository or git not available');
  }
}

function checkGitRemote() {
  try {
    run('git remote get-url origin');
  } catch (e) {
    fail('No git remote "origin" configured. Cannot push.');
  }
}

function getCurrentBranch() {
  return run('git rev-parse --abbrev-ref HEAD');
}

// ─── DEBUG LOG REMOVAL ───

/**
 * Patterns to remove from background.js (from handoff notes):
 * - [TCGCSV-Direct] logs
 * - [handleLookup] Overriding tcgplayerId
 * - [handleLookup] Enhancing card with TCGCSV product
 * - [findPrinting] Tie-breaker missed + Sample CM URLs
 * - [findPrinting] Extra-keyword tie-breaker
 */
const DEBUG_LOG_PATTERNS = [
  /^\s*console\.log\(['"`]?\[TCGCSV-Direct\]/,
  /^\s*console\.log\(['"`]?\[handleLookup\] Overriding tcgplayerId/,
  /^\s*console\.log\(['"`]?\[handleLookup\] Enhancing card with TCGCSV product/,
  /^\s*console\.log\(['"`]?\[findPrinting\] Tie-breaker missed/,
  /^\s*console\.log\(['"`]?\[findPrinting\] Extra-keyword tie-breaker/,
  /^\s*console\.log\(['"`]?\s*#\$\{c\.collector_number\}/,
];

/**
 * Checks if a line starts a debug log statement we want to remove.
 */
function isDebugLogLine(line) {
  return DEBUG_LOG_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Checks if a statement that started on a previous line is still open.
 * Counts unmatched parentheses - a simple heuristic for console.log(...).
 */
function isStatementOpen(line) {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') depth++;
    if (ch === ')') depth--;
  }

  return depth > 0;
}

/**
 * Removes known debug log statements from background.js.
 * Two-pass approach:
 *   Pass 1: Remove debug console.log statements and forEach blocks
 *   Pass 2: Clean up empty else blocks left behind
 * Returns { content, removedCount }.
 */
function removeDebugLogs(content) {
  // ─── Pass 1: Remove debug log statements ───
  let lines = content.split('\n');
  let result = [];
  let removedCount = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Pattern: debug console.log (single or multi-line)
    if (isDebugLogLine(trimmed)) {
      removedCount++;
      // Skip continuation lines if statement is open (multi-line console.log)
      let combined = trimmed;
      while (isStatementOpen(combined) && i + 1 < lines.length) {
        i++;
        combined += ' ' + lines[i].trim();
      }
      i++;
      continue;
    }

    // Pattern: forEach block for Sample CM URLs (appears right after tie-breaker missed log)
    if (trimmed.startsWith('setMatches.slice(0, 3).forEach')) {
      removedCount++;
      // Skip until closing `});`
      while (i < lines.length && !lines[i].trim().startsWith('});')) {
        i++;
      }
      if (i < lines.length) i++; // skip the `});` line itself
      continue;
    }

    result.push(line);
    i++;
  }

  // ─── Pass 2: Clean up empty else blocks ───
  lines = result;
  result = [];
  i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === '} else {') {
      // Look ahead: if the else body contains only whitespace and comments, remove the block
      let j = i + 1;
      let elseIsEmpty = true;
      while (j < lines.length) {
        const inner = lines[j].trim();
        if (inner === '}') break; // closing brace of else
        if (inner !== '' && !inner.startsWith('//')) {
          elseIsEmpty = false;
          break;
        }
        j++;
      }
      if (elseIsEmpty && j < lines.length) {
        // Replace `} else { ... }` with just `}`
        result.push(lines[i].replace('} else {', '}'));
        i = j + 1; // skip past the closing `}`
        continue;
      }
    }

    result.push(lines[i]);
    i++;
  }

  return { content: result.join('\n'), removedCount };
}

// ─── VERSION SYNC ───

function syncVersion(newVersion) {
  // Update package.json
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  pkg.version = newVersion;
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n');

  // Update all browser manifests
  for (const browser of BROWSERS) {
    const manifestPath = path.join(ROOT, browser, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = newVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

// ─── BUILD & PACKAGE ───

function buildAll() {
  run('node build.js all', { stdio: 'inherit' });
}

function packageAll() {
  run('node scripts/package.js', { stdio: 'inherit' });
}

// ─── GIT COMMIT & PUSH ───

function gitCommitAndPush(version, branch) {
  // Stage all release-relevant files
  run('git add package.json');
  for (const browser of BROWSERS) {
    run(`git add ${browser}/manifest.json`);
  }
  run('git add shared/src/background.js');
  run('git add dist/');
  run('git add packages/');

  // Also stage any other tracked changes
  try {
    run('git add -u');
  } catch (e) {
    // Ignore if nothing to add
  }

  const commitMsg = `Release v${version}`;
  run(`git commit -m "${commitMsg}"`);
  step('📝', `Committed: "${commitMsg}"`);

  run(`git push origin ${branch}`);
  step('🚀', `Pushed to origin/${branch}`);
}

// ─── MAIN ───

function main() {
  console.log('');
  console.log('🚀 MTG Price Checker - Release Script');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Parse arguments
  const bumpType = process.argv[2] || 'patch';
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`  ${currentVersion} → ${newVersion} (${bumpType})`);
  console.log('');

  // Step 1: Git checks
  step('🔍', 'Checking git status...');
  checkGitClean();
  checkGitRemote();
  const branch = getCurrentBranch();
  step('✅', `On branch: ${branch}`);

  // Step 2: Remove debug logs
  step('🧹', 'Removing debug logs from background.js...');
  const bgContent = fs.readFileSync(BACKGROUND_JS, 'utf8');
  const { content: cleanedContent, removedCount } = removeDebugLogs(bgContent);
  if (removedCount > 0) {
    fs.writeFileSync(BACKGROUND_JS, cleanedContent);
    step('✅', `Removed ${removedCount} debug log statement(s)`);
  } else {
    step('✅', 'No debug logs found (already clean)');
  }

  // Step 3: Bump version
  step('🔢', `Bumping version: ${currentVersion} → ${newVersion}`);
  syncVersion(newVersion);
  step('✅', 'Version synced to package.json + all manifests');

  // Step 4: Build
  step('🔨', 'Building all browsers...');
  buildAll();

  // Step 5: Package
  step('📦', 'Creating ZIP packages...');
  packageAll();

  // Step 6: Git commit + push
  step('📤', 'Committing and pushing...');
  gitCommitAndPush(newVersion, branch);

  // Done
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`✨ Release v${newVersion} complete!`);
  console.log('');
  console.log('  📤 Upload to stores:');
  console.log('     Chrome  → https://chrome.google.com/webstore/devconsole/');
  console.log('     Firefox → https://addons.mozilla.org/developers/');
  console.log('     Edge    → https://partner.microsoft.com/dashboard/microsoftedge/');
  console.log('');
}

main();
