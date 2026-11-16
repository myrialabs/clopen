# Roadmap

Where Clopen goes after v0.5. Each entry is one implementation session. On
finishing one, tick its box and replace the `—` after **Notes** with a short
bullet list of what was actually built, which decisions were taken, and where
the implementation deviated from the entry — the next session reads those
notes, not the diff. One bullet per topic, opened by a bold label.

**Where Clopen is.** 0.0 was the first design; 0.1 fixed the big bugs; 0.2
rebuilt it for vibe coding; 0.3 added the engines (Claude Code, OpenCode,
Codex, Copilot, Qwen, Pi, Cline, Cursor); 0.4 completed what agents need (MCP,
skills, commands, subagents, rules, memory). 0.5 hands the work to the agent:
Clopen is now an AI you talk to that drives the coding agents, verifies their
results, runs flows on its own, remembers across chats, and learns skills
and scripts from repetition.

**What makes Clopen different** — keep every entry below consistent with it.
It is free and open source; it runs on the owner's own computer or server; it
works with any of eight coding agents and with free models; and the work
happens in a real workspace the owner can watch, verify and undo (restore
points, workspace copies, the preview browser). Nothing here may trade one of those
away.

Against the closest projects (checked November 2026): **CopilotKit OpenBot**
is MIT but needs its paid Intelligence service, Kubernetes and Postgres in
production; it targets Slack/Teams/mobile, routines run at most every 15
minutes, it has no Telegram and no workspace to build in. **Nightly OpenBot**
is an Electron app under PolyForm Noncommercial; it drives many CLI agents
through ACP, has channels, an embedded browser and computer use, but runs with
full access and no approvals, and has no Telegram. Clopen keeps its lead by
being MIT and self-hosted with nothing paid in the path, by running crews and
flows whose structure is code (so a free model follows the same plan as a
flagship), by asking before anything irreversible, and by doing the work in a
real workspace — files, git, terminal, preview, databases — reachable from any
device and from Telegram.

---

## Rails — reuse, do not reinvent

- `backend/control/agent/` is the only way an agent drives Clopen. A new
  capability is a new action there (with its risk and scope), never a new MCP
  server or a handler in a surface.
- `backend/assistant/` owns tasks (stored as missions), the conversation
  router, the journal, the profile, cards, crews, learning, scripts and the
  assistant's brief; `backend/jobs/` owns flows — triggers and runs;
  `backend/recipes/` owns the recipe engine every flow and crew runs on. A new
  trigger type is a case in `jobs/service.ts` + `jobs/scheduler.ts`, not a
  second scheduler; a new kind of step is a case in `recipes/engine.ts` and
  `shared/utils/recipe-text.ts`, not a new runner.
- Recipe text is English-only in its structure (the verbs); the owner talks in
  any language and the AI writes the canonical form. Never add per-language
  keyword lists anywhere — judgement goes to a model, not to a word list.
- Secrets live in the `secrets` vault (`secret.*` actions); memory, scripts and
  prompts refer to them by name only.
- A write route in a shared namespace is announced by the router
  (`data:changed`); a new namespace that the UI caches is added to
  `SYNCED_NAMESPACES` and to `frontend/services/data-sync.ts`, not given its
  own event.
- `backend/integrations/` holds every third-party credential (one row per
  connected account). An integration never keeps its own copy of a secret.
- `@myrialabs/chatkit` is the single path for every chat platform. A gap in
  ChatKit is fixed in ChatKit, generically.
- Cards (`backend/assistant/cards.ts`) are the one way the owner is asked for
  anything — a question, an approval, a link to connect, a key. A feature that
  needs the owner raises a card; it reaches them where they are (Clopen's
  screen, Telegram) and does not invent its own prompt.

## House rules

Bun + Elysia, WebSocket-first (register every event in the `.emit` schema
block), Svelte 5 runes, `debug` logger, one numbered migration per schema
change, cross-platform (Linux/macOS/Windows), dependencies pinned exact, and
English for everything user-facing and committed.

---

# 0.5.x — finishing the assistant

**Task 1 — Context7 preset.** Up-to-date library documentation is what most
improves an autonomous agent's code. Ship Context7 as a curated MCP preset
through the integrations registry, enabled by default in the starter set, with
a tested default prompt telling agents when to look things up. No custom panel:
if it needs one, the preset rail is missing something and that is the fix.

- [ ] Done
- Notes: —

**Task 2 — Slack and Discord channels.** Two more ways to talk to Clopen and
hear back from it, through the existing chat-app code path (`backend/chat-apps`,
one `ChannelPlatform` file each). Each inherits the whole conversation model:
an active project/session per chat, reply-to-continue, edit-to-resend, the
command set generated from the control catalog, the progress line, questions
as buttons, and cards and reports (`broadcastToChats`, `announceCard`). Slack via Socket Mode.
Before starting, check what ChatKit's adapters emit for an edited message and
a reply, and whether each can delete a message and set typing; degrade where a
platform lacks something rather than branching Clopen. WhatsApp is deliberately
not included (ban risk for unofficial clients).

- [ ] Done
- Notes: —

**Task 3 — Voice.** Talk to Clopen and hear it answer, in the web UI and on the
phone: push-to-talk in the assistant chat, local or provider transcription, and
an optional spoken summary of a task report. Voice notes arriving through a
chat app are transcribed into the same path.

