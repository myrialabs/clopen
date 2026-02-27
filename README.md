# 🎯 Clopen

> All-in-one web workspace for Claude Code & OpenCode

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-black)](https://bun.sh)

**Clopen** provides a modern web interface for AI-assisted development, supporting both **Claude Code** and **OpenCode** as AI engines. It runs as a standalone web application — manage multiple Claude Code accounts, use built-in git source control, preview your app in a real browser, edit files, collaborate in real-time, and never lose progress with git-like checkpoints.

---

## ✨ Features

- 👤 **Multi-Account Claude Code** - Manage multiple accounts (personal, work, team) and switch instantly per session, isolated under `~/.clopen/claude/user/` without touching system-level Claude config
- 🔀 **Multi-Engine Support** - Switch between Claude Code and OpenCode
- 💬 **AI Chat Interface** - Streaming responses with tool use visualization
- 🔄 **Background Processing** - Chat, terminal, and other processes continue running even when you close the browser — come back later and pick up where you left off
- 🌿 **Git-like Checkpoints** - Multi-branch undo/redo system with file and folder snapshots
- 🌐 **Real Browser Preview** - Puppeteer-based Chromium rendering with WebCodecs streaming (80-90% bandwidth reduction), full click/type/scroll/drag interaction
- 💻 **Integrated Terminal** - Multi-tab terminal with full PTY control
- 📁 **File Management** - Directory browsing, live editing, and real-time file watching
- 🗂️ **Git Management** - Full source control: staging, commits, branches, push/pull, stash, log, conflict resolution
- 👥 **Real-time Collaboration** - Multiple users can work on the same project simultaneously
- 🚇 **Built-in Cloudflare Tunnel** - Expose local projects publicly for testing and sharing
---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.2.12 or higher
- [Claude Code](https://github.com/anthropics/claude-code) and/or [OpenCode](https://opencode.ai) — required for AI chat functionality

### Installation

```bash
bun add -g clopen
```

This installs dependencies, builds the frontend, and makes the `clopen` command available globally.

### Usage

```bash
clopen
```

On first run, Clopen creates `.env` from `.env.example`, verifies the build, and starts the server on `http://localhost:9141`.

**Configuration** — edit `.env` to customize:
```bash
PORT=9141              # Server port
NODE_ENV=production    # Environment mode
```

---

## 🛠️ Development

```bash
git clone https://github.com/myrialabs/clopen.git
cd clopen
bun install
bun run dev     # Start development server
bun run check   # Type checking
```

---

## 📚 Architecture

| Layer | Technology |
|-------|-----------|
| Runtime | Bun.js |
| Frontend | Svelte 5 (runes) + Vite |
| Backend | Elysia + WebSocket |
| Styling | Tailwind CSS v4 |
| Database | SQLite with migrations |
| Terminal | bun-pty |
| AI Engines | Claude Code + OpenCode |

### Engine Architecture

Clopen uses an engine-agnostic adapter pattern — the frontend and stream manager are not tied to any specific AI tool:

```
┌─────────────────────────────────────────┐
│              Stream Manager             │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
 ClaudeCodeEngine  OpenCodeEngine
```

Both engines normalize output to Claude SDK message format, ensuring a consistent experience regardless of which engine is selected.

---

## 🛣️ Planned Features

- [ ] **Configurable MCP Servers** - Add, remove, enable, and disable Model Context Protocol servers through the UI
- [ ] **Built-in Database Management** - Adminer/TablePlus-like interface
- [ ] **Additional Preview Platforms** - Android, iOS, and Desktop app preview
- [ ] **Enhanced Collaboration** - User authentication and permissions
- [ ] **Plugin System** - Extensible architecture for community plugins

---

## 📖 Documentation

- [Technical Decisions](DECISIONS.md) - Architectural and technical decision log
- [Development Guidelines](CLAUDE.md) - Guidelines for working with Claude Code on this project

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run `bun run check` to ensure code quality
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

---

## 🐛 Troubleshooting

### Port 9141 Already in Use

Use a different port:
```bash
clopen --port 9150
```

Or kill the existing process:
```bash
# Unix/Linux/macOS
lsof -ti:9141 | xargs kill -9

# Windows
netstat -ano | findstr :9141
taskkill /PID <PID> /F
```

### Claude Code Not Found

```bash
# macOS / Linux / WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

# Verify
claude --version
```

For complete installation instructions, visit the [official setup guide](https://code.claude.com/docs/en/quickstart).

### OpenCode Not Found

```bash
# macOS / Linux / WSL
curl -fsSL https://opencode.ai/install | bash

# Bun
bun add -g opencode-ai

# Verify
opencode --version
```

For complete installation instructions, visit the [official documentation](https://opencode.ai/docs).

### Browser Preview Issues

Browser sessions are automatically managed via Puppeteer's APIs and cleaned up when the preview is closed, the application exits, or the session times out.

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Claude Code](https://github.com/anthropics/claude-code) by Anthropic
- [OpenCode](https://opencode.ai) by SST
- [Bun](https://bun.sh/) runtime
- [Svelte](https://svelte.dev/) framework

---

## 🔗 Links

- **Repository:** [github.com/myrialabs/clopen](https://github.com/myrialabs/clopen)
- **Organization:** [MyriaLabs](https://github.com/myrialabs)
- **Issues:** [Report a bug or request a feature](https://github.com/myrialabs/clopen/issues)

---

<div align="center">
  <sub>Built with ❤️ by MyriaLabs</sub>
</div>
