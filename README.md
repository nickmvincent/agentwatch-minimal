# agentwatch-minimal

Lightweight toolkit for launching and monitoring coding agents (Claude Code, Codex, Gemini CLI) in tmux sessions.

## Features

- **launch** - Spawn agents with the same prompt in parallel tmux sessions
- **orchestrate** - Use Claude to decompose complex prompts into parallel sub-tasks
- **watch** - Unified TUI: monitor tmux sessions + Claude Code hooks in two-column layout
  - Embedded hooks server on port 8702
  - CPU/memory stats, session duration, pane output
  - Interactive keybinds for navigation, attach, kill
  - `--hooks-daemon` mode for headless hook server
- **notifications** - Desktop and webhook notifications for hook events
- **session metadata** - Log prompts/tags/status in a lightweight JSONL file

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

### Why Launch Instead of Manual tmux

- Consistent naming so you can filter/watch and reattach quickly
- Safe prompt handling for long or complex inputs
- One command to run multiple agents in parallel
- Session metadata (tags, previews) for lightweight tracking

### When to Use Each Command

| Command | Use Case |
|---------|----------|
| `launch.ts` | Run the same task on multiple agents to compare approaches |
| `orchestrate.ts` | Break a complex task into parallel sub-tasks automatically |
| `watch.ts` | Monitor sessions + hooks in unified TUI (default) |
| `watch.ts --hooks-daemon` | Run headless hooks server only |
| `watch.ts --no-hooks` | Monitor sessions only (no hooks server) |

### Session Naming and Prefix

Sessions are named `{prefix}-{agent}-{timestamp}`:
- `awm-claude-m1abc23` - Claude session
- `awm-codex-m1abc24` - Codex session

The `--prefix` flag controls the first part of the session name. This is purely for naming—it doesn't store metadata or affect agent behavior. The main benefits:
- **Filtering**: Use `watch.ts --filter myprefix` to show only matching sessions
- **Grouping**: Keep related work together (e.g., `--prefix auth-fix` for all auth-related sessions)
- **Avoiding collisions**: Distinguish agentwatch sessions from other tmux sessions

The default prefix is `awm` (agentwatch-minimal).

### Tags

The `--tag` flag stores a label in session metadata (`sessions.jsonl`). Tags are currently write-only—they're persisted but not displayed in the watch UI. They exist for future querying or custom scripts that read the JSONL directly.

### Mark Done

Pressing `d` in `watch.ts` marks a session as done. This does two things:
1. **Renames the tmux session** by appending `-done` (e.g., `awm-claude-m1abc23` → `awm-claude-m1abc23-done`)
2. **Writes metadata** to `sessions.jsonl` with `status: "done"`

The session keeps running—it's not killed. The `[done]` badge appears in the watch UI.

### Tips

- **Compare agents**: Launch the same prompt to claude and codex, watch them work, see which approach you prefer
- **Parallel decomposition**: Use `orchestrate.ts` for tasks with independent sub-parts (e.g., "add feature X, write tests, update docs")
- **Stay organized**: Use `--prefix` to group related sessions (e.g., `--prefix auth-fix`)
- **Quick check**: Use `watch.ts --once --last-line` for a snapshot without the refresh loop

### Options and When to Use Them

**launch.ts**
- `--agents` to compare outputs or parallelize a single prompt across CLIs
- `--cwd`/`--prefix` to target a project and keep related sessions grouped
- `--prompt-file` when prompts are long, reusable, or generated from scripts
- `--data-dir` to customize where session metadata is stored
- `--claude-flags`/`--codex-flags`/`--gemini-flags` to pass through agent-specific options

**orchestrate.ts**
- `--dry-run` to inspect the plan before launching (plan is discarded unless you also use `--save-plan`)
- `--dry-run --save-plan ./plan.json` to inspect AND save for later reuse
- `--plan-file ./plan.json` to rerun a saved plan without re-decomposing
- `--wait` to auto-launch dependent tasks when prerequisites complete
- `--cwd`/`--prefix` to scope where tasks run and keep them grouped in tmux
- `--tag`/`--data-dir` to label and persist orchestration metadata
- `--claude-flags`/`--codex-flags`/`--gemini-flags` to tune agent behavior per task

**watch.ts (view/interaction)**
- `--filter`/`--agents-only` to focus on just the sessions and panes you care about
- `--sort` to triage by activity or creation time
- `--interval` to trade off refresh rate vs system load
- `--no-last-line`/`--no-stats` for a minimal, low-noise view
- `--once`/`--no-interactive` for scriptable snapshots or non-TTY use

**watch.ts (hooks/notifications)**
- `--hooks-daemon` when you only want the hooks server (no TUI)
- `--no-hooks` to disable the embedded server when you only need tmux monitoring
- `--hooks-port` to match your local hook configuration
- `--forward-to` to fan out hook events to other services
- `--data-dir` to choose where hook and session metadata is stored
- `--notify-desktop`/`--notify-webhook`/`--notify-filter` to route alerts where you want them