- [ ] Done
- Notes: —

**Task 4 — Import from other agents.** Bring an owner's existing know-how in:
skills, rules/instructions and memories from Claude Code (`~/.claude`),
OpenClaw (MEMORY.md, USER.md, skills) and Hermes Agent (`~/.hermes`). A
dry-run preview first, then import into the Library and the memory graph, with
a source label on everything imported. Never import secrets silently.

- [ ] Done
- Notes: —

**Task 5 — Flows on other machines.** Let a flow run its script or its agent on
an SSH host or in a container instead of this computer, using the connections
SSH Client and Containers already manage. The run report and the cards stay
the same; only where the work happens changes.

- [ ] Done
- Notes: —

**Task 6 — Work that is not code.** Documents, slides and spreadsheets as
task results: an agent writes them into the project (Markdown → PDF/DOCX,
HTML slides, CSV/XLSX), the preview shows them, and the task report links
to them. Built on the existing agents and preview, not a separate editor.

- [ ] Done
- Notes: —

**Task 7 — Approve from the notification.** Approval cards carry
Approve / Decline actions in the Web Push notification itself (and as buttons
in chat apps), so an irreversible action can be allowed from the lock screen
without opening Clopen.

- [ ] Done
- Notes: —

**Task 8 — Sharing the Library.** Publish a skill, a script or a toolset to a
shared catalog and install one from it, with the same trust review the
marketplace import already does (no secrets, scripts shown before they run).

- [ ] Done
- Notes: —

---

**Task 9 — Flow canvas and n8n conversion.** v0.5 shows a flow as a nested
step list and edits it as recipe text. Add a canvas view of the same recipe
(branches, loops, parallel lanes, reviews) on the `@xyflow/svelte` the project
already ships — a view of the recipe, never a second format. Then convert an
n8n workflow JSON into a recipe: deterministic nodes to `Run`/`HTTP`/`Use`
steps, AI nodes to `Do` steps, IF/Switch to `If`/`Choose`, and show what could
not be mapped before saving. Converting, not importing: the recipe stays the
one format, so Clopen can keep repairing and learning it. Still to decide:
whether conversion is worth it at all versus asking Clopen to rebuild the flow
from a description of what it does.

- [ ] Done
- Notes: —

**Task 10 — Template gallery.** Ready-made flows ("morning email
summary", "watch a price", "weekly project report") and specialist roles,
installed in one click and adjusted by Clopen to the owner's accounts.

- [ ] Done
- Notes: —

**Task 11 — Email and calendar.** Gmail/Outlook and Google/Microsoft calendar
as integrations Clopen can read and act on (draft, send with approval, schedule)
and as flow triggers (a new email from someone, an event starting).

- [ ] Done
- Notes: —

---

# Beyond 0.5 — bigger bets

**Task 12 — Local models, offline by default.** Ollama / llama.cpp as a
first-class agent backend, with a model picked for the owner's hardware (the
Machine settings already know it), so Clopen works with no network and no
account at all.

- [ ] Done
- Notes: —

**Task 13 — Clopen relay.** Reach your Clopen from anywhere without a tunnel or
a public URL: an end-to-end encrypted relay the phone and the computer both dial
out to, upgrading to a direct WebRTC connection when the network allows (the
preview stream already speaks WebRTC). The relay sees ciphertext only;
self-hostable.

- [ ] Done
- Notes: —

**Task 14 — Native mobile app.** A thin native shell for iOS and Android with
real push, share-to-Clopen, voice, and cards on the lock screen; the UI
stays the web app.

- [ ] Done
- Notes: —

**Task 15 — Teach a task on the desktop.** Today a task is taught in the
Preview Browser. Record any desktop app the same way (accessibility tree plus
input), turning it into a skill an agent can replay with computer use.

- [ ] Done
- Notes: —

**Task 16 — Self-evaluation.** Clopen grades its own skills and specialists
against outcomes (verified criteria, the owner's corrections, retries) and
improves or retires the ones that underperform, with every change still a
revertible revision.

- [ ] Done
- Notes: —

**Task 17 — A sandbox per task.** Run each task's agents in their own
container (the Containers tool already manages them), with only the project and
the secrets it needs mounted, so an autonomous task cannot touch anything else.

- [ ] Done
- Notes: —

**Task 18 — Any ACP agent.** Today each of the eight engines has its own
adapter. Add one generic adapter for the Agent Client Protocol so any
ACP-speaking CLI agent works without new code, with the same permissions,
manager policy and recipe `Do` steps as the built-in engines.

- [ ] Done
- Notes: —

**Task 19 — Clopen in your language.** The UI in the owner's language
(starting with the languages the owners actually use), from one message
catalog. Recipe structure stays English; only what the owner reads changes.

- [ ] Done
- Notes: —

**Task 20 — Cross-model scenario checks.** A repeatable set of owner
scenarios (delegate a build, connect a service, make a flow with a branch,
send a screenshot, stop everything) run against several models, cheap and
flagship, scoring whether each reached the same result. Run before a release,
so "a free model does as well" stays true.

- [ ] Done
- Notes: —

---

*Integrations from the earlier third-party plan were narrowed to what stays
crucial once Clopen drives the agents itself: Context7 (Task 1) and Slack and
Discord (Task 2). Database tools for agents shipped in v0.5 as the `db.*`
actions, with per-connection agent access set in DB Client.*
