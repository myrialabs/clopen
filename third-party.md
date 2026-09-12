# Third-Party Integrations — Implementation Specs

Every entry below is numbered, and one task is one implementation session. Each
task carries its own checklist and notes line: on finishing one, tick the box and
replace the `—` with one to three lines recording what was actually built, which
decisions were taken, and where the implementation deviated from this spec — the
next session reads those notes, not the diff.

**Goal.** Two outcomes at once: a *product story* (a visible catalogue of
integrations that attracts new users) and *workflow depth* (a handful of
integrations that genuinely change how a session is worked).

**Order.** Strictly ascending, and the grouping is the reason why. `Foundation`
holds the credential layer everything else registers with. `Surfaces` each build
one provider-agnostic capability plus the first provider that proves its shape.
`Providers` and `Catalogue` only plug into what already exists — an entry in
those sections that finds itself building a new panel has hit a gap in the
surface it targets, and the fix belongs in that surface, not in a second panel.

---

## Architecture

Read this before any entry. It is the part that is easy to get subtly wrong, and
getting it wrong produces two places to connect the same service.

**A connected account is not a feature. It is a credential with capabilities.**
`Task 1` stores one row per connected third-party account, and that row is the
only place its credential lives. Everything that talks to that service reads
through the account instead of keeping its own copy.

**Settings → Integrations is where you connect. It is not where you work.** The
hub owns connect, disconnect, credentials, capability toggles and health. What an
integration actually *does* lives in the surface that owns that kind of work:

| Capability | Surface that owns it | Registered by |
|---|---|---|
| Agent tools | the engines, via an `mcp_servers` row | Task 1 |
| Issues, PRs, CI | Issues panel | Task 2 |
| Deployments, build logs | Deployments panel | Task 3 |
| Database connection | DB Client | Task 4 |
| Worktree lifecycle | worktree manager | Task 5 |
| Notifications and approvals | notification channels | Task 6 |
| Inbound events | webhook gateway | Task 1 |

**Surface rows are projections.** An account with the agent-tools capability
writes an `mcp_servers` row; one with a database capability writes a
`db_client_connections` row. Those rows are *derived* — regenerated from the
account whenever its credential or capabilities change, marked as
integration-managed, and read-only wherever they surface. Nothing reads a token
out of a projection to decide anything, and no subsystem downstream of a
projection needs to know accounts exist. That constraint is what keeps this layer
off the path every engine's MCP config already flows through.

**Connecting can start anywhere; the account still lives in one place.** DB
Client's "add connection" offers the database providers, the worktree manager
offers the branching ones, and both open the same connect dialog the hub does. A
user already in DB Client must never be told to go to Settings first.

**An integration is not automatically an MCP server.** Roughly half the entries
below expose no tools at all — Neon is a worktree hook, Turso is a driver, the
chat channels are adapters. Agent tools is one capability among several, and the
catalogue is the only section where it is the *only* one.

---

## Existing rails — reuse, do not reinvent

- `backend/mcp/external/` already installs any server from the official MCP
  registry, proxies it at `/mcp/ext/<slug>`, and centralises OAuth (RFC 8414
  discovery, RFC 7591 dynamic registration, PKCE). Note the audience: that token
  authorises the *MCP server*, not the vendor's REST API, so a provider needing
  both declares two credentials rather than reusing one.
- `backend/db-client/drivers/` already speaks postgres, mysql, mssql, mongodb,
  redis and sqlite with `sslMode`, and the DB Client panel already has a schema
  tree, structure manager, ER diagram and query console.
- `backend/mcp/internal/servers/` (`defineServer()`) is how a first-class
  capability is exposed to every engine at once, and is the pattern the provider
  registry mirrors.
- Existing primitives worth composing with: worktrees, preview + browser
  automation, ports, tunnel, terminal, git, memory graph, remote access,
  notifications.
- `@myrialabs/chatkit` is the single path for every chat platform (Telegram,
  WhatsApp, Discord, Slack). Never write a per-platform bot client by hand. It
  is a co-developed sibling repo consumed locally, so a gap in ChatKit is fixed
  in ChatKit — generically, never with a Clopen-shaped patch.
- Brand marks follow `shared/constants/tool-icons.ts`: inline SVG with a light
  and a dark variant, keyed by id, rendered with `{@html}`. Not an icon font —
  a monochrome glyph tinted with the theme foreground stops being a logo.

---

## House rules

Bun + Elysia, WebSocket-first (register every event in the `.emit` schema block),
Svelte 5 runes, `debug` logger, one numbered migration per schema change,
cross-platform (Linux/macOS/Windows), and credentials only ever through the
`Task 1` account layer — never a per-integration settings blob, and never a
second copy in the subsystem that consumes them.

---

# Foundation

**Task 1 — Account layer, encrypted credentials, inbound events, hub.** Build the
substrate every later entry registers with, as one piece of work.

*Provider registry.* A single source-of-truth registry in code, mirroring the
internal-MCP `defineServer()` pattern, where each provider declares id, display
name, category, auth method (api-key / oauth-device / oauth-code / mcp-oauth /
connection-string / none), credential field shapes, the capabilities it can
offer, and an optional MCP preset that maps the stored credential onto the env
vars or headers the upstream server expects. Providers carry no icon field — the
brand mark is keyed by provider id in the shared brand-mark constant, so a
provider without artwork falls back to a generic glyph rather than blocking.

*Accounts.* One table owning every third-party credential, keyed
`(provider, account_label)` with a nullable project binding so two projects can
point at different orgs. Connecting projects the account onto the surfaces its
capabilities name; changing a credential or toggling a capability re-projects;
disconnecting cleans up. A projection must ADOPT an unowned row already sitting
on the preset's slug rather than creating a sibling — a user who installed that
MCP server by hand before the provider existed must end up with one entry, not
two — and releasing it on disconnect must leave their own row intact.

