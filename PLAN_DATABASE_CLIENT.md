# PLAN — DB Client Feature

Built-in, **global** database management client (feature name: **DB Client**) with support for MySQL, PostgreSQL, SQLite, MongoDB, and Redis — all with optional SSH tunnel. Connections are independent of any project — the feature is accessible even when no project is selected or when the workspace has zero projects.

> The term **DB Client** (short: `db-client`) is used throughout — migrations, tables, folders, WS actions — to disambiguate from the internal Clopen SQLite system database (`backend/database/`).

> Status legend — `[ ]` todo · `[~]` in progress · `[x]` done

---

## 0. Agreed Decisions (locked)

| # | Decision | Note |
|---|---|---|
| 1 | Scope | **Global** — connections are workspace-wide, not tied to any project. The feature works with zero projects selected. |
| 2 | Drivers v1 | MySQL, PostgreSQL, SQLite, MongoDB, Redis |
| 3 | Credential storage | Plaintext in SQLite (same precedent as tunnel tokens) |
| 4 | SSH tunnel | **Included** in v1 — connection form has an SSH section (host, port, username, password or private key + passphrase). Library TBD in Phase 0. |
| 5 | `database` field | Optional — if empty, the client loads all databases the user has permission to see via `listDatabases()`. |
| 6 | Modal approach | `DbClientModal` uses `Modal.svelte` with `bare` mode (same pattern as `SettingsModal.svelte`), wider: `min(95vw, 1400px)`. |
| 7 | UI language | English |
| 8 | WS namespace | `db-client:*` |
| 9 | Execute tool name | `execute_query` — covers SQL, Mongo commands, Redis commands |
| 10 | Query history retention | Unlimited |
| 11 | Migrations | Single file `030_create_db_client_tables.ts` — 2 tables |
| 12 | Auto-LIMIT 500 | Applied to SELECTs without LIMIT in read mode |
| 13 | Destructive confirm (manual) | `Dialog.svelte` warning pattern before `execute-write`, structure drops, truncate, row deletes |
| 14 | Inline edit on ResultTable | Enabled only when target table has a primary key (auto-detected); disabled with tooltip otherwise |
| 15 | Schema cache | **None** — manual refresh only |
| 16 | Driver display names | MySQL, PostgreSQL, SQLite, MongoDB, Redis |
| 17 | Default ports | MySQL 3306, PostgreSQL 5432, MongoDB 27017, Redis 6379, SSH 22, SQLite = file path (no port) |
| 18 | Naming convention | Everything uses `db-client` / `db_client` — never `database-client` or `database_client` |
| 19 | Phase 0 output | Driver + SSH compatibility findings recorded in CHECKPOINT 0 table; results are binding for Phase 1 implementation choices |

---

## 1. High-Level Architecture

```
┌─ Frontend ──────────────────────────────────────────────┐
│  DbClientButton  →  DbClientModal (Modal.svelte bare)   │
│       │                                                 │
│       ├─ LeftPane (280px): ConnectionList + SchemaTree  │
│       └─ MainPane (flex-1):                             │
│             TabBar → Query · Data · Structure · History │
│             MonacoEditor / DataGrid / StructureManager / │
│             HistoryView                                 │
└─────────────────────────────────────────────────────────┘
                    │
               WS db-client:*
                    │
┌─ Backend ──────────▼────────────────────────────────────┐
│  backend/db-client/                                     │
│     ├─ drivers/ {mysql,postgres,sqlite,mongodb,redis}   │
│     ├─ connection-manager.ts  (+ SSH tunnel lifecycle)  │
│     ├─ query-executor.ts                                │
│     └─ schema-introspector.ts                           │
│                                                         │
│  backend/ws/db-client/                                  │
│     ├─ connections.ts                                   │
│     ├─ query.ts                                         │
│     ├─ schema.ts                                        │
│     └─ structure.ts                                     │
│                                                         │
│  backend/database/                                      │
│     ├─ migrations/030_create_db_client_tables.ts        │
│     └─ queries/ db-client-connection-queries.ts,        │
│                 db-client-query-history-queries.ts      │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Database Schema (Migration 030)

File: `backend/database/migrations/030_create_db_client_tables.ts`

### 2.1 `db_client_connections`

```sql
CREATE TABLE db_client_connections (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  driver         TEXT NOT NULL CHECK (driver IN ('mysql','postgres','sqlite','mongodb','redis')),
  -- DB connection
  host           TEXT,
  port           INTEGER,
  username       TEXT,
  password       TEXT,
  database       TEXT,         -- NULL = load all databases (if permitted)
  ssl_mode       TEXT DEFAULT 'disable' CHECK (ssl_mode IN ('disable','require','verify-ca','verify-full')),
  ssl_ca         TEXT,
  -- SSH tunnel (all nullable; ignored when ssh_enabled = 0)
  ssh_enabled    INTEGER NOT NULL DEFAULT 0,
  ssh_host       TEXT,
  ssh_port       INTEGER DEFAULT 22,
  ssh_username   TEXT,
  ssh_auth_method TEXT DEFAULT 'password' CHECK (ssh_auth_method IN ('password','key')),
  ssh_password   TEXT,
  ssh_private_key TEXT,
  ssh_passphrase TEXT,
  -- Misc
  options_json   TEXT,
  color          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_used_at   TEXT
);
CREATE INDEX idx_db_client_conn_last_used ON db_client_connections(last_used_at DESC);
```

### 2.2 `db_client_query_history`

```sql
CREATE TABLE db_client_query_history (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  user_id       TEXT,
  query         TEXT NOT NULL,
  duration_ms   INTEGER,
  row_count     INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('success','error')),
  error         TEXT,
  executed_at   TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES db_client_connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_db_client_hist_conn_time ON db_client_query_history(connection_id, executed_at DESC);
