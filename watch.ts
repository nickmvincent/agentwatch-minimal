import { parseArgs } from "util";
import { Hono } from "hono";
import { serve } from "bun";
import { listSessions, capturePanes, getProcessStatsBatch, killSession } from "./lib/tmux";
import { createId } from "./lib/ids";
import { appendJsonl, readJsonlTail, expandHome } from "./lib/jsonl";
import { notifyHook, type NotificationConfig } from "./lib/notify";
import type { TmuxSessionInfo, ProcessStats, HookEntry } from "./lib/types";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR } from "./lib/types";

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  inverse: "\x1b[7m",
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

// Color map for hook event types
const EVENT_COLORS: Record<string, string> = {
  "pre-tool-use": ANSI.cyan,
  "post-tool-use": ANSI.green,
  "notification": ANSI.yellow,
  "error": ANSI.red,
};

// Known agent process names
const AGENT_COMMANDS = new Set(["claude", "codex", "gemini", "node", "bun"]);

function isAgentCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return AGENT_COMMANDS.has(cmd.toLowerCase());
}

// State for the unified TUI
type WatchState = {
  filter: string | undefined;
  intervalMs: number;
  showLastLine: boolean;
  showStats: boolean;
  showHelp: boolean;
  showHooks: boolean;
  agentsOnly: boolean;
  selectedIndex: number;
  sessions: TmuxSessionInfo[];
  recentHooks: HookEntry[];
  hooksPort: number;
  hooksEnabled: boolean;
  notifyConfig: NotificationConfig;
  dataDir: string;
};

// In-memory ring buffer for hooks (most recent N)
const MAX_HOOKS_BUFFER = 100;
let hooksBuffer: HookEntry[] = [];

