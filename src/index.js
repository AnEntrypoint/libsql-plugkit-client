// libsql-plugkit-client — drop-in @libsql/client over gm's WASI-only libsql.wasm plugin.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM_PATH = joinPath(homedir(), '.agentplug', 'plugins', 'libsql.wasm');
const BUNDLED_WASM_PATH = resolvePath(__dirname, '..', 'bin', 'libsql.wasm');

// The wasm plugin's own diagnostic dedup (a Rust-side Mutex<HashSet>) is
// process-wide only in the sense that the WASM LINEAR MEMORY it lives in is
// process-wide -- but a fresh WebAssembly.Instance (see bootInstance below)
// gets fresh linear memory, resetting every static. createClient() boots a
// brand-new instance on EVERY call (deliberate, per db.js's own "stateless,
// release the db when done" design), so a diagnostic meant to fire "once per
// db path per process" instead fired on every single statement -- once per
// instance, not once per process. The plugin surfaces such diagnostics as a
// "diagnostics" array on its own JSON response (never raw eprintln!/stdio --
// WASI's stdio is a raw fd, not a JS-interceptable stream, and redirecting
// it to a scratch file risked aliasing with the real db file on the SAME
// preopened host directory) -- callVerb below dedupes against this Set,
// which is real JS memory and genuinely persists across bootInstance() calls
// within one process, unlike the wasm's own statics. Bounded: a caller
// touching many distinct db paths in one long-lived process (unlike
// freddie's own single-path db.js usage) would otherwise grow this
// unboundedly, since the dedup key is the full formatted message text
// (which embeds the db path) -- one entry per distinct path forever.
const DIAGNOSTICS_DEDUP_CAP = 500;
const _diagnosticsDedupSeen = new Set();

function resolveWasmPath(configPath) {
    if (configPath && existsSync(configPath)) return configPath;
    if (existsSync(DEFAULT_WASM_PATH)) return DEFAULT_WASM_PATH;
    if (existsSync(BUNDLED_WASM_PATH)) return BUNDLED_WASM_PATH;
    throw new Error(`plugkit-client: libsql.wasm not found at ${DEFAULT_WASM_PATH} or ${BUNDLED_WASM_PATH}`);
}

function parseFileUrl(url) {
    if (!url) return { memory: true, guestPath: ':memory:', hostDir: null };
    if (url === ':memory:' || url === 'file::memory:') return { memory: true, guestPath: ':memory:', hostDir: null };
    let raw = url;
    if (raw.startsWith('file:')) raw = raw.slice(5);
    if (raw.startsWith('//')) raw = raw.replace(/^\/\/[^/]*/, '');
    const abs = resolvePath(process.cwd(), raw);
    const hostDir = dirname(abs);
    const fileName = abs.slice(hostDir.length).replace(/^[\\/]+/, '');
    return { memory: false, guestPath: './' + fileName, hostDir };
}

async function bootInstance(wasmPath, hostDir) {
    const { WASI } = await import('node:wasi');
    const bytes = readFileSync(wasmPath);
    const mod = await WebAssembly.compile(bytes);
    const preopens = hostDir ? { '.': hostDir } : {};
    const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens });
    // Node's real WASI class exposes getImportObject()/initialize(); Bun's
    // node:wasi polyfill implements neither (confirmed live: both are
    // `undefined` on a real Bun WASI instance) and exposes the raw
    // wasi_snapshot_preview1 import namespace as `wasiImport` instead. This
    // wasm build exports no _initialize/_start (plain plugin_call/
    // plugkit_alloc/plugkit_free only, confirmed live against the actual
    // libsql.wasm binary), so on real Node initialize() has nothing to
    // actually invoke -- but it ALSO binds the WASI instance's internal
    // memory view (needed by every wasi syscall the module makes at
    // runtime, e.g. random_get for SQLite's rowid/uuid generation), a step
    // that still has to happen even with no _initialize/_start to call.
    // Bun's polyfill needs that same binding done explicitly via its own
    // setMemory(), confirmed live: omitting it produces a DIFFERENT crash
    // ("undefined is not an object (evaluating 'this.view')" inside Bun's
    // own random_get) the first time the module actually runs a query,
    // downstream of and easy to mistake for the getImportObject gap above.
    const importObject = typeof wasi.getImportObject === 'function'
        ? wasi.getImportObject()
        : { wasi_snapshot_preview1: wasi.wasiImport };
    const instance = await WebAssembly.instantiate(mod, importObject);
    if (typeof wasi.initialize === 'function') wasi.initialize(instance);
    else wasi.setMemory?.(instance.exports.memory);
    if (typeof instance.exports.plugin_call !== 'function') {
        throw new Error('libsql.wasm: plugin_call not exported');
    }
    return instance;
}

