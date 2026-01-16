import { parseArgs } from "util";
import { readJsonlTail, expandHome } from "./lib/jsonl";
import { DEFAULT_DATA_DIR, DEFAULT_HOOKS_PORT, type HookEntry } from "./lib/types";

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  reset: "\x1b[0m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

// Color map for different event types
const EVENT_COLORS: Record<string, string> = {
  "pre-tool-use": ANSI.cyan,
  "post-tool-use": ANSI.green,
  "notification": ANSI.yellow,
  "error": ANSI.red,
};

function getEventColor(event: string): string {
  return EVENT_COLORS[event] || ANSI.blue;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString();
}

function formatPayload(payload: Record<string, unknown>, maxLen = 80): string {
  // Try to extract useful info from common hook payloads
  if (payload.tool_name) {
    const tool = payload.tool_name as string;
    const input = payload.tool_input as Record<string, unknown> | undefined;

    if (input) {
      // Show relevant input based on tool type
      if (tool === "Read" && input.file_path) {
        return `${tool}: ${input.file_path}`;
      }
      if (tool === "Write" && input.file_path) {
        return `${tool}: ${input.file_path}`;
      }
      if (tool === "Edit" && input.file_path) {
        return `${tool}: ${input.file_path}`;
      }
      if (tool === "Bash" && input.command) {
        const cmd = String(input.command).slice(0, 50);
        return `${tool}: ${cmd}${String(input.command).length > 50 ? "..." : ""}`;
      }
      if (tool === "Grep" && input.pattern) {
        return `${tool}: "${input.pattern}"`;
      }
      if (tool === "Glob" && input.pattern) {
        return `${tool}: ${input.pattern}`;
      }
      if (tool === "WebFetch" && input.url) {
        return `${tool}: ${input.url}`;
      }
    }
    return tool;
  }

  // Fallback: stringify and truncate
  const str = JSON.stringify(payload);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function renderHooks(
  hooks: HookEntry[],
  filter: string | undefined,
  showPayload: boolean
): string {
  let output = "";

  output += `${ANSI.bold}agentwatch-minimal${ANSI.reset} - hooks watcher\n`;
  output += `${ANSI.dim}${new Date().toLocaleTimeString()} | ${hooks.length} event(s)${filter ? ` (filter: ${filter})` : ""}${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(70)}${ANSI.reset}\n\n`;

  if (hooks.length === 0) {
    output += `${ANSI.dim}No hooks found${ANSI.reset}\n`;
    output += `\n${ANSI.dim}Configure Claude Code hooks to send events to:${ANSI.reset}\n`;
    output += `  POST http://localhost:${DEFAULT_HOOKS_PORT}/hooks/<event>\n`;
    return output;
  }

  // Show most recent first
  const reversed = [...hooks].reverse();

  for (const hook of reversed) {
    const color = getEventColor(hook.event);
    const time = formatTimestamp(hook.timestamp);
    const payloadStr = showPayload ? formatPayload(hook.payload) : "";

    output += `${ANSI.dim}${time}${ANSI.reset} `;
    output += `${color}${hook.event.padEnd(15)}${ANSI.reset} `;
    if (payloadStr) {
      output += `${ANSI.dim}${payloadStr}${ANSI.reset}`;
    }
    output += "\n";
  }

  output += `\n${ANSI.dim}Press Ctrl+C to exit${ANSI.reset}\n`;

  return output;
}

async function fetchHooksFromServer(
  port: number,
  limit: number,
  filter?: string
): Promise<HookEntry[]> {
  try {
    const url = new URL(`http://localhost:${port}/hooks/recent`);
    url.searchParams.set("limit", String(limit));
    if (filter) url.searchParams.set("event", filter);

    const res = await fetch(url.toString());
    if (!res.ok) return [];

    const data = await res.json() as { hooks: HookEntry[] };
    return data.hooks || [];
  } catch {
    return [];
  }
}

async function fetchHooksFromFile(
  dataDir: string,
  limit: number,
  filter?: string
): Promise<HookEntry[]> {
  const file = `${expandHome(dataDir)}/hooks.jsonl`;
  let hooks = await readJsonlTail<HookEntry>(file, limit * 2);

  if (filter) {
    hooks = hooks.filter((h) => h.event === filter);
  }

  return hooks.slice(-limit);
}

async function watchLoop(
  source: "server" | "file",
  port: number,
  dataDir: string,
  limit: number,
  filter: string | undefined,
  showPayload: boolean,
  intervalMs: number,
  once: boolean
): Promise<void> {
  process.stdout.write(ANSI.hideCursor);

  const cleanup = () => {
    process.stdout.write(ANSI.showCursor);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    const hooks = source === "server"
      ? await fetchHooksFromServer(port, limit, filter)
      : await fetchHooksFromFile(dataDir, limit, filter);

    const output = renderHooks(hooks, filter, showPayload);

    process.stdout.write(ANSI.clear);
    process.stdout.write(output);

    if (once) break;
    await Bun.sleep(intervalMs);
  }

  process.stdout.write(ANSI.showCursor);
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: "string", default: "file" },
      port: { type: "string", short: "p", default: String(DEFAULT_HOOKS_PORT) },
      "data-dir": { type: "string", short: "d", default: DEFAULT_DATA_DIR },
      limit: { type: "string", short: "n", default: "20" },
      filter: { type: "string", short: "f" },
      payload: { type: "boolean", default: true },
      interval: { type: "string", short: "i", default: "1000" },
      once: { type: "boolean", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`agentwatch-minimal hooks watcher

Usage:
  bun run hooks-watch.ts [options]

Options:
  --source         Source: "file" (read JSONL) or "server" (poll HTTP) (default: file)
  -p, --port       Hooks server port (default: ${DEFAULT_HOOKS_PORT})
  -d, --data-dir   Data directory for JSONL file (default: ${DEFAULT_DATA_DIR})
  -n, --limit      Number of recent hooks to show (default: 20)
  -f, --filter     Filter by event type (e.g., pre-tool-use)
  --payload        Show payload details (default: true)
  -i, --interval   Refresh interval in ms (default: 1000)
  -o, --once       Run once and exit (no refresh loop)
  -h, --help       Show this help

Examples:
  bun run hooks-watch.ts
  bun run hooks-watch.ts --filter pre-tool-use
  bun run hooks-watch.ts --source server --port 8750
  bun run hooks-watch.ts --limit 50 --once
`);
    process.exit(0);
  }

  const source = values.source === "server" ? "server" : "file";
  const port = parseInt(values.port!, 10);
  const dataDir = values["data-dir"]!;
  const limit = parseInt(values.limit!, 10);
  const filter = values.filter;
  const showPayload = values.payload !== false;
  const intervalMs = parseInt(values.interval!, 10);
  const once = values.once ?? false;

  await watchLoop(source, port, dataDir, limit, filter, showPayload, intervalMs, once);
}

main().catch(console.error);
