# Database Manager — Complete Change Documentation

**Branch:** `feat/databasemanager`
**Date:** 2026-03-15
**Scope:** Full-featured multi-database management system added to Clopen workspace

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Support](#database-support)
4. [Backend — DB Manager Modules](#backend--db-manager-modules)
5. [Backend — WebSocket Handlers](#backend--websocket-handlers)
6. [Backend — Database Migrations](#backend--database-migrations)
7. [Backend — Query Files](#backend--query-files)
8. [Backend — REST Endpoints](#backend--rest-endpoints)
9. [Frontend — Components](#frontend--components)
10. [Frontend — Stores](#frontend--stores)
11. [Shared Types](#shared-types)
12. [Utilities & Tooling](#utilities--tooling)
13. [Modified Files](#modified-files)
14. [Dependencies Added](#dependencies-added)
15. [Git Hooks & Scripts](#git-hooks--scripts)

---

## Overview

This branch introduces a complete **Database Manager** feature — a multi-database administration tool integrated into the Clopen workspace sidebar. It provides connection management, schema exploration, SQL editing, ERD visualization, schema versioning, automated backups, RBAC, audit logging, data generation, and a SQL-to-REST API generator, all accessible from a single modal in the UI.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (Svelte 5 Runes)                               │
│  DesktopNavigator → DatabaseModal                       │
│  ├── Stores: db-manager, db-sql-editor, db-diff, ...   │
│  └── Components: ConnectionForm, QueryPanel, ERD, ...   │
├─────────────────────────────────────────────────────────┤
│ WebSocket API (Elysia)                                  │
│  ws/database/index.ts → merges all db sub-routers      │
│  ├── connections, query, schema, backup, diff           │
│  ├── history, rbac, snippets, sql-rest-api, health      │
│  ├── erd, data-generator, process-manager               │
│  └── schema-versioning, ai-assistant, export            │
├─────────────────────────────────────────────────────────┤
│ DB Manager Modules (backend/db-manager/)                │
│  ├── Adapters: postgres, mysql, sqlite, mongodb,        │
│  │             mssql, redis                             │
│  └── Services: backup, rbac, diff, export, health,      │
│                schema-versioning, sql-rest-api,          │
│                alter-table-generator, crypto,            │
│                data-generator, process-manager,          │
│                ssh-tunnel                                │
├─────────────────────────────────────────────────────────┤
│ REST API                                                │
│  GET /sql-api/:slug  — Execute SQL REST endpoints       │
│  GET /sql-api/spec   — OpenAPI 3.0 specification        │
│  GET /sql-api/docs   — Swagger UI                       │
├─────────────────────────────────────────────────────────┤
│ SQLite Migrations (migrations 027–033)                  │
│  query_history, db_connection_permissions, db_audit_log │
│  db_backup_configs, db_backup_runs, sql_snippets        │
│  sql_api_endpoints, sql_api_keys, sql_api_request_log   │
│  schema_versions                                        │
└─────────────────────────────────────────────────────────┘
```

---

## Database Support

| Database    | Type      | Adapter File             | Features                         |
|-------------|-----------|--------------------------|----------------------------------|
| PostgreSQL  | SQL       | postgres-adapter.ts      | Full (schema, FK, explain)       |
| MySQL       | SQL       | mysql-adapter.ts         | Full (SHOW COLUMNS, KILL)        |
| MariaDB     | SQL       | mysql-adapter.ts         | Full (same driver as MySQL)      |
| SQLite      | SQL       | sqlite-adapter.ts        | Full (PRAGMA, Bun native)        |
| SQL Server  | SQL       | mssql-adapter.ts         | Full (sys.*, OFFSET/FETCH)       |
| MongoDB     | Document  | mongodb-adapter.ts       | Collections, aggregation, filter |
| Redis       | Key-Value | redis-adapter.ts         | Key groups, commands, TTL        |

All adapters support optional **SSH tunneling** for secure remote access.

---

## Backend — DB Manager Modules

### `backend/db-manager/index.ts`
Main dispatcher. Routes all database operations to the correct adapter based on `DBConnectionConfig.type`. Provides a unified API surface for:
- `testConnection()` — verify connectivity
- `listTables()` / `describeTable()` — schema inspection
- `executeQuery()` — arbitrary SQL / Redis commands / MongoDB filters
- `getTableData()` — paginated data browsing with filters
- `insertRow()`, `updateRow()`, `deleteRows()` — row-level CRUD
- `bulkDeleteRows()` / `bulkUpdateRows()` — transactional batch ops
- `getERDMetadata()` — full FK graph for diagram
- `globalSearch()` / `globalSearchSuggest()` — cross-table text search
- `applyAlterStatements()` — execute schema changes

### `backend/db-manager/postgres-adapter.ts`
PostgreSQL adapter using Bun's native SQL client. URL-based connection strings. Fetches FK constraints from `information_schema`.

### `backend/db-manager/mysql-adapter.ts`
MySQL/MariaDB adapter using `mysql2/promise`. Uses `SHOW COLUMNS` for schema, `information_schema` for FK constraints.

### `backend/db-manager/sqlite-adapter.ts`
SQLite adapter using Bun's built-in `:sqlite` module. Uses `PRAGMA table_info` and `PRAGMA foreign_key_list`. File-based, no network required.

### `backend/db-manager/mongodb-adapter.ts`
MongoDB adapter. Lists collections as "tables", infers schema by sampling documents. Supports both JSON filter queries and aggregation pipelines (via `[...]` bracket syntax).

### `backend/db-manager/mssql-adapter.ts`
SQL Server adapter using `mssql` package with connection pooling. Uses `sys.foreign_key_columns` for FK info and `OFFSET/FETCH NEXT` for pagination.

### `backend/db-manager/redis-adapter.ts`
Redis adapter using `ioredis`. Models key groups (prefix before `:`) as "tables". Supports raw command execution, TTL display, and key type detection.

### `backend/db-manager/ssh-tunnel.ts`
TCP port forwarding over SSH using the `ssh2` package.
- `openSSHTunnel(config)` — opens tunnel, returns local port
- `withSSHTunnel(config, fn)` — wraps adapter calls with automatic cleanup
- Supports password auth and PEM/OpenSSH private keys with optional passphrases

### `backend/db-manager/crypto.ts`
AES-256-GCM encryption for all sensitive credentials stored in SQLite.
- Master key auto-generated and stored in the settings table
- Format: `enc:<base64-iv>:<base64-ciphertext>`
- `encrypt()` / `decrypt()` — low-level
- `encryptConnectionCredentials()` / `decryptConnectionCredentials()` — connection config
- `encryptSSHTunnelCredentials()` / `decryptSSHTunnelCredentials()` — SSH config
- `sanitizeSSHTunnelForClient()` — masks secrets before sending to frontend

### `backend/db-manager/rbac.ts`
Role-Based Access Control for database connections.

**Roles:**
| Role      | Permissions                                   |
|-----------|-----------------------------------------------|
| Owner     | Full access (all 24 actions)                  |
| Developer | DML/DDL/schema/export/backup/health — no DROP DATABASE or connection delete |
| Viewer    | SELECT, browse, history, ERD, explain, export |

App-level `admin` role gets Owner rights on all connections.

Key functions:
- `classifySql(sql)` — categorizes as SELECT, DML, DDL, or DROP_DB
- `getEffectiveRole(userId, connectionId)` — resolves role with admin override
- `can(role, action)` / `assertCan(role, action)` — permission gate
- `resolveIdentity(ws)` — extracts userId and appRole from WebSocket context

### `backend/db-manager/backup.ts`
Automated backup service with cloud storage upload.
- `generateSqlDump()` — async generator that streams SQL dump
- `runBackup(configId)` — full pipeline: dump → optional compress → encrypt → upload
- `uploadToS3()` — AWS S3 via SigV4 signed requests (no SDK dependency)
- `uploadToGCS()` — Google Cloud Storage via service account JWT
- `startBackupScheduler()` / `stopBackupScheduler()` — cron-like scheduler (checks every minute)
- Schedules: hourly, daily, weekly, monthly
- Automatic retention-based pruning of old backup records

### `backend/db-manager/diff.ts`
Schema comparison engine.
- `getFullSchema(config)` — snapshots all tables, columns, and indexes
- `compareSchemas(source, target)` — produces `DBSchemaDiff` with per-table/column/index status
- `generateMigrationScript(diff, source, target)` — generates UP and DOWN SQL
- Supports: SQLite, PostgreSQL, MySQL, MariaDB, MSSQL
- Warns on destructive operations (DROP COLUMN, DROP TABLE)

### `backend/db-manager/export.ts`
Batch export and import utilities.
- `fetchExportBatch(config, table, page, pageSize)` — paginated row fetch
- `generateCreateTableSql(config, table)` — CREATE TABLE statement for export
- `rowsToInsertSql(table, rows)` — converts rows to INSERT statements
- `rowsToCsv(columns, rows)` — CSV formatting
- `importBatch(config, table, rows, mapping)` — batch INSERT with column mapping and skip-on-error support

### `backend/db-manager/health.ts`
Health metrics collector. Engine-specific implementations for:
- **PostgreSQL** — `pg_stat_activity`, `pg_stat_bgwriter`, `pg_stat_database`
- **MySQL/MariaDB** — `SHOW STATUS`, `SHOW PROCESSLIST`
- **MSSQL** — `sys.dm_exec_requests`, `sys.dm_os_performance_counters`
- **MongoDB** — `serverStatus` command
- **Redis** — `INFO` command sections
- **SQLite** — file size, PRAGMA page stats

Collected metrics: active connections, TPS, buffer cache hit ratio, DB size, top slow queries.

### `backend/db-manager/schema-versioning.ts`
Helper for computing column states and generating DOWN migration SQL.
- `applyChangesToColumns(cols, changes)` — simulates schema changes
- `generateDownStatements(before, after, dbType, table)` — reverse operations for rollback

### `backend/db-manager/sql-rest-api.ts`
SQL-to-REST API execution engine.
- `buildSafeQuery(template, params)` — named parameter substitution (no SQL injection)
- `assertSelectOnly(sql)` — enforces read-only access
- `checkRateLimit(keyId, limit, windowSecs)` — in-memory sliding-window limiter
- `getCached()` / `setCache()` — in-memory TTL cache
- `executeEndpointQuery(slug, params, apiKey, ip)` — main handler with full pipeline
- `generateOpenApiSpec()` — OpenAPI 3.0 JSON spec
- `generateSwaggerHtml()` — self-hosted Swagger UI page

### `backend/db-manager/alter-table-generator.ts`
Database-specific ALTER TABLE statement generator.
- `generateAlterStatements(dbType, table, changes, schema)` — main dispatcher
- Dialects: PostgreSQL (`ALTER COLUMN ... TYPE`), MySQL (`CHANGE`/`MODIFY`), MSSQL (`ALTER COLUMN`), SQLite (full table recreation)
- Change types: Add Column, Drop Column, Rename Column, Modify (type, nullable, default, FK, unique)
- `validate(changes)` — returns warnings for data-loss operations

### `backend/db-manager/data-generator.ts`
Fake data generator powered by `@faker-js/faker`.
- `suggestStrategy(col)` — heuristic strategy detection from column name/type
- `inspectTableForDatagen(config, table)` — returns column infos with suggestions
- `generateAndInsert(config, table, colConfigs, count)` — generates and inserts in batches
- 31 Faker strategies: firstName, lastName, email, phone, address, uuid, integer, float, date, boolean, and more
- FK-aware: samples referenced table values to honor constraints
- Detects auto-increment columns and skips them

### `backend/db-manager/process-manager.ts`
Active database session monitoring and management.
- `listProcesses(config)` — returns active sessions/queries with stats
- `killProcess(config, processId, mode)` — terminates query or full connection
- Per-engine: MySQL `SHOW FULL PROCESSLIST`, PostgreSQL `pg_stat_activity`, MSSQL `sys.dm_exec_requests`, MongoDB `currentOp`, Redis `CLIENT LIST`
- Kill modes: `'query'` (cancel only) vs `'connection'` (full termination)

---

## Backend — WebSocket Handlers

All handlers live in `backend/ws/database/` and are merged in `backend/ws/database/index.ts` into a single `databaseRouter` which is then merged into the main `wsRouter`.

### `ws/database/connections.ts`
Manages connection CRUD with encrypted credential storage and permission scoping.

| Message | Description |
|---------|-------------|
| `db:connections:list` | List connections visible to the requesting user |
| `db:connections:create` | Create connection (encrypts credentials) |
| `db:connections:update` | Update connection (preserves existing encrypted values for masked fields) |
| `db:connections:delete` | Delete connection and all associated permissions |
| `db:connections:test` | Test without saving |

### `ws/database/query.ts`
Query execution, data browsing, CRUD, and global search. All DML/DDL operations are automatically written to `db_audit_log`.

| Message | Description |
|---------|-------------|
| `db:explore:tables` | List tables for connection |
| `db:explore:columns` | Describe table columns with FK info |
| `db:explore:data` | Browse rows with filters and pagination |
| `db:data:count` | Row count for table/filter |
| `db:query:execute` | Execute SQL (auto-saved to query history) |
| `db:query:explain` | Run EXPLAIN on SQL |
| `db:data:insert` | Insert row with audit |
| `db:data:update` | Update row with before/after snapshot |
| `db:data:delete` | Delete row(s) with audit |
| `db:bulk:delete` | Transactional bulk delete |
| `db:bulk:update` | Transactional bulk update |
| `db:search:suggest` | Autocomplete suggestions |
| `db:search:global` | Cross-table full-text search |

### `ws/database/schema.ts`
Schema alteration with preview and version tracking.

| Message | Description |
|---------|-------------|
| `db:schema:columns` | Load column definitions for Table Architect |
| `db:schema:preview` | Generate SQL preview (no DB mutation) |
| `db:schema:apply` | Apply changes and record schema version |

### `ws/database/backup.ts`
Backup configuration and scheduling.

| Message | Description |
|---------|-------------|
| `db:backup:list` | List backup configs |
| `db:backup:create` | Create config (encrypts cloud credentials) |
| `db:backup:update` | Update config (masked credential handling) |
| `db:backup:delete` | Delete config |
| `db:backup:run` | Trigger backup immediately |
| `db:backup:history` | Get backup run history for a config |

### `ws/database/diff.ts`
Schema diff and migration.

| Message | Description |
|---------|-------------|
| `db:diff:compare` | Compare two connection schemas |
| `db:diff:generate` | Generate UP/DOWN migration SQL |
| `db:diff:apply` | Apply migration to target connection |

### `ws/database/export.ts`
Streaming export and import.

| Message | Description |
|---------|-------------|
| `db:export:batch` | Fetch rows in batches for client-side streaming |
| `db:export:schema` | Get CREATE TABLE SQL for a table |
| `db:import:batch` | Import rows with column mapping |

### `ws/database/health.ts`

| Message | Description |
|---------|-------------|
| `db:health:metrics` | Collect and return health metrics snapshot |

### `ws/database/history.ts`

| Message | Description |
|---------|-------------|
| `db:history:list` | List query history (optional connection filter) |
| `db:history:delete` | Delete history entry |
| `db:history:favorite` | Toggle favorite flag |
| `db:history:clear` | Clear all history for connection |

### `ws/database/rbac.ts`

| Message | Description |
|---------|-------------|
| `db:rbac:permissions:list` | List all permissions for connection |
| `db:rbac:permissions:grant` | Grant/update role for user |
| `db:rbac:permissions:revoke` | Revoke permission (prevents last owner self-revoke) |
| `db:rbac:my-role` | Get requesting user's role |
| `db:rbac:users:list` | List all app users for permission picker |
| `db:rbac:audit:list` | View audit log |
| `db:rbac:audit:prune` | Delete logs older than N days |
| `db:audit:rollback` | Rollback DML using before_data snapshot |

### `ws/database/schema-versioning.ts`

| Message | Description |
|---------|-------------|
| `db:schema:version:list` | List versions for a table |
| `db:schema:version:list-connection` | List versions across all tables |
| `db:schema:version:get` | Get full version with SQL and column snapshots |
| `db:schema:version:diff` | Compute diff between two versions |
| `db:schema:version:rollback` | Run DOWN migration and record as new version |
| `db:schema:version:label` | Update version label/notes |
| `db:schema:version:export` | Export version SQL (up or down) |
| `db:schema:version:delete` | Delete rolled_back version records |

### `ws/database/snippets.ts`

| Message | Description |
|---------|-------------|
| `db:snippets:list` | List own + public snippets |
| `db:snippets:create` | Create snippet |
| `db:snippets:update` | Update (owner only) |
| `db:snippets:delete` | Delete (owner only) |
| `db:snippets:share` | Generate or revoke share token |
| `db:snippets:get-by-token` | Public access by share token |

### `ws/database/sql-rest-api.ts`

| Message | Description |
|---------|-------------|
| `db:rest-api:list` | List endpoints |
| `db:rest-api:get` | Get single endpoint |
| `db:rest-api:create` | Create endpoint with slug validation |
| `db:rest-api:update` | Update endpoint |
| `db:rest-api:delete` | Delete endpoint |
| `db:rest-api:extract-params` | Extract `:placeholder` params from SQL |
| `db:rest-api:keys:list` | List API keys |
| `db:rest-api:keys:create` | Create key (secret shown once) |
| `db:rest-api:keys:delete` | Revoke key |
| `db:rest-api:keys:toggle` | Enable/disable key |
| `db:rest-api:logs` | Get request logs |

### `ws/database/ai-assistant.ts`

| Message | Description |
|---------|-------------|
| `db:ai:generate-sql` | Natural language → SQL using schema context |
| `db:ai:explain-query` | Explain SQL in plain language with step-by-step breakdown |

Supports Claude models: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`. Uses `ANTHROPIC_API_KEY` env var or app OAuth token.

### `ws/database/erd.ts`

| Message | Description |
|---------|-------------|
| `db:erd:metadata` | Get tables, columns, and FK relationships for ERD |

### `ws/database/data-generator.ts`

| Message | Description |
|---------|-------------|
| `db:datagen:schema` | Inspect table and return Faker strategy suggestions |
| `db:datagen:batch` | Generate and insert a batch of fake rows |

### `ws/database/process-manager.ts`

| Message | Description |
|---------|-------------|
| `db:processes:list` | List active sessions/queries |
| `db:processes:kill` | Kill session or cancel query |

---

## Backend — Database Migrations

| Migration | File | Tables Created |
|-----------|------|----------------|
| 027 | `027_query_history.ts` | `query_history` |
| 028 | `028_db_manager_rbac.ts` | `db_connection_permissions`, `db_audit_log` |
| 029 | `029_db_backup.ts` | `db_backup_configs`, `db_backup_runs` |
| 030 | `030_sql_snippets.ts` | `sql_snippets` |
| 031 | `031_sql_rest_api.ts` | `sql_api_endpoints`, `sql_api_keys`, `sql_api_request_log` |
| 032 | `032_audit_trail_snapshots.ts` | Adds `before_data`, `after_data`, `pk_column`, `pk_value` to `db_audit_log` |
| 033 | `033_schema_versioning.ts` | `schema_versions` |

### Schema Details

**`query_history`** — SQL execution log
`id, connection_id, connection_name, connection_type, sql, execution_time_ms, row_count, error, executed_at, is_favorite`

**`db_connection_permissions`** — Per-user connection roles
`id, connection_id, user_id, role (owner|developer|viewer), granted_by, granted_at`
Unique constraint: `(connection_id, user_id)`

**`db_audit_log`** — Full DML/DDL audit trail
`id, connection_id, connection_name, user_id, user_name, action, sql, table_name, row_count, execution_time_ms, success, error, ip_address, performed_at, before_data, after_data, pk_column, pk_value`

**`db_backup_configs`** — Automated backup schedules
`id, connection_id, name, enabled, provider (aws-s3|gcs), frequency (hourly|daily|weekly|monthly), hour, day_of_week, day_of_month, bucket, prefix, [encrypted cloud credentials], retention_days, last_run_at, last_run_success, last_run_error, created_at, updated_at`

**`db_backup_runs`** — Backup execution history
`id, config_id, connection_id, connection_name, started_at, completed_at, success, file_size, storage_path, error`

**`sql_snippets`** — Reusable SQL library
`id, title, description, sql, tags (JSON), is_public, share_token (UNIQUE), created_by, created_by_name, created_at, updated_at`

**`sql_api_endpoints`** — SQL REST API definitions
`id, connection_id, name, description, slug (UNIQUE), sql_template, params (JSON), is_public, enabled, rate_limit_requests, rate_limit_window_secs, cache_ttl_secs, created_by, created_by_name, created_at, updated_at`

**`sql_api_keys`** — API authentication keys
`id, endpoint_id, name, key_hash (UNIQUE), key_prefix, enabled, last_used_at, expires_at, created_by, created_at`

**`sql_api_request_log`** — API endpoint usage log
`id, endpoint_id, endpoint_slug, api_key_id, ip_address, params (JSON), status_code, row_count, execution_time_ms, error, requested_at`

**`schema_versions`** — Schema change history
`id, connection_id, connection_name, connection_type, table_name, schema_name, version_number, label, up_sql, down_sql, changes_json, columns_before_json, columns_after_json, applied_by_id, applied_by_name, applied_at, status (applied|rolled_back), notes`
Unique constraint: `(connection_id, table_name, version_number)`

---

## Backend — Query Files

| File | Tables Accessed | Purpose |
|------|-----------------|---------|
| `query-history-queries.ts` | `query_history` | CRUD + favorite toggle |
| `db-rbac-queries.ts` | `db_connection_permissions`, `db_audit_log` | Permissions, audit log, rollback data |
| `db-backup-queries.ts` | `db_backup_configs`, `db_backup_runs` | Backup config and history |
| `sql-snippet-queries.ts` | `sql_snippets` | Snippet CRUD + share token |
| `sql-rest-api-queries.ts` | `sql_api_endpoints`, `sql_api_keys`, `sql_api_request_log` | Endpoint CRUD, key management, logging |
| `schema-version-queries.ts` | `schema_versions` | Version history CRUD |

---

## Backend — REST Endpoints

Three new HTTP endpoints added to `backend/index.ts`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sql-api/spec` | Returns OpenAPI 3.0 specification JSON |
| `GET` | `/sql-api/docs` | Serves Swagger UI HTML |
| `GET` | `/sql-api/:slug` | Executes a SQL REST API endpoint |

The `/:slug` endpoint handles:
- API key lookup and validation (expiration check, enabled flag)
- Per-endpoint authorization (public vs key-required)
- Rate limiting (sliding window)
- Response caching (configurable TTL)
- Request logging to `sql_api_request_log`
- Error response normalization

---

## Frontend — Components

All components in `frontend/components/database/`.

### `DatabaseModal.svelte`
Main modal that hosts the entire database manager UI. Features:
- Left sidebar with connection list, add/edit/delete, and Schema Diff button
- Right panel: empty state, connection form, or connected database view
- Multi-tab bar (up to 10 tabs) with color-coded connection identifiers
- Lazy rendering — only active tab DOM is mounted
- Keyboard shortcuts: `Ctrl+P` (quick search), `Ctrl+Enter` (run query), `Ctrl+I` (ERD), `Ctrl+Shift+F` (global search), `Ctrl+Shift+H` (health), `Ctrl+Shift+M` (processes), `Ctrl+Shift+B` (backup), `Ctrl+Shift+R` (REST API), `Ctrl+1-9` (switch tabs)

### `ConnectionForm.svelte`
Form for creating/editing database connections. Features:
- Database type selector with icons, colors, and default ports
- Fields adapt per database type (file path for SQLite, host/port for others)
- SSH tunnel section (toggle, server credentials, PEM key upload)
- SSL toggle, test connection button with live feedback

### `TabBar.svelte`
Multi-tab navigation with connection color dots, tab close, and new-tab picker dropdown.

### `SchemaExplorer.svelte`
Tree view of tables/views grouped by schema. Shows columns with type badges and PK indicators. Clicking a table navigates to it in browse mode.

### `QueryPanel.svelte`
Container for SQL editing and results. Manages the dual-mode (Browse / Query) toggle, sub-tabs (Results, Plan, History, Snippets, Audit, Visualize, AI), and keyboard shortcut dispatch.

### `SqlEditor.svelte`
Monaco editor instance for SQL/JSON input. Features:
- SQL syntax highlighting with IntelliSense from `sql-completion.ts`
- `Ctrl+Enter` to execute, `Ctrl+Shift+Enter` for explain
- Imperative `setValue()` and `focus()` for programmatic control

### `ResultsTable.svelte`
Interactive data grid. Features:
- Inline cell editing with type-aware inputs
- Row selection with checkbox column
- Filter builder (column, operator, value)
- Pagination controls with configurable page size
- "Add Row" and "Delete Row" buttons with confirmation
- Data masking toggle (partial, stars, random)
- Bulk action bar (bulk delete/update on selection)
- Import/export buttons

### `AlterPreviewModal.svelte`
Shows generated ALTER TABLE SQL before applying. Displays warnings for destructive operations and blocks apply if any errors exist.

### `TableArchitectModal.svelte`
Visual table editor (Table Architect). Column list with type selector, nullable toggle, default value, FK picker, and unique constraint toggle. Tracks pending changes and sends them to preview/apply.

### `ColumnEditor.svelte`
Individual column editor row within Table Architect. Handles all column property edits.

### `ERDDiagram.svelte`
Interactive Entity-Relationship Diagram. Features:
- Layered auto-layout algorithm (Sugiyama-inspired)
- Pan and zoom with mouse/touch
- FK edges with directional arrows and highlight on hover
- Table cards with PK/FK column indicators
- Refresh button to reload schema

### `HealthDashboardPanel.svelte`
Real-time health monitoring. Features:
- Connection pool gauge (active / idle / waiting)
- TPS line chart (rolling 30 points)
- Memory/buffer cache hit ratio gauge
- Database size and disk metrics
- Top slow queries list
- Auto-refresh with configurable interval
- Alert badges for threshold violations

### `DiffPanel.svelte`
Schema comparison between two connections. Features:
- Source/target connection selectors
- Visual diff with color-coded status (added/removed/modified)
- Expand tables to see column-level changes
- "Generate Migration" to produce UP/DOWN SQL
- "Apply to Target" with confirmation

### `DiffMigrationModal.svelte`
Shows generated migration SQL with up/down toggle and copy button.

### `BackupPanel.svelte`
Automated backup management. Features:
- Backup config CRUD (AWS S3 / Google Cloud Storage)
- Schedule picker (hourly, daily, weekly, monthly)
- Retention days setting
- "Run Now" button for manual trigger
- Run history with success/failure indicators and file sizes

### `ExportModal.svelte`
Export configuration modal. Supports CSV, JSON, SQL (INSERT statements) with optional CREATE TABLE prefix.

### `ImportModal.svelte`
Import modal with file upload, header detection, column mapping, and skip-errors toggle.

### `VisualizationPanel.svelte`
Chart.js-backed visualization. Features:
- Chart type selector (bar, line, area, pie)
- X/Y column pickers from query result columns
- "Save to Dashboard" persists chart config to localStorage
- Snapshot-based stale-while-revalidate pattern
- Dashboard item list with staleness metadata and refresh

### `QueryHistoryPanel.svelte`
Query execution history. Features:
- Grouped by date (Today, Yesterday, date labels)
- Execution time and row count badges
- Favorite star toggle
- Search/filter by SQL text
- Delete individual entries

### `QueryProfilerDiagram.svelte`
Visual query profiler for EXPLAIN output. Renders execution plan steps as a flow diagram.

### `ExplainPanel.svelte`
Query plan viewer. Supports:
- SQLite tree-style output
- PostgreSQL plain-text format
- MySQL table-format output
- Profiler diagram toggle

### `AiSqlAssistantPanel.svelte`
AI-powered SQL assistant. Features:
- Natural language → SQL generation
- Query explanation with step-by-step breakdown
- Model selector (Haiku/Sonnet/Opus)
- Copy to clipboard and insert into editor

### `SqlRestApiPanel.svelte`
REST API generator management. Features:
- Endpoint list with search
- Form for creating/editing endpoints with SQL template, params, rate limit, and cache config
- API key management (create, revoke, toggle)
- Request log viewer
- URL copy button and link to docs

### `SqlRestApiFormModal.svelte`
Form modal for endpoint creation/editing with parameter extraction.

### `SqlRestApiKeyModal.svelte`
API key management modal (shows secret only on creation).

### `SqlRestApiDocsModal.svelte`
Embedded Swagger/OpenAPI documentation viewer.

### `SnippetsPanel.svelte`
SQL snippet library. Features:
- Tag-based filtering
- Public/private toggle with share token generation
- Quick insert and run actions
- Preview modal with syntax highlighting

### `SnippetFormModal.svelte`
Form modal for creating/editing snippets with tags, description, and visibility.

### `SnippetPreviewModal.svelte`
Read-only snippet preview with insert/run/copy actions.

### `SchemaVersionPanel.svelte`
Schema change version history. Features:
- Timeline view with version numbers and applied dates
- Status badges (applied, rolled_back)
- Inline label editing
- Version detail view with UP/DOWN SQL and column diff
- "Compare Versions" diff modal
- "Rollback" with confirmation
- Export SQL (up or down direction)

### `SchemaVersionDiffModal.svelte`
Shows diff between two schema versions with color-coded column changes.

### `SchemaRollbackModal.svelte`
Rollback confirmation modal showing DOWN SQL that will be executed.

### `AuditLogPanel.svelte`
Audit trail viewer. Features:
- Searchable/filterable action log
- Before/after data diff for UPDATE/INSERT/DELETE
- Expandable row details with SQL
- Prune old entries
- One-click rollback with confirmation modal

### `ProcessManagerPanel.svelte`
Database process monitor. Features:
- Real-time session list with state badges (active, idle, waiting)
- Duration with color-coded warnings
- CPU and I/O stats where available
- Connection pool bar visualization
- Kill (query) or Terminate (connection) with confirmation

### `DataGeneratorModal.svelte`
Fake data seeding UI. Features:
- Column list with auto-suggested Faker strategies
- Per-column strategy selector and options
- Row count input and batch size
- Progress bar with inserted/failed counts
- Error log display

### `DataMaskingModal.svelte`
Client-side data masking rule editor. Supports partial, stars, and random masking methods per column.

### `BulkActionModal.svelte`
Modal for confirming bulk delete/update operations with row count display.

### `RowEditModal.svelte`
Full row edit/insert form with field-per-column layout and FK hints.

### `PermissionsModal.svelte`
RBAC permission management. Shows current permissions table with role selectors and a user picker for granting new roles.

### `GlobalSearchPanel.svelte`
Full-text cross-table search panel. Features:
- Debounced autocomplete suggestions
- Results grouped by table
- Click to navigate to matching row

### `QuickTableSearch.svelte`
Spotlight-style quick search for tables (opened with `Ctrl+P`).

### `ShortcutGuideModal.svelte`
Reference modal listing all keyboard shortcuts for the database manager.

### `SshTunnelSection.svelte`
Reusable SSH tunnel configuration section used within ConnectionForm.

### `diff-utils.ts`
Client-side utility functions for formatting schema diffs in DiffPanel.

---

## Frontend — Stores

All stores use Svelte 5 runes (`$state`, `$derived`, `$effect`) and live in `frontend/stores/features/`.

| Store | File | Responsibility |
|-------|------|----------------|
| DB Manager | `db-manager.svelte.ts` | Connections, tabs (max 10), browse state, CRUD, bulk ops, global selection |
| SQL Editor | `db-sql-editor.svelte.ts` | Schema cache for IntelliSense, query history, AI assistant, EXPLAIN |
| Diff | `db-diff.svelte.ts` | Source/target selection, diff result, migration generation/apply |
| Backup | `db-backup.svelte.ts` | Backup config CRUD, run history, modal state |
| Health | `db-health.svelte.ts` | Metrics polling, 30-point rolling history, alert computation |
| ERD | `db-erd.svelte.ts` | ERD metadata loading and layout state |
| RBAC | `db-rbac.svelte.ts` | User role, permissions CRUD, audit log, rollback |
| Schema Versioning | `db-schema-versioning.svelte.ts` | Version history, diff modal, rollback confirmation, label editing |
| SQL REST API | `db-sql-rest-api.svelte.ts` | Endpoint CRUD, API keys, request logs, param extraction |
| SQL Snippets | `db-sql-snippets.svelte.ts` | Snippet CRUD, search, tag filter, share tokens |
| Visualization | `db-visualization.svelte.ts` | Chart config, dashboard items (localStorage), snapshot SWR |
| Alter Table | `db-alter.svelte.ts` | Pending changes, SQL preview, apply with callback |
| Data Generator | `db-data-generator.svelte.ts` | Column strategy config, batch generation progress |
| Data Masking | `db-data-masking.svelte.ts` | Mask rules (localStorage), masking functions |
| Export | `db-export.svelte.ts` | Streaming export (CSV/JSON/SQL), import with column mapping |
| Global Search | `db-global-search.svelte.ts` | Debounced suggestions, cross-table search results |
| Process Manager | `db-process-manager.svelte.ts` | Process list, kill/terminate actions |

### Multi-Tab Architecture (db-manager.svelte.ts)

Each connection session is stored as a `DBTabState` containing:
- Active table, columns, row data, page/filter state
- SQL editor content and query results
- Scroll position and selected rows

Switching tabs: snapshot current → restore target (no re-fetch). Maximum 10 simultaneous tabs.

---

## Shared Types

All types in `shared/types/` provide the contract between backend handlers and frontend stores.

| File | Key Types |
|------|-----------|
| `db-manager.ts` | `DBType`, `DBConnectionConfig`, `DBTable`, `DBColumn`, `DBQueryResult`, `DBTabState`, `DBBulkActionResult` |
| `db-diff.ts` | `DiffStatus`, `DBColumnDiff`, `DBIndexDiff`, `DBTableDiff`, `DBSchemaDiff`, `DBMigrationScript` |
| `db-export.ts` | `ExportFormat`, `ExportOptions`, `ExportBatchResult`, `ColumnMapping`, `ImportPreview`, `BackupConfig`, `BackupRun` |
| `db-health.ts` | `DBHealthConnections`, `DBHealthTPS`, `DBHealthMemory`, `DBHealthDisk`, `DBSlowQuery`, `DBHealthMetrics`, `HEALTH_THRESHOLDS` |
| `db-rbac.ts` | `DBConnectionRole`, `DBAction` (24 actions), `DBConnectionPermission`, `DBAuditLogEntry` |
| `db-visualization.ts` | `ChartType`, `ChartConfig`, `DashboardItem` |
| `erd.ts` | `ERDColumn`, `ERDTableMeta`, `ERDRelationship`, `ERDMetadata`, `ERDNode`, `ERDEdge` |
| `process-manager.ts` | `DBProcess`, `DBProcessList`, `KillMode`, `KillProcessResult` |
| `query-history.ts` | `QueryHistoryEntry` |
| `schema-versioning.ts` | `SchemaVersion`, `SchemaVersionSummary`, `ColumnVersionDiff`, `SchemaVersionDiff` |
| `sql-rest-api.ts` | `SqlApiParam`, `SqlApiEndpoint`, `SqlApiKey`, `SqlApiRequestLog`, `SqlApiResponse` |
| `sql-snippets.ts` | `SqlSnippet`, `SqlSnippetCreateInput`, `SqlSnippetUpdateInput` |
| `ssh-tunnel.ts` | `SSHAuthMethod`, `SSHTunnelConfig` |
| `alter-table.ts` | `DBColumnDef`, `ForeignKeyDef`, `AlterChange`, `AlterPreview`, `DB_TYPE_GROUPS`, `ALTER_SUPPORTED_TYPES` |
| `ai-sql-assistant.ts` | `AiSqlGenerateResult`, `AiQueryExplainResult` |
| `data-generator.ts` | `FakerStrategy` (31 strategies), `DataGenColumnConfig`, `DataGenColumnInfo`, `DataGenBatchResult` |

---

## Utilities & Tooling

### `frontend/utils/sql-completion.ts`
Monaco editor SQL IntelliSense provider.
- `registerSqlCompletion(schema)` — registers completions for the `sql` language
- Table-aware completions: after `FROM`/`JOIN` keywords shows table list
- Column-aware completions: after `tableName.` shows columns with type/constraint info
- Fallback: SQL keywords, all table names, all column names (deduplicated)
- Trigger characters: `.`, space, newline

---

## Modified Files

### `backend/database/migrations/index.ts`
Imports and registers migrations 027–033 in order.

### `backend/database/queries/index.ts`
Exports all new query modules: `queryHistoryQueries`, `dbRbacQueries`, `dbBackupQueries`, `sqlSnippetQueries`, `sqlRestApiQueries`, `schemaVersionQueries`.

### `backend/ws/index.ts`
Imports `databaseRouter` from `ws/database/index.ts` and merges it into the main `wsRouter`.

### `backend/index.ts`
- Added three `/sql-api` REST routes (spec, docs, execute)
- Added `startBackupScheduler()` call on server startup
- Added `stopBackupScheduler()` in graceful shutdown handler

### `frontend/components/workspace/DesktopNavigator.svelte`
Added "Database" button (with database icon) in both expanded and collapsed sidebar states. Opens `DatabaseModal` on click.

### `frontend/components/common/editor/MonacoEditor.svelte`
Updated to support `registerSqlCompletion()` when language is `sql`.

### `frontend/stores/ui/theme.svelte.ts`
Minor addition: database connection tab color palette integrated.

### `shared/utils/logger.ts`
Added `'backup'` to the list of valid log labels for backup scheduler logging.

### `vite.config.ts`
Added `/sql-api` proxy rule to forward requests to the Elysia backend during development.

### `bun.lock` / `package.json`
New runtime dependencies added (see section below).

---

## Dependencies Added

### Runtime (`dependencies`)

| Package | Version | Used For |
|---------|---------|---------|
| `@faker-js/faker` | ^10.3.0 | Fake data generation |
| `chart.js` | ^4.4.9 | Visualization charts |
| `ioredis` | ^5.10.0 | Redis adapter |
| `mongodb` | ^7.1.0 | MongoDB adapter |
| `mssql` | ^12.2.0 | SQL Server adapter |
| `mysql2` | ^3.19.1 | MySQL/MariaDB adapter |
| `ssh2` | ^1.16.0 | SSH tunneling |

### Dev (`devDependencies`)

| Package | Version | Used For |
|---------|---------|---------|
| `@types/mssql` | ^9.1.9 | MSSQL TypeScript types |
| `@types/ssh2` | ^1.15.1 | SSH2 TypeScript types |

---

## Git Hooks & Scripts

Four new shell scripts added in `scripts/` for development workflow enforcement:

### `scripts/setup-hooks.sh`
Installs git hooks: `commit-msg`, `pre-commit`, `pre-push`. Run once after cloning or to reinstall.

### `scripts/validate-commit-msg.sh`
`commit-msg` hook. Enforces conventional commit format: `<type>(<scope>): <subject>`.
Allowed types: `feat`, `fix`, `docs`, `chore`, `release`. Max 72-char subject.

### `scripts/validate-branch-name.sh`
`pre-push` hook. Enforces branch naming: `^(main|dev|feature|fix|docs|chore)/[a-z0-9-]+$`.
Lowercase, hyphenated. Protected branches (main, dev) pass without validation.

### `scripts/pre-publish-check.sh`
Pre-publish validation. Checks:
1. On `main` or `dev` branch
2. No uncommitted changes
3. `bun run check` passes
4. `bun run lint` passes
5. `bun run build` produces `dist/`

---

## Security Notes

- All database credentials stored in SQLite are encrypted with **AES-256-GCM** (master key per installation)
- SSH private keys, backup cloud credentials are also encrypted at rest
- SQL REST API endpoints enforce **SELECT-only** queries; parameterized inputs prevent SQL injection
- RBAC checks are enforced server-side before every DB operation; WebSocket identity resolution is non-bypassable from client
- API keys stored as **SHA-256 hashes** only; raw secret shown once on creation
- Audit logs capture before/after snapshots for all DML, enabling row-level rollback