*Encryption at rest.* Clopen stores secrets as plaintext today, which becomes
materially riskier once it holds GitHub, Vercel and Supabase tokens. Seal them
with AES-256-GCM in a prefixed envelope carrying a key fingerprint, applied at
the DATABASE QUERY LAYER so every existing caller keeps working in plaintext. The
prefix is what makes the rollout safe: an unprefixed value is pre-migration
plaintext and passes through untouched, and re-sealing an already-sealed value is
a no-op, so a half-migrated table reads correctly and a re-run migration cannot
double-encrypt. Decryption must NEVER throw — a value the active key cannot open
returns null and increments a counter the hub surfaces as a banner, because
throwing would take down every read path that touches a stored connection the
moment a key went missing. Key resolution is a generated file in the data
directory plus a `CLOPEN_MASTER_KEY` environment override, deliberately NOT bound
to a machine id: binding would make a restored backup undecryptable on a new
host, and self-hosters migrate hosts. State the real threat model in the module
and the UI — this protects a database that leaves the machine, not local root.

*Migration.* One migration creating the tables, and a second re-encrypting every
existing secret: MCP env, headers and OAuth state, db-client and SSH passwords,
SSH private keys and passphrases, and engine account credentials. It must use RAW
SQL rather than the query modules, which now seal on write and open on read —
routing it through them would encrypt an already-encrypted value on the way in
and hand back plaintext on the way out, appearing to do nothing while corrupting
every row. `down()` must decrypt back to plaintext, or a rollback is data loss.

*OAuth ownership.* For providers whose MCP server drives its own OAuth, the
account is the durable owner and `mcp_servers.oauth` stays a projection that is
still the READ path — so `resolveServerRow()` and every per-engine config builder
keep reading exactly what they read before, and nothing on that path changes.

*Inbound events.* One signed endpoint, `/api/integrations/hooks/<provider>`, with
per-provider signature verification over the RAW request bytes (a JSON round-trip
reorders keys and invalidates a valid signature), replay rejection backed by a
unique constraint on `(provider, delivery_id)` rather than a read-then-write
check, a per-provider rate limit, and a body size cap applied before parsing.
Treat it as a new attack surface: deny by default, answer 404 for an unknown
provider AND for a disabled one so an unauthenticated caller cannot enumerate
what is connected, and log every rejection. It ships with no subscriber and no UI
of its own; `Task 7` is the first consumer.

*Hub.* Settings gains an Integrations section that ABSORBS the existing
Connectors section rather than sitting beside it — two places to connect a
service means two tokens in two tables. One list holds everything Clopen can use,
with filter pills for All / Built-in / Integrations / Custom MCP, and a catalogue
of curated providers not yet connected. Browsing the official MCP registry and
installing anything from it stays exactly as possible as it is today, it just
stops being the front door. One unified detail view serves every row, with
sections appearing according to what the row is: account and capabilities for a
connected provider, editable configuration for a hand-installed server, and
per-tool + per-engine exposure, the tool inspector, health detail and the raw
config an engine receives for anything backed by MCP. Do not add a standalone
public-URL field — it reads as unexplained configuration next to a grid of logos;
surface it where a webhook is actually being registered.

Ship two working presets so both credential-projection paths are exercised by
something real rather than a fixture: one projecting into request headers and one
into a stdio server's environment.

- [x] Done
- Notes: Sealing lives in the QUERY MODULES (`backend/database/crypto` +
  `sealFor`/`openRow` calls), not in a wrapper around the connection — every
  statement touching a secret column already lives in a query module, so SQL
  parsing bought nothing and could fail silently toward plaintext.
  `auditSecretColumns()` replaces the safety net a wrapper would have given and
  runs at dev startup. `mcp_servers.env`/`headers` open to `'{}'` rather than
  `null`, because they are NOT NULL JSON maps and a lost key must not become a
  TypeError inside every engine config builder. Migrations: 072 re-encrypts,
  073 creates the tables. Presets are Context7 (headers) and Firecrawl (stdio
  env) — both pure MCP, so neither collides with Task 2/3's providers; VERIFY
  Context7's remote URL and `CONTEXT7_API_KEY` header name against their docs at
  runtime QA. Only the `agent-tools` projector is implemented; the capability
  enum is complete and later surfaces call `registerProjector()`. Adoption
  snapshots the row's env/headers into `integration_projections.restore_json`
  and only rewrites credential-bearing fields, never the user's command/args/URL.
  Brand marks are the vendors' own SVGs, keyed by provider id in
  `PROVIDER_ICONS`; a provider without one still falls back to a category glyph.
  The hub toolbar is two fixed rows (controls, then pills) because one flex line
  reflowed differently at every panel width, and everything addable lives behind
  one `Add` button rather than an "Available" list under the connected one.
  `ConnectAccountModal` stays mounted and opens by flipping `isOpen` — mounting
  it already-open skips the modal's intro transition — so its credential inputs
  use `value` + `onchange` rather than `bind:`, which would point at `undefined`
  before the seeding effect runs (`props_invalid_value`). The detail view is
  tabbed (Overview / Configuration / Tools / Advanced) with a header status strip
  that owns the enable switch, and tool exposure + the inspector are inline
  panels rather than a modal stacked on a modal. The webhook gateway ships with
  no subscriber. "Connectors" is retired everywhere it named the section —
  Settings → Profiles still used it, and the README, `backend/mcp/README.md` and
  `backend/engine/docs/artifacts.md` are updated; `backend/mcp/README.md` now
  states where `backend/integrations/` sits relative to it, since MCP is a
  protocol and an integration is a credential, and the two being separate
  modules is otherwise easy to read as duplication. Runtime QA of the backend
  paths is still pending.

---

# Surfaces

Each entry builds one provider-agnostic capability and the first provider that
proves its shape. If the second provider needs a second panel, the interface is
wrong and fixing it belongs here.

