# Engine Artifact Framework — Prompt Berurutan

> Tiap blok di bawah (dipisah `-----`) adalah **satu prompt utuh** untuk **satu sesi
> chat baru**. Kerjakan **berurutan**: Prompt 1 dulu (di-merge), baru Prompt 2, dst.
> Copy satu blok saja per sesi. Tujuh fitur yang disepakati (Commands, Subagents,
> Instructions, MCP tool-control, MCP inspector, Permissions, Profiles) sengaja
> dikelompokkan jadi 4 prompt berdasarkan mekanik/abstraksi yang dibagikan.

-----

# Prompt 1 — Fondasi (artifact framework) + Commands, Subagents, Instructions

Baca `CLAUDE.md` dan `MAINTAINERS.md` dulu. **STOP untuk review di tiap akhir
tahap.** Jangan jalankan `bun run dev`/`build`. Jalankan `bun run check` &
`bun run lint` setelah ngoding. Pakai modul `debug` (bukan `console.*`), Svelte 5
runes, TypeScript, `const` default, Tailwind v4. Mutasi extension = `adminOnly`.
Usulkan nama branch/commit (Conventional Commits, English) — jangan buat otomatis.

## Tujuan

Clopen sudah punya manajer **MCP Servers** dan **Skills** di Settings → Tools &
Extensions. Bangun **fondasi bersama** untuk fitur extension sejenis, lalu pakai
fondasi itu untuk menambah tiga fitur baru sekaligus (karena berbagi mekanik):
Custom Commands, Subagents, Project Instructions.

## Konteks arsitektur yang sudah ada (jangan ubah polanya tanpa diskusi)

Skills & MCP bekerja **satu arah**: canonical store (DB+disk) → di-materialize ke
tiap engine saat stream start. **Belum ada deteksi** artefak yang sudah ada di
disk, dan **sync logic hardcoded per fitur**. Sudah ada pola **native vs synthetic**
yang akan berulang:
- **Native** (Claude, Qwen, Copilot): engine baca direktori artefak asli; Clopen
  mirror folder. Claude pakai dir terisolasi `CLAUDE_CONFIG_DIR`; Qwen/Copilot
  resolve dari `$HOME` (`~/.qwen/skills`, `~/.copilot/skills`) — Clopen mengelola
  dir global asli user, **hanya slug miliknya sendiri**.
- **Synthetic** (Codex, OpenCode): tak ada konsep native → Clopen suntik blok
  **marker-delimited** ke file instruksi global engine. Lihat marker existing di
  `backend/skills/sync.ts`: `<!-- CLOPEN:SKILLS:START — managed block, do not edit -->`.

Engine **terisolasi** per `{clopenDir}/engine/{engine}/user/` via
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/dst — jadi engine Clopen **tidak membaca
`~/.claude` asli** user (kecuali kasus Qwen/Copilot di atas).

### File map (sudah diverifikasi)

Backend Skills: `backend/skills/{store,spec,sync,service,marketplace}.ts`,
`backend/database/migrations/044_create_skills_table.ts`,
`backend/database/queries/skill-queries.ts`, `backend/ws/skills/` (`skills:*`).
Backend MCP: `backend/mcp/index.ts`, `backend/mcp/external/{config,proxy,oauth}.ts`,
`backend/database/migrations/040_create_mcp_servers_table.ts`,
`backend/database/queries/mcp-server-queries.ts`, `backend/ws/mcp/crud.ts` (`mcp:*`).
Engine/paths: `backend/engine/index.ts`, `backend/engine/adapters/{engine}/stream.ts`
(tempat skills/MCP dikonsumsi), `backend/utils/paths.ts`
(`getClopenDir()`, `getEngineUserConfigDir(engine)`), `shared/constants/engines.ts`,
`shared/types/unified/engine.ts` (`EngineType`).
Frontend: `frontend/stores/features/{skills,mcp-servers}.svelte.ts` (pola store:
`installed` + `catalog` + pagination), `frontend/components/settings/{skills,mcp}/*`,
`frontend/components/settings/SettingsModal.svelte`,
`frontend/stores/ui/settings-modal.svelte.ts` (registrasi section: union
`SettingsSection`, `settingsGroups`, `settingsSections[]`; grup `'extensions'` =
"Tools & Extensions").

