[← Engine adapter guide](../README.md)

## 7. Registering a binary in System Tools (`install-recipes.ts`)

`install-recipes.ts` is a **declarative** registry of install commands.
`install-runner.ts` is what actually runs them.

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

### 7.2 Per-platform pattern

`resolveRecipe(tool)` switches to a per-tool resolver. Each resolver:
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

### 7.3 Status detection

`getToolStatus(tool)` returns `{ tool, installed, version, source }`:
- `chrome` has a special path (puppeteer cache scan + system Chrome).
- `cloudflared` at `~/.clopen/bin/cloudflared` is marked `source: 'clopen'`.
- Otherwise `resolveBinaryWithRefresh(tool)` + `runVersion(resolved)`.

### 7.4 Runner

`install-runner.ts::startInstall(tool, userId)`:
1. Verifies no other session is active for this tool
   (`InstallAlreadyRunningError`).
2. Resolves the recipe, validates `autoInstallable && command`
   (`InstallNotAutoInstallableError`).
3. If `requiresCurl`, calls `ensureCurlAvailable(...)` (downloads
   pinned static-curl if needed, prepends its dir to PATH).
4. `Bun.spawn(spawnArgs, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env })`.
5. Streams stdout/stderr per-line into a ring buffer (10k lines) + emits
   `system-tools:install-stream` to the user room.
6. On exit: emits `system-tools:install-finished` + retains the session
   for 5 minutes for re-attach.

Exit-code hints (`explainFailure(137|143, cancelled)`) explain SIGKILL OOM
or SIGTERM with actual total/free memory readings.

### 7.5 Adding a new tool

1. Add the literal to `ToolId` (`'goose'`).
2. Write `resolveGooseRecipe(): Promise<Recipe>` following the
   `resolveOpenCodeRecipe` pattern.
3. Add a case in `resolveRecipe(tool)`.
4. Add the literal to `TOOL_UNION` (`status.ts`, `install.ts`).
5. Add `<ToolInstallCard tool="goose" ... />` in
   `SystemToolsSettings.svelte`.
6. (Optional) detect in `engine:<engine>-status` so Settings → Engines
   knows the binary is installed.

---

