# Third-Party Integrations — Implementation Specs

Every entry below is numbered, and one task is one implementation session. Each
task carries its own checklist and notes line: on finishing one, tick the box and
replace the `—` with a nested bullet list recording what was actually built,
which decisions were taken, and where the implementation deviated from this spec
— the next session reads those notes, not the diff. ONE BULLET PER TOPIC, opened
by a bolded label, grouped by subject rather than by the order things happened:
later passes and reversals belong inside the topic bullet they corrected, so a
reader looking for how auth works finds one place and not a chronology.

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
- Notes:
  - **Encryption at rest.** Sealing lives in the QUERY MODULES
    (`backend/database/crypto` + `sealFor`/`openRow` calls), not in a wrapper
    around the connection — every statement touching a secret column already
    lives in a query module, so SQL parsing bought nothing and could fail
    silently toward plaintext. `auditSecretColumns()` replaces the safety net a
    wrapper would have given and runs at dev startup.
  - **Open defaults.** `mcp_servers.env`/`headers` open to `'{}'` rather than
    `null`, because they are NOT NULL JSON maps and a lost key must not become a
    TypeError inside every engine config builder.
  - **Migrations.** 072 re-encrypts every existing secret, 073 creates the
    tables.
  - **Presets.** Context7 (headers) and Firecrawl (stdio env) — both pure MCP, so
    neither collides with Task 2/3's providers. VERIFY Context7's remote URL and
    `CONTEXT7_API_KEY` header name against their docs at runtime QA.
  - **Projections.** Only the `agent-tools` projector is implemented; the
    capability enum is complete and later surfaces call `registerProjector()`.
    Adoption snapshots the row's env/headers into
    `integration_projections.restore_json` and only rewrites credential-bearing
    fields, never the user's command/args/URL.
  - **Brand marks.** The vendors' own SVGs, keyed by provider id in
    `PROVIDER_ICONS`; a provider without one still falls back to a category
    glyph.
  - **Hub layout.** The toolbar is two fixed rows (controls, then pills) because
    one flex line reflowed differently at every panel width, and everything
    addable lives behind one `Add` button rather than an "Available" list under
    the connected one.
  - **Connect modal.** `ConnectAccountModal` stays mounted and opens by flipping
    `isOpen` — mounting it already-open skips the modal's intro transition — so
    its credential inputs use `value` + `onchange` rather than `bind:`, which
    would point at `undefined` before the seeding effect runs
    (`props_invalid_value`).
  - **Detail view.** Tabbed (Overview / Configuration / Tools / Advanced) with a
    header status strip that owns the enable switch; tool exposure and the
    inspector are inline panels rather than a modal stacked on a modal.
  - **Webhook gateway.** Ships with no subscriber.
  - **Naming.** "Connectors" is retired everywhere it named the section —
    Settings → Profiles still used it, and the README, `backend/mcp/README.md`
    and `backend/engine/docs/artifacts.md` are updated. `backend/mcp/README.md`
    now states where `backend/integrations/` sits relative to it, since MCP is a
    protocol and an integration is a credential, and the two being separate
    modules is otherwise easy to read as duplication.
  - **Status.** Runtime QA of the backend paths is still pending.

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
- Notes:
  - **Where it lives.** The surface is `More Tools → Issues`, NOT a sixth dock
    panel — adding one touches `PanelId`, the split tree, every layout preset and
    both navigators, and a second entry point for the same work would repeat the
    Notes mistake. The Git panel's More menu gained `Open pull request…`, which
    opens THIS surface with its composer up; many doors, one room.
  - **Adapter, not projector.** Issues registers an ADAPTER
    (`backend/issues/registry.ts`): a projection derives a row on a surface that
    owns a table, and work items are deliberately never copied locally, so there
    was no row to derive — the comment in `projections/types.ts` promising an
    `issues` projector is corrected. That left the hub reporting "Nothing to
    probe yet" forever for a provider with no MCP row, so `health.ts` gained
    `registerAccountProbe(provider, probe)`, which the surface registers and
    which returns null when it has nothing to say (a GitHub account with `issues`
    off still probes through MCP).
  - **Auth.** A TOKEN, not the OAuth device flow sketched above — a device flow
    needs an embedded client id that makes every self-hosted install depend on
    one app we own, its narrowest scope is `repo` (write to EVERY repository the
    user can reach), and `Task 9`'s targets only offer tokens, so the token path
    had to exist anyway. Device flow remains addable later without changing what
    is stored: it is another way to fill the same `token` field. The
    recommendation ENDED UP a CLASSIC token with `repo`, reversing the
    fine-grained guidance shipped first — least privilege is the wrong trade when
    it silently removes access the user already has, since a fine-grained token
    cannot reach a repository you merely collaborate on and that is the common
    case here. Fine-grained still works and is diagnosed, not rejected:
    `tokenKindOf()` reads the prefix, and GitHub's 404 (identical for a missing
    repository and an unpermitted one) is explained rather than repeated — the
    real cause is almost always a fine-grained token scoped to one resource
    owner, which also needs an owner's approval for an organisation's
    repositories. GitHub declares `agent-tools` too (official remote MCP, same
    bearer) but OFF by default.
  - **Schema (migration 074).** `issue_bindings` (which repo, per project per
    account, plus the transition/branch-template config — off by default) and
    `issue_work_links` (item → worktree/session/branch, `ON DELETE SET NULL` so
    applying and deleting a worktree does not erase which issue a branch belongs
    to). Nothing else about a work item is persisted. Binding is DETECTED from
    the git remotes and recorded as detected, always overridable.
  - **Start work.** Kind-aware: an ISSUE gets a new branch from the template, a
    PULL REQUEST gets its head branch fetched and checked out — reviewing code on
    an empty branch is the wrong action — and every branch step fails soft,
    reporting the branch it actually landed on. The prompt differs per mode for
    the same reason. `issues:start-work` timed out at the default 30s mid-clone
    while the server carried on, leaving a worktree nobody was working in; the
    call now carries a 10-minute budget.
  - **Actions logs.** Pull only FAILED jobs via the per-job endpoint (the
    run-level one is a zip of everything) and keep the TAIL, since a CI log's
    head is dependency installation; the redirect to signed storage is followed
    manually so the bearer token is never replayed at a third-party host.
    `CheckLogsModal` shows in-app exactly the bundle the chat prompt is built
    from.
  - **Chat handoff.** Both loops hand TEXT back to the client to send, because
    the chat pipeline is browser-owned and a second injection path would race it.
  - **Reuse over copy.** `diff-budget.ts` was generalised from `--cached` to a
    `DiffScope` (`rangeScope(base, head)` uses three dots, or the description
    would claim work someone else did) rather than copied. `switchToSession()`
    was added to the worktree store and `switchWorktreeContext` refactored onto
    the same barrier, rather than duplicating the swap. `MenuSurface` later
    replaced six hand-rolled popovers: every menu now animates, measures itself
    against the viewport to flip left/right and up/down, and shares one z-index —
    the comment menu used to render beneath the composer.
  - **Access.** Routes are project-access gated, not admin-gated like
    `integrations:*` — they act inside one project, the way `git:push` does.
    Every route takes an optional `projectId` (`ws/issues/context.ts`) so the
    surface is genuinely global: it has its own project picker, no longer follows
    the workspace, and only "start work" relocates you.
  - **Layout.** The More Tools menu is capped at the viewport and scrolls (nine
    entries ran off the top of small screens). The modal is one header row —
    title, account and repository together, with the repository editor as a
    popover — because two stacked strips of chrome cost a quarter of the height
    before an issue was shown. Every control on a row is a fixed h-8/h-9 rather
    than sized by its own padding, since a button sized by text and a `<select>`
    sized by the browser never line up. No action is hover-revealed, because a
    touch screen has no hover and the control simply does not exist there.
    Behaviour is a stacked modal instead of a band that pushed the list down,
    tabs moved into the list column (a full-width strip spent a whole row
    labelling a third-width column), the sidebar is 19rem, and the provider mark
    moved to the footer beside the rate limit — it is identification, not
    navigation. The empty state deep-links to the Connect dialog for the provider
    it needs via `openIntegrationConnect()`, not to the integrations list.
  - **Parity features.** Edit/delete comment (`canModify` computed server-side
    from authorship plus repo write access, because GitHub reports no per-comment
    permission); merge with the method choice restricted to what the repo allows;
    PR sub-tabs Conversation/Commits/Checks/Files changed; assignees; create
    issue; edit title and edit body (the item body renders through `CommentCard`,
    so its menu comes from one component); copy link, copy-as-markdown and
    open-in-browser on every comment; author/label/date-range filters behind one
    button and a state filter including Closed; infinite scroll with
    provider-driven `hasMore`; a `StatePicker` dropdown replacing the native
    `<select>`, which cannot show the current state or a coloured glyph; a
    project-picker filter input; a shared `RefreshButton` that spins, disables
    and holds the spinner a beat so a fast response still reads as an action;
    author names as profile links; a status badge carrying an icon and a category
    colour; "Only mine" renamed "Assigned to me"; the item timeline
    (`/issues/{n}/timeline`, unknown event kinds dropped) on a vertical rail with
    the comments; and a Files-changed view rebuilt as tree + code with an
    IntersectionObserver scroll-spy, a unified/split toggle, copy-path and a
    whole-file viewer through the shared Monaco editor.
  - **Composer.** A markdown composer with a toolbar and Write/Preview — NOT the
    Notes editor, which is contenteditable HTML with its own image store, and
    converting HTML→markdown on the way out is where fidelity goes. IMAGE UPLOAD
    IS NOT POSSIBLE: no REST endpoint attaches a file to a comment (the one
    behind drag-and-drop on github.com is private), and storing bytes in Clopen
    would produce a link broken for everyone else on the thread — so the composer
    offers image-by-URL and says so when a file is dropped.
    `frontend/utils/clipboard.ts` was added because `navigator.clipboard` does
    not exist on a non-secure origin, which is how Clopen is usually reached.
  - **Multi-account.** Now REACHABLE: the account layer always supported
    `(provider, label)`, but Add hid connected providers, which made the connect
    dialog's "only if you connect more than one" a promise the UI refused to keep
    — Add now lists every provider with an "Add another" action and a connected
    count. The inner filter pill "Integrations" is renamed "Accounts" so it no
    longer repeats its own section name.
  - **Bugs found in QA.** A PR's discussion lives on THREE endpoints and only two
    were read: `/pulls/{n}/reviews` carries the summary a reviewer submits, which
    is where review bots put their findings, so a bot's comment was simply never
    shown and looked deleted — review summaries now appear, marked read-only
    (they are edited through the reviews endpoint with different rules). The list
    raced itself: typing a filter and clearing it fired two requests and the
    slower first one could land last, leaving a partial list — every response now
    checks a generation counter before writing. `state=all` rendered a single
    row: `/issues` returns pull requests too and they are filtered out here, so
    on a busy repo the fifty most recently updated items were nearly all closed
    PRs and almost nothing survived — both list paths now go through
    `fillPage()`, which keeps pulling provider pages until the FILTERED page is
    full and reports `nextPage` so load-more resumes where the fill stopped
    rather than at `page + 1`. Relative time was off by one unit (an hour-old
    item read "1 minute ago") because the loop divided and then applied the
    previous unit's name; it is now `frontend/utils/relative-time.ts` with
    explicit thresholds and tests. The filter badge counted Open/Closed/All,
    which is a view rather than a narrowing, so an untouched list claimed one
    filter. The account Name field was read-only when reconfiguring, so a typo
    was permanent — rename was added. Copy-as-markdown copied only a comment's
    first line, and now copies the whole comment as an attributed blockquote.

