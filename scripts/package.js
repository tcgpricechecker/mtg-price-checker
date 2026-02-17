const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BROWSERS = ['chrome', 'firefox', 'edge'];
const DIST_DIR = 'dist';
const OUTPUT_DIR = 'packages';

function getVersion() {
    const manifestPath = path.join(DIST_DIR, 'chrome', 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ Chrome manifest not found. Run "npm run build" first.');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.version;
}

function createZip(browser, version) {
    const sourceDir = path.join(DIST_DIR, browser);
    const zipName = `mtg-price-checker-${browser}-v${version}.zip`;
    const zipPath = path.join(OUTPUT_DIR, zipName);
    
    if (!fs.existsSync(sourceDir)) {
        console.log(`⚠️  ${browser}/ not found, skipping`);
        return null;
    }
    
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    
    try {
        const absoluteSource = path.resolve(sourceDir);
        const absoluteZip = path.resolve(zipPath);
        
        // Use PowerShell on Windows, zip on Unix
        const isWindows = process.platform === 'win32';
        
        if (isWindows) {
            execSync(
                `powershell -Command "Compress-Archive -Path '${absoluteSource}\\*' -DestinationPath '${absoluteZip}'"`,
                { stdio: 'pipe' }
            );
        } else {
            execSync(`cd "${sourceDir}" && zip -r "${absoluteZip}" .`, { stdio: 'pipe' });
        }
        
        const stats = fs.statSync(zipPath);
        console.log(`✅ ${zipName} (${Math.round(stats.size / 1024)} KB)`);
        return zipPath;
    } catch (error) {
        console.error(`❌ Failed to create ${zipName}: ${error.message}`);
        return null;
    }
}

function main() {
    console.log('📦 MTG Price Checker - Package Script\n');
    if (!fs.existsSync(DIST_DIR)) {
        console.error('❌ dist/ folder not found. Run "npm run build" first.');
        process.exit(1);
    }
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    
    const version = getVersion();
    console.log(`Version: ${version}\n`);
    
    const created = [];
    for (const browser of BROWSERS) {
        const result = createZip(browser, version);
        if (result) created.push(result);
    }
    
    console.log(`\n✨ ${created.length} package(s) created in ${OUTPUT_DIR}/`);
    console.log('\n📤 Upload to:');
    console.log('   Chrome  → https://chrome.google.com/webstore/devconsole/');
    console.log('   Firefox → https://addons.mozilla.org/developers/');
    console.log('   Edge    → https://partner.microsoft.com/dashboard/microsoftedge/');
}

main();