**Nambah section:** tambah id ke union `SettingsSection` → entri di
`settingsSections[]` (group `'extensions'`, `adminOnly: true`) → import komponen di
`SettingsModal.svelte` → render conditional `activeSection === ...`.

## Keputusan terkunci

1. **Manage-in-place.**
   - **Scope proyek** → in-place murni di file repo. File bersama
     (`CLAUDE.md`/`AGENTS.md`) **wajib marker-region**, jangan timpa tulisan tangan.
   - **Scope global** → tulis di **dir efektif engine (terisolasi)**, PLUS
     **"detect & link"**: scan lokasi standar asli (`~/.agents/skills`,
     `~/.claude/skills`, `~/.codex/AGENTS.md`, dll.), tampilkan yang ada, tawarkan
     **adopt via symlink/mirror** ke dir efektif engine. Jujur ke on-disk **dan**
     berefek untuk engine Clopen.
2. **Shared abstraction lebih dulu** — fitur baru jadi konfigurasi, bukan copy-paste.
3. **Scope global + project** — schema & deteksi tangani keduanya (butuh asosiasi
   project + scan dir proyek).
4. **Auto-detect** = turunan adapter (yang bisa menulis, bisa mendeteksi).

### Rambu
- Jangan timpa konten user (marker-region untuk file bersama; folder utuh hanya
  yang Clopen buat). **Git noise**: menulis ke `.claude/...` atau `CLAUDE.md` di
  repo = menyentuh working tree — harus eksplisit/visible di UI, jangan diam-diam.
- **State per-project jangan bocor** antar proyek (pola viewed-session mirror:
  state proyek aktif saja, sinkron ulang saat switch).
- Path engine non-Claude (Codex/OpenCode synthetic) **best-effort/unverified** —
  beri penanda, jangan klaim pasti berefek sebelum diverifikasi.

## Fase 0 — Artifact framework (capability matrix)

Abstraksi yang mendeskripsikan, untuk tiap `artifactType × engine × scope`, cara
deteksi & tulis artefak. Bentuk konseptual (nama final menyesuaikan codebase):

```
artifactType: 'skill' | 'command' | 'subagent' | 'instruction'   // extensible: nanti 'mcp' | 'permission'
engine:       'claude' | 'codex' | 'copilot' | 'qwen' | 'opencode'
scope:        'global' | 'project'

resolve(artifactType, engine, scope) -> {
  supported: boolean
  format: 'folder-md' | 'single-md' | 'preamble-region' | 'json' | 'toml'
  ownership: 'whole-file' | 'marker-region'
  locateEffective(ctx): string
  locateReal?(ctx): string[]          // lokasi standar asli untuk detect & link (global)
  detect(ctx): DetectedArtifact[]
  write(artifact, ctx): void
  remove(artifact, ctx): void
}
```

`ctx` minimal = `{ engine, scope, projectId? }`. Rancang agar nanti bisa di-scope
oleh **profile aktif** (Prompt 4) tanpa membongkar resolusi — mis. cukup tambah
`profileId?` belakangan, bukan mengubah signature.

Tugas:
1. Tipe & registry adapter di backend (disarankan `backend/artifacts/`; refaktor
   bertahap, rombak besar sekaligus).
2. Scanner/detect generik + writer generik (native mirror, synthetic
   marker-region, detect & link untuk global; idempotent & aman — hanya slug Clopen).
3. **Retrofit Skills & MCP** ke adapter ini **tanpa regresi perilaku** (verifikasi
   `check`/`lint` + bandingkan output sync). Jika retrofit MCP terlalu berisiko di
   sesi ini, batasi ke **Skills** saja + sediakan slot adapter MCP; **laporkan**
   keputusan ini saat stop-for-review.

