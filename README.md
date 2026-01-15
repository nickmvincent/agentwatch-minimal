# agentwatch-minimal

Lightweight toolkit for launching and monitoring coding agents (Claude Code, Codex, Gemini CLI) in tmux sessions.

## Features

- **launch** - Spawn agents with the same prompt in parallel tmux sessions
- **orchestrate** - Use Claude to decompose complex prompts into parallel sub-tasks
- **watch** - Monitor tmux sessions with a live ANSI display
- **hooks** - HTTP server for logging Claude Code hook events

## Install

```bash
bun install
```

Requires: [Bun](https://bun.sh), [tmux](https://github.com/tmux/tmux), and at least one agent CLI (claude, codex, or gemini).

---

## Quick Start

```bash
# Launch Claude with a prompt
bun run launch.ts "Fix the auth bug" --agents claude

# Watch your sessions
bun run watch.ts --filter awm

# Attach to a session
tmux attach -t awm-claude-xxx
```

---

## User Guide

### Core Workflow

1. **Launch** agents with a prompt - each agent runs in its own tmux session
2. **Watch** sessions to monitor progress across all agents
3. **Attach** to individual sessions to interact directly

### When to Use Each Command

| Command | Use Case |
|---------|----------|
| `launch.ts` | Run the same task on multiple agents to compare approaches |
| `orchestrate.ts` | Break a complex task into parallel sub-tasks automatically |
| `watch.ts` | Monitor multiple agents running simultaneously |
| `hooks.ts` | Debug/audit Claude Code tool usage |

### Session Naming

Sessions are named `{prefix}-{agent}-{timestamp}`:
- `awm-claude-m1abc23` - Claude session
- `awm-codex-m1abc24` - Codex session

The default prefix is `awm` (agentwatch-minimal). Use `--prefix` to customize.

### Tips

- **Compare agents**: Launch the same prompt to claude and codex, watch them work, see which approach you prefer
- **Parallel decomposition**: Use `orchestrate.ts` for tasks with independent sub-parts (e.g., "add feature X, write tests, update docs")
- **Stay organized**: Use `--prefix` to group related sessions (e.g., `--prefix auth-fix`)
- **Quick check**: Use `watch.ts --once --last-line` for a snapshot without the refresh loop

---

## CLI Reference

### launch.ts

Spawn agents in tmux sessions with a prompt.

```bash
bun run launch.ts "your prompt" [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--agents` | `-a` | `claude` | Comma-separated agents: claude, codex, gemini |
| `--cwd` | `-c` | current dir | Working directory for agents |
| `--prefix` | `-p` | `awm` | Session name prefix |
| `--help` | `-h` | | Show help |

**Examples:**

```bash
# Single agent
bun run launch.ts "Fix the authentication bug" --agents claude

# Multiple agents (launches in parallel)
bun run launch.ts "Write unit tests" --agents claude,codex

# Custom working directory
bun run launch.ts "Refactor this module" --cwd /path/to/project

# Custom prefix for grouping
bun run launch.ts "Debug issue #42" --prefix issue42
```

---

### watch.ts

Monitor tmux sessions with a live display.

```bash
bun run watch.ts [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--filter` | `-f` | (none) | Filter sessions by name prefix |
| `--interval` | `-i` | `2000` | Refresh interval in milliseconds |
| `--last-line` | `-l` | `false` | Show last line of output from each pane |
| `--once` | `-o` | `false` | Run once and exit (no refresh loop) |
| `--help` | `-h` | | Show help |

**Examples:**

```bash
# Watch all awm sessions
bun run watch.ts --filter awm

# Show last output line (useful to see agent status)
bun run watch.ts --filter awm --last-line

# Faster refresh
bun run watch.ts --filter awm --interval 500

# One-shot status check
bun run watch.ts --filter awm --once
```

---

### orchestrate.ts

Decompose complex tasks into parallel sub-tasks using Claude as an orchestrator.

```bash
bun run orchestrate.ts "complex task" [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--cwd` | `-c` | current dir | Working directory for agents |
| `--prefix` | `-p` | `awm` | Session name prefix |
| `--dry-run` | `-n` | `false` | Show plan without launching agents |
| `--wait` | `-w` | `false` | Wait for dependencies and auto-launch dependent tasks |
| `--help` | `-h` | | Show help |

**How it works:**

1. Sends your prompt to Claude with instructions to decompose it
2. Claude returns a JSON plan with sub-tasks and dependencies
3. Independent tasks launch immediately in parallel
4. Dependent tasks either wait (`--wait`) or print manual instructions

**Examples:**

```bash
# Decompose and launch
bun run orchestrate.ts "Build a REST API with auth, validation, and tests"

# Preview the plan first
bun run orchestrate.ts "Refactor the payment module" --dry-run

# Auto-execute dependent tasks when dependencies complete
bun run orchestrate.ts "Complex multi-step task" --wait
```

---

### hooks.ts

HTTP server for logging Claude Code hook events.

```bash
bun run hooks.ts [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `8750` | Server port |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Directory for hook logs |

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hooks/:event` | Log a hook event (returns `{}` = approved) |
| GET | `/hooks/recent?limit=N&event=X` | Query recent hooks |
| GET | `/hooks/health` | Health check |
| GET | `/` | Service info |

**Examples:**

```bash
# Start server
bun run hooks.ts

# Custom port
bun run hooks.ts --port 8751

# Query recent hooks
curl http://localhost:8750/hooks/recent
curl http://localhost:8750/hooks/recent?limit=10&event=pre-tool-use
```

---

## Claude Code Integration

### Basic Hook Logging

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "curl -sS -X POST http://localhost:8750/hooks/pre-tool-use -H 'Content-Type: application/json' -d @-"
        }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "curl -sS -X POST http://localhost:8750/hooks/post-tool-use -H 'Content-Type: application/json' -d @-"
        }]
      }
    ]
  }
}
```

### Hook Fanout (Multiple Servers)

Use `bin/hook-fanout` to send hooks to multiple servers:

```bash
# Install
cp bin/hook-fanout ~/.local/bin/
chmod +x ~/.local/bin/hook-fanout
```

Configure in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "~/.local/bin/hook-fanout pre-tool-use" }] }
    ]
  }
}
```

Edit the `TARGETS` array in the script to customize endpoints.

---

## Data Storage

```
~/.agentwatch-minimal/
  hooks.jsonl    # Append-only hook event log
```

Hook entries are JSON lines with `id`, `timestamp`, `event`, and `payload` fields.

---

## Development

```bash
# Run tests
bun test

# Type check
bunx tsc --noEmit
```

## License

MIT
