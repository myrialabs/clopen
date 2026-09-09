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

- [ ] Done
- Notes: —

**Task 3 — Deployments surface + Vercel.** Close the loop after preview. Build
the panel every deploy target plugs into — deployments for the current project
behind one interface covering list, status, build logs and open-preview — with
failing build logs streamed into the chat and the preview URL exposed directly to
the existing preview browser so an agent can drive a real deployed build. Every
action that triggers a build or changes what is live is outward-facing and must
be confirmed explicitly. Vercel is the first provider (API token). Six more
targets plug in later; none of them may add a panel.

- [ ] Done
- Notes: —

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
