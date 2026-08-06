[← Engine adapter guide](../README.md)

## 3. Database — `engine_providers` & `engine_accounts`

Migration: `backend/database/migrations/029_migrate_messages_to_unified.ts`
(Phases 6–7). Previously split into `claude_accounts`, `opencode_providers`,
`opencode_accounts` — now **consolidated**.

### 3.1 Schema

```sql
CREATE TABLE engine_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_type TEXT NOT NULL,            -- 'claude-code' | 'opencode' | 'copilot' | <new>
  slug        TEXT NOT NULL,            -- 'anthropic', 'openai', etc (lowercase)
  name        TEXT NOT NULL,            -- display name
  npm         TEXT,                     -- npm package (opencode), NULL for claude/copilot
  api_url     TEXT,                     -- custom endpoint
  options     TEXT NOT NULL DEFAULT '{}', -- JSON: env var values, flags
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (engine_type, slug)
);

CREATE TABLE engine_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES engine_providers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  credential  TEXT NOT NULL,            -- OAuth token / API key / PAT
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Concepts:
- **Provider** = "who owns the model". For `claude-code` there is exactly
  one provider (`anthropic`, seeded in the migration). For `copilot` there
  is exactly one provider (`github`, seeded in `032_seed_copilot_provider.ts`).
  For `opencode`, the user adds many providers (Anthropic, OpenAI, Google,
  OpenRouter, …).
- **Account** = the concrete credential under a provider. Multiple are
  allowed; exactly one row per provider has `is_active = 1`.
- **Switching account** flip-flags automatically:
  `engineQueries.switchAccount(id)` sets all accounts under that provider
  to `is_active = 0`, then sets the chosen one to `1`.
- **Deleting the active account** automatically promotes another account in
  the same provider to active (logic in `engineQueries.deleteAccount`).

### 3.2 Main helpers (`engineQueries`)

```ts
// Provider
getProviders(engineType?)            getEnabledProviders(engineType?)
getProvider(id)                      getProviderBySlug(engineType, slug)
createProvider({...})                updateProviderOptions(id, jsonStr)
toggleProvider(id, enabled)          deleteProvider(id)   // cascades to accounts

// Account
getAccount(id)                       getAccountsByProvider(providerId)
getActiveAccount(providerId)         getActiveAccountForEngine(engineType)
createAccount(providerId, name, credential)              // auto-active if first
switchAccount(accountId)             deleteAccount(accountId)
renameAccount(accountId, name)

// Composite
getProvidersWithAccounts(engineType?) // join used by endpoint listing
```

### 3.3 How an adapter reads them

- **Claude** — `environment.ts` calls
  `engineQueries.getActiveAccountForEngine('claude-code')` inside
  `setupEnvironmentOnce()` to inject `CLAUDE_CODE_OAUTH_TOKEN`. When
  `streamQuery` is called with an explicit `accountId`,
  `getEngineEnv(accountId)` overrides the token without mutating singleton
  state — ideal for per-stream account override.

- **OpenCode** — `config.ts::generateOpenCodeProviderConfig()`:
  1. `engineQueries.getEnabledProviders('opencode')`
  2. For each provider, `getActiveAccount(provider.id)`
  3. Look up the env-var name(s) from the `models.dev` catalog cached in
     `presets.ts::getCachedModelsDevCatalog()` (see §3.4)
  4. Inject the first env var with `account.credential`, remaining env vars
     from `provider.options` JSON
  5. Result: `enabledProviders[]` (for `OPENCODE_CONFIG_CONTENT`) +
     `envVars{}` (merged into the `opencode serve` process)

- **Copilot** — `stream.ts::initialize(accountId?)` calls
  `engineQueries.getAccount(accountId)` (or
  `getActiveAccountForEngine('copilot')` when no override is supplied)
  and constructs a fresh `CopilotClient({ gitHubToken: account.credential })`.
  The Copilot SDK takes the token at **client construction time**, so a
  per-stream account switch requires `dispose()` + `initialize(newId)` —
  see `streamQuery` in `copilot/stream.ts` and §10.9 below.

> **Pattern: auth-blob materialization for shared CLI dotfiles.**
> Some CLIs (e.g. Codex's `auth.json`) read credentials from a fixed
> filename inside their home dir. That home dir is isolated to
> `{clopenDir}/engine/codex/user/` (via `CODEX_HOME` — see §10.19), but it is a
> **single** dir shared by all of the engine's Clopen accounts, so the
> dotfile inside it still has to be swapped per account. For those engines,
> `credential` stores the **whole file content** as a JSON wrapper
> (`{ kind: 'chatgpt', authJson: '...' }`), and the adapter / WS handler
> writes that blob back to the shared dotfile on `accounts-switch`. After
> each stream, snapshot the (possibly-refreshed-by-the-CLI) dotfile back
> into `engine_accounts.credential` so token refreshes survive across
> account switches. This keeps multi-account support working **without**
> per-account `XYZ_HOME` directories — see §10.13 for the rationale, and
> §10.19 for the Clopen-vs-global home-dir isolation.

### 3.4 The models.dev catalog (OpenCode-specific)

`presets.ts::fetchAndCacheModelsDevCatalog()` caches the catalog in the
`settings` table under `opencode.models_dev_cache`
(+ `opencode.models_dev_cached_at`). `getCachedModelsDevCatalog()` reads it
back. The catalog lists the providers OpenCode supports along with the
env-var names they expect. The frontend uses the catalog in the "Add
Provider" picker — the user just selects a provider, enters the API key,
and the env-var mapping is automatically correct.

The split between `presets.ts` (catalog data + cache) and `config.ts`
(runtime env-var builder) mirrors `qwen/`, the canonical multi-provider
adapter — see §2.6 and §4.6.

---

