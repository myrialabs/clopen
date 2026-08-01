[← Engine adapter guide](../README.md)

## 7. Registering a tool in Stack (`install-recipes.ts`)

`install-recipes.ts` is a **declarative** registry of install commands.
`install-runner.ts` is what actually runs them. The Settings panel that
surfaces these is **Stack** — the name is consistent all the way down: the WS
namespace is `stack:*` (`backend/ws/stack/`), the settings section id is
`stack`, and the UI lives in `frontend/components/settings/stack/`.

Two kinds of `ToolId` live here:

- **Host tools** (`git`, `chrome`, `cloudflared`) — real binaries installed on
  the machine's PATH via the platform's package manager. Detected by resolving
  the binary + running `--version`.
- **Engine SDKs** (`claude`, `opencode`, `copilot`, `codex`, `qwen`, `pi`,
  `cline`, `cursor`) — npm packages clopen installs **on demand** into the
  managed stack dir `~/.clopen/stack/engines` (`getStackEnginesDir()`), NOT the
  user's global bun store and NOT a global CLI on PATH. Their exact versions are
  pinned in `package.json` (the single source of truth). `pi`, `cline`, and
  `cursor` are now installable here too (they were previously read-only
  InfoCards).

### 7.1 Anatomy of a `Recipe`

```ts
interface Recipe {
  tool: ToolId;
  autoInstallable: boolean;
  unavailableReason?: string;       // shown when not auto-installable
  command?: string[];               // argv for Bun.spawn
  shell?: { program; args };        // wrap argv (sh -c, pwsh -Command)
  requiresCurl?: boolean;           // staged static-curl if needed
  pendingCurlDownload?: { version, url, sha256, archKey };
  displayCommand?: string;          // string for the confirm dialog
  env?: Record<string, string>;     // extra env for the subprocess
  missingPrereqs: ToolId[];
  manualInstructions: ManualInstruction[]; // always present (copy-able fallback)
}
```

### 7.2 Per-platform pattern (host tools)

This applies to **host tools** only; engine SDKs use the single
`resolveEngineRecipe` path in §7.3. `resolveRecipe(tool)` switches to a per-tool
resolver. Each host-tool resolver:
1. Builds `base: Recipe` with full `manualInstructions` (always provide a
   fallback for users on unsupported OSes).
2. Checks platform (`process.platform`) and package manager:
   - macOS: `brew`
   - Linux: `apt | dnf | pacman | apk | zypper` (`detectLinuxPkgMgr`)
   - Windows: `winget | scoop | choco` (`detectWindowsPkgMgr`)
3. Checks privilege via `isElevated()` if the package manager needs
   root/admin.
4. If the installer uses `curl`, calls `attachCurlRequirement(base, label)`
   so the runner can stage SHA-pinned static-curl from
   `static-curl-assets.ts` when the system has no curl.
5. Sets `autoInstallable = true` + `command` + `shell` + `displayCommand`,
   or leaves it `false` with `unavailableReason` so the UI renders manual
   instructions only.

### 7.3 Engine-SDK recipes

`resolveEngineRecipe(tool)` handles every engine `ToolId`. It maps the engine to
its pinned SDK package(s) (`ENGINE_PACKAGES`, versions read from `package.json`
via `getRequiredSdkVersion`) and installs them with `bun add <pkg>@<version>`
run with `recipe.cwd = getStackEnginesDir()`, so they land in
`~/.clopen/stack/engines` instead of the global store. Installing the SDK also
pulls whatever CLI binary it bundles; the drifting Copilot CLI is pinned exact
(`@github/copilot`). Because everything is fully clopen-managed, engine recipes
carry **no** `manualInstructions` — there is no command for the user to run by
hand. `install-runner.ts` bootstraps the stack dir + a minimal `package.json`
before the first `bun add`.

### 7.4 Status detection

`getToolStatus(tool)` returns `{ tool, installed, version, source }` (engines
additionally carry `requiredVersion` + `needsUpdate`):
- `chrome` has a special path (puppeteer cache scan + system Chrome).
- `cloudflared` at `~/.clopen/bin/cloudflared` is marked `source: 'clopen'`.
- **Engine SDKs** are detected by `readEngineSdkVersion(pkg)` — the SDK's
  version inside the stack dir, NOT a CLI on PATH. `source` is the stack dir;
  `needsUpdate` is true when the installed version ≠ the pinned
  `requiredVersion`. The engine-picker `status.ts` handlers use the same
  `readEngineSdkVersion` seam.