**Task 2 — Issues surface + GitHub.** Highest ROI: an agentic session almost
always ends at a pull request, but the git panel stops at push. Build the panel
every issue-shaped provider plugs into — work items scoped to the current
project, behind one interface covering list, detail, comment, state transition,
and a "start work" action that creates a worktree, names the branch from the item
identifier and seeds the first prompt with the item body and comments. State
transitions stay configurable and off by default. GitHub is the first provider
(OAuth device flow), adding pull requests, review comments and Actions runs, with
two closed loops: open a PR from the current branch with an AI-drafted
description, and stream a failing Actions run's logs back into the chat as
context. Reuse `backend/git/git-service.ts` for local state and never duplicate
remote data into local git commands. Six more providers plug in later.

- [x] Done
- Notes: The surface is `More Tools → Issues`, NOT a sixth dock panel — adding
  one touches `PanelId`, the split tree, every layout preset and both
  navigators, and a second entry point for the same work would repeat the Notes
  mistake. The Git panel's More menu gained `Open pull request…`, which opens
  THIS surface with its composer up; many doors, one room. Issues registers an
  ADAPTER (`backend/issues/registry.ts`), not a projector: a projection derives
  a row on a surface that owns a table, and work items are deliberately never
  copied locally, so there was no row to derive — the comment in
  `projections/types.ts` promising an `issues` projector is corrected. That left
  the hub reporting "Nothing to probe yet" forever for a provider with no MCP
  row, so `health.ts` gained `registerAccountProbe(provider, probe)`, which the
  surface registers and which returns null when it has nothing to say (a GitHub
  account with `issues` off still probes through MCP). AUTH IS A FINE-GRAINED
  PAT, not the OAuth device flow sketched above — a device flow needs an
  embedded client id that makes every self-hosted install depend on one app we
  own, its narrowest scope is `repo` (write to EVERY repository the user can
  reach), and `Task 9`'s targets only offer tokens, so the token path had to
  exist anyway. Device flow remains addable later without changing what is
  stored: it is another way to fill the same `token` field. GitHub declares
  `agent-tools` too (official remote MCP, same bearer) but OFF by default.
  Migration 074 adds `issue_bindings` (which repo, per project per account, plus
  the transition/branch-template config — off by default) and `issue_work_links`
  (item → worktree/session/branch, `ON DELETE SET NULL` so applying and deleting
  a worktree does not erase which issue a branch belongs to). Nothing else about
  a work item is persisted. Binding is DETECTED from the git remotes and
  recorded as detected, always overridable. `diff-budget.ts` was generalised
  from `--cached` to a `DiffScope` (`rangeScope(base, head)` uses three dots, or
  the description would claim work someone else did) rather than copied. Start
  work is kind-aware: an ISSUE gets a new branch from the template, a PULL
  REQUEST gets its head branch fetched and checked out — reviewing code on an
  empty branch is the wrong action — and every branch step fails soft, reporting
  the branch it actually landed on. The prompt differs per mode for the same
  reason. Actions logs pull only FAILED jobs via the per-job endpoint (the
  run-level one is a zip of everything) and keep the TAIL, since a CI log's head
  is dependency installation; the redirect to signed storage is followed
  manually so the bearer token is never replayed at a third-party host. Both
  loops hand TEXT back to the client to send, because the chat pipeline is
  browser-owned and a second injection path would race it. `switchToSession()`
  was added to the worktree store and `switchWorktreeContext` refactored onto
  the same barrier, rather than duplicating the swap. Routes are project-access
  gated, not admin-gated like `integrations:*` — they act inside one project,
  the way `git:push` does. Post-QA pass: the More Tools menu is capped at the
  viewport and scrolls (nine entries ran off the top of small screens); the
  modal is one header row — title, account and repository together, with the
  repository editor as a popover — because two stacked strips of chrome cost a
  quarter of the height before an issue was shown; every control on a row is a
  fixed h-8/h-9 rather than sized by its own padding, since a button sized by
  text and a `<select>` sized by the browser never line up; no action is
  hover-revealed, because a touch screen has no hover and the control simply
  does not exist there. The empty state deep-links to the Connect dialog for the
  provider it needs via `openIntegrationConnect()`, not to the integrations
  list. GitHub's 404 is now explained rather than repeated: it answers the same
  way for a missing repository and an unpermitted one, and the real cause is
  almost always that a FINE-GRAINED token is scoped to one resource owner — it
  cannot reach another person's repository even as a collaborator, and needs an
  owner's approval for an organisation's. `tokenKindOf()` reads the prefix and
  the message names the fix. Second QA pass REVERSED the token guidance: the
  recommendation is now a CLASSIC token with `repo`, because least privilege is
  the wrong trade when it silently removes access the user already has — a
  fine-grained token cannot reach a repository you merely collaborate on, and
  that is the common case here. Fine-grained still works and is diagnosed, not
  rejected. `issues:start-work` timed out at the default 30s mid-clone while the
  server carried on, leaving a worktree nobody was working in; the call now
  carries a 10-minute budget. Every route takes an optional `projectId`
  (`ws/issues/context.ts`) so the surface is genuinely global — it has its own
  project picker and no longer follows the workspace, and only "start work"
  relocates you. Layout: Behaviour is a stacked modal instead of a band that
  pushed the list down, tabs moved into the list column (a full-width strip
  spent a whole row labelling a third-width column), the sidebar is 19rem, and
  the provider mark moved to the footer beside the rate limit — it is
  identification, not navigation. Features added to reach parity: edit/delete
  comment (`canModify` computed server-side from authorship plus repo write
  access, because GitHub reports no per-comment permission), merge with method
  choice restricted to what the repo allows, PR sub-tabs
  Conversation/Commits/Checks/Files changed, assignees, create issue, copy
  link/markdown. The comment box is a markdown composer with a toolbar and
  Write/Preview — NOT the Notes editor, which is contenteditable HTML with its
  own image store, and converting HTML→markdown on the way out is where fidelity
  goes. IMAGE UPLOAD IS NOT POSSIBLE: no REST endpoint attaches a file to a
  comment (the one behind drag-and-drop on github.com is private), and storing
  bytes in Clopen would produce a link broken for everyone else on the thread —
  so the composer offers image-by-URL and says so when a file is dropped.
  `frontend/utils/clipboard.ts` was added because `navigator.clipboard` does not
  exist on a non-secure origin, which is how Clopen is usually reached. Third QA
  pass fixed two real bugs and closed the parity gap. A PR's discussion lives on
  THREE endpoints and only two were read: `/pulls/{n}/reviews` carries the
  summary a reviewer submits, which is where review bots put their findings, so
  a bot's comment was simply never shown and looked deleted. Review summaries
  now appear, marked read-only (they are edited through the reviews endpoint
  with different rules). The list also raced itself: typing a filter and
  clearing it fired two requests and the slower first one could land last,
  leaving a partial list — every response now checks a generation counter before
  writing. Added: state filter incl. Closed, author/label/date-range filters
  behind one button, infinite scroll with provider-driven `hasMore`, edit title
  and edit body (the item body renders through `CommentCard`, so its menu comes
  from one component), copy-as-markdown and open-in-browser on every comment,
  author names as profile links, a `StatePicker` dropdown replacing the native
  `<select>` (which cannot show the current state or a coloured glyph), a
  project-picker filter input, a shared `RefreshButton` that spins, disables and
  holds the spinner a beat so a fast response still reads as an action, an
  in-app log viewer (`CheckLogsModal`) showing exactly the bundle the chat
  prompt is built from, and a Files-changed view rebuilt as tree + code with an
  IntersectionObserver scroll-spy. Multi-account is now REACHABLE: the account
  layer always supported `(provider, label)`, but Add hid connected providers,
  which made the connect dialog's "only if you connect more than one" a promise
  the UI refused to keep — Add now lists every provider with an "Add another"
  action and a connected count. The inner filter pill "Integrations" is renamed
  "Accounts" so it no longer repeats its own section name. Fourth QA pass, three
  more bugs. `state=all` rendered a single row: `/issues` returns pull requests
  too and they are filtered out here, so on a busy repo the fifty most recently
  updated items were nearly all closed PRs and almost nothing survived — both
  list paths now go through `fillPage()`, which keeps pulling provider pages
  until the FILTERED page is full and reports `nextPage` so load-more resumes
  where the fill stopped rather than at `page + 1`. Relative time was off by one
  unit (an hour-old item read "1 minute ago") because the loop divided and then
  applied the previous unit's name; it is now `frontend/utils/relative-time.ts`
  with explicit thresholds and tests. The filter badge counted Open/Closed/All,
  which is a view rather than a narrowing, so an untouched list claimed one
  filter. `MenuSurface` replaced six hand-rolled popovers: every menu now
  animates, measures itself against the viewport to flip left/right and
  up/down, and shares one z-index — the comment menu used to render beneath the
  composer. Also: account rename (the Name field was read-only when
  reconfiguring, so a typo was permanent), copy-as-markdown now copies the whole
  comment as an attributed blockquote instead of its first line, the status
  badge carries an icon and a category colour, "Only mine" became "Assigned to
  me", the item timeline (`/issues/{n}/timeline`, unknown event kinds dropped)
  renders on a vertical rail with the comments, and Files changed gained a
  unified/split toggle, copy-path, and a whole-file viewer through the shared
  Monaco editor.

