# libsql-plugkit-client

Drop-in replacement for `@libsql/client` backed by a single wasm artifact
(`plugkit-wasm`). One cross-platform `.wasm` instead of N
per-architecture NAPI `.node` binaries.

## Why

- **Zero native compilation.** No `node-gyp`, no per-platform binaries, no
  postinstall builds. The same wasm runs on Linux x64/arm64, macOS, Windows,
  Alpine — anywhere Node 20+ runs.
- **API parity.** Wherever `@libsql/client`'s `createClient({ url })` works,
  this drops in: `await db.execute({ sql, args })`, `await db.execute('SELECT
  …')`. Returns `{rows, columns, rowsAffected, lastInsertRowid}`. Used by
  busybase and similar Supabase-shaped layers without code changes.
- **Same SQL engine.** `plugkit.wasm` bundles the real libsql amalgamation
  (3.45.1) including the native vector ops (`F32_BLOB`, `vector_distance_cos`,
  `vector_top_k`, `libsql_vector_idx`).

## Install

```bash
# From GitHub (always works):
npm install github:AnEntrypoint/libsql-plugkit-client
# bun add github:AnEntrypoint/libsql-plugkit-client

# Once published to npm (gated on an npm automation token):
npm install libsql-plugkit-client
```

The postinstall script downloads `plugkit.wasm` (~12 MB) from
`AnEntrypoint/plugkit-bin` GitHub Releases. To pin a specific version,
set `PLUGKIT_VERSION=0.1.408` env var before install, or commit a file
named `PLUGKIT_VERSION` at your project root.

## Use

```js
import { createClient } from 'libsql-plugkit-client';

const db = createClient({ url: 'file:./data/app.db' });

await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
await db.execute({ sql: 'INSERT INTO t (name) VALUES (?)', args: ['hello'] });
const r = await db.execute('SELECT * FROM t');
console.log(r.rows); // [{ id: 1, name: 'hello' }]

db.close(); // flushes a final snapshot to disk
```

## Persistence model

The wasm runs an in-memory libsql DB. After every write SQL statement, a
debounced snapshot (default 1.5s) serializes the entire DB to disk via
`sqlite3_serialize` and writes it to `url`'s path. On the next `createClient`,
the same file is read and `sqlite3_deserialize`'d back into memory.

This trades higher latency between writes for cross-platform deployment with
no native deps. For workloads with > ~50MB databases, native `@libsql/client`
will outperform.

## Compatibility notes

- `execute` accepts `string | { sql, args }`. Named args (`Record<string,
  InValue>`) aren't supported yet — use positional `?` placeholders.
- `transaction()` works via raw `BEGIN`/`COMMIT`/`ROLLBACK`; there's no
  separate sqlite3_txn handle.
- `rowsAffected` returns `0` — plugkit doesn't surface SQLite's change count
  yet (filed upstream).

## License

MIT
