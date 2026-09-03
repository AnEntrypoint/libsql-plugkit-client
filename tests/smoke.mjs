// Smoke test for libsql-plugkit-client.
import { createClient } from '../src/index.js';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
function assert(cond, label) {
    if (cond) { passed++; console.log(`✓ ${label}`); }
    else { failed++; console.error(`✗ ${label}`); }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'plugkit-client-test-'));
const dbPath = join(tmpDir, 'test.db');

console.log(`temp db: ${dbPath}`);

// --- Round 1: fresh DB, write rows ---
{
    const db = createClient({ url: `file:${dbPath}` });

    const masterEmpty = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: ['users'] });
    assert(masterEmpty.rows.length === 0, 'sqlite_master probe on empty DB returns 0 rows');

    await db.execute('CREATE TABLE users (id TEXT, email TEXT, name TEXT)');
    const masterAfter = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: ['users'] });
    assert(masterAfter.rows.length === 1 && masterAfter.rows[0].name === 'users', 'sqlite_master finds created table');

    const info = await db.execute('PRAGMA table_info(users)');
    const colNames = info.rows.map(r => r.name);
    assert(colNames.includes('id') && colNames.includes('email') && colNames.includes('name'), 'PRAGMA table_info returns column names');

    await db.execute({ sql: 'INSERT INTO users (id, email, name) VALUES (?, ?, ?)', args: ['u1', 'a@b.com', "O'Brien"] });
    await db.execute({ sql: 'INSERT INTO users (id, email, name) VALUES (?, ?, ?)', args: ['u2', 'c@d.com', 'Alice'] });

    const all = await db.execute('SELECT * FROM users');
    assert(all.rows.length === 2, 'SELECT * returns 2 rows');
    assert(all.rows.find(r => r.id === 'u1' && r.name === "O'Brien"), 'single-quote escape round-trips');

    const one = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: ['c@d.com'] });
    assert(one.rows.length === 1 && one.rows[0].id === 'u2', 'parameterized WHERE returns correct row');

    await db.execute({ sql: 'UPDATE users SET name = ? WHERE id = ?', args: ['Bob', 'u1'] });
    const updated = await db.execute({ sql: 'SELECT name FROM users WHERE id = ?', args: ['u1'] });
    assert(updated.rows[0].name === 'Bob', 'UPDATE persisted');

    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: ['u2'] });
    const remaining = await db.execute('SELECT COUNT(*) AS n FROM users');
    assert(Number(remaining.rows[0].n) === 1, 'DELETE removed the row');

    await db.execute('CREATE TABLE memos (id INTEGER PRIMARY KEY, emb F32_BLOB(4))');
    await db.execute("INSERT INTO memos(emb) VALUES (vector('[1.0, 0.0, 0.0, 0.0]'))");
    await db.execute("INSERT INTO memos(emb) VALUES (vector('[0.0, 1.0, 0.0, 0.0]'))");
    const dist = await db.execute("SELECT id, vector_distance_cos(emb, vector('[1.0,0.0,0.0,0.0]')) AS d FROM memos ORDER BY d");
    assert(dist.rows.length === 2, 'vector_distance_cos returns 2 rows');
    assert(dist.rows[0].id === 1, 'closest vector ranks first');

    await db.sync();
    db.close();
}
console.log('--- round 1 closed ---');

// Give the close() best-effort snapshot a moment on slower CI
for (let i = 0; i < 20 && !existsSync(dbPath); i++) await new Promise(r => setTimeout(r, 250));
assert(existsSync(dbPath), `snapshot file persisted at ${dbPath}`);

// --- Round 2: reload, verify rows survive ---
{
    const db = createClient({ url: `file:${dbPath}` });
    const users = await db.execute('SELECT * FROM users');
    assert(users.rows.length === 1 && users.rows[0].id === 'u1' && users.rows[0].name === 'Bob', 'rows restored after reload');

    const memos = await db.execute('SELECT COUNT(*) AS n FROM memos');
    assert(Number(memos.rows[0].n) === 2, 'memos table restored after reload');

    db.close();
}
console.log('--- round 2 closed ---');

try { unlinkSync(dbPath); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