**Task 3 — Deployments surface + Vercel.** Close the loop after preview. Build
the panel every deploy target plugs into — deployments for the current project
behind one interface covering list, status, build logs and open-preview — with
failing build logs streamed into the chat and the preview URL exposed directly to
the existing preview browser so an agent can drive a real deployed build. Every
action that triggers a build or changes what is live is outward-facing and must
be confirmed explicitly. Vercel is the first provider (API token). Six more
targets plug in later; none of them may add a panel.

- [x] Done
- Notes: The surface is `More Tools → Deployments`, NOT a dock panel — same
  reasoning as Task 2, and `capabilities.ts` was corrected from the "Deployments
  panel" it promised. Like Issues it registers an ADAPTER
  (`backend/deployments/registry.ts`) plus a `registerAccountProbe`, not a
  projector: nothing about a deployment is copied locally, so migration 075
  creates `deploy_bindings` and there is no link table either — unlike an issue,
  a build leaves no worktree behind that outlives the remote record. The binding
  is a sibling of `work_bindings` rather than a generalisation: it needs
  `display_name` (a locator is an opaque `prj_8Qc…`, not a self-describing
  `owner/repo`) and `team_id`. THE TEAM LIVES ON THE BINDING, NOT THE ACCOUNT —
  one token reaches every team, so "which team" is a property of the project you
  picked; a credential field would force connecting the same token twice. Vercel
  therefore declares ONE field. Detection is two passes, `.vercel/project.json`
  then a git-remote match against each target's connected repo, both recorded as
  detected and both overridable (a monorepo deploying three apps WILL be detected
  wrong). Three Vercel facts are absorbed in the adapter so no later provider
  inherits them: versions are per-endpoint (`/v10/projects` to list but
  `/v9/projects/{id}` to read, rollback on `/v1` and promote on `/v10` — two of
  these were wrong on first guess and were checked against the published OpenAPI
  document); `target` is `production` or NULL with no `preview` value, so only
  production filters server-side and everything else fills the page through
  repeated requests — the same bug `state=all` shipped with on the Issues list,
  fixed before shipping here and covered by `list.test.ts`; and LIVE IS NOT A
  STATE, since a superseded production build is still `READY` and still
  `production`, so `targets.production.id` off the project is the only honest
  answer for `isCurrent`. Logs genuinely stream (`follow=1` NDJSON), managed like
  container logs — coalesced flush, bounded ring, per-user cap, stopped when the
  socket closes and at shutdown. Rollback and promote report `pending`, never
  `done`: Vercel accepts the request and moves the aliases afterwards, and saying
  "done" would tell someone their incident was over while the old build still
  served. All four actions sit behind one confirm dialog that names the
  consequence and the hostname rather than asking "are you sure", with the
  destructive styling reserved for production; the surface exposes NO MCP tool,
  so no agent can trigger a build. Open-in-preview needed a new generic
  `openUrlInPreview()`, which creates the tab and lets BrowserPreview's existing
  adopt-a-URL-with-no-session effect launch it — calling `launchBrowser` here
  would open a second backend tab for one link. That uncovered a REAL RACE worth
  knowing about: docks hydrate AFTER the reveal and the project switch does not
  await them, so `await setCurrentProject(...)` returns while the preview dock is
  still rebuilding and would wipe the tab just created. Fixed with an exported
  `whenWorkspaceSettled()` — a no-op when no switch is in flight — which every
  future "relocate then act on a dock" path needs. Both loops hand TEXT back to
  the client to send, for the reason Task 2 found. Deliberately out of scope:
  webhooks (Task 7 is the first consumer, and a local Clopen has no public URL to
  register), env-var management, and `agent-tools` — Vercel's MCP server uses its
  own OAuth, a different audience from this REST token, so declaring it would
  mean projecting a row this credential cannot fill. `MenuSurface`,
  `RefreshButton` and `ProviderMark` were PROMOTED from `components/work/` to
  `components/common/` rather than duplicated, and `Button` gained the `danger`
  variant every destructive confirm in the app had been hand-rolling. RUNTIME QA
  PENDING: nothing here has been run against a real Vercel token — the endpoint
  set, the alias ordering and the log-stream shape are all verified against
  documentation and mocked tests, not against the live API.
  POST-QA PASS, three real findings. The scoped and default project listings
  OVERLAP — `/v10/projects` with no `teamId` returns the token's DEFAULT scope,
  which for anyone in a team is that team, so the same project arrived twice and
  crashed the keyed picker. De-duplicating it is not the whole fix: only the
  team-scoped copy carries the `teamId` that every later call needs, so a
  team-scoped entry must always win over an unscoped one or the picker looks
  right and everything behind it 404s. The fill loop could repeat a row the same
  way when a build landed mid-fetch and shifted the timestamp window. And the
  empty state said "nothing matches this environment filter" with no filter set,
  on a target that had simply never been deployed — it now distinguishes never
  deployed / filtered out / nothing yet, and each says something different.
  Behind that last one was the real gap: THE SURFACE COULD NOT DEPLOY. Redeploy
  needs an existing deployment to copy, so a project that had never been built
  was a dead end — exactly the project someone most wants to get live. Added
  `createDeployment` (`gitSource` from the project's own link, so a GitLab
  project is not sent `type: 'github'`), and note the trap: `name` alone is
  enough for the API to accept the call and CREATES a project when it does not
  match, so `project` is what pins the build to the bound target. Added
  `createProject` too, prefilled from the local project's name and git remote
  and auto-bound on success, because "connect an account" previously left a user
  with nothing to point at. Three things declared in the model but never
  surfaced were also closed: the branch filter, the auto-refresh toggle, and the
  `custom` environment chip.
  SECOND QA PASS. The new dialogs passed no `title` to `Modal`, which renders an
  empty header band containing a stray close button, and they added their own
  padding on top of the body padding `Modal` already supplies — the house
  pattern is `<Modal title=… size=…>` with an unpadded child, as `MergeDialog`
  does. More substantially, "this project is not connected to a git repository"
  was a DEAD END that sent the user to the provider's dashboard, which is
  exactly the read-only-window feeling this surface exists to remove. Added
  `connectRepository`, offered in the deploy dialog prefilled from the local git
  remote. NOTE THE RISK: `POST /v9/projects/{id}/link` is NOT in Vercel's
  published OpenAPI document — `PATCH /v9/projects/{id}` accepts no
  `gitRepository`, and the only documented way to get a connected project is to
  create a new one. It is what `vercel git connect` calls, so the official CLI
  exercises it, but it is the single call in this adapter with no compatibility
  promise; the failure path falls back to the documented create-a-project route
  rather than to a dead end. `deployInfo` is now composed in the ROUTE from the
  adapter's answer about the remote project plus the local working tree's
  remote, with `AdapterDeployInfo = Omit<DeployInfo, 'suggestedRepo'>` keeping
  the adapter free of any notion that a Clopen project has a working tree.
  THIRD QA PASS found the limit of that: Connect failed with "You need to add a
  Login Connection to your GitHub account first". Vercel requires the ACCOUNT to
  hold a git login connection before any project can be linked, and that is an
  OAuth flow on vercel.com which NO API token can stand in for — the one
  prerequisite this surface can detect but never satisfy. `repositoryAccess()`
  now asks `GET /v1/integrations/git-namespaces` before the button is offered
  and distinguishes three states: no connection at all, connected but not to
  that repository's owner (the GitHub app is installed per account or org, and
  the message names which owners ARE reachable), and connected but restricted
  pending an owner's approval. When blocked the dialog shows a link to
  vercel.com/account/login-connections plus a "Check again" that re-reads
  without closing, instead of a button that cannot win. A failed check is
  treated as permission to try anyway — unreadable is not the same as absent —
  and the raw Vercel error is still rewritten to carry that address, since the
  pre-check can be skipped or go stale.
  FOURTH QA PASS corrected that last sentence, which was the bug. The check
  answered a BOOLEAN, so the case it could not read had to pretend — it returned
  "can connect", which put the button back on screen and let the exact failure
  the check exists to prevent arrive as a toast. It is now three states:
  `ready` enables the button, `blocked` DISABLES it and offers a link out
  instead, `unknown` allows the attempt but says so. A wrapped namespaces
  response is also tolerated rather than read as "none", since that would be a
  confident `blocked` built on a parsing mistake. And provider failures in this
  dialog now render INSIDE it (`InlineError`, which splits URLs out of the
  message and renders them as real links — never `{@html}` on a third-party
  string) rather than as a toast: these messages end in "set it up at <url>",
  and a toast removes the URL before it can be clicked. The general rule for
  later surfaces: anything the user must ACT on belongs in the surface that
  caused it, and only outcomes they merely need to KNOW belong in a toast.
  FIFTH QA PASS, from a server log the user read. `teamId` was being sent to
  `/v1/integrations/git-namespaces`, which REJECTS it with a 400 — namespaces
  belong to the signed-in user, not to a team, and the endpoint's parameter list
  never included it. That single wrong query parameter turned every readiness
  check into an error, which surfaced as `unknown`, which let the button through:
  the whole pre-flight was decoration. Locked by a test asserting the URL carries
  no `teamId`. Timeouts were wrong in TWO layers and the inner one was the real
  culprit — the Vercel client aborted at 20s before the 30s WebSocket budget was
  reached, so a link that Vercel completed server-side was reported as a client
  timeout. Reads keep 20s; mutations get 120s, and the slow WS calls get a
  3-minute budget (a long budget, NOT unbounded — an unbounded call cannot tell
  "still working" from "this socket will never answer"). Finally, build progress:
  `deployment-state` events were being dropped with the other non-output events,
  but they are the only thing that speaks during the stretches where a build
  prints nothing, so they are now forwarded as a `phase` — pushed immediately
  rather than on the flush interval, and only on a change — and rendered where
  the "live" dot used to be. A bare dot cannot be told apart from a stall.
  SIXTH QA PASS corrected a REASONING error rather than a coding one, and it is
  the one worth remembering. An account with GitHub connected and working was
  told it had no GitHub connection, because the check inferred that from an
  EMPTY `git-namespaces` list and then disabled the button on the strength of
  it. Two mistakes stacked: conflating a Vercel "Login Connection" (how you sign
  in) with a GitHub App installation (what lets Vercel read repositories) — an
  account can have the first without the second — and turning a weak signal into
  a hard gate. The rule now: only a POSITIVE match is confident. Owner present
  and unrestricted → `ready`. Owner absent from a NON-EMPTY list → `blocked`,
  which is informative because the app is installed somewhere just not there. An
  empty list → `unknown`, never blocked, because this endpoint's silence can
  equally mean a token that cannot read integrations. The action URL is the
  GitHub App install page, not the login-connections page, since repository
  access is what is actually missing. General lesson for later providers: a
  pre-flight check may enable confidently and warn freely, but it must not
  DISABLE on an inference it cannot verify — being wrong there contradicts what
  the user can see on their own screen.
  SEVENTH QA PASS, after the first successful end-to-end deploy. The build log
  is rendered with the app's own `processAnsiCodes` — the path chat tool output
  already takes — rather than a PtyKit terminal: PtyKit is an interactive
  emulator with a keyboard, cursor and resize protocol, and this is read-only
  text, so it would cost far more than the colour is worth and look unlike every
  other static output in Clopen. The log also opens itself now for every state:
  hiding the substance of the pane behind a "Show the build log" click to save
  one request was the wrong trade. "Open in preview" was removed at the user's
  request — note that Task 3's spec named that loop explicitly, so this is a
  deliberate deviation; `openUrlInPreview()` went with it rather than shipping
  dead code, but `whenWorkspaceSettled()` stays because the send-log-to-chat
  relocation still needs it. Detail gained the Domains list (a production build
  answers on three hostnames and which one you want depends on the task), copy
  buttons for commit and domains, and the trigger source; the list column went
  from 22rem to 17rem, and the newest deployment is selected automatically
  because an empty right-hand pane reads as a panel that failed to load. The
  deploy dialog now caches its readiness answer per (project, account) and shows
  a shaped skeleton instead of a bare spinner — three provider requests on every
  open was most of why it felt slow — and offers the LOCALLY CHECKED-OUT branch
  alongside the production one, since the branch in front of you is at least as
  likely to be the one you meant. `repositoryAccess` became UNBOUND so the
  new-project dialog can ask it too: that form was offering "Connect acme/web"
  ticked by default on accounts that cannot reach acme, which is the same
  can't-win button in a second place.
  EIGHTH QA PASS, all layout. The two dialogs became ONE with tabs and the
  header lost its bare "+": two buttons both about deploying made the user
  choose before knowing what either did, so `DeployDialog`/`NewProjectModal`
  are now `DeployPanel`/`NewProjectPanel` inside `DeployModal`, and the tab
  strip hides itself when only one tab applies. The auto-refresh and refresh
  controls moved off the environment-chip row (a fourth chip ran into them) onto
  the search row they act upon, the branch filter's glyph is a search icon, and
  list timestamps use a new `shortRelativeTime` — the long form wrapped on a row
  that already carries a state badge, a branch and a commit. Domains are their
  own component with an icon PER KIND: the project domain follows what is live,
  the branch alias follows the newest build of that branch, and the build URL
  pins this exact build, so rendering all three with one globe made them look
  like duplicates of one address. Facts and domains now sit side by side rather
  than stacked, which was leaving half the pane blank while pushing the log
  down. The log lost its bordered container (a short log looked like an empty
  card) and trims trailing whitespace, since the provider ends its stream with
  blank lines and every streamed chunk appends its own newline. Spinners moved
  INSIDE their buttons via a shared `ActionButton` — a spinner beside a row of
  four actions cannot say which one is running — and the footer's empty left
  half now names the provider and account owner, as the Issues footer does.
  NINTH QA PASS added the actions that were still missing, and found that one of
  them had been there all along and was unreachable. `isRollbackCandidate` was
  read as `raw.isRollbackCandidate === true`, which collapsed "the provider says
  no" and "the provider did not say" into the same answer — so Roll back never
  appeared on any listing that omits the field. It is now `boolean | null`, and
  the UI trusts a stated value but falls back to what is knowable (a ready
  production build that is not live) when there is none. Same shape of mistake
  as the namespace check: an absent signal is not a negative one. Added Delete
  (`DELETE /v13/deployments/{id}`, never offered for what is serving production
  since the provider refuses it) and Pause/Resume (`POST /v1/projects/{id}/pause`
  and `/unpause`), which is target-level rather than per-build and is the only
  thing that explains a list which has stopped growing — so it also gets a
  banner. Pausing is confirmed and resuming is not: one silently changes what a
  push does for everyone on the project, the other undoes that. Finally the
  `pending` that rollback and promote return is now finishable: `projectStatus`
  reads `lastAliasRequest.jobStatus`, a bounded poll follows the request to
  succeeded or failed, and a banner says traffic is mid-move. Reporting
  `pending` and then never mentioning it again was honest about the moment and
  useless about the outcome.
  TENTH QA PASS REMOVED the pause action added in the ninth, and the reason
  matters more than the removal. Vercel's own endpoint description says pausing
  "blocks the active Production Deployment" — it takes the SITE DOWN, it does
  not merely stop future builds — and the confirm dialog written for it said the
  opposite: "anything already live keeps serving". A confirm dialog that
  misstates the consequence is worse than none, because it is the thing the user
  relies on. That the copy was wrong is itself evidence the action was not well
  enough understood to ship from an editor, so it is gone rather than reworded.
  `paused` survives as READ-ONLY state with a banner, because when someone pauses
  in the provider's dashboard nothing else explains a list that stopped growing
  and a site that stopped answering. General rule: when a capability's
  consequence is hard to state accurately, that is a reason not to offer it, not
  a prompt to write better copy. Also: detail-pane text moved off 11px (fine for
  labels, below comfortable for content) and the modal dropped from 90vw to
  72rem, since the surface never needed the whole screen.