**STOP untuk review setelah Fase 0** sebelum lanjut.

## Fase A — tiga fitur di atas framework

Reuse pola UI Skills (tab installed/browse + editor) & store pattern. Tiap fitur:
registrasi section di `settings-modal.svelte.ts` (grup `'extensions'`,
`adminOnly: true`), import & render di `SettingsModal.svelte`. semua akan digabungkan dalam satu commit (sarankan juga commit body).

- **A1. Custom Commands** — `.claude/commands/*.md` (project) & `~/.claude/commands/`
  (global); synthetic via preamble bila perlu. DB + queries + WS `commands:*` +
  store + `CommandsSettings.svelte` (reuse editor Skills).
- **A2. Subagents** — seperti Skills + field tambahan: **tool allowlist**, **model
  override**, **agent type**. `.claude/agents/` & `~/.claude/agents/`. DB + queries
  + WS `subagents:*` + store + `SubagentsSettings.svelte`.
- **A3. Project Instructions** — editor file instruksi proyek & global, mapping
  per-engine (`CLAUDE.md`→Claude, `AGENTS.md`→Codex/OpenCode, dst). **Ownership =
  marker-region**; tampilkan jelas bagian managed. Cek fitur memory yang sudah ada
  agar tidak duplikat.

## Acceptance
- `bun run check` & `bun run lint` lulus.
- Skills & MCP tetap identik setelah retrofit (no regression).
- Tiga fitur baru muncul di Settings → Tools & Extensions dengan tab
  installed/browse + editor, dan auto-detect on-disk (project + global detect & link).
- Tidak menimpa konten user; perubahan working tree repo eksplisit.

## ✅ Checkpoint — Prompt 1 SELESAI (untuk Prompt 2/3/4)

Implemented in one pass; `bun run check` + `bun run lint` hijau. Ringkasan agar prompt
berikutnya tahu apa yang sudah ada:

**Framework (`backend/artifacts/`)** — pondasi capability-matrix:
- `types.ts` — `ArtifactType` (`skill|command|subagent|instruction|mcp`; **`'mcp'` = slot
  RESERVED, belum ada adapter**), `ArtifactContext` (sudah punya `profileId?` untuk Prompt 4
  tanpa ubah signature), `ArtifactResolution` (+ `exclusive`: dir isolated milik Clopen boleh
  di-prune total).
- `matrix.ts` `resolveArtifact(type, ctx)` — sumber tunggal lokasi/format/ownership per
  `type×engine×scope`. `sync.ts` `materializeArtifacts()` — writer generik (native mirror +
  synthetic marker-region). `detect.ts` `detectArtifacts()` + `adoptArtifact()` (symlink real→effective).
  `markers.ts` (marker-region idempotent), `frontmatter.ts` (parseDoc/serializeDoc), `slug.ts`.
- **Skills di-retrofit** lewat framework, output byte-identical (marker `CLOPEN:SKILLS` + teks preamble
  dipertahankan). Lihat `backend/skills/sync.ts`.

**Tiga fitur baru** (pola: DB table + queries + service + `backend/ws/<fitur>/` + store + `*Settings.svelte`,
section di `settings-modal.svelte.ts` grup `extensions` `adminOnly`):
- **Commands** (`backend/commands/`, migration 045, `commands:*`) — single-md, native Claude `.claude/commands`,
  synthetic lainnya. Terintegrasi ke **ChatInput**: ketik `/` → `SlashCommandMenu.svelte`, endpoint
  **non-admin** `commands:available`.
- **Subagents** (`backend/subagents/`, migration 046, `subagents:*`) — single-md + `tools`/`model`/`agent-type`,
  native Claude `.claude/agents`.
- **Instructions** (`backend/instructions/`, migration 047, `instructions:*`) — marker-region ke memory file
  tiap engine (global). Tidak ada fitur memory lama (sudah dicek, greenfield).