```

### 2.3 Down migration

Drop `idx_db_client_hist_conn_time`, `idx_db_client_conn_last_used`, then drop `db_client_query_history`, `db_client_connections`.

---

## 3. Shared Types (`shared/types/db-client/`)

### 3.1 `connection.ts`

```ts
export type DbDriver = 'mysql' | 'postgres' | 'sqlite' | 'mongodb' | 'redis';
export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';
export type DbSshAuthMethod = 'password' | 'key';

export interface DbClientSshConfig {
  enabled: boolean;
  host: string;
  port: number;           // default 22
  username: string;
  authMethod: DbSshAuthMethod;
  password?: string;
  privateKey?: string;   // full PEM content
  passphrase?: string;
}

export interface DbClientConnection {
  id: string;
  name: string;
  driver: DbDriver;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  database: string | null;   // null = list all databases
  sslMode: DbSslMode;
  sslCa: string | null;
  ssh: DbClientSshConfig;
  options: Record<string, unknown>;
  color: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface DbClientConnectionInput {
  name: string;
  driver: DbDriver;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  sslMode?: DbSslMode;
  sslCa?: string;
  ssh?: Partial<DbClientSshConfig>;
  options?: Record<string, unknown>;
  color?: string;
}

export interface DbClientHealth {
  ok: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  sshOk: boolean | null;     // null when SSH not enabled
  error: string | null;
}
```

### 3.2 `query.ts`

```ts
export interface DbClientQueryResult {
  columns: Array<{ name: string; type: string | null }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  affectedRows: number | null;
  durationMs: number;
  driverMeta: Record<string, unknown>;
}

export interface DbClientSchemaNode {
  name: string;
  type: 'database' | 'schema' | 'table' | 'view' | 'collection' | 'index' | 'key' | 'column';
  children?: DbClientSchemaNode[];
  meta?: Record<string, unknown>;
}

export interface DbClientObjectDetails {
  name: string;
  type: DbClientSchemaNode['type'];
  columns?: Array<{
    name: string; type: string; nullable: boolean;
    default: string | null; isPrimary: boolean; isUnique: boolean;
  }>;
  indexes?: Array<{ name: string; columns: string[]; unique: boolean; type?: string }>;
  foreignKeys?: Array<{ column: string; refTable: string; refColumn: string }>;
  rowCount?: number;
  sizeBytes?: number;
  mongoFieldStats?: Array<{ field: string; types: string[]; sampleCount: number }>;
  redisTtlSeconds?: number | null;
  redisValueType?: string;
}
```

---

## 4. WebSocket API (`db-client:*`)

Router: `backend/ws/db-client/index.ts`

### 4.1 Connections

| Action | Payload | Response |
|---|---|---|
| `db-client:list` | `{}` | `DbClientConnection[]` |
| `db-client:get` | `{ id }` | `DbClientConnection` |
| `db-client:create` | `DbClientConnectionInput` | `DbClientConnection` |
| `db-client:update` | `{ id, patch }` | `DbClientConnection` |
| `db-client:delete` | `{ id }` | `{ ok: true }` |
| `db-client:test` | `DbClientConnectionInput` or `{ id }` | `DbClientHealth` |
| `db-client:health` | `{ id }` | `DbClientHealth` |

### 4.2 Schema / Introspection

| Action | Payload | Response |
|---|---|---|
| `db-client:list-databases` | `{ connectionId }` | `DbClientSchemaNode[]` |
| `db-client:list-schemas` | `{ connectionId, database? }` | `DbClientSchemaNode[]` |
| `db-client:list-objects` | `{ connectionId, database?, schema? }` | `DbClientSchemaNode[]` |
| `db-client:object-details` | `{ connectionId, database?, schema?, name, type }` | `DbClientObjectDetails` |

### 4.3 Query Execution

| Action | Payload | Response |
|---|---|---|
| `db-client:execute-read` | `{ connectionId, query, params?, database?, limit? }` | `DbClientQueryResult` |
| `db-client:execute-write` | `{ connectionId, query, params?, database? }` | `DbClientQueryResult` |
| `db-client:explain` | `{ connectionId, query, database? }` | `DbClientQueryResult` |
| `db-client:cancel` | `{ executionId }` | `{ ok }` |
| `db-client:history:list` | `{ connectionId, limit?, offset?, search? }` | `{ items, total }` |
| `db-client:history:delete` | `{ connectionId?, id? }` | `{ ok }` |

### 4.4 Structure Management

| Action | Payload | Response |
|---|---|---|
| `db-client:structure:create-table` | `{ connectionId, database?, schema?, definition }` | `{ ok, ddl }` |
| `db-client:structure:alter-table` | `{ connectionId, database?, schema?, name, operations }` | `{ ok, ddl }` |
| `db-client:structure:drop-table` | `{ connectionId, database?, schema?, name }` | `{ ok }` |
| `db-client:structure:truncate-table` | `{ connectionId, database?, schema?, name }` | `{ ok }` |
| `db-client:structure:rename-table` | `{ connectionId, database?, schema?, name, newName }` | `{ ok }` |
| `db-client:structure:create-index` | `{ connectionId, database?, schema?, tableName, indexDef }` | `{ ok, ddl }` |
| `db-client:structure:drop-index` | `{ connectionId, database?, schema?, tableName, indexName }` | `{ ok }` |
| `db-client:structure:create-view` | `{ connectionId, database?, schema?, name, query }` | `{ ok, ddl }` |
| `db-client:structure:drop-view` | `{ connectionId, database?, schema?, name }` | `{ ok }` |

Note: `ddl` in response is the generated statement that was executed — used for showing in history and audit.

### 4.5 Data CRUD

| Action | Payload | Response |
|---|---|---|
| `db-client:data:insert` | `{ connectionId, database?, schema?, table, row }` | `DbClientQueryResult` |
| `db-client:data:update` | `{ connectionId, database?, schema?, table, pk, changes }` | `DbClientQueryResult` |
| `db-client:data:delete` | `{ connectionId, database?, schema?, table, pks }` | `DbClientQueryResult` |

These actions generate safe parameterized statements from structured input rather than raw SQL strings.

---

## 5. Driver Layer (`backend/db-client/drivers/`)

### 5.1 Unified interface (`drivers/types.ts`)

```ts
export interface DbClientDriverAdapter {
  readonly kind: DbDriver;
  connect(conn: DbClientConnection, tunnelPort?: number): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
  health(): Promise<DbClientHealth>;