**Task 4 — Account-backed database connections + Supabase.** Teach DB Client to
show connections that came from a connected account rather than a hand-typed
form: the projected row is read-only in the connection form, badged with the
account that owns it, and re-projected when that credential rotates. DB Client's
add-connection flow gains a contextual connect entry point so a user already
there never has to go to Settings first. Supabase is the first provider, going
beyond the Postgres connection db-client already gives you: a project-level
integration (management API + project ref) adding tabs inside DB Client for
migrations with a proposed diff applied against a chosen environment, RLS
policies, edge functions, storage buckets and auth users, plus generated
TypeScript types written into the project on demand. Detect an existing local
Supabase CLI project and adopt its config rather than asking the user to retype
it.

- [ ] Done
- Notes: —

**Task 5 — Worktree database branching + Neon.** Pair database branching with the
worktree manager Clopen already has. Creating a worktree optionally creates a
branch on the connected account and injects its connection string into that
worktree's environment; deleting the worktree deletes the branch. This gives
every agent an isolated database to migrate against without touching dev data.
Expose it as a worktree-lifecycle capability other providers implement rather
than as Neon-specific code — Turso lands on the same shape. Opt-in per project
and fail soft: a provider outage must never block worktree creation, and an
orphaned remote branch must be reported rather than silently leaked.