**Materialisasi per-stream**: `backend/engine/artifact-sync.ts` `syncEngineArtifacts(engine)` dipanggil setelah
`syncSkills` di 5 adapter, **GLOBAL scope saja** (SEQUENTIAL, bukan Promise.all — hindari race blok di AGENTS.md).
Mutasi Commands/Subagents **eager sync-all-engines** (WS layer) supaya disk langsung reflect + fix orphan-leak.

**Keputusan/batasan yang sengaja ditunda (kerjaan lanjutan, BUKAN bug):**
1. **MCP tidak di-retrofit** — tetap jalur config-object/bridge; `'mcp'` cuma slot type.
2. **detect & link**: backend lengkap (`adoptArtifact` symlink) tapi UI baru **menampilkan** item on-disk;
   tombol "adopt" belum di-surface.
3. **Project-scope Instructions**: backend + `instructions:save-project` ada, TAPI penulisan ke `CLAUDE.md`
   repo TIDAK dilakukan otomatis saat stream (hindari git noise diam-diam) — perlu aksi eksplisit/UI.
4. **Non-Claude subagent invocation** = best-effort (synthetic preamble; model "lihat" tapi belum tentu
   men-spawn). Sudah diberi catatan jujur di UI. Bikin native per-engine butuh verifikasi tiap engine.
5. **Skills tetap lazy** (stream-start + restart banner), tidak diubah ke eager (jaga no-regression).

**Logger**: `LogLabel` baru `artifacts|commands|subagents|instructions` di `shared/utils/logger.ts`.

### Round 2 (setelah user testing lanjutan)
- **Commands/Subagents kini NATIVE per-engine** (bukan cuma Claude). Matrix `nativeDir(type, ctx)`
  eksplisit: Commands native di **Claude** (`.../commands`), **OpenCode** (`<config>/opencode/command`),
  **Codex** (`$CODEX_HOME/prompts`); Subagents native di **Claude** (`.../agents`) + **OpenCode**
  (`<config>/opencode/agent`). Sisanya (qwen/copilot commands, codex/qwen/copilot subagents) tetap synthetic
  preamble. **Transform per-engine** di feature sync: Codex command = body-only (prompt polos, tanpa
  frontmatter); OpenCode subagent = `mode: subagent` + drop `tools` comma-list (format opencode beda).
  Catatan: temuan Claude "`/loremm` → tool `Skill` + body jadi user turn" itu **konvensi Claude Agent SDK**
  (slash-command = skill-launch + expand prompt), bukan bug.
- **AI-generate** untuk Skills/Commands/Subagents/Instructions: `backend/artifacts/generate.ts`
  (`generateArtifact` via `engine.generateStructured`, schema+prompt per type) + WS `artifacts:generate`
  (admin). Model diatur di **Settings → Models → tab "Authoring"** (`settings.artifactGenerator` OPTIONAL,
  fallback ke assistant model). UI: `ArtifactGenerateBar.svelte` (1 input purpose) di tiap editor;
  helper `frontend/utils/artifact-generate.ts`.
- **Notes best-effort dihapus** dari Commands/Subagents/Instructions (permintaan user).

-----

# Prompt 2 — MCP deepening: tool-level control + inspector/playground

Prasyarat: Prompt 1 sudah selesai & di-merge (artifact framework ada). Baca
`CLAUDE.md` & `MAINTAINERS.md`. **STOP untuk review di tiap akhir tahap.** Jangan
`bun run dev`/`build`. Jalankan `check` & `lint`. Modul `debug`, Svelte 5 runes,
TypeScript, Tailwind v4, mutasi = `adminOnly`. Usulkan branch/commit (English),
jangan buat otomatis.

## Tujuan
Memperdalam fitur MCP yang sudah ada (bukan fitur baru). Dua hal yang berbagi
backend introspeksi tool yang sama, jadi dikerjakan dalam satu paket:

