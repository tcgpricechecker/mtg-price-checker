const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

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
    return new Promise((resolve) => {
        const sourceDir = path.join(DIST_DIR, browser);
        const zipName = `mtg-price-checker-${browser}-v${version}.zip`;
        const zipPath = path.join(OUTPUT_DIR, zipName);

        if (!fs.existsSync(sourceDir)) {
            console.log(`⚠️  ${browser}/ not found, skipping`);
            resolve(null);
            return;
        }

        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            const stats = fs.statSync(zipPath);
            console.log(`✅ ${zipName} (${Math.round(stats.size / 1024)} KB)`);
            resolve(zipPath);
        });

        archive.on('error', (err) => {
            console.error(`❌ Failed to create ${zipName}: ${err.message}`);
            resolve(null);
        });

        archive.pipe(output);

        // Walk directory and add files with forward-slash paths
        // (archive.directory() preserves OS backslashes on Windows)
        function addDir(dir, base) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                const zipPath = base ? `${base}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    addDir(fullPath, zipPath);
                } else {
                    archive.file(fullPath, { name: zipPath });
                }
            }
        }
        addDir(sourceDir, '');

        archive.finalize();
    });
}

async function main() {
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
        const result = await createZip(browser, version);
        if (result) created.push(result);
    }

    console.log(`\n✨ ${created.length} package(s) created in ${OUTPUT_DIR}/`);
    console.log('\n📤 Upload to:');
    console.log('   Chrome  → https://chrome.google.com/webstore/devconsole/');
    console.log('   Firefox → https://addons.mozilla.org/developers/');
    console.log('   Edge    → https://partner.microsoft.com/dashboard/microsoftedge/');
}

main();