- [ ] Done
- Notes: —

**Task 6 — Notification channels + Telegram.** Build the loop Remote Access has
been missing: when a session needs input or finishes a long run, Clopen sends a
message carrying interactive buttons, and the inbound universal `postback` routes
straight back into that session as user input — approve, reject or reply from a
phone. The channel is a capability surfaced in the existing notification
settings, not a catalogue entry with a panel. Depend on ChatKit **locally**
(`file:../chatkit`, from `~/Codes/MyriaLabs/chatkit`), not from npm: the library
is still maturing, so anything missing or wrong is fixed upstream in the ChatKit
repo as part of this task rather than worked around inside Clopen — but keep
those fixes generic, since ChatKit has other consumers coming and nothing
Clopen-specific may leak into it. Mind the refresh trap: Bun caches a `file:`
dependency by version, not by dist content, so bump ChatKit's version after every
rebuild or Clopen will silently keep the stale build. One backend-owned `ChatKit`
instance, per-account adapters registered at runtime with `chat.add()` /
`chat.remove()`, webhooks mounted through the library's ready-made Elysia handler
from `@myrialabs/chatkit/middleware` behind the `Task 1` gateway (raw body —
signatures are computed over unmodified bytes), and persistent adapters held open
by the long-running backend process. Pass ChatKit a `stateKey` so its
AES-256-GCM auth state is never left unencrypted, scope every message to a single
session id so multi-project users never get crossed wires, and surface
`chat.health()` per account. Telegram ships first: webhook, no ban risk, simplest
pairing.