1. **Tool-level control** — di dalam server MCP yang ter-install: list tool-nya,
   enable/disable **per tool**, dan pilih tool mana yang diexpose ke engine mana.
   Untuk membatasi surface area & mengurangi noise prompt.
2. **Inspector / playground** — test-call satu tool MCP dari Settings (isi argumen
   → lihat hasil) + lihat JSON schema-nya. Untuk debug server baru sebelum dipakai.

## Konteks teknis
- Introspeksi berasal dari `backend/mcp/external/proxy.ts` — in-process MCP client
  yang sudah connect upstream & sanitasi schema (strip `outputSchema`, repair
  `$ref`). Tambahkan kemampuan **list tools** + **call tool** lewat proxy ini.
- Bridge mengekspos server via `/mcp/ext/<slug>` (loopback + service-token). Engine
  bicara ke bridge, bukan upstream. Filter tool harus diterapkan **di layer bridge/
  config** (`backend/mcp/external/config.ts`, `backend/mcp/index.ts`) agar konsisten
  ke semua engine.
- Per-tool enable state perlu disimpan (kolom baru di `mcp_servers` atau tabel
  relasi `mcp_server_tools`). Default: semua tool enabled.
- Store: `frontend/stores/features/mcp-servers.svelte.ts`. UI:
  `frontend/components/settings/mcp/McpSettings.svelte` (tambah panel tool di
  configure modal + tab/section inspector). WS: `backend/ws/mcp/`.

## Acceptance
- Bisa lihat daftar tool + schema per server; toggle per tool; pilih expose per
  engine — dan filter benar-benar diterapkan ke config tiap engine.
- Inspector bisa memanggil tool dengan argumen dan menampilkan hasil/erornya.
- `check` & `lint` lulus; MCP existing tidak regresi.

## ✅ Checkpoint — Prompt 2 SELESAI (untuk Prompt 3/4)

Implemented in one pass; `bun run check` + `bun run lint` hijau. Ringkasan agar prompt
berikutnya tahu apa yang sudah ada:

**Storage (migration 048)** — kolom JSON `mcp_servers.tool_overrides`, key = **bare tool
name**: `{ "<tool>": { enabled?, engines?: { "<EngineType>": false } } }`. Absent = exposed
everywhere, jadi `{}` kosong = default all-on (no regresi untuk server lama). Queries:
tipe `McpToolOverride`/`McpToolOverrides` + `updateToolOverrides`.

**Override logic (`backend/mcp/external/tools.ts`, murni)** — `parseToolOverrides`,
`isToolExposed(overrides, tool, engine?)` (dipakai bridge untuk filter/guard),
`resolveToolExposure` (expand ke 2 kontrol **independen**: `enabled` global + per-engine
map, supaya pilihan per-engine tak hilang saat master di-off→on), `pruneToolOverrides`
(hanya simpan restriksi nyata), `MCP_ENGINES`.

**Enforcement = BRIDGE, satu titik untuk SEMUA engine.** Tiap config builder emit
`/mcp/ext/<slug>?engine=<engine>` (`external/config.ts` `bridgeUrl`). `remote-server.ts` baca
query `engine` → `createExternalProxyServer(slug, engine)` yang **filter `tools/list` +
guard `tools/call`** via `isToolExposed`. Karena enforcement di proxy Clopen (bukan config
SDK tiap engine), berlaku identik walau engine tak punya tool-allowlist di config. Filter
mengikat saat initialize → berlaku sepanjang session.

**Introspeksi (`external/proxy.ts`)** — `listExternalServerTools(slug)` /
`callExternalServerTool(slug, tool, args)` reuse jalur connect+kredensial upstream (client
short-lived, **tanpa syarat `is_enabled`** jadi bisa dikonfigurasi sebelum server di-on-kan).

**WS (admin-only, `backend/ws/mcp/tools.ts`)** — `mcp:tools` (list live + exposure, refresh
OAuth dulu spt `mcp:status`), `mcp:set-tool-overrides` (persist ter-prune), `mcp:call-tool`
(inspector; return raw termasuk `isError` supaya error tool ke-render). `mcp:list` DTO nambah
`restrictedToolCount` untuk badge.