  listDatabases(): Promise<DbClientSchemaNode[]>;
  listSchemas(database?: string): Promise<DbClientSchemaNode[]>;
  listObjects(database?: string, schema?: string): Promise<DbClientSchemaNode[]>;
  getObjectDetails(name: string, type: DbClientSchemaNode['type'], database?: string, schema?: string): Promise<DbClientObjectDetails>;

  executeRead(q: string, params?: unknown[], opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult>;
  executeWrite(q: string, params?: unknown[], opts?: { database?: string }): Promise<DbClientQueryResult>;
  explain(q: string, opts?: { database?: string }): Promise<DbClientQueryResult>;
  cancel(): Promise<void>;

  // Structure
  createTable(definition: TableDefinition, opts?: SchemaOpts): Promise<string>;   // returns DDL
  alterTable(name: string, operations: AlterOperation[], opts?: SchemaOpts): Promise<string>;
  dropTable(name: string, opts?: SchemaOpts): Promise<void>;
  truncateTable(name: string, opts?: SchemaOpts): Promise<void>;
  renameTable(name: string, newName: string, opts?: SchemaOpts): Promise<void>;
  createIndex(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string>;
  dropIndex(tableName: string, indexName: string, opts?: SchemaOpts): Promise<void>;
  createView(name: string, query: string, opts?: SchemaOpts): Promise<string>;
  dropView(name: string, opts?: SchemaOpts): Promise<void>;

  // Data CRUD (parameterized, safe)
  insertRow(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult>;
  updateRow(table: string, pk: Record<string, unknown>, changes: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult>;
  deleteRows(table: string, pks: Record<string, unknown>[], opts?: SchemaOpts): Promise<DbClientQueryResult>;
}

interface SchemaOpts { database?: string; schema?: string; }
```

### 5.2 Per-driver notes

**MySQL** (API TBD in Phase 0 — `Bun.sql` mysql or `mysql2`):
- Introspect: `information_schema.tables/columns/key_column_usage` + `SHOW INDEXES`.
- Structure: full DDL support. Rename column: `ALTER TABLE RENAME COLUMN` (MySQL 8+) or `CHANGE COLUMN`.
- No TRUNCATE in transaction — warn user.

**PostgreSQL** (API TBD in Phase 0 — `Bun.sql` postgres or `pg`):
- Introspect: `information_schema` + `pg_indexes` + `pg_description`.
- Structure: full DDL, `EXPLAIN FORMAT JSON`.

**SQLite** (`bun:sqlite` — confirmed native):
- `database` field = file path.
- Introspect: `sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA foreign_key_list`.
- Structure limits: no `ALTER TABLE MODIFY COLUMN`; no `DROP COLUMN` before SQLite 3.35. Backend must detect version and either apply workaround (recreate table) or surface a clear error.

**MongoDB** (API TBD in Phase 0 — `mongodb` npm, version compatibility):
- Query shape: `{ collection, op: 'find'|'aggregate'|'insertOne'|..., args: [...] }`.
- Introspect: `listCollections`, `indexInformation`, 100-doc field sampler.
- Structure: `createCollection`, `drop`, `createIndex`, `dropIndex`, `renameCollection`.

**Redis** (API TBD in Phase 0 — `Bun.redis` or `ioredis`):
- Query shape: command array `['GET','foo']`.
- Introspect: `SCAN` cursor (cap 1000), `TYPE`, `TTL`, `MEMORY USAGE`.
- "Structure" for Redis = key management: rename, set TTL, delete.
- Type-aware value editing: string (SET), hash (HSET/HDEL), list (LSET/LINSERT/LREM), set (SADD/SREM), sorted set (ZADD/ZREM).

### 5.3 Query classification

`query-executor.ts` exports `classifyQuery(driver, query): 'read' | 'write' | 'ddl' | 'unknown'`:

- SQL: first meaningful token — `SELECT|SHOW|DESCRIBE|EXPLAIN|WITH` → read; `INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|RENAME|GRANT|REVOKE` → write/ddl.
- Mongo: `op` field — `find|aggregate|findOne|countDocuments|distinct` → read; `insert*|update*|delete*|drop*|replaceOne|bulkWrite` → write.
- Redis: command whitelist — `GET|MGET|EXISTS|TYPE|TTL|KEYS|SCAN|HGET|HGETALL|LRANGE|SMEMBERS|ZRANGE` → read; all others → write.

### 5.4 Connection manager (`connection-manager.ts`)

- Singleton `Map<connectionId, { adapter: DbClientDriverAdapter; tunnel?: SshTunnel }>`.
- `get(id)` — lazy connect: if SSH enabled, establish tunnel first → get ephemeral local port → pass to driver `connect(conn, tunnelPort)`.
- `release(id)` — close driver + SSH tunnel.
- Idle sweeper: close entries idle >10 min.
- On adapter error → evict entry, surface error.

### 5.5 SSH tunnel (`ssh-tunnel.ts`)

Library TBD in Phase 0 (candidate: `ssh2`).

```ts
export interface SshTunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function openSshTunnel(
  ssh: DbClientSshConfig,
  remoteHost: string,
  remotePort: number
): Promise<SshTunnel>
```

Creates a local TCP server that forwards to `remoteHost:remotePort` through the SSH connection. Authentication: password or PEM private key + optional passphrase.

---

## 6. Complete CRUD Coverage

### 6.1 Data operations (per driver)

**SQL (MySQL, PostgreSQL, SQLite):**
- Browse: SELECT with pagination, sort, column filter, WHERE clause builder.
- Insert: form-based row entry → parameterized INSERT.
- Update: inline cell edit → parameterized UPDATE WHERE PK. Saves individually or batched.
- Delete: select row(s) → Dialog confirm → DELETE WHERE PK IN.
- Bulk delete: filter rows → confirm count → DELETE WHERE conditions.

**MongoDB:**
- Browse: `find` with pagination, sort, JSON filter.
- Insert: JSON document editor → `insertOne`.
- Update: inline field edit (individual key) or full document editor → `updateOne { $set }`.
- Delete: select document(s) → confirm → `deleteOne` / `deleteMany`.

**Redis:**
- Browse: SCAN with pattern + TYPE filter, paginated.
- View/edit by value type:
  - String: `GET` → edit → `SET`.
  - Hash: `HGETALL` → inline field edit → `HSET` / `HDEL`.
  - List: `LRANGE` → edit items → `LSET` / `LINSERT` / `LREM`.
  - Set: `SMEMBERS` → add/remove → `SADD` / `SREM`.
  - Sorted set: `ZRANGE WITHSCORES` → edit score/member → `ZADD` / `ZREM`.
- Set TTL: `EXPIRE` / `PERSIST`.
- Rename key: `RENAME`.
- Delete key: `DEL` with confirm.

### 6.2 Structure operations (per driver)

**MySQL / PostgreSQL:**
| Operation | UI trigger | Generated statement |
|---|---|---|
| Create table | SchemaTree ctx menu → "New table" → column designer form | `CREATE TABLE ...` |
| Add column | StructureView → "+ Add column" form | `ALTER TABLE ADD COLUMN` |
| Modify column | StructureView → column row → edit | `ALTER TABLE MODIFY COLUMN` (MySQL) / `ALTER TABLE ALTER COLUMN` (PG) |
| Drop column | StructureView → column row → delete | `ALTER TABLE DROP COLUMN` |
| Rename column | StructureView → column row → rename | `ALTER TABLE RENAME COLUMN` |
| Create index | StructureView → Indexes tab → "+ Add index" | `CREATE [UNIQUE] INDEX` |
| Drop index | StructureView → Indexes tab → delete | `DROP INDEX` |
| Create view | SchemaTree ctx menu → "New view" | `CREATE VIEW` |
| Drop view | SchemaTree ctx menu → "Drop view" | `DROP VIEW` |
| Rename table | SchemaTree ctx menu → "Rename" | `RENAME TABLE` / `ALTER TABLE RENAME TO` |
| Drop table | SchemaTree ctx menu → "Drop table" | `DROP TABLE` with Dialog confirm |
| Truncate table | SchemaTree ctx menu → "Truncate" | `TRUNCATE TABLE` with Dialog confirm |

**SQLite:**
- Same as above except: `MODIFY COLUMN` not supported → surface clear error with workaround note.
- `DROP COLUMN` requires SQLite ≥3.35 — backend detects version, errors clearly if older.

**MongoDB:**
| Operation | Generated command |
|---|---|
| Create collection | `db.createCollection` |
| Drop collection | `collection.drop` with Dialog confirm |
| Rename collection | `db.renameCollection` with Dialog confirm |
| Create index | `collection.createIndex` |
| Drop index | `collection.dropIndex` with Dialog confirm |

**Redis:**
- No table-level structure. All operations are key-level (see §6.1).

---

## 7. Frontend Structure

### 7.1 Component tree

```
frontend/components/db-client/
  DbClientButton.svelte
  DbClientModal.svelte              ← Modal.svelte bare mode, min(95vw,1400px)
  sidebar/
    ConnectionList.svelte
    ConnectionForm.svelte           ← driver-aware; SSH section collapsible
    SchemaTree.svelte               ← lazy, manual refresh; context menus
    ConnectionBadge.svelte          ← driver icon + health dot
  main/
    TabBar.svelte                   ← new tab, close, reorder (drag)
    QueryEditor.svelte              ← Monaco (sql/javascript/shell per driver)
    DataGrid.svelte                 ← browse + inline edit + insert/delete row
    StructureManager.svelte         ← view + manage columns/indexes/FK
    HistoryView.svelte              ← paginated unlimited, search, re-run
    TableDesigner.svelte            ← create/alter table form (generates DDL preview)
    IndexForm.svelte                ← create index form
    ViewForm.svelte                 ← create/edit view form
  shared/
    DriverIcon.svelte
    SqlStatusPill.svelte
    RowForm.svelte                  ← generic insert/edit row form (type-aware fields)
    ConfirmDestructive.svelte       ← thin wrapper for Dialog.svelte with destructive preset
```

### 7.2 Tab types

Each tab has a `type`:
- `query` — Monaco editor + result panel.
- `data` — DataGrid for a specific table/collection.
- `structure` — StructureManager for a specific table/collection.
- `history` — HistoryView.

Double-clicking a table in SchemaTree opens/focuses its `data` tab. Right-click → "View Structure" opens its `structure` tab.

### 7.3 SchemaTree context menu

| Node type | Menu items |
|---|---|
| Database | Refresh, New Table, New View |
| Table / Collection | Open Data, Open Structure, New Query (`SELECT * FROM …`), Rename, Truncate, Drop |
| View | Open Query, Drop |
| Index | Drop |

### 7.4 Store (`frontend/stores/features/db-client.svelte.ts`)

```ts
class DbClientStore {
  connections = $state<DbClientConnection[]>([]);
  activeConnectionId = $state<string | null>(null);
  schema = $state<Record<string, DbClientSchemaNode[]>>({});
  queryTabs = $state<QueryTab[]>([]);
  activeTabId = $state<string | null>(null);
  health = $state<Record<string, DbClientHealth>>({});

  // Connections
  async list() { ... }
  async create(input: DbClientConnectionInput) { ... }
  async update(id: string, patch: Partial<DbClientConnectionInput>) { ... }
  async remove(id: string) { ... }
  async test(input: DbClientConnectionInput) { ... }

  // Schema
  async refreshSchema(connId: string, opts?: { database?: string }) { ... }
  async getObjectDetails(connId: string, opts: { database?: string; schema?: string; name: string; type: string }) { ... }

  // Query execution
  async executeRead(connId: string, query: string, opts?: { database?: string; limit?: number }) { ... }
  async executeWrite(connId: string, query: string, opts?: { database?: string }) { ... }
  async cancelExecution(executionId: string) { ... }

  // Data CRUD
  async insertRow(connId: string, table: string, row: Record<string, unknown>, opts?: { database?: string }) { ... }
  async updateRow(connId: string, table: string, pk: Record<string, unknown>, changes: Record<string, unknown>, opts?: { database?: string }) { ... }
  async deleteRows(connId: string, table: string, pks: Record<string, unknown>[], opts?: { database?: string }) { ... }

  // Structure
  async createTable(connId: string, definition: TableDefinition, opts?: { database?: string }) { ... }
  async alterTable(connId: string, name: string, ops: AlterOperation[], opts?: { database?: string }) { ... }
  async dropTable(connId: string, name: string, opts?: { database?: string }) { ... }
  async truncateTable(connId: string, name: string, opts?: { database?: string }) { ... }
  async createIndex(connId: string, tableName: string, def: IndexDefinition, opts?: { database?: string }) { ... }
  async dropIndex(connId: string, tableName: string, indexName: string, opts?: { database?: string }) { ... }

  // History
  async listHistory(connId: string, opts?: { limit?: number; offset?: number; search?: string }) { ... }
  async deleteHistory(opts: { connectionId?: string; id?: string }) { ... }

  // Tabs
  openTab(tab: QueryTab) { ... }
  closeTab(tabId: string) { ... }
  setActiveTab(tabId: string) { ... }
}
export const dbClient = new DbClientStore();
```

### 7.5 Navigator button placement

- `DesktopNavigator.svelte` — insert `DbClientButton` between `TunnelButton` and Settings (expanded + collapsed states).
- `MobileNavigator.svelte` — insert `DbClientButton` next to `TunnelButton`.
- Icon: `lucide:database`. Badge: count of live connections.
- Keyboard shortcut (v1): `Cmd+Shift+D`.

---

## 8. Modal Layout

```
┌────────────── DbClientModal (min(95vw, 1400px)) ─────────────────┐
│ Sidebar (280px)           │ Main (flex-1)                        │
│  [header: connection]     │  [TabBar]  Query · Data · Structure  │
│  ConnectionList           │            · History                 │
│    + ConnectionForm       │                                      │
│  ──────────────────       │  Active tab content:                 │
│  SchemaTree               │   Query  → Monaco + result panel     │
│    (lazy, manual refresh) │   Data   → DataGrid (CRUD)           │
│    right-click menus      │   Structure → StructureManager       │
│                           │   History → HistoryView              │
└───────────────────────────┴──────────────────────────────────────┘
```

Mirrors SettingsModal structure: left sidebar with nav, right content area. Uses `Modal.svelte` with `bare` mode and overridden max-width.

---

## 9. Dependencies To Add

| Package | Phase | Reason |
|---|---|---|
| `mongodb` | Phase 1 | MongoDB driver — no Bun native equivalent |
| SSH library (TBD Phase 0) | Phase 1 | SSH tunnel — `ssh2` or alternative |

All other drivers use Bun native APIs pending Phase 0 confirmation.

---

## 10. Phase Breakdown with Checkpoints

Each checkpoint ends in a STOP for user review per `CLAUDE.md`.

---

### PHASE 0 — Driver & Library Compatibility Research

Goal: verify which Bun-native APIs work for each driver, find the right SSH tunnel library, identify limitations. **No production code written.** Results recorded in CHECKPOINT 0 table and used as binding reference for Phases 1–2.

#### 0.1 Bun.sql — MySQL `[ ]`
- [ ] Install test MySQL instance (local Docker or existing).
- [ ] Test `Bun.sql` (Bun ≥1.2) with MySQL: `connect`, `ping`, `SELECT 1`.
- [ ] Verify parameterized queries work.
- [ ] Test connection close / reconnect.
- [ ] If fails → test `mysql2` npm package as alternative.
- [ ] Record: API chosen, Bun version required, known limitations.

#### 0.2 Bun.sql — PostgreSQL `[ ]`
- [ ] Same test suite as above with PostgreSQL.
- [ ] Test `EXPLAIN FORMAT JSON`.
- [ ] If fails → test `pg` npm package.
- [ ] Record findings.

#### 0.3 bun:sqlite — SQLite `[ ]`
- [ ] Confirm `bun:sqlite` works (expected: yes).
- [ ] Check SQLite version bundled in current Bun — determines `DROP COLUMN` / `RENAME COLUMN` availability.
- [ ] Record SQLite version and resulting feature constraints.

#### 0.4 Bun.redis — Redis `[ ]`
- [ ] Test `Bun.redis` (Bun ≥1.2.9): `PING`, `SET`, `GET`, `SCAN`, `HSET`.
- [ ] Test command array interface.
- [ ] If fails → test `ioredis` npm package.
- [ ] Record findings.

#### 0.5 mongodb npm — MongoDB `[ ]`
- [ ] `bun add mongodb` — confirm Bun compatibility.
- [ ] Test: connect, `ping`, `listCollections`, `find`, `insertOne`.
- [ ] Record version and any Bun-specific quirks.

#### 0.6 SSH tunnel library `[ ]`
- [ ] Test `ssh2` npm with Bun: install, open TCP forward to a remote host.
- [ ] Verify both `password` and `privateKey` auth work.
- [ ] Test tunnel through which `Bun.sql` (or chosen MySQL driver) connects.
- [ ] If `ssh2` fails → test `node-ssh` or `tunnel-ssh`.
- [ ] Record: library chosen, auth methods confirmed, limitations.

#### CHECKPOINT 0 `[ ]`

Fill in this table before proceeding:

| Driver | Bun-native API | Alternative (if needed) | Min Bun version | SQLite version | Known limitations |
|---|---|---|---|---|---|
| MySQL | `Bun.sql` / `mysql2` | — | ? | — | ? |
| PostgreSQL | `Bun.sql` / `pg` | — | ? | — | ? |
| SQLite | `bun:sqlite` | — | any | ? | DROP/MODIFY COLUMN? |
| MongoDB | `mongodb` vX.X | — | any | — | ? |
| Redis | `Bun.redis` / `ioredis` | — | ? | — | ? |
| SSH tunnel | `ssh2` vX.X / other | — | any | — | key auth quirks? |

- [ ] All 6 rows filled in.
- [ ] Implementation notes written for any driver with a non-native fallback.
- [ ] **STOP for user review.**

---

### PHASE 1 — Foundation

Goal: persist connections (with SSH), test them, open empty 2-pane modal from navigator.

#### 1.1 Migration + types + queries `[ ]`
- [ ] `backend/database/migrations/030_create_db_client_tables.ts` (2 tables, §2).
- [ ] Register in `backend/database/migrations/index.ts`.
- [ ] `shared/types/db-client/{connection,query,index}.ts` (§3).
- [ ] Row types for 2 new tables in `shared/types/database/schema.ts`.
- [ ] `backend/database/queries/db-client-connection-queries.ts`: `list`, `get`, `create`, `update`, `delete`, `markUsed`.
- [ ] `backend/database/queries/db-client-query-history-queries.ts`: `insert`, `list`, `deleteByConnection`, `deleteOne`.
- [ ] Export from `backend/database/queries/index.ts`.

#### 1.2 SSH tunnel `[ ]`
- [ ] `bun add <ssh-library-from-phase-0>`.
- [ ] `backend/db-client/ssh-tunnel.ts` — `openSshTunnel(ssh, remoteHost, remotePort): Promise<SshTunnel>`.
- [ ] Support `password` and `key` auth methods.
- [ ] Cleanup: tunnel auto-closes when `SshTunnel.close()` called.

#### 1.3 Driver layer + connection manager `[ ]`
- [ ] `bun add mongodb` + SSH library (if not above).
- [ ] `backend/db-client/drivers/types.ts` — full `DbClientDriverAdapter` interface (§5.1).
- [ ] `backend/db-client/drivers/mysql.ts` — connect/close/health/executeRead/executeWrite/explain (Phase 1 only; structure + data CRUD in Phase 2).
- [ ] `backend/db-client/drivers/postgres.ts` — same.
- [ ] `backend/db-client/drivers/sqlite.ts` — same.
- [ ] `backend/db-client/drivers/mongodb.ts` — connect/close/health/ping/listCollections.
- [ ] `backend/db-client/drivers/redis.ts` — connect/close/health/PING.
- [ ] `backend/db-client/connection-manager.ts` — singleton, SSH tunnel lifecycle, lazy connect, idle sweep (10 min).
- [ ] `backend/db-client/query-executor.ts` — `classifyQuery` + skeleton `runSafely` (auto-LIMIT 500 for read SELECT).

#### 1.4 WS handlers — connections only `[ ]`
- [ ] `backend/ws/db-client/connections.ts` — list/get/create/update/delete/test/health.
- [ ] `backend/ws/db-client/index.ts` — router.
- [ ] Register in `backend/ws/index.ts`.

#### 1.5 Frontend shell `[ ]`
- [ ] `frontend/stores/features/db-client.svelte.ts` — connections CRUD + test (skeleton).
- [ ] `frontend/components/db-client/DbClientButton.svelte` — icon `lucide:database`, badge = live connection count.
- [ ] `frontend/components/db-client/DbClientModal.svelte` — `Modal.svelte` bare mode, `min(95vw,1400px)`, 2-pane placeholder.
- [ ] `frontend/components/db-client/sidebar/ConnectionList.svelte`.
- [ ] `frontend/components/db-client/sidebar/ConnectionForm.svelte` — driver-aware; default ports (decision #17); SSH section (collapsible, off by default); Test + Save buttons; shows `DbClientHealth` result inline.
- [ ] `frontend/components/db-client/sidebar/ConnectionBadge.svelte` — driver icon + health dot.
- [ ] `frontend/components/db-client/shared/DriverIcon.svelte`.
- [ ] Wire button into `DesktopNavigator.svelte` (expanded + collapsed) and `MobileNavigator.svelte`.

#### CHECKPOINT 1 `[ ]`
- [ ] `bun run check` passes.
- [ ] `bun run lint` passes.
- [ ] Manual: button visible between TunnelButton and Settings (desktop + mobile + collapsed nav).
- [ ] Manual: create one connection per driver — Test returns health (success or descriptive error).
- [ ] Manual: create connection with SSH tunnel enabled — Test shows both SSH and DB status.
- [ ] Manual: empty `database` field → health check still passes (no error for missing DB field).
- [ ] **STOP for user review.**

---

### PHASE 2 — Data Exploration & Full CRUD

Goal: browse schemas, execute queries, CRUD data, manage structure, export, history.

#### 2.1 Schema introspection `[ ]`
- [ ] MySQL: `information_schema.tables/columns/key_column_usage` + `SHOW INDEXES`.
- [ ] PostgreSQL: `information_schema` + `pg_indexes` + `pg_description`.
- [ ] SQLite: `sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA foreign_key_list`. Detect SQLite version for feature flags.
- [ ] MongoDB: `listCollections`, `indexInformation`, 100-doc field sampler.
- [ ] Redis: `SCAN` (cap 1000), `TYPE`, `TTL`, `MEMORY USAGE`.
- [ ] WS: `db-client:list-databases|list-schemas|list-objects|object-details` → `backend/ws/db-client/schema.ts`.
- [ ] `listDatabases` respects empty `database` field — returns all accessible databases.

#### 2.2 Query execution `[ ]`
- [ ] Complete `classifyQuery` + `runSafely` (LIMIT 500 injection).
- [ ] WS: `db-client:execute-read|execute-write|explain|cancel` → `backend/ws/db-client/query.ts`.
- [ ] Persist every execution to `db_client_query_history`.
- [ ] WS: `db-client:history:list|delete`.

#### 2.3 Data CRUD handlers `[ ]`
- [ ] Per-driver `insertRow`, `updateRow`, `deleteRows` in each driver adapter.
- [ ] WS: `db-client:data:insert|update|delete` → `backend/ws/db-client/query.ts`.
- [ ] All statements fully parameterized — no raw string interpolation of user values.

#### 2.4 Structure handlers `[ ]`
- [ ] Per-driver structure methods in each adapter (create/alter/drop table, index, view per §6.2).
- [ ] SQLite: detect version, apply `DROP COLUMN` / `MODIFY COLUMN` availability guard.
- [ ] WS: all `db-client:structure:*` actions → `backend/ws/db-client/structure.ts`.
- [ ] Every structure action that executes a DDL persists it to `db_client_query_history` with status.

#### 2.5 Schema tree UI `[ ]`
- [ ] `SchemaTree.svelte` — lazy expand, manual refresh button (per-connection).
- [ ] Right-click context menus per node type (§7.3).
- [ ] Double-click table → open Data tab; single-click column → copy name.

#### 2.6 Query tab UI `[ ]`
- [ ] `TabBar.svelte` — list tabs, `+` new, close, reorder (drag).
- [ ] `QueryEditor.svelte` — Monaco, language per driver; `Cmd+Enter` run, `Esc` cancel, `Cmd+K` clear.
- [ ] Classification badge (read / write / ddl / unknown) above run button.
- [ ] `write` or `ddl` classification → show `ConfirmDestructive` before executing.
- [ ] Result panel below editor: `DbClientQueryResult` rows + affected rows count + duration.

#### 2.7 Data tab UI `[ ]`
- [ ] `DataGrid.svelte` — virtualized grid, pagination (100/page default).
- [ ] Column sort (click header), basic filter input per column.
- [ ] PK auto-detect from `ObjectDetails`; inline edit gated on PK presence.
- [ ] Inline edit: click cell → edit → Tab/Enter → stage change → Save button → `db-client:data:update`.
- [ ] Insert row: `+ Add row` button → `RowForm.svelte` → `db-client:data:insert`.
- [ ] Delete row(s): select checkbox(es) → trash button → `ConfirmDestructive` → `db-client:data:delete`.
- [ ] Export current result: CSV / JSON / Markdown. Copy cell / row / column.
- [ ] Redis: type-aware rendering and editing (string/hash/list/set/zset per §6.1).

#### 2.8 Structure tab UI `[ ]`
- [ ] `StructureManager.svelte` — shows `DbClientObjectDetails` for active table/collection.
- [ ] Columns section: list with type/nullable/default/PK/unique; inline rename; "+ Add column" → `TableDesigner.svelte` add-column form; delete column → `ConfirmDestructive`.
- [ ] Indexes section: list; "+ Add index" → `IndexForm.svelte`; drop index → `ConfirmDestructive`.
- [ ] Foreign keys section: read-only display (v1).
- [ ] Table actions toolbar: Rename table, Truncate (+ confirm), Drop table (+ confirm).
- [ ] MongoDB: collection name, indexes, field stats from sampler; rename + drop actions.
- [ ] SQLite: surface limitation notice for unsupported operations.
- [ ] `TableDesigner.svelte`: column designer form (name, type, nullable, default, PK, unique) with live DDL preview before submit.

#### 2.9 History tab UI `[ ]`
- [ ] `HistoryView.svelte` — paginated unlimited, search, re-run (inserts query into new Query tab), delete entry.

#### CHECKPOINT 2 `[ ]`
- [ ] `bun run check` / `bun run lint` pass.
- [ ] Manual: expand schema tree on each driver — correct objects listed.
- [ ] Manual: empty `database` → all databases listed in sidebar tree.
- [ ] Manual: SELECT returns results; CSV/JSON export works.
- [ ] Manual: write/DDL query triggers `ConfirmDestructive` before execution.
- [ ] Manual: inline edit commits UPDATE (tested MySQL, PostgreSQL, SQLite).
- [ ] Manual: inline edit disabled with tooltip on PK-less table.
- [ ] Manual: Insert row via form — row appears in grid.
- [ ] Manual: Delete row(s) — confirm dialog → rows removed.
- [ ] Manual: Add column → DDL preview shown → column appears in StructureManager.
- [ ] Manual: Drop index → ConfirmDestructive → index removed.
- [ ] Manual: Truncate table → confirm → table empty.
- [ ] Manual: Drop table → confirm → table removed from schema tree.
- [ ] Manual: MongoDB — insert document, update field inline, delete document.
- [ ] Manual: Redis — GET/SET string, HSET field, SADD member, set TTL.
- [ ] Manual: SSH tunnel connection — all above operations work through tunnel.
- [ ] Manual: history entries persist; re-run inserts query into new tab.
- [ ] Manual: cancel long-running query works.
- [ ] **STOP for user review.**

---

## 11. Post-v1 Backlog (NOT in scope)

- AI assistant panel backed by MCP `db-client` server.
- Encrypted credentials at rest (AES-GCM w/ machine key).
- Data diff between two connections.
- Export dump (mysqldump / pg_dump).
- Schema visualizer (ERD).
- Saved queries library.
- Foreign key navigation (click FK value → jump to referenced row).
- Query result plotting / charts.
- Collaborative cursors.
- Connection groups / folders.

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bun.sql MySQL/PG not production-ready | Phase 0 validates this; fallback to `mysql2`/`pg` if needed. |
| `ssh2` Bun compatibility unknown | Phase 0 tests this; alternatives noted in research. |
| SQLite ALTER TABLE limitations | Backend version-detects; surfaces clear error; workaround (recreate table) documented per limitation. |
| Driver connection leaks through SSH tunnel | Idle sweeper (10 min) closes both adapter and SSH tunnel together. |
| Huge result sets OOM frontend | Auto-LIMIT 500 + virtualized grid. |
| No schema cache = many WS round-trips | Tree is lazy (only expanded nodes fetch); refresh is explicit (decision #15). |
| MongoDB field sampler slow on large collection | 100-doc cap + driver-side timeout. |
| Parameterized INSERT/UPDATE building errors | Backend generates statements from structured input; never interpolates raw user strings. |

---

## 13. Conventions Recap (from CLAUDE.md)

- `const` by default; `let` only when reassignment needed.
- `.svelte`: `let` for `$state`/`$bindable`; `const` for `$derived`/`$props`/functions.
- Use `debug` module, never `console.*`.
- Tailwind v4 utilities.
- `bun run check` + `bun run lint` after each phase.
- Stop per checkpoint; do not proceed without user approval.
- Do not create additional `.md` files unless requested.
- Commit/branch naming per `CONTRIBUTING.md` — suggest only, never create.
- Everything uses `db-client` / `db_client` naming — never `database-client` / `database_client`.
