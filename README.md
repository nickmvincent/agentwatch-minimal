# agentwatch-minimal

Lightweight toolkit for launching and monitoring coding agents (Claude Code, Codex, Gemini CLI) in tmux sessions.

## Features

- **launch** - Spawn agents with the same prompt across multiple agents
- **orchestrate** - Use Claude to decompose complex prompts into parallel sub-tasks
- **watch** - Monitor tmux sessions with a live ANSI display
- **hooks** - HTTP server for logging Claude Code hook events

## Install

```bash
bun install
```

## Usage

### Launch agents

```bash
# Launch Claude with a prompt
bun run launch.ts "Fix the authentication bug" --agents claude

# Launch same prompt to multiple agents
bun run launch.ts "Write unit tests for the parser" --agents claude,codex

# Specify working directory
bun run launch.ts "Refactor this module" --agents claude --cwd /path/to/project
```

### Watch sessions

```bash
# Watch all agentwatch-minimal sessions
bun run watch.ts --filter awm

# Show last line of output from each pane
bun run watch.ts --filter awm --last-line

# Run once (no refresh loop)
bun run watch.ts --once
```

### Orchestrate complex tasks

```bash
# Decompose a task and launch sub-agents
bun run orchestrate.ts "Build a REST API with authentication, validation, and tests"

# Dry run - show the plan without launching
bun run orchestrate.ts "Refactor the payment module" --dry-run
```

### Hooks server

```bash
# Start the hooks logger
bun run hooks.ts

# Custom port
bun run hooks.ts --port 8751

# Query recent hooks
curl http://localhost:8750/hooks/recent
```

## Claude Code Integration

To send Claude Code hooks to this server, update your `~/.claude/settings.json`:

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
    ]
  }
}
```

### Hook fanout (multiple servers)

Use `bin/hook-fanout` to send hooks to multiple servers with smart port detection:

```bash
# Install the fanout script
cp bin/hook-fanout ~/.local/bin/
chmod +x ~/.local/bin/hook-fanout
```

Then configure Claude Code to use it:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "~/.local/bin/hook-fanout pre-tool-use" }] }
    ]
  }
}
```

Edit the `TARGETS` array in the script to add/remove endpoints.

## Data Storage

All data is stored in `~/.agentwatch-minimal/`:

```
~/.agentwatch-minimal/
  hooks.jsonl    # Append-only hook event log
```

## Development

```bash
# Run tests
bun test

# Type check
bunx tsc --noEmit
```

## License

MIT