### Shell Aliases (Recommended)

Add to `~/.zshrc` or `~/.bashrc` for quick access:

```bash
# Base path (adjust to your install location)
AWM_PATH="$HOME/projects/agentwatch-minimal"

# Quick launch
alias awm="bun run $AWM_PATH/launch.ts"
alias awm2="bun run $AWM_PATH/launch.ts --agents claude,codex"
alias awm-all="bun run $AWM_PATH/launch.ts --agents claude,codex,gemini"

# Watch sessions + hooks (unified TUI)
alias awm-watch="bun run $AWM_PATH/watch.ts --filter awm"
alias awm-w="awm-watch --last-line --stats"

# Hooks server only (daemon mode)
alias awm-hooks="bun run $AWM_PATH/watch.ts --hooks-daemon"

# Orchestrate
alias awm-orch="bun run $AWM_PATH/orchestrate.ts"
```

**Example workflow:**

```bash
# Compare claude and codex on same task
awm2 "Fix the authentication bug in src/auth.ts"

# Watch them work (in another terminal)
awm-w

# Attach to a specific session
tmux attach -t awm-claude-xxx
```

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
| `--prompt-file` | | (none) | Read prompt from file (`-` = stdin) |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Data directory for session metadata |
| `--tag` | | (none) | Tag stored in metadata (not displayed in UI yet) |
| `--claude-flags` | | (none) | Extra flags for Claude |
| `--codex-flags` | | (none) | Extra flags for Codex |
| `--gemini-flags` | | (none) | Extra flags for Gemini |
| `--help` | `-h` | | Show help |

**Examples:**

```bash
# Single agent
bun run launch.ts "Fix the authentication bug" --agents claude

# Multiple agents (launches in parallel)
bun run launch.ts "Write unit tests" --agents claude,codex

# Custom working directory
bun run launch.ts "Refactor this module" --cwd /path/to/project

# With agent-specific flags
bun run launch.ts "Auto-fix tests" --agents gemini --gemini-flags "--yolo"
bun run launch.ts "Refactor" --agents codex --codex-flags "--approval-mode full-auto"

# Prompt from file
bun run launch.ts --prompt-file ./prompt.txt --agents claude
```

---

### watch.ts

Unified TUI for monitoring tmux sessions and Claude Code hooks. Includes an embedded HTTP server that receives hook events and displays them in a two-column layout alongside your sessions.

```bash
bun run watch.ts [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--filter` | `-f` | (none) | Filter sessions by name prefix |
| `--interval` | `-i` | `2000` | Refresh interval in milliseconds |
| `--agents-only` | `-a` | `false` | Only show panes running agents |
| `--sort` | | (none) | Sort sessions: name, created, activity |
| `--no-last-line` | | `false` | Hide pane output (shown by default) |
| `--no-stats` | | `false` | Hide CPU/memory stats (shown by default) |
| `--hooks-port` | | `8702` | Hooks server port |
| `--no-hooks` | | `false` | Disable embedded hooks server |
| `--hooks-daemon` | | `false` | Run only hooks server (no TUI) |
| `--forward-to` | | (none) | Forward hooks to URL (repeatable) |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Data directory for hooks + sessions |
| `--notify-desktop` | | `false` | Send desktop notifications |
| `--notify-webhook` | | (none) | Send webhooks to URL |
| `--notify-filter` | | (none) | Comma-separated events to notify |
| `--once` | `-o` | `false` | Run once and exit (no refresh loop) |
| `--no-interactive` | | `false` | Disable interactive mode |
| `--help` | `-h` | | Show help |

**Interactive Keybindings:**

| Key | Action |
|-----|--------|
| `j`/`↓` | Move selection down |
| `k`/`↑` | Move selection up |
| `Enter`/`a` | Attach to selected session |
| `x` | Kill selected session |
| `d` | Mark done (renames session with `-done` suffix, keeps running) |
| `l` | Toggle last-line display |
| `s` | Toggle stats display |
| `f` | Toggle agents-only filter |
| `e` | Toggle expand all (default: only selected expanded) |
| `h` | Toggle hooks panel |
| `r` | Refresh now |
| `?` | Toggle help |
| `q` | Quit |

**Examples:**