function addHookToBuffer(hook: HookEntry): void {
  hooksBuffer.push(hook);
  if (hooksBuffer.length > MAX_HOOKS_BUFFER) {
    hooksBuffer = hooksBuffer.slice(-MAX_HOOKS_BUFFER);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatMemory(kb: number): string {
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

function formatStats(stats: ProcessStats | undefined): string {
  if (!stats) return "";
  const cpu = stats.cpu > 0 ? `${stats.cpu.toFixed(0)}%` : "0%";
  const mem = formatMemory(stats.rss);
  return `${ANSI.cyan}cpu:${cpu} mem:${mem}${ANSI.reset}`;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatHookPayload(payload: Record<string, unknown>, maxLen = 35): string {
  if (payload.tool_name) {
    const tool = payload.tool_name as string;
    const input = payload.tool_input as Record<string, unknown> | undefined;
    if (input) {
      if ((tool === "Read" || tool === "Write" || tool === "Edit") && input.file_path) {
        const path = String(input.file_path).split("/").pop() || input.file_path;
        return `${tool}: ${path}`;
      }
      if (tool === "Bash" && input.command) {
        const cmd = String(input.command).slice(0, 25);
        return `${tool}: ${cmd}${String(input.command).length > 25 ? "…" : ""}`;
      }
      if ((tool === "Grep" || tool === "Glob") && input.pattern) {
        return `${tool}: ${String(input.pattern).slice(0, 20)}`;
      }
    }
    return tool;
  }
  const str = JSON.stringify(payload);
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + "…";
}

function getEventColor(event: string): string {
  return EVENT_COLORS[event] || ANSI.blue;
}

function renderHelp(): string {
  return `
${ANSI.bold}Keybindings${ANSI.reset}
${ANSI.dim}${"─".repeat(50)}${ANSI.reset}

  ${ANSI.cyan}Navigation${ANSI.reset}
  j/↓      Move selection down
  k/↑      Move selection up
  Enter/a  Attach to selected session

  ${ANSI.cyan}Display${ANSI.reset}
  l        Toggle last line output
  s        Toggle CPU/memory stats
  f        Toggle agents-only filter
  h        Toggle hooks panel
  r        Refresh now

  ${ANSI.cyan}Actions${ANSI.reset}
  x        Kill selected session

  ${ANSI.cyan}General${ANSI.reset}
  ?        Toggle this help
  q        Quit

${ANSI.dim}Press any key to close help${ANSI.reset}
`;
}

function renderTwoColumn(state: WatchState, leftContent: string, rightContent: string): string {
  const termWidth = process.stdout.columns || 120;
  const leftWidth = Math.floor(termWidth * 0.55);
  const rightWidth = termWidth - leftWidth - 3; // 3 for separator

  const leftLines = leftContent.split("\n");
  const rightLines = rightContent.split("\n");
  const maxLines = Math.max(leftLines.length, rightLines.length);

  let output = "";

  for (let i = 0; i < maxLines; i++) {
    const left = leftLines[i] || "";
    const right = rightLines[i] || "";

    // Strip ANSI for length calculation
    const leftPlain = left.replace(/\x1b\[[0-9;]*m/g, "");
    const rightPlain = right.replace(/\x1b\[[0-9;]*m/g, "");

    // Truncate if needed
    const leftTrunc = leftPlain.length > leftWidth
      ? left.slice(0, leftWidth - 1) + "…"
      : left + " ".repeat(Math.max(0, leftWidth - leftPlain.length));

    const rightTrunc = rightPlain.length > rightWidth
      ? right.slice(0, rightWidth - 1) + "…"
      : right;

    output += `${leftTrunc}${ANSI.dim}│${ANSI.reset} ${rightTrunc}\n`;
  }

  return output;
}

function renderSessions(state: WatchState, capturedLines: Map<string, string | undefined>, processStats: Map<number, ProcessStats>): string {
  const { sessions, showLastLine, showStats, selectedIndex, filter, agentsOnly } = state;
  const now = Math.floor(Date.now() / 1000);

  let output = "";
  output += `${ANSI.bold}Sessions${ANSI.reset}`;
  if (filter) output += ` ${ANSI.dim}(${filter})${ANSI.reset}`;
  if (agentsOnly) output += ` ${ANSI.magenta}[agents]${ANSI.reset}`;
  output += `\n${ANSI.dim}${"─".repeat(35)}${ANSI.reset}\n`;

  if (sessions.length === 0) {
    output += `${ANSI.dim}No sessions found${ANSI.reset}\n`;
    return output;
  }

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const isSelected = i === selectedIndex;

    // Filter panes to only agents if agentsOnly is set
    const filteredWindows = agentsOnly
      ? session.windowList.map(w => ({
          ...w,
          panes: w.panes.filter(p => isAgentCommand(p.command))
        })).filter(w => w.panes.length > 0)
      : session.windowList;

    // Skip session entirely if no matching panes
    if (agentsOnly && filteredWindows.length === 0) continue;

    const attachIcon = session.attached ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
    const durationSec = session.created ? now - session.created : 0;
    const durationStr = durationSec > 0 ? `${ANSI.dim}${formatDuration(durationSec)}${ANSI.reset}` : "";

    const selectMark = isSelected ? `${ANSI.inverse}►${ANSI.reset}` : " ";
    const namePart = isSelected
      ? `${ANSI.bold}${ANSI.yellow}${session.name}${ANSI.reset}`
      : `${ANSI.bold}${session.name}${ANSI.reset}`;

    output += `${selectMark}${attachIcon} ${namePart} ${durationStr}\n`;

    for (const window of filteredWindows) {
      // Compact: skip window line if only 1 window with 1 pane
      const showWindowLine = session.windowList.length > 1 || window.panes.length > 1;
      if (showWindowLine) {
        const windowActive = window.active ? `${ANSI.yellow}*${ANSI.reset}` : " ";
        output += `   ${windowActive}${window.index}:${ANSI.cyan}${window.name}${ANSI.reset}\n`;
      }

      for (const pane of window.panes) {
        const indent = showWindowLine ? "    " : "  ";
        const paneActive = pane.active ? `${ANSI.green}›${ANSI.reset}` : " ";
        const cmdStr = pane.command ? `${ANSI.blue}${pane.command}${ANSI.reset}` : "";
        const statsStr = showStats && pane.panePid ? ` ${formatStats(processStats.get(pane.panePid))}` : "";

        // Compact: command + stats on same line
        output += `${indent}${paneActive}${cmdStr}${statsStr}\n`;

        if (showLastLine) {
          const target = `${session.name}:${window.index}.${pane.paneIndex}`;
          const lastLine = capturedLines.get(target);
          if (lastLine) {
            const truncated = lastLine.slice(0, 38);
            output += `${indent} ${ANSI.dim}${truncated}${lastLine.length > 38 ? "…" : ""}${ANSI.reset}\n`;
          }
        }
      }
    }
  }

  return output;
}

function renderHooks(state: WatchState): string {
  const hooks = state.recentHooks.slice(-20);

  let output = "";
  output += `${ANSI.bold}Hooks${ANSI.reset} ${ANSI.dim}(:${state.hooksPort})${ANSI.reset}`;
  output += ` ${ANSI.dim}${hooks.length} recent${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(35)}${ANSI.reset}\n`;

  if (hooks.length === 0) {
    output += `${ANSI.dim}No hooks yet${ANSI.reset}\n`;
    output += `${ANSI.dim}Listening on :${state.hooksPort}${ANSI.reset}\n`;
    return output;
  }

  // Show most recent first
  const reversed = [...hooks].reverse().slice(0, 15);
  for (const hook of reversed) {
    const color = getEventColor(hook.event);
    const time = formatTimestamp(hook.timestamp);
    const eventShort = hook.event.replace("pre-tool-use", "pre").replace("post-tool-use", "post");
    const payloadStr = formatHookPayload(hook.payload);

    output += `${ANSI.dim}${time}${ANSI.reset} `;
    output += `${color}${eventShort.padEnd(5)}${ANSI.reset} `;
    output += `${ANSI.dim}${payloadStr}${ANSI.reset}\n`;
  }

  return output;
}

async function renderDisplay(state: WatchState): Promise<string> {
  const { sessions, showLastLine, showStats, showHelp, showHooks, agentsOnly } = state;

  if (showHelp) {
    return renderHelp();
  }

  let output = "";
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });

  // Header
  output += `${ANSI.bold}agentwatch${ANSI.reset} ${ANSI.dim}${now}${ANSI.reset}\n`;

  // Status indicators
  const indicators = [];
  if (showLastLine) indicators.push(`${ANSI.green}L${ANSI.reset}`);
  if (showStats) indicators.push(`${ANSI.green}S${ANSI.reset}`);
  if (agentsOnly) indicators.push(`${ANSI.magenta}F${ANSI.reset}`);
  if (showHooks) indicators.push(`${ANSI.green}H${ANSI.reset}`);

  output += `${ANSI.dim}[${indicators.join("")}] l:line s:stats f:filter h:hooks ?:help q:quit${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(70)}${ANSI.reset}\n\n`;

  // Collect pane data
  const paneTargets: string[] = [];
  const panePids: number[] = [];

  for (const session of sessions) {
    for (const window of session.windowList) {
      for (const pane of window.panes) {
        if (showLastLine) {
          paneTargets.push(`${session.name}:${window.index}.${pane.paneIndex}`);
        }
        if (showStats && pane.panePid) {
          panePids.push(pane.panePid);
        }
      }
    }
  }

  const [capturedLines, processStats] = await Promise.all([
    showLastLine ? capturePanes(paneTargets) : Promise.resolve(new Map<string, string | undefined>()),
    showStats ? getProcessStatsBatch(panePids) : Promise.resolve(new Map<number, ProcessStats>()),
  ]);

  const sessionsContent = renderSessions(state, capturedLines, processStats);

  if (showHooks && state.hooksEnabled) {
    const hooksContent = renderHooks(state);
    output += renderTwoColumn(state, sessionsContent, hooksContent);
  } else {
    output += sessionsContent;
  }

  // Footer
  output += `\n${ANSI.dim}Enter:attach x:kill ↑↓/jk:nav${state.hooksEnabled ? ` │ hooks::${state.hooksPort}` : ""}${ANSI.reset}\n`;

  return output;
}

// Create hooks HTTP server
function createHooksApp(state: WatchState): Hono {
  const app = new Hono();
  const hooksFile = () => `${expandHome(state.dataDir)}/hooks.jsonl`;

  app.post("/hooks/:event", async (c) => {
    const event = c.req.param("event");
    const payload = await c.req.json().catch(() => ({}));

    const entry: HookEntry = {
      id: createId("hook"),
      timestamp: new Date().toISOString(),
      event,
      payload,
    };

    // Add to in-memory buffer
    addHookToBuffer(entry);
    state.recentHooks = hooksBuffer;

    // Write to file
    await appendJsonl(hooksFile(), entry);

    // Notify if configured
    if (state.notifyConfig.desktop || state.notifyConfig.webhook) {
      notifyHook(entry, state.notifyConfig).catch(() => {});
    }

    return c.json({});
  });

  app.get("/hooks/recent", async (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const event = c.req.query("event");

    let hooks = await readJsonlTail<HookEntry>(hooksFile(), limit * 2);
    if (event) hooks = hooks.filter((h) => h.event === event);

    return c.json({ ok: true, hooks: hooks.slice(-limit), total: hooks.length });
  });

  app.get("/hooks/health", (c) => c.json({ ok: true, service: "agentwatch" }));
  app.get("/", (c) => c.json({
    service: "agentwatch",
    endpoints: ["POST /hooks/:event", "GET /hooks/recent", "GET /hooks/health"],
  }));

  return app;
}

function setupRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
}

function cleanupRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdout.write(ANSI.showCursor);
}

async function attachToSession(sessionName: string): Promise<void> {
  cleanupRawMode();
  process.stdout.write(ANSI.clear);

  const proc = Bun.spawn(["tmux", "attach", "-t", sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

async function interactiveLoop(state: WatchState): Promise<void> {
  process.stdout.write(ANSI.hideCursor);
  setupRawMode();

  const cleanup = () => {
    cleanupRawMode();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let needsRefresh = true;
  let lastRefresh = 0;

  process.stdin.on("data", async (key: string) => {
    const code = key.charCodeAt(0);

    if (key === "\x1b[A" || key === "k") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      needsRefresh = true;
    } else if (key === "\x1b[B" || key === "j") {
      state.selectedIndex = Math.min(state.sessions.length - 1, state.selectedIndex + 1);
      needsRefresh = true;
    } else if (key === "q" || code === 3) {
      cleanup();
    } else if (key === "?") {
      state.showHelp = !state.showHelp;
      needsRefresh = true;
    } else if (key === "l") {
      state.showLastLine = !state.showLastLine;
      needsRefresh = true;
    } else if (key === "s") {
      state.showStats = !state.showStats;
      needsRefresh = true;
    } else if (key === "h") {
      state.showHooks = !state.showHooks;
      needsRefresh = true;
    } else if (key === "f") {
      state.agentsOnly = !state.agentsOnly;
      needsRefresh = true;
    } else if (key === "r") {
      needsRefresh = true;
    } else if ((key === "\r" || key === "\n" || key === "a") && state.sessions.length > 0) {
      const session = state.sessions[state.selectedIndex];
      if (session) {
        await attachToSession(session.name);
        setupRawMode();
        process.stdout.write(ANSI.hideCursor);
        needsRefresh = true;
      }
    } else if (key === "x" && state.sessions.length > 0) {
      const session = state.sessions[state.selectedIndex];
      if (session) {
        await killSession(session.name);
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.sessions.length - 2));
        needsRefresh = true;
      }
    } else if (state.showHelp) {
      state.showHelp = false;
      needsRefresh = true;
    }
  });

  while (true) {
    const now = Date.now();

    if (needsRefresh || now - lastRefresh >= state.intervalMs) {
      state.sessions = await listSessions(state.filter);
      state.recentHooks = hooksBuffer;

      if (state.sessions.length > 0) {
        state.selectedIndex = Math.min(state.selectedIndex, state.sessions.length - 1);
      } else {
        state.selectedIndex = 0;
      }

      const output = await renderDisplay(state);
      process.stdout.write(ANSI.clear);
      process.stdout.write(output);

      lastRefresh = now;
      needsRefresh = false;
    }

    await Bun.sleep(100);
  }
}

async function nonInteractiveLoop(state: WatchState, once: boolean): Promise<void> {
  process.stdout.write(ANSI.hideCursor);

  const cleanup = () => {
    process.stdout.write(ANSI.showCursor);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    state.sessions = await listSessions(state.filter);
    state.recentHooks = hooksBuffer;
    const output = await renderDisplay(state);

    process.stdout.write(ANSI.clear);
    process.stdout.write(output);

    if (once) break;
    await Bun.sleep(state.intervalMs);
  }

  process.stdout.write(ANSI.showCursor);
}

async function daemonMode(state: WatchState): Promise<void> {
  console.log(`agentwatch hooks server (daemon mode)`);
  console.log(`  Port: ${state.hooksPort}`);
  console.log(`  Data: ${expandHome(state.dataDir)}/hooks.jsonl`);
  if (state.notifyConfig.desktop) console.log(`  Desktop notifications: enabled`);
  if (state.notifyConfig.webhook) console.log(`  Webhook: ${state.notifyConfig.webhook}`);
  console.log();
  console.log(`Listening on http://localhost:${state.hooksPort}`);

  // Keep process alive
  await new Promise(() => {});
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      filter: { type: "string", short: "f" },
      interval: { type: "string", short: "i", default: "2000" },
      "no-last-line": { type: "boolean" },
      "no-stats": { type: "boolean" },
      "agents-only": { type: "boolean", short: "a" },
      hooks: { type: "boolean", default: true },
      "hooks-port": { type: "string", default: String(DEFAULT_HOOKS_PORT) },
      "hooks-daemon": { type: "boolean" },
      "no-hooks": { type: "boolean" },
      "data-dir": { type: "string", short: "d", default: DEFAULT_DATA_DIR },
      "notify-desktop": { type: "boolean" },
      "notify-webhook": { type: "string" },
      "notify-filter": { type: "string" },
      once: { type: "boolean", short: "o" },
      "no-interactive": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`agentwatch - unified tmux + hooks watcher

Usage:
  bun run watch.ts [options]

Options:
  -f, --filter        Filter sessions by prefix (e.g., awm)
  -i, --interval      Refresh interval in ms (default: 2000)
  -a, --agents-only   Only show panes running agents (claude/codex/gemini)
  --no-last-line      Hide pane output (shown by default)
  --no-stats          Hide CPU/memory stats (shown by default)

  --hooks-port        Hooks server port (default: ${DEFAULT_HOOKS_PORT})
  --no-hooks          Disable embedded hooks server
  --hooks-daemon      Run only hooks server (no TUI, headless)

  -d, --data-dir      Data directory (default: ${DEFAULT_DATA_DIR})
  --notify-desktop    Send desktop notifications for hooks
  --notify-webhook    Send webhooks to URL for each hook
  --notify-filter     Comma-separated events to notify

  -o, --once          Run once and exit (no refresh loop)
  --no-interactive    Disable interactive mode
  -h, --help          Show this help

Interactive Keybindings:
  j/↓       Move selection down
  k/↑       Move selection up
  Enter/a   Attach to selected session
  x         Kill selected session
  l         Toggle last-line display
  s         Toggle stats display
  f         Toggle agents-only filter
  h         Toggle hooks panel
  r         Refresh now
  ?         Toggle help
  q         Quit

Examples:
  bun run watch.ts --filter awm
  bun run watch.ts --filter awm --agents-only
  bun run watch.ts --no-stats --no-last-line
  bun run watch.ts --hooks-daemon
`);
    process.exit(0);
  }

  const hooksEnabled = !values["no-hooks"];
  const hooksPort = parseInt(values["hooks-port"]!, 10);
  const isDaemon = values["hooks-daemon"] ?? false;

  const state: WatchState = {
    filter: values.filter,
    intervalMs: parseInt(values.interval!, 10),
    showLastLine: !values["no-last-line"],  // ON by default
    showStats: !values["no-stats"],          // ON by default
    showHelp: false,
    showHooks: hooksEnabled,
    agentsOnly: values["agents-only"] ?? false,
    selectedIndex: 0,
    sessions: [],
    recentHooks: [],
    hooksPort,
    hooksEnabled,
    dataDir: values["data-dir"]!,
    notifyConfig: {
      desktop: values["notify-desktop"] ?? false,
      webhook: values["notify-webhook"],
      filter: values["notify-filter"]?.split(",").map((s) => s.trim()),
    },
  };

  // Load existing hooks from file into buffer
  if (hooksEnabled) {
    const hooksFile = `${expandHome(state.dataDir)}/hooks.jsonl`;
    const existing = await readJsonlTail<HookEntry>(hooksFile, MAX_HOOKS_BUFFER).catch(() => []);
    hooksBuffer = existing;
    state.recentHooks = hooksBuffer;
  }

  // Start hooks server
  let server: ReturnType<typeof serve> | undefined;
  if (hooksEnabled) {
    const app = createHooksApp(state);
    server = serve({
      fetch: app.fetch,
      port: hooksPort,
    });
  }

  // Daemon mode: just run hooks server, no TUI
  if (isDaemon) {
    if (!hooksEnabled) {
      console.error("Error: --hooks-daemon requires hooks to be enabled (don't use --no-hooks)");
      process.exit(1);
    }
    await daemonMode(state);
    return;
  }

  const once = values.once ?? false;
  const noInteractive = values["no-interactive"] ?? false;

  if (once || noInteractive || !process.stdin.isTTY) {
    await nonInteractiveLoop(state, once);
  } else {
    await interactiveLoop(state);
  }
}

main().catch(console.error);