**Task 3 — Deployments surface + Vercel.** Close the loop after preview. Build
the panel every deploy target plugs into — deployments for the current project
behind one interface covering list, status, build logs and open-preview — with
failing build logs streamed into the chat and the preview URL exposed directly to
the existing preview browser so an agent can drive a real deployed build. Every
action that triggers a build or changes what is live is outward-facing and must
be confirmed explicitly. Vercel is the first provider (API token). Six more
targets plug in later; none of them may add a panel.

- [x] Done
- Notes:
  - **Where it lives.** The surface is `More Tools → Deployments`, NOT a dock
    panel — same reasoning as Task 2, and `capabilities.ts` was corrected from
    the "Deployments panel" it promised.
  - **Adapter, not projector.** Like Issues it registers an ADAPTER
    (`backend/deployments/registry.ts`) plus a `registerAccountProbe`: nothing
    about a deployment is copied locally, so migration 075 creates
    `deploy_bindings` and there is no link table either — unlike an issue, a
    build leaves no worktree behind that outlives the remote record. The binding
    is a sibling of `work_bindings` rather than a generalisation: it needs
    `display_name` (a locator is an opaque `prj_8Qc…`, not a self-describing
    `owner/repo`) and `team_id`.
  - **The team lives on the BINDING, not the account.** One token reaches every
    team, so "which team" is a property of the project you picked; a credential
    field would force connecting the same token twice. Vercel therefore declares
    ONE field.
  - **Detection.** Two passes — `.vercel/project.json`, then a git-remote match
    against each target's connected repo — both recorded as detected and both
    overridable (a monorepo deploying three apps WILL be detected wrong).
  - **Vercel facts absorbed in the adapter,** so no later provider inherits them.
    Versions are per-endpoint (`/v10/projects` to list but `/v9/projects/{id}` to
    read, rollback on `/v1` and promote on `/v10` — two of these were wrong on
    first guess and were checked against the published OpenAPI document).
    `target` is `production` or NULL with no `preview` value, so only production
    filters server-side and everything else fills the page through repeated
    requests — the same bug `state=all` shipped with on the Issues list, fixed
    before shipping here and covered by `list.test.ts`. And LIVE IS NOT A STATE:
    a superseded production build is still `READY` and still `production`, so
    `targets.production.id` off the project is the only honest answer for
    `isCurrent`.
  - **Logs.** They genuinely stream (`follow=1` NDJSON), managed like container
    logs — coalesced flush, bounded ring, per-user cap, stopped when the socket
    closes and at shutdown. `deployment-state` events were being dropped with the
    other non-output events, but they are the only thing that speaks during the
    stretches where a build prints nothing, so they are now forwarded as a
    `phase` — pushed immediately rather than on the flush interval, and only on a
    change — and rendered where the "live" dot used to be. A bare dot cannot be
    told apart from a stall. Rendering goes through the app's own
    `processAnsiCodes`, the path chat tool output already takes, rather than a
    PtyKit terminal: PtyKit is an interactive emulator with a keyboard, cursor
    and resize protocol, and this is read-only text, so it would cost far more
    than the colour is worth and look unlike every other static output in Clopen.
    The log opens itself for every state — hiding the substance of the pane
    behind a "Show the build log" click to save one request was the wrong trade —
    lost its bordered container (a short log looked like an empty card) and trims
    trailing whitespace, since the provider ends its stream with blank lines and
    every streamed chunk appends its own newline.
  - **Outward-facing actions.** Rollback and promote report `pending`, never
    `done`: Vercel accepts the request and moves the aliases afterwards, and
    saying "done" would tell someone their incident was over while the old build
    still served. That `pending` is now finishable — `projectStatus` reads
    `lastAliasRequest.jobStatus`, a bounded poll follows the request to succeeded
    or failed, and a banner says traffic is mid-move; reporting `pending` and
    then never mentioning it again was honest about the moment and useless about
    the outcome. Delete is `DELETE /v13/deployments/{id}`, never offered for what
    is serving production since the provider refuses it. Every action sits behind
    one confirm dialog that names the consequence and the hostname rather than
    asking "are you sure", with the destructive styling reserved for production,
    and the surface exposes NO MCP tool, so no agent can trigger a build.
  - **Pause was added and then REMOVED,** and the reason matters more than the
    removal. It shipped as Pause/Resume (`POST /v1/projects/{id}/pause` and
    `/unpause`), target-level rather than per-build. Vercel's own endpoint
    description says pausing "blocks the active Production Deployment" — it takes
    the SITE DOWN, it does not merely stop future builds — and the confirm dialog
    written for it said the opposite: "anything already live keeps serving". A
    confirm dialog that misstates the consequence is worse than none, because it
    is the thing the user relies on. That the copy was wrong is itself evidence
    the action was not well enough understood to ship from an editor, so it is
    gone rather than reworded. `paused` survives as READ-ONLY state with a
    banner, because when someone pauses in the provider's dashboard nothing else
    explains a list that stopped growing and a site that stopped answering.
    General rule: when a capability's consequence is hard to state accurately,
    that is a reason not to offer it, not a prompt to write better copy.
  - **Creating things, not just listing them.** Redeploy needs an existing
    deployment to copy, so a project that had never been built was a dead end —
    exactly the project someone most wants to get live. `createDeployment` takes
    its `gitSource` from the project's own link, so a GitLab project is not sent
    `type: 'github'`, and note the trap: `name` alone is enough for the API to
    accept the call and CREATES a project when it does not match, so `project` is
    what pins the build to the bound target. `createProject` is prefilled from
    the local project's name and git remote and auto-bound on success, because
    "connect an account" previously left a user with nothing to point at.
    `connectRepository` closes the same kind of dead end for "this project is not
    connected to a git repository", which used to send the user to the provider's
    dashboard — exactly the read-only-window feeling this surface exists to
    remove — and is offered in the deploy dialog prefilled from the local git
    remote. NOTE THE RISK: `POST /v9/projects/{id}/link` is NOT in Vercel's
    published OpenAPI document — `PATCH /v9/projects/{id}` accepts no
    `gitRepository`, and the only documented way to get a connected project is to
    create a new one. It is what `vercel git connect` calls, so the official CLI
    exercises it, but it is the single call in this adapter with no compatibility
    promise; its failure path falls back to the documented create-a-project route
    rather than to a dead end. `deployInfo` is composed in the ROUTE from the
    adapter's answer about the remote project plus the local working tree's
    remote, with `AdapterDeployInfo = Omit<DeployInfo, 'suggestedRepo'>` keeping
    the adapter free of any notion that a Clopen project has a working tree.
  - **The git-connection pre-flight, which took four passes to get right.**
    Connect failed with "You need to add a Login Connection to your GitHub
    account first": Vercel requires the ACCOUNT to hold a git login connection
    before any project can be linked, and that is an OAuth flow on vercel.com
    which NO API token can stand in for — the one prerequisite this surface can
    detect but never satisfy. `repositoryAccess()` asks `GET
    /v1/integrations/git-namespaces` before the button is offered. It first
    answered a BOOLEAN, so the case it could not read had to pretend and returned
    "can connect", which put the button back on screen and let the exact failure
    the check exists to prevent arrive as a toast; it is now three states —
    `ready` enables the button, `blocked` DISABLES it and offers a link out
    instead, `unknown` allows the attempt but says so. `teamId` was also being
    sent to that endpoint, which REJECTS it with a 400 — namespaces belong to the
    signed-in user, not to a team, and the parameter list never included it — so
    every readiness check became an error, surfaced as `unknown`, and let the
    button through: the whole pre-flight was decoration. Locked by a test
    asserting the URL carries no `teamId`. Finally the inference itself was
    wrong: an account with GitHub connected and working was told it had no
    connection, because the check read an EMPTY namespaces list as absence and
    disabled the button on the strength of it — conflating a Vercel "Login
    Connection" (how you sign in) with a GitHub App installation (what lets
    Vercel read repositories), which an account can have one of without the
    other. The rule now: only a POSITIVE match is confident. Owner present and
    unrestricted → `ready`; owner present but RESTRICTED pending an owner's
    approval is named as that, not flattened into a failure; owner absent from a
    NON-EMPTY list → `blocked`, which is informative because the app is installed
    somewhere just not there; an empty list → `unknown`, never blocked, because
    this endpoint's silence can equally mean a token that cannot read
    integrations. A wrapped namespaces response is tolerated rather than read as
    "none", since that would be a confident `blocked` built on a parsing mistake.
    The raw Vercel error is still rewritten to carry the address the user needs,
    because the pre-check can be skipped or go stale. The action URL is the
    GitHub App install page, not the login-connections page, since repository
    access is what is actually missing, and a "Check again" re-reads without
    closing instead of a button that cannot win. `repositoryAccess` is UNBOUND so
    the new-project dialog can ask it too — that form was offering "Connect
    acme/web" ticked by default on accounts that cannot reach acme, the same
    can't-win button in a second place. GENERAL LESSON for later providers: a
    pre-flight check may enable confidently and warn freely, but it must not
    DISABLE on an inference it cannot verify — being wrong there contradicts what
    the user can see on their own screen.
  - **An absent signal is not a negative one** — the same shape of mistake twice.
    `isRollbackCandidate` was read as `raw.isRollbackCandidate === true`, which
    collapsed "the provider says no" and "the provider did not say" into one
    answer, so Roll back never appeared on any listing that omits the field. It
    is now `boolean | null`, and the UI trusts a stated value but falls back to
    what is knowable (a ready production build that is not live) when there is
    none.
  - **Where errors belong.** Provider failures in these dialogs render INSIDE
    them (`InlineError`, which splits URLs out of the message and renders them as
    real links — never `{@html}` on a third-party string) rather than as a toast:
    these messages end in "set it up at <url>", and a toast removes the URL
    before it can be clicked. The general rule for later surfaces: anything the
    user must ACT on belongs in the surface that caused it, and only outcomes
    they merely need to KNOW belong in a toast.
  - **Timeouts.** Wrong in TWO layers, and the inner one was the real culprit —
    the Vercel client aborted at 20s before the 30s WebSocket budget was reached,
    so a link that Vercel completed server-side was reported as a client timeout.
    Reads keep 20s; mutations get 120s, and the slow WS calls get a 3-minute
    budget (a long budget, NOT unbounded — an unbounded call cannot tell "still
    working" from "this socket will never answer").
  - **Preview integration, then its removal.** Open-in-preview needed a new
    generic `openUrlInPreview()`, which creates the tab and lets BrowserPreview's
    existing adopt-a-URL-with-no-session effect launch it — calling
    `launchBrowser` here would open a second backend tab for one link. That
    uncovered a REAL RACE worth knowing about: docks hydrate AFTER the reveal and
    the project switch does not await them, so `await setCurrentProject(...)`
    returns while the preview dock is still rebuilding and would wipe the tab
    just created. Fixed with an exported `whenWorkspaceSettled()` — a no-op when
    no switch is in flight — which every future "relocate then act on a dock"
    path needs. "Open in preview" was later REMOVED at the user's request; Task
    3's spec named that loop explicitly, so this is a deliberate deviation.
    `openUrlInPreview()` went with it rather than shipping dead code, but
    `whenWorkspaceSettled()` stays because the send-log-to-chat relocation still
    needs it.
  - **Chat handoff.** Both loops hand TEXT back to the client to send, for the
    reason Task 2 found.
  - **Deliberately out of scope.** Webhooks (Task 7 is the first consumer, and a
    local Clopen has no public URL to register), env-var management, and
    `agent-tools` — Vercel's MCP server uses its own OAuth, a different audience
    from this REST token, so declaring it would mean projecting a row this
    credential cannot fill.
  - **Shared components.** `MenuSurface`, `RefreshButton` and `ProviderMark` were
    PROMOTED from `components/work/` to `components/common/` rather than
    duplicated; `Button` gained the `danger` variant every destructive confirm in
    the app had been hand-rolling; and spinners moved INSIDE their buttons via a
    shared `ActionButton`, since a spinner beside a row of four actions cannot
    say which one is running.
  - **Dialogs.** The new ones passed no `title` to `Modal`, which renders an
    empty header band containing a stray close button, and added their own
    padding on top of the body padding `Modal` already supplies — the house
    pattern is `<Modal title=… size=…>` with an unpadded child, as `MergeDialog`
    does. Deploy and New Project then became ONE dialog with tabs and the header
    lost its bare "+": two buttons both about deploying made the user choose
    before knowing what either did, so `DeployDialog`/`NewProjectModal` are now
    `DeployPanel`/`NewProjectPanel` inside `DeployModal`, and the tab strip hides
    itself when only one tab applies. The deploy dialog caches its readiness
    answer per (project, account) and shows a shaped skeleton instead of a bare
    spinner — three provider requests on every open was most of why it felt slow
    — and offers the LOCALLY CHECKED-OUT branch alongside the production one,
    since the branch in front of you is at least as likely to be the one you
    meant. The modal is 72rem, not 90vw: the surface never needed the whole
    screen.
  - **List and detail layout.** The auto-refresh and refresh controls moved off
    the environment-chip row (a fourth chip ran into them) onto the search row
    they act upon, the branch filter's glyph is a search icon, and list
    timestamps use a new `shortRelativeTime` — the long form wrapped on a row
    that already carries a state badge, a branch and a commit. Detail gained the
    Domains list (a production build answers on three hostnames and which one you
    want depends on the task), copy buttons for commit and domains, and the
    trigger source; the list column went from 22rem to 17rem, and the newest
    deployment is selected automatically because an empty right-hand pane reads
    as a panel that failed to load. Domains are their own component with an icon
    PER KIND: the project domain follows what is live, the branch alias follows
    the newest build of that branch, and the build URL pins this exact build, so
    rendering all three with one globe made them look like duplicates of one
    address. Facts and domains sit side by side rather than stacked, which was
    leaving half the pane blank while pushing the log down. Detail-pane text
    moved off 11px (fine for labels, below comfortable for content), and the
    footer's empty left half names the provider and account owner, as the Issues
    footer does.
  - **Bugs found in QA.** The scoped and default project listings OVERLAP —
    `/v10/projects` with no `teamId` returns the token's DEFAULT scope, which for
    anyone in a team is that team, so the same project arrived twice and crashed
    the keyed picker. De-duplicating it is not the whole fix: only the
    team-scoped copy carries the `teamId` that every later call needs, so a
    team-scoped entry must always win over an unscoped one, or the picker looks
    right and everything behind it 404s. The fill loop could repeat a row the
    same way when a build landed mid-fetch and shifted the timestamp window. And
    the empty state said "nothing matches this environment filter" with no filter
    set, on a target that had simply never been deployed — it now distinguishes
    never deployed / filtered out / nothing yet, and each says something
    different. Three things declared in the model but never surfaced were also
    closed: the branch filter, the auto-refresh toggle, and the `custom`
    environment chip.
  - **Status.** Nothing here had been run against a real Vercel token when it
    first shipped — the endpoint set, the alias ordering and the log-stream shape
    were verified against documentation and mocked tests only. Every pass
    recorded above came from running it for real, the seventh onwards after a
    successful end-to-end deploy.

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

- [x] Done
- Notes:
  - **The projection contract had to widen, and that is the load-bearing
    change.** `integration_projections` was keyed `(account, capability,
    target_kind)`, which encoded an assumption true only of the first capability
    shipped: an account owns exactly ONE row. One Supabase personal access token
    reaches every project in every organisation its user belongs to, so "which
    database" is a choice made as many times as the user has databases. The
    alternative — one account per Supabase project — is the mistake `Task 3`
    refused for Vercel teams, since it makes a user with production and staging
    paste the same token twice and rotate it in two places. So migration 077
    widens the key with `target_id`, `Projector.project()` returns a LIST, and
    `reproject()` diffs per TARGET rather than per capability: dropping one link
    of two must release exactly one row, because releasing by capability would
    tear the survivor down and re-adopt it, snapshotting our own credential on
    the way. `mcp-projector` returns a single-element array and behaves exactly
    as before. The pass also now computes every wanted projection BEFORE
    releasing anything, so a provider error leaves the previous state intact
    rather than half-released.
  - **A link is where everything per-database lives.** New table
    `integration_db_links` `(account_id, remote_ref, label, driver, mode,
    secrets, config_json)`, the database sibling of `deploy_bindings`. The
    Postgres password lives HERE, sealed (`secret-columns` gained the table),
    because no Supabase API can read it back — `/database/password` is
    PATCH-only by design — and because a projection must be rebuildable from
    account + link alone, so a release-then-reproject cannot silently lose it.
  - **Resolving an endpoint is async; projecting is not.** `reproject()` runs
    inside account mutations, and working out a pooled host is a network call,
    so the adapter's `resolveEndpoint()` is called ONCE at link time and its
    answer is stored on the link. The projector then only copies fields, which
    is also why a token rotation re-projects instantly instead of making every
    account save wait on a third-party API.
  - **Adoption identity includes the USERNAME, and a test caught that it must.**
    Every Supabase project in one region answers on the same pooler host, the
    same port and a database called `postgres`; `postgres.<ref>` is the only
    part that says which project. Matching on host+port+database made a second
    linked project adopt the first one's row, so an account with two projects
    projected one connection. `projector.test.ts` covers it, plus
    release-one-of-two, adopt-and-hand-back-with-the-user's-password, and
    re-projecting not re-snapshotting our own credential.
  - **Verified against the published OpenAPI document** at
    `api.supabase.com/api/v1-json`, not from memory, after `Task 3`'s endpoint
    guesses. Used: `/v1/projects`, `/v1/projects/{ref}`,
    `/config/database/pooler`, `/types/typescript`, `/functions` + `/body`,
    `/advisors/security`. NOT used: `POST /database/query`, which exists and is
    marked beta — everything inside the database goes over SQL instead.
  - **The rule that shapes the whole surface: anything inside the database is
    read over SQL through the connection DB Client already holds; only what
    lives outside it goes to the Management API.** Policies
    (`pg_policies`/`pg_policy`), applied migrations
    (`supabase_migrations.schema_migrations`), buckets (`storage.buckets`) and
    users (`auth.users`) are all Postgres, so five of the six tabs work for a
    `supabase start` stack with no token at all. Only edge functions, generated
    types and the advisor need an account, and each says so rather than
    rendering empty. `storage.buckets` over SQL is also strictly better than the
    API's bucket listing: it carries the size limit and allowed MIME types,
    which the API's does not.
  - **Auth users and storage objects are read-only, deliberately.** Both write
    paths need the SERVICE ROLE key — a key that bypasses every policy in the
    database — and storing one to render a list would be a poor trade.
    `auth.users` answers the same question with the credential already present,
    and `banned_until` is read as a TIMESTAMP rather than a flag, since an
    expired ban is not a ban and rendering it as one accuses the wrong accounts.
  - **Applying a migration goes over SQL, in one transaction.** Not `POST
    /database/migrations`: the SQL path is what `supabase db push` does, it also
    works for a local stack, and one implementation beats two. The whole file is
    sent as ONE parameterless statement — Bun's SQL uses the simple protocol
    there, which is what allows several statements — because splitting it would
    have to understand dollar-quoted function bodies, and getting that wrong
    truncates a function mid-definition. The already-applied guard sits INSIDE
    the transaction, or two people applying at once both see it pending and the
    second one's SQL runs before the primary key rejects it. Known limit, passed
    through unrewritten: `CREATE INDEX CONCURRENTLY` cannot run in a
    transaction.
  - **Supabase's connection modes are not interchangeable, and the default is
    not a question to ask.** Pooler session mode is correct for this client in
    every case the other two are not: a direct connection is IPv6-only on
    projects created since 2024 without the IPv4 add-on (a DNS-shaped failure
    that says nothing about the cause), and transaction mode does not support
    prepared statements, which `Bun.sql` uses. The dialog first offered all
    three as radio buttons with a paragraph each, and that was WRONG — it asked
    the user to choose between one right answer and two ways to fail, before
    they had connected anything. The default is now chosen silently, the other
    two are marked `isAdvanced` and folded behind a "Change" link, and every
    helper line was cut to one clause. The provider blurb went with them: it
    repeated the password field's own help almost word for word, which is how a
    form ends up saying the same thing twice. `sslMode` is `require` rather than
    `verify-full`: Supabase's certificate comes from its own CA, so verifying
    without shipping that CA would refuse every connection.
  - **Creating a database, not only listing them.** An account that reaches no
    projects — or a user who wants a fresh one — was a dead end, which is the
    same gap `Task 3` closed for Vercel. `POST /v1/projects` needs `{db_pass,
    name, organization_slug}` plus a region, so the adapter gained an optional
    `createOptions`/`createDatabase` pair and the dialog gained a New database
    form beside the picker — one dialog with a mode switch, not a second modal.
    The payoff is that the one awkward step disappears: CLOPEN GENERATES THE
    PASSWORD, so a project it created is one there is nothing to type for. That
    makes the ORDER load-bearing. The link row is written FIRST, carrying the
    generated secret, and the endpoint is resolved afterwards — every other
    ordering has a window where a slow provision, a dropped socket or a restart
    leaves a real database whose password nothing holds and only a reset can
    recover. The readiness wait is bounded at three minutes and failing it is
    NOT an error: the database exists, the link exists, and saving the link is
    the retry (`update()` re-resolves whenever a link has no endpoint, so there
    is no second button to find). The WS call carries a four-minute budget for
    the reason `issues:start-work` needed ten: at the default 30s the socket
    gives up while the server carries on, and the user is told it failed while a
    real project quietly finishes provisioning. `region_selection` is used
    rather than the `region` string the API document marks deprecated, and the
    region list is hard-coded from that document rather than read from
    `/available-regions`, which is beta, needs an organisation slug and answers
    with a nested recommendation structure. `DbRemoteDatabase` also gained
    `isReady`, decided by the ADAPTER: a paused or still-starting project looks
    like an ordinary row and refuses every connection, so the picker now
    disables it and names its state.
  - **Contextual connect is embedded, not deep-linked.** `LinkDatabaseModal`
    mounts the hub's own `ConnectAccountModal` — whose header comment already
    promised this — so a user in DB Client never lands in Settings. It also
    serves editing a link, and the local-stack path needs no account at all:
    `supabase/config.toml` is parsed by a small SECTION-AWARE reader rather than
    a TOML dependency, because `port` appears under `[api]`, `[db]`,
    `[db.pooler]` and `[studio]` and a flat scan reports the API port as the
    database's (`local.test.ts` locks that down).
  - **Read-only means the server enforces it, not just the form.** A managed
    connection renders with an ownership strip and disabled fields, but
    `db-client:update` also drops everything except name and colour, and
    `db-client:delete` refuses outright and points at unlinking — deleting the
    row would leave the account owning a connection that no longer exists and
    the next re-projection would recreate it. Every link mutation also RELEASES
    the live driver adapter afterwards: `connectionManager` holds an open
    connection per row, so rotating a password rewrote the row while every query
    kept using the old credential until the pool happened to sweep it.
  - **Visibility is admin-only,** by decision: a projected row is created with
    no owner, which in db-client's existing access model means admins see it and
    members do not, matching who can connect an account. Treating a null owner
    as "shared" would also have exposed pre-migration-035 rows that have been
    admin-only all along. Members keep their own hand-typed connections
    unchanged, and the local-stack adoption path is member-visible because it
    creates an ordinary user-owned connection.
  - **Where things live.** One entry in DB Client's view strip, not six: that
    row already shares its width with the open-table tabs, so the six Supabase
    tabs live inside `SupabasePanel`. `InlineError` was PROMOTED from
    `components/deployments/` to `components/common/display/` rather than
    duplicated, following what `Task 3` did with `MenuSurface` and
    `ProviderMark`.
  - **A crash found while reviewing the hub, not the new code.**
    `IntegrationDetail`'s projection list was keyed `capability + targetKind`,
    which is no longer unique once one capability owns two rows — Svelte throws
    on duplicate keys. It now groups by capability and reports counts.
  - **Deliberately out of scope.** Deploying an edge function (bundling is the
    CLI's job), listing storage objects and mutating auth users (both need the
    service-role key), and `supabase db diff` for schema drift (needs the CLI
    and a shadow database). Supabase branching is left to `Task 5`, whose shape
    it is. NO `agent-tools`, even though Supabase's MCP server takes exactly
    this token: that server is scoped with `--project-ref` to ONE project and an
    account here can hold several, so there is no honest single row to project.
    Reviewing that decision is what produced `Task 20`: the right answer is not
    the vendor's MCP but ONE internal server over DB Client, because an agent
    today cannot query any database at all — local Postgres and SQLite included
    — and a per-vendor server would leave every one of those out while adding a
    second path to the databases it does cover.
  - **Scoped tokens are the thing to know about this provider, and the prefix
    gives them away.** Supabase is rolling out personal access tokens that carry
    only the permissions you tick, prefixed `sbp_fc` where a classic full-access
    token is plain `sbp_`. That is what the account in QA had, and it explains
    every symptom at once: it could list projects and not read organisations, so
    `/v1/organizations` answered `[]` and `POST /v1/projects` answered a bare
    "Forbidden" that named nothing. `tokenKindOf()` now reads that prefix and a
    403 is rewritten to say which permission the call needed — the same trick
    `Task 2` used on GitHub's fine-grained token prefix, for the same reason:
    the provider's own word for it is undiagnosable. The credential help names
    the permissions instead of describing the screen (Projects account-wide
    Read, Project Settings Read, Database Read-write, plus Organizations Read
    and Organization Projects Read-write to create), because a missing scope
    fails at the moment the feature is reached rather than at connect. Verified
    end to end against a live scoped token: the 403 now reads "this call needs
    Organization Settings (Read)".
  - **Creating the organisation, not just pointing at the dashboard — and then
    trusting that we did.** An account whose token reaches no organisation
    cannot create a database anywhere, and answering that with "go to
    supabase.com" is the read-only-window feeling this surface exists to remove.
    `POST /v1/organizations` takes a name and nothing else, so the adapter
    contract gained an optional `createGroup`, kept separate from
    `createDatabase` because an organisation is a BILLING entity and the dialog
    says so. The first version then RE-READ the options to verify what it had
    just made, which looked rigorous and was wrong: reading and creating are
    SEPARATE permissions, and a token that had successfully created an
    organisation could not read it back, so the new organisation failed
    verification, vanished from the list, and creating it again answered "you
    are already a member of an organisation named…". Having just created
    something is the strongest evidence available that the token can act in it;
    the result is now used directly.
  - **Offer the unverifiable, mark it, do not hide it.** The same three facts
    forced a third position on the picker itself. `/v1/organizations` can answer
    `[]` for a token that plainly reaches projects; a project's
    `organization_slug` names where that project lives rather than somewhere the
    token may act, so offering those unmarked produced a 403 after the form was
    filled in; but dropping every unverifiable candidate removed a capability
    that may well work, which left the whole feature permanently unreachable
    behind a warning. So a derived organisation is checked, and when the check
    cannot confirm it the option is still offered carrying `isUnverified` — the
    form warns that creating may be refused and that the error will name the
    missing permission. `Task 3`'s rule was that a pre-flight must not disable
    on an inference it cannot verify; the corollary learned here is that it must
    not ENABLE silently either. Marking is the third state both halves were
    missing.
  - **Anything a user manages needs a place that exists before it is needed.**
    Creating an organisation lived inside the create-a-database form's EMPTY
    STATE — reachable only once things had gone wrong, and invisible the moment
    they had not, so a user who had seen it once could not find it again. The
    dialog is now two peer tabs, Databases and Organisations, and the second
    lists what the account can reach, creates one, and states plainly that
    deleting one is not possible: `/v1/organizations/{slug}` is GET-only, so no
    permission would help and a missing button would read as an oversight.
  - **The account strip owns the account.** It gained an Edit that opens the
    SAME connect dialog Settings uses, in reconfigure mode — a contextual entry
    point that then sends you to Settings to change a token was only ever half
    an entry point. A credential change invalidates everything derived from the
    old one, so the options, the database list and the health probe are all
    discarded and re-fetched rather than left to look correct.
  - **"UNKNOWN" was a question nobody had asked.** An account's status is only
    ever written by a probe, and nothing probes on connect, so an account
    connected from this dialog reported UNKNOWN indefinitely and read as a fault
    — including right after the user had fixed their token. The dialog now
    probes an unknown account through the hub's own `integrations:health` route
    rather than inventing a second notion of working, and renders that state as
    a neutral "checking…" while it runs.
  - **Deleting a database, which is not unlinking.** `DELETE /v1/projects/{ref}`
    exists, so the row gained the action — behind a confirm that NAMES the
    database and says what the other button does, because unlink sits beside it,
    looks similar and leaves the data alone. The link is dropped before the
    remote call: a failed delete then costs a link that can be recreated rather
    than leaving a projection pointing at something that no longer exists.
  - **Copy that names one action.** The empty-organisation notice listed three
    ways out in one paragraph and ended on "link it here", which named no action
    available from where the reader was standing. It is now one sentence with
    one instruction. The Create button beside the name field was also taller
    than the input next to it, because a `Button`'s own padding sizes it while
    an input is sized by its text — both are `h-9` now, the same fix the Issues
    modal's rows needed.
  - **A form that has to fetch before it can be drawn needs a skeleton.**
    Clicking New database blanked the dialog and then filled it a second later,
    because the render guard required the fetched options and there was nothing
    to show without them. Empty space reads as a glitch, not as work. It now
    draws a skeleton shaped like the form that is coming — which says what is
    loading, where a bare spinner would not.
  - **The organisation picker was empty, and the first fix made it worse.** `GET
    /v1/organizations` answers `[]` WITH A 200 for a token that plainly reaches
    projects — confirmed against a live account, alongside a 403 on
    `/v1/organizations/{slug}` for the very organisation that account's project
    lives in. So the token can see a project without being able to act on its
    organisation at all. The first fix derived the organisation from each
    project's `organization_slug` and offered it, which turned a disabled button
    into something worse: a confident dropdown entry whose only possible outcome
    was a 403 AFTER the user had filled in the form and pressed Create. `Task 3`
    recorded that a pre-flight must not DISABLE on an inference it cannot
    verify; this is the mirror image, and it must not ENABLE on one either. A
    derived candidate is now only offered once `GET /v1/organizations/{slug}`
    has answered for it — the same permission the create call needs — and when
    nothing survives, the form is not rendered at all. There is no point
    collecting a name and a region for a request that cannot succeed, so the
    dialog states the two real causes instead: the token's user belongs to no
    organisation, or belongs to one without permission to manage it.
  - **A third-party footer on the modal, not in the tab.** Once a panel shows
    data living in someone else's service, "which account am I looking through"
    and "how much budget is left" stop being answerable from anything on screen
    — the same gap the Issues and Deployments footers close. It sits on the DB
    Client modal rather than inside the Supabase panel, because the question is
    just as live while browsing a table, which is most of the time, and because
    a later provider inherits it without a panel of its own. Identity comes from
    `managedBy`, which every provider has, and is dropped when the account label
    merely repeats the provider name — a single account is labelled "Supabase",
    so the row first read "Supabase · Supabase". The quota comes from headers
    Supabase does not document but sends on every response: `x-ratelimit-limit:
    120` (per MINUTE), `-remaining`, and `-reset`. THAT RESET IS A DURATION IN
    SECONDS, not an epoch — GitHub and Vercel both send an epoch there, and
    reading this one the same way dated every reset to 1970. Readings are kept
    PER TOKEN, since the limit is counted per Supabase user and one global
    figure would bill one account's usage to another. The footer showed nothing
    at first because resolving a connection's context touches no API and the
    default tab is pure SQL, so an account with no reading yet now takes exactly
    one, once per process. Absent still means NOT REPORTED rather than zero:
    with no figure the row names what it does know, such as a local stack having
    no API quota at all.
  - **Bugs found in QA.** The first connect hit `effect_update_depth_exceeded`
    and drove the account straight into a Supabase rate limit, and the cause is
    worth stating as a rule because three places had it: EVERY ONE OF THESE
    FETCHES WRITES ITS OWN CELL — `loading: true` goes in synchronously — SO AN
    EFFECT THAT DECIDES WHETHER TO FETCH BY READING THAT CELL SUBSCRIBES TO WHAT
    IT IS ABOUT TO CHANGE AND RE-RUNS ITSELF FOREVER. The database picker
    checked `remoteFor(id).data`, which is never set before the first response,
    so it fired a request per frame. The connection-context effect was worse and
    had not been noticed: a plain Postgres connection resolves to `null`, so its
    `!== null` guard was never satisfied and it looped for every non-Supabase
    row in the list. The five Supabase tabs had the same shape conditionally —
    they checked `!data && !loading`, which is exactly the state a FAILED fetch
    leaves behind, so a provider outage turned one mounted tab into an unbounded
    retry. The fix is that "have I asked yet" is now kept OUT of the reactive
    graph entirely, in a plain `Set` in the store, behind `ensure*` methods an
    effect calls with an id and nothing else; the un-prefixed methods stay the
    forced path for the refresh controls and clear the guard. A failed fetch
    deliberately does NOT clear it, or a provider that is down is hammered by
    whatever is on screen. Two smaller ones fell out of the same review: the
    link dialog's seed effect read the account list reactively, so connecting an
    account from inside it reloaded that list, re-ran the seed and silently
    un-chose the account `onConnected` had just chosen (the read is now
    `untrack`ed), and `context` now distinguishes a MISSING key from `null` —
    unasked versus known-not-Supabase — because collapsing them bounced a
    restored Supabase tab to Overview on every open.
  - **Status.** Connecting an account, listing projects, linking, the
    create-options path and the rate-limit headers have all been exercised
    against a real Supabase token — the last three by running the adapter
    directly against the live account rather than by reading documentation,
    which is how the 403 and the 1970 timestamp were found. Creating a project
    has NOT been run end to end: the only token available cannot reach an
    organisation, so the request it would make is unproven. Also still
    unverified: whether `/config/database/pooler` returns a `connection_string`
    carrying a real password (it is treated as a template and ignored either
    way), and whether `auth.users.raw_app_meta_data -> 'providers'` arrives as
    an array or a string through `Bun.sql`.

**Task 5 — Worktree database branching + Neon.** Pair database branching with the
worktree manager Clopen already has. Creating a worktree optionally creates a
branch on the connected account and injects its connection string into that
worktree's environment; deleting the worktree deletes the branch. This gives
every agent an isolated database to migrate against without touching dev data.
Expose it as a worktree-lifecycle capability other providers implement rather
than as Neon-specific code — Turso lands on the same shape. Opt-in per project
and fail soft: a provider outage must never block worktree creation, and an
orphaned remote branch must be reported rather than silently leaked.

- [x] Done
- Notes:
  - **One credential, TWO capabilities, and that is the shape this entry
    proves.** Neon declares `database` AND `worktree-branching` from one API
    key, so it is both a DB Client provider like Supabase and the first
    lifecycle provider. Two accounts would have meant pasting one key twice and
    rotating it in two places — the mistake `Task 3` refused for Vercel teams.
    It works only because migration 077 widened the projection key with
    `target_id`: both capabilities write `db_client_connections` rows for the
    same account, and releasing by capability alone would tear down the other's
    on every pass. `projections/types.ts`, which promised `worktree-branching`
    as future work, now states that rule instead. `registerAccountProbe` also
    had to become a LIST per provider — it was a map, so whichever module loaded
    last silently replaced the other's probe, and an account using only the
    losing capability would have reported on one it had switched off.
  - **Adapter AND projector, not one or the other.** `backend/worktrees/branching/`
    registers an adapter (`registry.ts`, the sibling of the Issues, Deployments
    and DB Client registries) because a provider has to be asked to cut a branch,
    and a projector because a branch IS a real database worth looking at —
    without it a user could see that their agent had run migrations and have no
    way to inspect what those migrations did. The projected row is deliberately
    NOT an `integration_db_links` row even though the shape matches: a link is
    user-managed and carries an Unlink button, and unlinking would tear the
    connection out from under a live worktree while leaving the branch running.
    Nothing is ever ADOPTED here either — a host the provider minted seconds ago
    cannot have been typed in by anyone — so release is always a delete and
    there is no snapshot to restore.
  - **The dotenv write, and the one thing it refuses.** A Clopen worktree is a
    FILE COPY, so it already carries the project's `.env` pointing at the
    database this feature exists to protect. The fix is therefore a marked block
    (`# >>> clopen:worktree-database >>>`) appended to a dotenv file inside the
    worktree: one write reaches all nine engines, the PtyKit terminal, a dev
    server from the Ports manager and the user's own shell, where process-env
    injection would have needed an upstream PtyKit change (`CreateSessionOptions`
    has no `env` field at all) plus nine adapter edits and still missed the last
    one. Appended at the END because every dotenv reader takes the LAST
    assignment of a repeated key, which is how it beats the copy the worktree
    inherited without editing the user's own line. THE REFUSAL IS THE
    LOAD-BEARING PART: a dotenv file git TRACKS is never written, because
    `hashTree` lists files with `git ls-files -co --exclude-standard` — an
    ignored file is invisible to the merge plan, a tracked one is carried to the
    main project by "Apply to Main", overwriting the real connection string with
    one whose database deleting that worktree destroys. An unknown answer from
    git counts as tracked, since that failure is one-directional.
  - **Which dotenv file is ASKED, not guessed.** Next.js and Vite read
    `.env.local` in preference to `.env`, so a project with both has exactly one
    right answer and picking the other produces the worst outcome available: the
    branch is created, the variable is written, and nothing reads it. The setup
    dialog lists the files that exist (most-precedent first, templates excluded —
    writing a live password into a committed `.env.example` is the opposite of
    the rule above) and always offers `.env` and `.env.local` as creatable, so a
    project that has never needed one is not a dead end.
  - **Ordering, in both directions.** The branch is cut AFTER the clone
    succeeds: the clone is the step that genuinely fails, and cutting first would
    leak a branch at the provider on every failed create. The row is written
    BEFORE the dotenv file is touched, so a crash in between leaves a branch that
    is tracked and deletable — which is also why `env_status` defaults to
    `failed` rather than `written`: a process that died there genuinely wrote
    nothing, so the default is the honest reading of that moment rather than a
    placeholder. On delete the branch goes BEFORE the directory, and a failure
    there does NOT stop the deletion — refusing to delete a worktree because a
    third party is down would trap the user in a state they cannot leave.
  - **`worktree_id` is `ON DELETE SET NULL`, never a cascade, and that single
    choice is what makes leak reporting possible.** When the remote delete fails
    the branch is still there costing money, and a cascade would delete the only
    record of it in the same breath — a leak both silent and unrecoverable.
    `worktree_id IS NULL` is therefore the definition of an orphan. The sweep has
    a second half for the crash window between "the provider created it" and "the
    row was written": branch names are deterministic and prefixed
    (`clopen/<project>/<worktree>`) because no provider here lets a client set
    metadata on a branch — Neon's `creation_source` is read-only — so the name is
    the entire evidence. Reported, never auto-deleted, and "no untracked
    branches" is kept distinct from "the sweep could not run".
  - **`/projects` IS ORGANISATION-SCOPED, and getting that wrong took down every
    read path.** The endpoint reads like an account-wide listing and is not —
    the document calls it "a list of projects for the specified organization" —
    so the first version sent no `org_id` at all, on the reading that a personal
    key answers with its user's projects. Against a real key every call answered
    `400 org_id is required, you can find it on your organization settings
    page`: the database picker, the branching parent list, the health probe (so
    both accounts sat on a red ERROR badge) and the readiness poll of a project
    that had just been created successfully. The fix is
    `GET /users/me/organizations`, which is the ONE endpoint answering for both
    kinds of Neon key — the document is explicit that an organisation- or
    project-scoped key, tied to no user at all, gets back the organisation that
    owns it — and then one `/projects?org_id=` per organisation, merged and
    de-duplicated. That also closes a quieter bug the 400 was hiding: a key
    belonging to two organisations would only ever have seen one of them. The
    lookup is memoised for a minute per key, because `listNeonProjects` sits on
    the readiness poll's path and would otherwise double its request count every
    five seconds for three minutes. A partial failure returns what it got and
    logs the rest, but a TOTAL failure rethrows rather than answering with an
    empty list — "an absent signal is not a negative one", `Task 3`'s rule,
    applied to a list this time. Locked down by `list.test.ts`, whose first
    assertion is simply that no request for `/projects` goes out without a
    scope. Two things fell out of the same fix: the create form's synthetic
    "Personal account" option (an empty `org_id`) is GONE, since it would create
    a project this adapter then could not list, and Neon reports a personal
    account as an organisation of its own anyway; and a 400 is now classified
    `config` rather than `error`, so the hub's strip says there is something to
    fix rather than showing a red failure with no guidance. Neon's own wording
    is REWRITTEN rather than repeated — by the time it surfaces it is our
    organisation lookup that came back empty, so "you can find it on your
    organization settings page" would send the user to a page with nothing on
    it. Same trick as `Task 2` on GitHub's 404 and `Task 4` on Supabase's 403.
  - **Two connection shapes, conflated, and every link failed on it.** Neon has
    `ConnectionDetails` — `{connection_uri, connection_parameters}`, the items of
    the `connection_uris[]` array on a CREATE response — and
    `ConnectionURIResponse`, which is what `GET /connection_uri` answers with and
    is `{uri}`, ONE bare string with no host, role or database field at all. The
    first version typed the second as the first, so every discrete field read
    back `undefined` and both linking a project and creating one died on "Neon
    did not report a host for branch …". The endpoint's answer is now PARSED, and
    kept verbatim rather than rebuilt: it already reflects the `pooled` parameter
    it was asked for, and it may carry options (`channel_binding`) a rebuild
    would silently drop. The create-response reader keeps its own path, with one
    added rule — given only the string it will answer a DIRECT request and
    refuse a POOLED one, because the string names the direct host and deriving
    the pooler hostname would mean guessing at a naming convention; refusing
    sends the caller to `GET /connection_uri?pooled=true`, which is
    authoritative. `reveal_password` survives as the second fallback for a URI
    that carries no password. The two shapes are now declared as two types in
    `api-types.ts`, each naming the other, so the next reader cannot repeat it.
  - **The dialog was naming the wrong vendor, in three places.** DB Client's link
    dialog had Supabase written into its own markup: a Neon user saw "Connect
    Supabase…" directly under their selected Neon account, a hint saying where
    *Supabase* tokens live, and — on the organisations tab — "Rename or delete an
    organisation in Supabase's dashboard". All three are provider-driven now.
    `DbProviderInfo` gained `docsUrl`, filled from the INTEGRATION registry
    rather than declared a second time in the adapter, so the credential hint
    points at the right page per provider. `DbProviderCreateOptions` gained
    `groupManagementNotice`, because which of create/rename/delete exist really
    is per-vendor: Supabase has no PATCH or DELETE for an organisation, Neon has
    no POST either. The connect entries moved under an "Add another provider"
    heading, since a dashed row sitting directly beneath the chosen account read
    as part of that selection. Two smaller ones from the same screenshots: Neon's
    `groupLabel` went back to `Organisation` (it was `Owner`, left over from the
    synthetic personal entry, so the tab said "Owners" while the copy under it
    said "organisation"), and the database rows were printing the literal word
    "Organisation" as a fallback for a missing `org_name` — which made two
    projects in different organisations indistinguishable, the exact question
    that field exists to answer. It now resolves the real name from the
    organisation list already in hand, and shows nothing when it cannot.
  - **Neon facts, read from the OpenAPI document** at
    `dfv3qgd2ykmrx.cloudfront.net/api_spec/release/v2.json`, not from memory.
    `endpoints: [{type:'read_write'}]` is MANDATORY on create — without it the
    branch exists, costs storage and refuses every connection. `connection_uris`
    in the response is OPTIONAL: the document states a branch cut from a parent
    with more than one role or database comes back without one, so the fallback
    to `GET /connection_uri` (which insists on `database_name` AND `role_name`)
    is a correctness requirement, not an optimisation — and it is the
    established projects, the ones this feature most helps, that take it.
    `connection_parameters` carries `host` and `pooler_host` together, so pooled
    versus direct is a field choice rather than a second request, but the URI is
    REBUILT from the parts because `connection_uri` always names the direct host
    and would contradict the fields beside it. `expires_at` would have been a
    perfect leak guard and is deliberately unused: EARLY ACCESS ONLY, so sending
    it fails for most accounts. Direct is the silent default and pooled the
    advanced escape hatch — the REVERSE of Supabase, because Neon's pooler is
    PgBouncer in transaction mode (no prepared statements, which `Bun.sql` uses)
    while its direct host is reachable over IPv4, so the pooler-or-unreachable
    trade Supabase forced does not arise here.
  - **Linking a Neon database asks for NO password, which needed a contract
    change.** `GET /branches/{id}/roles/{role}/reveal_password` exists, so
    `secretFields` is empty — the opposite of Supabase, whose
    `/database/password` is PATCH-only by design. But a resolved endpoint lives
    in the link's `config_json`, which is NOT a sealed column, so
    `DbProviderEndpoint` gained an optional `secrets` that `links.ts` PEELS OFF
    before storing: the password lands in `secrets`, which is sealed. It is
    re-resolved whenever the endpoint is, so a password reset at Neon is picked
    up by saving the link rather than by finding a second button. Two more
    places where Neon is simply better-behaved than Supabase: `ProjectListItem`
    carries `org_name`, so naming the billed organisation costs no second
    request and no extra permission, and `GET /regions` is documented and
    non-beta, so the region list is live rather than hard-coded. And there is no
    `POST /organizations` at all, so `createGroup` is ABSENT rather than faked.
  - **Access is split across two mechanisms.** Every route takes project access
    the way `worktrees:create` does; the configuring and destroying ones are
    additionally listed in `backend/auth/permissions.ts` as admin-only the way
    `db-client:link` is, because a binding commits an account's quota to a
    project. `worktrees:branching-state` and `worktrees:branch-rewrite-env` stay
    open so a member can see and repair their own worktree's branch — the same
    split that leaves the Supabase reads ungated.
  - **Where the UI lives.** No new panel and no Settings page: the switcher is
    already "the one place worktrees are seen and acted on", so it gains a
    `Database branching…` footer entry opening a two-tab dialog (Setup / Leaks).
    Leaks is a PEER TAB rather than an empty state, applying `Task 4`'s lesson
    that anything a user manages needs a place existing before it is needed — an
    orphan list reachable only once something has gone wrong is invisible the
    moment it has not. `CreateWorktreeModal` states before the button that a
    real database is about to be created and offers a per-worktree opt-out; a
    failed branch renders INLINE there rather than as a toast and does not close
    the dialog, since the message usually ends in "delete a branch you no longer
    need". The delete confirm NAMES the branch it will destroy. The transfer
    modal says once, where the misunderstanding happens, that Apply moves files
    and NOT schema. `ConfirmDestructive` was PROMOTED from
    `components/db-client/shared/` to `components/common/overlay/` rather than
    duplicated, following `MenuSurface`, `ProviderMark` and `InlineError`.
  - **A bug the tests found, fixed at the root in both places.** `NFKD`
    normalisation followed by `[^\w\s-] → ' '` turns a combining diaeresis into
    a space, so "münchen" slugged to `mu-nchen` — a name split mid-word and not
    the one anyone would search the provider's console for. Combining marks are
    now dropped before the character class runs, in `branching/naming.ts` AND in
    `work/start-work.ts`, which had the identical shape from `Task 2`.
  - **Brand mark.** Added from Neon's own asset pack — the logomark in its two
    greens, `#37C38F` on a light background and `#34D59A` on a dark one, which
    is the pair the vendor ships rather than a tint we picked. Vercel's entry
    was re-taken from the same kind of source at the same time: its viewBox had
    been re-typed by hand and was a slightly different aspect ratio from the
    official artwork.
  - **Deliberately out of scope.** Turso (`Task 13`'s, and the reason
    `info().noun` exists — it seeds a whole database rather than branching one,
    and the dialog must not call that a branch), merging a branch back into its
    parent (no provider here offers it, and migrations are files the user runs
    against main themselves), branching per CHAT SESSION rather than per
    worktree, and `agent-tools` — Neon's MCP server uses its own OAuth, a
    different audience from this REST key, which is the reason `Task 3` left
    Vercel's alone.
  - **Status.** `bun run check`, `bun run lint` and the full suite pass; 57 new
    tests cover the branch name, the managed dotenv block (including the
    tracked-file refusal against a real git repository), the projection, the
    organisation scoping of the project listing, and both connection shapes.
    Runtime QA against a real Neon key found BOTH API-reading mistakes recorded
    above, and the pattern is worth naming: every one of them came from reading
    a schema name and assuming its shape rather than opening it. Now exercised
    for real: connecting an account, listing projects, creating a project, the
    health probe, and the link dialog's copy. Still unverified against a live
    key: cutting and deleting a branch, whether `connection_uris` really is
    absent on a multi-role parent, `reveal_password` as the second fallback, and
    what a branch-limit refusal answers with.

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

**Task 20 — Database tools for agents: one internal MCP server over DB Client.**
The gap the Supabase work made obvious: an agent can read the repository, drive a
browser and search the memory graph, but it cannot ask a single question of any
database Clopen is already connected to. Not a local Postgres, not SQLite, not a
projected Supabase project. Every vendor ships an MCP server that would solve
this for its own service alone, and taking that route means one credential and
one config per vendor, nothing at all for local databases, and — for Supabase
specifically — a server scoped with `--project-ref` to ONE project when an
account here can hold several. That is two places to reach the same database,
which is the mistake the architecture above exists to prevent.

Build it the other way round. DB Client OWNS the connections, so DB Client
exposes the tools, once, through `backend/mcp/internal/servers/`
(`defineServer()`) — the same rail Browser Automation and the memory graph use.
One server, every driver, and every provider that projects a connection gets it
free: Turso and Neon arrive already covered.

*Shape.* One batched `actions` tool rather than a dozen, which is what the
Browser Automation pass settled on after shipping twelve: a registry that is the
single source of truth for schema, docs and dispatch. The actions are the
questions an agent actually has — list the connections it may use, describe a
schema, read a table's structure, run a query — over the existing
`connectionManager` and `query-executor`, so the driver differences are already
solved.

*Permission is the hard half, and it is the reason this is its own entry.* An
agent with write access to a production database is a different risk class from
one editing files, and "the user connected it" is not consent to that. Every
connection gets an explicit agent-access setting — `none` by default, then
`read-only`, then `read-write` — stored on the connection and enforced in the
server rather than in a prompt. A read-only connection must be enforced by
classifying the statement, not by asking the model nicely; `query-executor`
already classifies read versus write for the query console, so the same
classifier decides. Write access names the connection in the consent UI and is
never inherited by a connection the agent discovers later. Schema-only access is
the useful middle ground and should be the recommended setting: an agent that can
read the shape of a table writes better migrations without ever seeing a row of
customer data.

*Other things it must get right.* Results are bounded and truncated with an
honest count rather than streamed whole into a context window. Secrets never
cross the tool boundary — the agent gets connection ids and names, never a host
or a password. And the tool list is filtered per connection, so an agent working
in a project with no database access sees no database tools at all.

- [ ] Done
- Notes: —