function callVerb(instance, verb, bodyObj) {
    const exp = instance.exports;
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const verbBuf = enc.encode(verb);
    const bodyBuf = enc.encode(JSON.stringify(bodyObj));
    const vp = exp.plugkit_alloc(verbBuf.length);
    const bp = exp.plugkit_alloc(bodyBuf.length);
    new Uint8Array(exp.memory.buffer, vp, verbBuf.length).set(verbBuf);
    new Uint8Array(exp.memory.buffer, bp, bodyBuf.length).set(bodyBuf);
    let packed;
    try {
        packed = exp.plugin_call(vp, verbBuf.length, bp, bodyBuf.length);
    } finally {
        try { exp.plugkit_free(vp, verbBuf.length); } catch {}
        try { exp.plugkit_free(bp, bodyBuf.length); } catch {}
    }
    const bi = typeof packed === 'bigint' ? packed : BigInt(packed);
    const p = Number(bi & 0xffffffffn);
    const l = Number((bi >> 32n) & 0xffffffffn);
    if (!p || !l) return null;
    const txt = dec.decode(new Uint8Array(exp.memory.buffer, p, l));
    let parsed;
    try { parsed = JSON.parse(txt); } catch { return { raw: txt }; }
    if (Array.isArray(parsed?.diagnostics)) {
        for (const line of parsed.diagnostics) {
            if (_diagnosticsDedupSeen.has(line)) continue;
            if (_diagnosticsDedupSeen.size >= DIAGNOSTICS_DEDUP_CAP) _diagnosticsDedupSeen.clear();
            _diagnosticsDedupSeen.add(line);
            process.stderr.write(line + '\n');
        }
    }
    return parsed;
}

function isWriteSql(sql) {
    const s = sql.trim().toUpperCase();
    return s.startsWith('INSERT') || s.startsWith('UPDATE') || s.startsWith('DELETE') ||
           s.startsWith('CREATE') || s.startsWith('DROP') || s.startsWith('ALTER') ||
           s.startsWith('REPLACE') || s.startsWith('BEGIN') || s.startsWith('COMMIT') ||
           s.startsWith('ROLLBACK') || s.startsWith('SAVEPOINT') || s.startsWith('RELEASE');
}

function normalizeParams(args) {
    if (!args) return [];
    if (Array.isArray(args)) return args;
    throw new Error('plugkit-client: named args not yet supported; use positional ? placeholders');
}

export function createClient(config = {}) {
    const parsed = parseFileUrl(config.url);
    const dbPath = parsed.guestPath;
    const dbName = config.dbName || 'main';
    const wasmPath = resolveWasmPath(config.wasmPath);
    let instance = null;
    let bootPromise = null;
    let closed = false;

    async function ensure() {
        if (instance) return instance;
        if (!bootPromise) bootPromise = bootInstance(wasmPath, parsed.hostDir).then(i => { instance = i; return i; });
        return bootPromise;
    }

    async function execute(stmt) {
        if (closed) throw new Error('plugkit-client: closed');
        await ensure();
        let sql, args;
        if (typeof stmt === 'string') { sql = stmt; args = []; }
        else { sql = stmt.sql; args = stmt.args || []; }
        const params = normalizeParams(args);
        if (isWriteSql(sql)) {
            const r = callVerb(instance, 'exec_params', { path: dbPath, sql, params, db_name: dbName });
            if (!r || r.ok === false) {
                throw new Error(`plugkit-client: exec failed: ${(r && r.error) || 'unknown'}\nSQL: ${sql.slice(0, 200)}`);
            }
            return {
                rows: [], columns: [],
                rowsAffected: r.changes || 0,
                lastInsertRowid: r.last_insert_rowid != null ? BigInt(r.last_insert_rowid) : undefined,
                toJSON() { return { rows: [], columns: [], rowsAffected: r.changes || 0 }; },
            };
        }
        const r = callVerb(instance, 'query_params', { path: dbPath, sql, params, db_name: dbName });
        if (!r || r.ok === false) {
            throw new Error(`plugkit-client: query failed: ${(r && r.error) || 'unknown'}\nSQL: ${sql.slice(0, 200)}`);
        }
        const rawRows = r.rows || [];
        const columns = rawRows.length ? Object.keys(rawRows[0]) : [];
        const rows = rawRows.map(obj => {
            const arr = columns.map(c => obj[c]);
            for (const c of columns) arr[c] = obj[c];
            return arr;
        });
        return { rows, columns, rowsAffected: 0, lastInsertRowid: undefined, toJSON() { return { rows: rawRows, columns, rowsAffected: 0 }; } };
    }

    async function batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await execute(s));
        return out;
    }

    async function transaction(_mode = 'deferred') {
        await execute('BEGIN');
        let done = false;
        return {
            async execute(s) { return execute(s); },
            async commit() { if (done) return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) }; done = true; return execute('COMMIT'); },
            async rollback() { if (done) return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) }; done = true; return execute('ROLLBACK'); },
            close() { if (!done) execute('ROLLBACK').catch(() => {}); done = true; },
        };
    }

    function close() {
        closed = true;
    }

    return {
        execute,
        batch,
        transaction,
        sync: async () => {},
        close,
        get closed() { return closed; },
        get protocol() { return 'plugkit-libsql'; },
    };
}

export default { createClient };