- Otherwise `resolveBinaryWithRefresh(tool)` + `runVersion(resolved)`.

### 7.5 Runner

`install-runner.ts::startInstall(tool, userId)`:
1. Verifies no other session is active for this tool
   (`InstallAlreadyRunningError`).
2. Resolves the recipe, validates `autoInstallable && command`
   (`InstallNotAutoInstallableError`).
3. If `requiresCurl`, calls `ensureCurlAvailable(...)` (downloads
   pinned static-curl if needed, prepends its dir to PATH).
4. `Bun.spawn(spawnArgs, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env })`.
5. Streams stdout/stderr per-line into a ring buffer (10k lines) + emits
   `stack:install-stream` to the user room.
6. On exit: emits `stack:install-finished` + retains the session
   for 5 minutes for re-attach.

Exit-code hints (`explainFailure(137|143, cancelled)`) explain SIGKILL OOM
or SIGTERM with actual total/free memory readings.

### 7.6 Adding a new host tool

1. Add the literal to `ToolId` (`'goose'`).
2. Write `resolveGooseRecipe(): Promise<Recipe>` following the
   `resolveGitRecipe` pattern.
3. Add a case in `resolveRecipe(tool)`.
4. Add the literal to `TOOL_UNION` (`status.ts`, `install.ts`).
5. Add `<ToolInstallCard tool="goose" ... />` in
   `StackSettings.svelte`.
6. (Optional) detect in `engine:<engine>-status` so Settings → Engines
   knows the binary is installed.

### 7.7 Adding a new engine SDK

Engine SDKs don't need a hand-written resolver. When you add an engine
(see [adding-an-engine](./adding-an-engine.md) Stage 7):

1. Add the engine literal to `ToolId`.
2. Add its pinned SDK package(s) to `ENGINE_PACKAGES` (first entry = the SDK
   clopen imports and detects install-state from; extras pin a transitive CLI
   the SDK would otherwise float). Add the same packages to `package.json`
   `devDependencies` at an exact version — that is the single source of truth.
3. `resolveEngineRecipe(tool)` handles the rest automatically (installs into the
   stack dir at the pinned version).
4. Add the literal to `TOOL_UNION` (`status.ts`, `install.ts`).
5. Add `<ToolInstallCard tool="newengine" ... />` in `StackSettings.svelte`.

There is no "Check for Updates" for engines — their versions move in lockstep
with clopen releases, so `version-check.ts` has no update source for them. The
Stack card instead shows **Update required** whenever the installed version ≠
the pinned version, driven by `ToolStatus.needsUpdate`.

### 7.8 Default-engine bootstrap (fresh install)

Since no SDK ships in the package, a brand-new install has **zero** working
engines — a dead-end first run. `backend/engine/bootstrap-default-engine.ts`
closes that gap: `ensureDefaultEngineInstalled()` runs the `opencode` recipe in
the background (OpenCode is the one free, no-account engine) and no-ops the
moment **any** engine SDK is present, so it never fights a user who
deliberately removed it. Failures are non-fatal — everything stays installable
from Settings → Stack.

Two details that were bugs before they were rules:

- **Gate on the in-flight promise, not an "already started" latch.** A permanent
  boolean would correctly de-dupe concurrent callers but then wrongly skip a
  *legitimate* reinstall later in the same process. Holding the promise and
  clearing it in `.finally()` de-dupes while it runs and lets the next caller
  re-evaluate `isEngineSdkInstalled` once it settles.
- **It is not startup-only.** The call lives in
  `backend/bootstrap.ts::bootstrapAfterDbInit()`, shared by `startServer()` and
  the **Clear All Data** handler (`backend/ws/system/operations.ts`). Clear-data
  wipes `~/.clopen` — including the stack dir — and re-runs only migrations +
  seeders on the *same live process*, so anything established outside that
  pipeline silently vanishes until the next restart. `bootstrapAfterDbInit()` is
  where code-synced built-ins are re-established (today: internal MCP servers +
  the default engine). **Add any future startup-synced built-in there**, not in
  `startServer()` — but keep long-lived schedulers out of it, since they'd
  double-run when invoked on the live process.

---