**Frontend** — store: `fetchTools`/`setToolOverrides`/`callTool` + tipe `McpToolInfo`.
`McpSettings.svelte`: tombol **Tools** (sliders) per server → modal (master switch = kill
switch; chip per-engine hanya saat enabled = kontrol terpisah) + **Inspector** (schema view +
JSON args + result). Deskripsi tool (satu blob tanpa newline) di-render via `Markdown.svelte`
lewat `formatToolDescription` (re-add header + fence `<example>`). Badge "N restricted".

**Rename UI:** section `'mcp'` **"MCP Servers" → "Connectors"** (icon `lucide:blocks` →
`lucide:plug`), ikut istilah Claude/ChatGPT/Cursor. Section id + route `mcp:*` + kode
TETAP `mcp`, hanya label user-facing berubah.

**Keputusan/batasan yang sengaja ditunda (BUKAN bug):**
1. **Codex `?engine=` UNVERIFIED** — Codex terima bridge URL sbg flag `--config
   mcp_servers.<n>.url=...`; query `?engine=codex` belum diverifikasi end-to-end di stream
   Codex live (best-effort, sesuai rambu non-Claude). Claude/OpenCode/Qwen/Copilot fetch URL
   langsung → filter solid.
2. **JSON column** dipilih (konsisten dgn args/env/headers/oauth) alih-alih tabel relasi
   `mcp_server_tools`; **filter di bridge via query-param** alih-alih allowlist config
   per-engine (SDK tak seragam: Copilot/Qwen include-list, Claude tak ada).
3. Introspeksi connect upstream tiap panggilan (stdio = spawn subprocess tiap kali),
   konsisten dgn `probe.ts`.
4. Prompt 3 (Permissions, artifactType `'permission'`) akan mengambil inventaris tool
   sebagian dari daftar tool MCP ini.

-----

# Prompt 3 — Permissions / allowlist per engine

Prasyarat: Prompt 1 & 2 selesai (framework + inventaris tool MCP ada). Baca
`CLAUDE.md` & `MAINTAINERS.md`. **STOP untuk review di tiap akhir tahap.** Jangan
`bun run dev`/`build`. Jalankan `check` & `lint`. Modul `debug`, Svelte 5 runes,
TypeScript, Tailwind v4, mutasi = `adminOnly`. Usulkan branch/commit (English),
jangan buat otomatis.

## Tujuan
Kelola aturan **allow/deny tool** per engine (dan/atau per proyek) — titik temu
MCP + Skills + Subagents yang semuanya menghasilkan tool yang butuh izin.

## Konteks teknis
- Format izin **beda tiap engine** (Claude `settings.json` allow/deny, Codex
  `config.toml`, dst) → ini **artifactType baru `'permission'`** di capability
  matrix dari Prompt 1. Manfaatkan adapter: tiap engine punya
  format/lokasi/ownership sendiri.
- Inventaris tool diambil dari tool MCP (Prompt 2) + tool allowlist subagent
  (Prompt 1 / A2) + tool bawaan engine.
- **Ownership = marker-region** bila menulis ke file config bersama user.
- Scope: global + project (ikuti keputusan Prompt 1). Jangan bocor antar proyek.

## Acceptance
- UI untuk allow/deny tool per engine (dan project bila relevan), tersimpan & benar
  diterapkan ke config tiap engine via adapter.
- Tidak menimpa konten user; `check` & `lint` lulus.

-----

# Prompt 4 — Profiles (bundle reusable + aktivasi per-session)

Prasyarat: Prompt 1–3 selesai. Baca `CLAUDE.md` & `MAINTAINERS.md`. **STOP untuk
review di tiap akhir tahap.** Jangan `bun run dev`/`build`. Jalankan `check` &
`lint`. Modul `debug`, Svelte 5 runes, TypeScript, Tailwind v4, mutasi =
`adminOnly`. Usulkan branch/commit (English), jangan buat otomatis.