```bash
# Watch sessions (stats + output shown by default)
bun run watch.ts --filter awm

# Only show agent panes (filter out shells)
bun run watch.ts --filter awm --agents-only

# Minimal view (no stats, no output)
bun run watch.ts --filter awm --no-stats --no-last-line

# Hooks server only (daemon mode, no TUI)
bun run watch.ts --hooks-daemon

# One-shot status check (non-interactive)
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
| `--dry-run` | `-n` | `false` | Show plan without launching (plan discarded unless `--save-plan` used) |
| `--wait` | `-w` | `false` | Wait for dependencies and auto-launch dependent tasks |
| `--prompt-file` | | (none) | Read task prompt from file (`-` = stdin) |
| `--plan-file` | | (none) | Use an existing plan JSON (skip decomposition) |
| `--save-plan` | | (none) | Save the generated plan to a file |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Data directory for session metadata |
| `--tag` | | (none) | Tag stored in metadata (not displayed in UI yet) |
| `--help` | `-h` | | Show help |

**How it works:**

1. Sends your prompt to Claude with instructions to decompose it
2. Claude returns a JSON plan with sub-tasks and dependencies
3. Independent tasks launch immediately in parallel
4. Dependent tasks either wait (`--wait`) or print manual instructions

**Examples:**

```bash
# Decompose and launch immediately
bun run orchestrate.ts "Build a REST API with auth, validation, and tests"

# Preview plan without launching (plan is discarded after display)
bun run orchestrate.ts "Refactor the payment module" --dry-run

# Preview AND save plan for later reuse
bun run orchestrate.ts "Refactor the payment module" --dry-run --save-plan ./plan.json

# Run a previously saved plan (skips decomposition)
bun run orchestrate.ts --plan-file ./plan.json

# Auto-execute dependent tasks when dependencies complete
bun run orchestrate.ts "Complex multi-step task" --wait

# Save plan while also launching
bun run orchestrate.ts "Refactor the payment module" --save-plan ./plan.json

# Reuse a saved plan
bun run orchestrate.ts --plan-file ./plan.json
```

---

### hooks.ts (standalone)

> **Note:** The unified `watch.ts` now includes an embedded hooks server. Use `watch.ts --hooks-daemon` for a headless hooks server. This standalone file is kept for backwards compatibility.

HTTP server for logging Claude Code hook events with optional notifications.

```bash
bun run hooks.ts [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `8702` | Server port |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Directory for hook logs |
| `--notify-desktop` | | `false` | Send desktop notifications |
| `--notify-webhook` | | (none) | Send webhooks to URL |
| `--notify-filter` | | (none) | Comma-separated events to notify |
| `--help` | `-h` | | Show help |

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

# With desktop notifications
bun run hooks.ts --notify-desktop

# With webhook notifications
bun run hooks.ts --notify-webhook https://example.com/webhook

# Only notify for specific events
bun run hooks.ts --notify-desktop --notify-filter pre-tool-use,error
```

---

### hooks-watch.ts (standalone)

> **Note:** The unified `watch.ts` now displays hooks in a two-column layout alongside sessions. This standalone file is kept for backwards compatibility or if you want a hooks-only view.

Live TUI for watching hook events.

```bash
bun run hooks-watch.ts [options]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--source` | | `file` | Source: "file" (JSONL) or "server" (HTTP) |
| `--port` | `-p` | `8702` | Hooks server port (for server source) |
| `--data-dir` | `-d` | `~/.agentwatch-minimal` | Data directory (for file source) |
| `--limit` | `-n` | `20` | Number of recent hooks to show |
| `--filter` | `-f` | (none) | Filter by event type |
| `--interval` | `-i` | `1000` | Refresh interval in milliseconds |
| `--once` | `-o` | `false` | Run once and exit |
| `--help` | `-h` | | Show help |

**Examples:**

```bash
# Watch hooks from JSONL file
bun run hooks-watch.ts

# Filter by event type
bun run hooks-watch.ts --filter pre-tool-use

# Watch from running server
bun run hooks-watch.ts --source server

# Show more events
bun run hooks-watch.ts --limit 50
```

---

## Claude Code Integration

### Hook Setup

Add to `~/.claude/settings.json` to send hooks to watch.ts:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "curl -sS -X POST http://localhost:8702/hooks/pre-tool-use -H 'Content-Type: application/json' -d @-"
        }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "curl -sS -X POST http://localhost:8702/hooks/post-tool-use -H 'Content-Type: application/json' -d @-"
        }]
      }
    ]
  }
}
```

### Forwarding to Multiple Servers

If you need to send hooks to multiple servers (e.g., agentwatch-minimal + another service), use the `--forward-to` flag:

```bash
# Forward hooks to another server
bun run watch.ts --forward-to http://localhost:8702/api/hooks

# Forward to multiple servers
bun run watch.ts --forward-to http://localhost:8702/api/hooks --forward-to http://example.com/hooks
```

The event name is appended to the URL (e.g., `http://localhost:8702/api/hooks/pre-tool-use`).

### Legacy: Bash Fanout Script

For client-side fanout (when you can't modify the watch.ts invocation), `bin/hook-fanout` can fan out hooks to multiple servers. See the script for configuration.

---

## Data Storage

```
~/.agentwatch-minimal/
  hooks.jsonl    # Append-only hook event log
  sessions.jsonl # Session metadata (prompt previews, tags, status)
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
