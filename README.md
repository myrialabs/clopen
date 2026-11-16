<p align="center">
  <img src="https://clopen.myrialabs.dev/favicon.svg" alt="Clopen" width="72" height="72" />
</p>

<h1 align="center">Clopen</h1>

<p align="center">
  <strong>Tell it what you want. It gets it built.</strong><br />
  Your AI that runs your AI coding agents
</p>

<p align="center">
  <a href="https://clopen.myrialabs.dev">Website</a> ·
  <a href="https://github.com/myrialabs/clopen/issues">Issues</a> ·
  <a href="https://www.npmjs.com/package/@myrialabs/clopen">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@myrialabs/clopen"><img src="https://img.shields.io/npm/v/@myrialabs/clopen" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/myrialabs/clopen/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Built%20with-Bun-black" alt="Built with Bun" /></a>
</p>

<p align="center">
  <img src="https://clopen.myrialabs.dev/images/workspace.webp" alt="Clopen workspace overview" />
</p>

Clopen is an AI you talk to. Ask for something — a landing page, a bug hunt, a check that runs every morning — and Clopen hands the work to a coding agent (Claude Code, OpenCode, Codex, Copilot, Qwen Code, Pi, Cline or Cursor), checks the result itself, and keeps correcting until it is right. It runs on your own computer or server, works with free models out of the box, and does everything in a real workspace you can watch, verify and undo: chat, files, git, terminal, browser preview, databases and remote access from any device.

---

## Screenshots