## Tujuan
**Profile** = bundle bernama & reusable berisi referensi ke MCP servers + Skills +
Commands + Subagents + Permissions. Satu profile bisa dipakai banyak proyek, dan
profile yang **aktif dipilih per-session** (seperti memilih engine/model). Ini
menjawab tiga kebutuhan sekaligus: library reusable, config per-proyek, dan mode
switcher saat runtime. Dikerjakan terakhir karena mengkomposisi semua fitur
sebelumnya.

## Model data terkunci (penting — ikuti persis)

Clopen punya **With Login (cross-device)** dan **collaboration (multi-user/proyek)**,
jadi semua state **server-side**. Tiga lapis:

1. **Artifact stores (Lapis 1)** — sudah ada dari Prompt 1–3: global artifacts
   instance-global admin-managed; project artifacts = file repo di FS server.
   Keduanya **inheren shared** antar kolaborator & konsisten cross-device. Jangan
   diduplikasi per-user.
2. **Profiles (Lapis 2)** — **instance-global, admin-managed**, persis pola
   `skills`/`mcp_servers` (tabel TANPA `user_id`). Tabel `profiles` + relasi
   `profile_items` (referensi artefak by type+id/slug, **jangan duplikasi datanya**).
3. **Aktivasi (Lapis 3):**
   - **Profile aktif = per-session.** Tambah kolom `profile_id` ke `chat_sessions`
     **di sebelah `engine`/`account_id`/`model_id`** (lihat migrations 014/019).
     Ikuti jalur yang sama: persist saat stream, restore saat lanjut session
     (`restoreChatModelFromSession` di `frontend/stores/ui/chat-model.svelte.ts`).
     Konsekuensi: cross-device otomatis ✓, tiap kolaborator bisa mode beda tanpa
     tabrakan ✓ (mode switcher).
   - **Default per-proyek = shared.** Tambah kolom `default_profile_id` ke tabel
     `projects` (BUKAN `user_projects`) — semua kolaborator dapat default yang sama.
     Ini **setting project-scoped-shared pertama** di codebase; lakukan sengaja &
     beri komentar migration yang jelas. Session baru memakai default ini bila user
     belum memilih.

## Resolusi saat stream
Di `backend/chat/stream-manager.ts` (tempat `engine`/`model`/`account` di-resolve,
~baris 427–630): resolusikan **profile aktif** = `chat_sessions.profile_id` →
fallback `projects.default_profile_id`. Terapkan set artefaknya lewat
adapter/jalur sync yang **sudah ada** — **jangan bikin jalur sync baru**.

## UI
- **Kelola profiles**: section `'profiles'` di Settings (grup `'extensions'`,
  `adminOnly: true`); pola store + editor mengikuti Skills.
- **Pilih profile aktif**: picker per-session dekat pemilih model (lihat
  `EngineModelPicker`) — bukan adminOnly, ini pilihan run biasa.
- **Default per-proyek**: kontrol kecil di pengaturan proyek untuk set
  `default_profile_id`.

## Collaboration — yang harus diperhatikan
- Profiles & artefak global shared → satu sumber, konsisten otomatis.
- File repo (`CLAUDE.md`, `.claude/*`) tunggal di server → dua kolaborator edit
  bareng = konflik tulis satu file. Pakai **marker-region** + last-write-wins;
  sadari kemungkinan lock ringan bila perlu.

## Acceptance
- Bisa buat/edit profile (kombinasi artefak) di Settings; profile reusable lintas
  proyek.
- Profile aktif terpilih per-session, tersimpan & dipulihkan cross-device; default
  per-proyek (shared) dipakai untuk session baru.
- Set artefak benar-benar aktif/nonaktif sesuai profile, lewat jalur sync existing.
- `check` & `lint` lulus; fitur existing tidak regresi.