- [ ] Done
- Notes: —

---

# Providers

Each entry registers with `Task 1` and plugs into a surface that already exists.
None of them may add a panel.

**Task 7 — Sentry.** The most distinctive loop Clopen can own, and the first
consumer of the `Task 1` webhook gateway: an issue arrives inbound, its stack
trace, breadcrumbs and release metadata become session context, the agent
reproduces it with the existing browser-automation tools, fixes it, and opens a
PR referencing the issue. Register the inbound handler and expose issues through
the `Task 2` interface so "start a session from this issue" is the action that
surface already provides. This is also where the hook URL becomes real, so
surface public-URL configuration here, in the place a user is registering a
webhook — and warn plainly when the resolved origin comes from a quick tunnel,
whose hostname changes on every restart.

- [ ] Done
- Notes: —

**Task 8 — Linear.** Make task tracking a *trigger into* Clopen rather than a
place to report out. An assigned-issues list through the `Task 2` interface, with
issue-to-worktree already provided by that surface, and state transitions on
branch push and PR open — configurable and off by default. OAuth.

- [ ] Done
- Notes: —

**Task 9 — GitLab, Gitea and Forgejo.** The proof that the GitHub work
generalises: merge requests, issues and pipeline status behind the same
issue-provider interface, with a user-supplied base URL so self-hosted instances
work. Gitea and Forgejo matter because Clopen's audience skews toward
self-hosting; support personal access tokens and degrade gracefully when an
instance lacks newer API endpoints. If any of the three needs bespoke panel code,
`Task 2`'s interface is wrong and that is what to fix.