![AI chat interface](https://clopen.myrialabs.dev/images/chat-panel.webp)

![Engines and accounts](https://clopen.myrialabs.dev/images/engines-setting.webp)

![Database client](https://clopen.myrialabs.dev/images/db-client.webp)

![Browser preview panel](https://clopen.myrialabs.dev/images/preview-panel.webp)

![Integrations settings](https://clopen.myrialabs.dev/images/connectors-setting.webp)

![Public tunnel](https://clopen.myrialabs.dev/images/public-tunnel.webp)

![Checkpoint restore](https://clopen.myrialabs.dev/images/restore-checkpoint.webp)

### Works on Any Device

<img src="https://clopen.myrialabs.dev/images/chat-panel-mobile.jpg" width="140" alt="AI Chat on mobile" /> <img src="https://clopen.myrialabs.dev/images/files-panel-mobile.jpg" width="140" alt="File Explorer on mobile" /> <img src="https://clopen.myrialabs.dev/images/git-panel-mobile.jpg" width="140" alt="Git on mobile" /> <img src="https://clopen.myrialabs.dev/images/terminal-panel-mobile.jpg" width="140" alt="Terminal on mobile" /> <img src="https://clopen.myrialabs.dev/images/preview-panel-mobile.jpg" width="140" alt="Browser Preview on mobile" /> <img src="https://clopen.myrialabs.dev/images/db-client-mobile.jpg" width="140" alt="Database Client on mobile" />

---

## Features

### Clopen, the assistant

- **One conversation, like Telegram** — Clopen's chat is a single timeline with everything said and sent, and a quick first word while it works before the result arrives. Talk to Clopen in plain words, in the app or on Telegram (menu: /tasks, /stop, /clear, /help). Quick things it answers; bigger things become background tasks, so the chat stays free while the work goes on. Messages on another subject, or sent while it is busy, move to a fresh chat on their own — judged by meaning, with the context carried over
- **Tasks** — A goal with checkable criteria that Clopen drives to done across your projects, handing each part to a specialist (Writer, Developer, Researcher…) and verifying the result itself — in the browser, with tests, in the files. No limit on rounds or time; it stops only when truly stuck. Ask how it is going and you get a progress note with a screenshot of what the agent sees
- **Your assistant, not a worker** — Clopen does one-off things itself, right away: a screenshot, a lookup, a reminder, a note in Notion, a calendar entry. Project work — building or changing an app, writing a document — goes to agents in a project, and the team is sized to the request: a developer and a tester for a build (a researcher only when facts are needed, a marketer only when you ask for a launch). The tester tries it in a real browser and the developer fixes what was found, until it passes; then you get a link. You hear honestly how it ended — done, needs you, not finished, or impossible as asked. A free model and a flagship follow the same plan, because the plan is run by Clopen, not left to the model
- **Tasks, once or repeating** — One list for everything Clopen works on. A repeating task starts on its own — on a schedule, once at a time you name, when a page you watch changes, on an event, or with one tap — and is a short recipe of plain steps (do, run a script, call a service, tell me, ask me, wait for my OK) with branches, loops, parallel branches and reviews. Every task's plan is drawn as a canvas (Svelte Flow) showing who does what and how each step went. Repeating tasks learn: a failing step is repaired and the lesson kept, a step that always gives the same answer becomes a free script, and every change is a version you can go back to. Optional daily budget
- **Never hands you homework** — If something needs a login, an install or a setting, Clopen does it. It asks only for what only you have — a password, a key, a choice — keeps it in the encrypted **Secrets** vault, and carries on
- **Remembers you** — A journal of what happened across every chat, a profile of who you are and how you work, and long-term memory — so a new chat already knows yesterday
- **Comes to you, with results only** — Clopen tells you what you got, never how it got there. Questions, approvals, a service to connect and a login arrive as cards where you are — right above the chat input, or in Telegram with buttons — and are answered right there, in your language; a reply like "ok" goes to the question it answers, and "make it realistic" changes the task you just got instead of starting another. Results come once: a screenshot as one photo with its caption, a full-page one as a file. A password typed into a chat is moved to the encrypted vault and removed from the chat. **Needs you** lists only what is waiting on you
- **Connects services from the chat** — "Connect Notion" gives you one sign-in link (or one field for a key); Clopen installs and sets up the rest. Keys go to the encrypted vault, never to the AI
- **Live view** — While an agent is in a browser, its screen appears as a card beside the chat (fold it to a pill when you don't need it); when a site needs you — a login, a captcha — you click and type into it there
- **Connect from anywhere** — "Connect Notion" gives you one sign-in link that works from your phone too: the sign-in returns through a short-lived relay that answers nothing but that callback, so Clopen itself is never exposed. With "No login" set, Clopen refuses to put itself on the internet at all
- **Short answers** — Clopen replies like a person in a chat: a sentence or two, more only when you ask
- **Learns as it goes** — Steps that keep being repeated become scripts; requests you keep making become skills; skills Clopen had to correct get improved — every change versioned and revertible
- **Teach a task** — Record what you do once in the preview browser and save it as a skill an agent can repeat, or a script that replays it
- **Autonomous by default, safe by design** — Clopen works on its own, while anything irreversible (deleting data, force-pushing, deploying, writing to a database) waits for your approval unless you allow it. Every action is in an audit trail. Prefer to be asked first? One switch. **Stop everything** halts every task, flow, agent and shared link at once
- **Controls all of Clopen** — The built-in `control` MCP server (its `run` tool) lets the assistant read projects and drive chats, tasks, repeating tasks, scripts, skills, secrets, databases you opened to agents, and the whole Clopen API — batched into a single call. Changes made this way show up on every open screen at once
- **One model per job** — Settings → Models picks a model for Clopen itself, for the specialists doing the work, for project chats and for background decisions (routing, reviews, commit messages) — the same choice on the web and in Telegram. If a model fails, Clopen retries once on another
- **Free to start** — Clopen runs on a free model with no account the moment it is installed; add an API key or connect your own Claude, ChatGPT/Codex, Copilot or Cursor account whenever you want more power

### The workspace

- **Multi-Agent Support** — Switch between Claude Code, OpenCode, Codex, GitHub Copilot, Qwen Code, Pi, Cline, and Cursor per chat, with multiple accounts per agent
- **Reasoning Effort Control** — Dial a model's thinking level right from the chat input, using that agent's own levels
- **Integrated Terminal** — Multi-tab terminal with full keyboard control and complete ANSI/VT support
- **Full Git Management** — Stage, commit, branch, push, pull, stash, log, and resolve conflicts from a clean UI
- **Real Browser Preview** — A live browser preview streams into your workspace. Use it yourself, or let the AI drive it for visual testing
- **Database Client** — PostgreSQL, MySQL, SQLite, MongoDB, and Redis, with optional SSH tunneling. You decide per connection what an AI agent may do: nothing, see the structure, read, or write
- **Restore points** — Multi-branch undo/redo with full file snapshots. Go back to any point in a conversation without touching your git history
- **Remote Access** — Add your phone, tablet, or another computer with a one-time link or QR code. Every device stays in sync live
- **Library** — Skills, scripts, specialists, rules, toolsets, integrations (including the full MCP registry with OAuth) and secrets, built once and shared by every agent and project
- **Public Links** — One-click public HTTPS URL for your local dev server, through Cloudflare
- **Background Processing** — Chats, tasks, automations and terminals keep running when you close the browser
- **Works on Any Device** — Fully responsive across desktop, laptop, tablet, and mobile

---

## Quick Start

### Prerequisites

- [Bun.js](https://bun.sh/) v1.2.12+

That is all. Clopen installs OpenCode with its free models on first launch, so it works without any account. Other agents — [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [GitHub Copilot CLI](https://github.com/github/copilot-cli), [Qwen Code](https://github.com/QwenLM/qwen-code), [Pi](https://github.com/earendil-works/pi), [Cline](https://github.com/cline/cline), [Cursor](https://cursor.com) — install on demand from **Settings → Agents** into Clopen's own folder (nothing global changes): each agent goes Install → Sign in → Ready in place.

### Installation

```bash
bun add -g @myrialabs/clopen
```

### Update

```bash
clopen update
```

Or manually via Bun:

```bash
bun add -g @myrialabs/clopen
```

You can also update from **Settings → Maintenance → Updates** in the web UI.

### Usage

```bash
clopen
```

Starts the server on `http://localhost:9141`.

### First-Time Setup

On first launch — and once after upgrading from 0.4, with everything you already set kept as it is — three short steps:

1. **Access** — **Just this computer** (nothing to sign in to) or **My other devices too** (protected by a sign-in key, shown once)
2. **AI** — OpenCode with free models installs itself; add an API key (OpenRouter, OpenAI, Anthropic, Google…) or another agent right there
3. **Preferences** — Ask me before acting, start with this computer, dark mode

Then you land in the chat with Clopen. Everything can be changed later in **Settings → Clopen** and **Settings → Devices & Access**.

To sign in another of your devices, open **Remote Access → Add a device** and scan the one-time link (valid for 5 minutes).

If you lose your key:

```bash
clopen reset-pat
```

### Start with the computer

Repeating tasks run only while Clopen is running. To keep their schedule after a restart, turn on **Settings → Clopen → Start with this computer**, or:

```bash
clopen service install     # macOS LaunchAgent, Linux systemd user unit, Windows Task Scheduler
clopen service status
clopen service uninstall
```

It uses your own account's startup — no administrator rights — and takes effect at your next log in.

---

## Contributing

Clopen is open source and contributions are welcome! Whether it's a bug fix, new feature, or improvement to docs — feel free to open an issue or submit a pull request.

```bash
git clone https://github.com/myrialabs/clopen.git
cd clopen
bun install
bun run dev     # Start development server
bun run check   # Type checking
```

When running in development mode, Clopen uses `~/.clopen-dev` instead of `~/.clopen`, keeping dev data separate from any production instance.

Each AI agent's config/state (credentials, sessions, logs) is isolated under `~/.clopen/engine/<engine>/user/` rather than the engine's global location (`~/.codex`, `~/.copilot`, `~/.qwen`, the OpenCode XDG dirs), so Clopen never mixes with — or disturbs — your own standalone CLI usage.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, [DECISIONS.md](DECISIONS.md) for architectural decisions, and [ROADMAP.md](ROADMAP.md) for what comes next.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Bun.js |
| Frontend | Svelte 5 (runes) + Vite |
| Backend | Elysia + WebSocket |
| Styling | Tailwind CSS v4 |
| Database | SQLite with migrations |
| Terminal | bun-pty |
| AI Agents | Claude Code, OpenCode, Codex, Copilot, Qwen Code, Pi, Cline, Cursor |
| Assistant | Tasks (one-off crews and repeating flows on one recipe engine), cards, journal, secrets, learning loop — driven through the internal `control` MCP server |
| DB Client | Postgres, MySQL, SQLite, MongoDB, Redis (+ SSH tunnel) |

---

## Troubleshooting

### Port 9141 Already in Use

```bash
clopen --port 9145
```

Or kill the existing process:
```bash
# Unix/Linux/macOS
lsof -ti:9141 | xargs kill -9

# Windows
netstat -ano | findstr :9141
taskkill /PID <PID> /F
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [Claude Code](https://github.com/anthropics/claude-code) by Anthropic
- [OpenCode](https://opencode.ai) by Anomaly
- [Codex](https://github.com/openai/codex) by OpenAI
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) by GitHub
- [Qwen Code](https://github.com/QwenLM/qwen-code) by Alibaba Qwen
- [Pi](https://github.com/earendil-works/pi) by Earendil Works
- [Cline](https://github.com/cline/cline) by Cline Bot Inc.
- [Cursor](https://cursor.com) by Anysphere
- [Bun](https://bun.sh/) runtime
- [Svelte](https://svelte.dev/) framework

---

## Support

If Clopen is useful to you, consider supporting its development:

| Method | Address / Link |
|--------|----------------|
| Bitcoin (BTC) | `bc1qd9fyx4r84cce2a9hkjksetah802knadw5msls3` |
| Solana (SOL) | `Ev3P4KLF1PNC5C9rZYP8M3DdssyBQAQAiNJkvNmPQPVs` |
| Ethereum (ERC-20) | `0x61D826e5b666AA5345302EEEd485Acca39b1AFCF` |
| USDT (TRC-20) | `TLH49i3EoVKhFyLb6u2JUXZWScK7uzksdC` |
| Saweria | [saweria.co/myrialabs](https://saweria.co/myrialabs) |

---

**Repository:** [github.com/myrialabs/clopen](https://github.com/myrialabs/clopen) · **Issues:** [Report a bug or request a feature](https://github.com/myrialabs/clopen/issues)
