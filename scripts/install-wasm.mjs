#!/usr/bin/env node
// Fetches the latest plugkit.wasm from GitHub Releases (AnEntrypoint/plugkit-bin)
// and caches it under <pkg>/bin/plugkit.wasm. Idempotent: skips if already present
// and matches the .version stamp.
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const BIN_DIR = resolve(PKG_ROOT, 'bin');
const WASM_PATH = resolve(BIN_DIR, 'plugkit.wasm');
const VERSION_PATH = resolve(BIN_DIR, 'plugkit.version');
const PIN_PATH = resolve(PKG_ROOT, 'PLUGKIT_VERSION');

async function latestTag() {
    const r = await fetch('https://api.github.com/repos/AnEntrypoint/plugkit-bin/releases/latest', {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'libsql-plugkit-client' },
    });
    if (!r.ok) throw new Error(`gh api ${r.status}`);
    const body = await r.json();
    return body.tag_name; // e.g. "v0.1.408"
}

async function fetchAsset(tag, asset) {
    const url = `https://github.com/AnEntrypoint/plugkit-bin/releases/download/${tag}/${asset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
}

async function main() {
    let targetTag;
    const pin = existsSync(PIN_PATH) ? readFileSync(PIN_PATH, 'utf8').trim() : '';
    const envPin = (process.env.PLUGKIT_VERSION || '').trim();
    const raw = pin || envPin;
    if (raw && raw !== 'latest') {
        targetTag = raw.startsWith('v') ? raw : 'v' + raw;
    } else {
        targetTag = await latestTag();
    }
    const targetVersion = targetTag.replace(/^v/, '');

    if (existsSync(WASM_PATH) && existsSync(VERSION_PATH)) {
        const have = readFileSync(VERSION_PATH, 'utf8').trim();
        if (have === targetVersion && statSync(WASM_PATH).size > 100_000) {
            console.error(`[plugkit-client] plugkit.wasm ${have} already installed`);
            return;
        }
    }
    mkdirSync(BIN_DIR, { recursive: true });
    console.error(`[plugkit-client] fetching plugkit.wasm ${targetTag}…`);
    const wasm = await fetchAsset(targetTag, 'plugkit.wasm');
    if (wasm.length < 100_000) throw new Error(`plugkit.wasm suspiciously small (${wasm.length} bytes)`);
    writeFileSync(WASM_PATH, wasm);
    writeFileSync(VERSION_PATH, targetVersion);
    console.error(`[plugkit-client] installed plugkit.wasm ${targetVersion} (${(wasm.length / 1024 / 1024).toFixed(2)} MB)`);
}

export { main as install };

// When executed directly (postinstall / `node scripts/install-wasm.mjs`), run main.
const invokedDirectly = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
                        import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') || '__never__');
if (invokedDirectly) {
    main().catch(err => {
        console.error('[plugkit-client] install failed:', err.message);
        // Don't fail npm install; first runtime use will trigger another attempt.
        process.exit(0);
    });
}