- [ ] Done
- Notes: —

**Task 10 — Jira and PostHog.** Jira is the enterprise counterpart to Linear
behind the same interface: assigned issues, issue-to-worktree, status transitions
on push, both Cloud and Data Center base URLs, and expect JQL to be the only
reliable way to scope a query. PostHog feeds product reality into the same
surface: funnels, error events and session replays for the current project, where
an issue found in a replay becomes a session prompt with the reproduction steps
attached. Read-only to start; writing feature flags can come later.

- [ ] Done
- Notes: —

**Task 11 — Cloudflare.** One account feeding three surfaces, which is why it is
its own entry: D1 as a first-class DB Client connection, Workers and Pages
deployment status and log tailing through the `Task 3` surface, and the tunnel
credentials Clopen already depends on. Keep tunnel credentials and account API
tokens strictly separate in the account store — they authorise different things
and must not be interchangeable.

- [ ] Done
- Notes: —

**Task 12 — Deploy targets: Coolify/Dokploy, Railway, Fly.io, Netlify, Render.**
Five providers behind the `Task 3` interface, each supplying applications,
deployments and log streams. Coolify and Dokploy take a user-supplied instance
URL and API key and match Clopen's VPS story better than any managed PaaS; the
other three take an API token. Read-only first, with any action that triggers a
build confirmed explicitly. No custom UI for any of them.

- [ ] Done
- Notes: —

**Task 13 — Database targets: Turso, Upstash, PlanetScale, MongoDB Atlas.** Four
providers behind the `Task 4` interface. Turso is a near-free win given Clopen is
already SQLite-native: token auth plus embedded-replica awareness, reusing the
existing sqlite driver's query layer wherever the dialect matches, and
per-worktree branches through `Task 5`. Upstash adds serverless Redis (and
optionally QStash) with REST-token auth so the existing redis explorer works
without a TCP connection. PlanetScale uses the existing mysql driver with the
required TLS settings. MongoDB Atlas reuses the mongodb driver with SRV
connection strings and IP-allowlist guidance in the connect dialog.

- [ ] Done
- Notes: —

**Task 14 — Chat channels: Discord, Slack, WhatsApp.** Three more channels
through the `Task 6` code path, which is the point — if any of them needs
platform-specific handling inside Clopen, the gap belongs in ChatKit. Discord and
Slack (Socket Mode) come nearly free. WhatsApp via Baileys ships last, off by
default, with its ban-risk warning shown in the connect dialog.

- [ ] Done
- Notes: —

---

# Catalogue

Curated MCP presets: icon, category, credential shape and a tested default
prompt, registered with `Task 1` and exposing agent tools only. If one of them
starts needing custom code or a panel, promote it to a `Providers` entry instead.

**Task 15 — Research and documentation: Context7, Exa, Firecrawl.** Context7 for
up-to-date library documentation, one of the highest daily-value tools for a
coding agent — ship it enabled by default in the suggested starter set. Exa for
semantic web and code search when the agent needs research beyond documentation;
keep it distinct from Context7 in the catalogue copy so users understand when to
use which. Firecrawl for crawling and converting live sites into clean markdown,
useful for migration and scraping work, pairing with the existing browser
automation rather than replacing it.

- [ ] Done
- Notes: —

**Task 16 — Design and knowledge sources: Figma, Notion.** Figma installs the
official Dev Mode MCP server plus a thin surface listing selected frames and
exposing design tokens to the session, so frontend work starts from real design
data — no bespoke API client, the value is the preset plus a good default prompt.
Notion is a documentation and spec source: connect a workspace, let the user pick
pages or databases to expose as session context, and allow the agent to write
session summaries back to a chosen page, with write access opt-in per page.

- [ ] Done
- Notes: —

**Task 17 — Developer services: Stripe, Resend, Twilio.** Stripe for payment-flow
work, scoped to test-mode keys by default and refusing to store live keys without
an explicit confirmation in the connect dialog. Resend for transactional email so
agents can send and inspect test messages while building signup and notification
flows, domain and API-key auth only. Twilio for SMS and voice testing during auth
or notification work, with sandbox credentials encouraged in the connect copy.

- [ ] Done
- Notes: —

**Task 18 — Inspection presets: Grafana, Axiom, Better Stack, Docker Hub, GHCR,
Firebase.** Read-only windows into external systems, so a production signal can
be pulled into a session without leaving Clopen. Grafana queries dashboards and
logs against a user-supplied instance with a base URL and service-account token.
Axiom and Better Stack query logs; one category, two entries, same shape.
Docker Hub and GHCR inspect images and tags with token auth, composing with the
existing containers surface. Firebase inspects Firestore and auth for users
migrating off or maintaining Firebase apps; service-account JSON is the
credential shape, stored through the account layer and never written to disk.

- [ ] Done
- Notes: —

**Task 19 — Secrets managers: 1Password, Doppler, Infisical.** Presets so project
environment variables can be pulled at session start instead of being pasted into
Clopen. This also strengthens `Task 1` by making Clopen a *consumer* of secrets
rather than their permanent home, which is the strongest available answer to
"why is my token in your database".

- [ ] Done
- Notes: —
