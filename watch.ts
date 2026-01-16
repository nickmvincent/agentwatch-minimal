import { parseArgs } from "util";
import { listSessions, capturePanes, getProcessStatsBatch, killSession } from "./lib/tmux";
import type { TmuxSessionInfo, ProcessStats } from "./lib/types";

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

// State for interactive mode
type WatchState = {
  filter: string | undefined;
  intervalMs: number;
  showLastLine: boolean;
  showStats: boolean;
  showHelp: boolean;
  selectedIndex: number;
  sessions: TmuxSessionInfo[];
};

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

function renderHelp(): string {
  return `
${ANSI.bold}Keybindings${ANSI.reset}
${ANSI.dim}${"─".repeat(40)}${ANSI.reset}

  ${ANSI.cyan}Navigation${ANSI.reset}
  j/↓      Move selection down
  k/↑      Move selection up
  Enter    Attach to selected session

  ${ANSI.cyan}Display${ANSI.reset}
  l        Toggle last line display
  s        Toggle CPU/memory stats
  r        Refresh now

  ${ANSI.cyan}Actions${ANSI.reset}
  a        Attach to selected session
  x        Kill selected session

  ${ANSI.cyan}General${ANSI.reset}
  h/?      Toggle this help
  q        Quit

${ANSI.dim}Press any key to close help${ANSI.reset}
`;
}

async function renderSessions(state: WatchState): Promise<string> {
  const { sessions, showLastLine, showStats, selectedIndex, showHelp, filter } = state;

  if (showHelp) {
    return renderHelp();
  }

  let output = "";
  const now = Math.floor(Date.now() / 1000);

  // Header
  output += `${ANSI.bold}agentwatch-minimal${ANSI.reset} - tmux watcher\n`;
  output += `${ANSI.dim}${new Date().toLocaleTimeString()} | ${sessions.length} session(s)`;
  if (filter) output += ` | filter: ${filter}`;
  output += `${ANSI.reset}\n`;

  // Status indicators
  const indicators = [];
  if (showLastLine) indicators.push(`${ANSI.green}L${ANSI.reset}`);
  if (showStats) indicators.push(`${ANSI.green}S${ANSI.reset}`);
  if (indicators.length > 0) {
    output += `${ANSI.dim}[${indicators.join(" ")}] l:last-line s:stats h:help q:quit${ANSI.reset}\n`;
  } else {
    output += `${ANSI.dim}l:last-line s:stats h:help q:quit${ANSI.reset}\n`;
  }
  output += `${ANSI.dim}${"─".repeat(60)}${ANSI.reset}\n\n`;

  if (sessions.length === 0) {
    output += `${ANSI.dim}No tmux sessions found${ANSI.reset}\n`;
    output += `\n${ANSI.dim}Start an agent with:${ANSI.reset}\n`;
    output += `  bun run launch.ts "your prompt" --agents claude\n`;
    return output;
  }

  // Collect all pane targets and PIDs
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

  // Batch fetch in parallel
  const [capturedLines, processStats] = await Promise.all([
    showLastLine ? capturePanes(paneTargets) : Promise.resolve(new Map<string, string | undefined>()),
    showStats ? getProcessStatsBatch(panePids) : Promise.resolve(new Map<number, ProcessStats>()),
  ]);

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const isSelected = i === selectedIndex;
    const attachIcon = session.attached ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
    const durationSec = session.created ? now - session.created : 0;
    const durationStr = durationSec > 0 ? `${ANSI.dim}(${formatDuration(durationSec)})${ANSI.reset}` : "";

    // Highlight selected session
    const selectMark = isSelected ? `${ANSI.inverse} ► ${ANSI.reset}` : "   ";
    const namePart = isSelected
      ? `${ANSI.bold}${ANSI.yellow}${session.name}${ANSI.reset}`
      : `${ANSI.bold}${session.name}${ANSI.reset}`;

    output += `${selectMark}${attachIcon} ${namePart} ${durationStr}\n`;

    for (const window of session.windowList) {
      const windowActive = window.active ? `${ANSI.yellow}*${ANSI.reset}` : " ";
      output += `     ${windowActive} ${window.index}:${ANSI.cyan}${window.name}${ANSI.reset}`;
      output += ` ${ANSI.dim}(${window.panes.length} pane${window.panes.length > 1 ? "s" : ""})${ANSI.reset}\n`;

      for (const pane of window.panes) {
        const paneActive = pane.active ? `${ANSI.green}>${ANSI.reset}` : " ";
        const idleStr = pane.idleSeconds !== undefined
          ? `${ANSI.dim}idle:${formatDuration(pane.idleSeconds)}${ANSI.reset}`
          : "";
        const cmdStr = pane.command ? `${ANSI.blue}${pane.command}${ANSI.reset}` : "";
        const statsStr = showStats && pane.panePid ? formatStats(processStats.get(pane.panePid)) : "";

        output += `       ${paneActive} ${pane.paneIndex}: ${cmdStr} ${idleStr} ${statsStr}\n`;

        if (showLastLine) {
          const target = `${session.name}:${window.index}.${pane.paneIndex}`;
          const lastLine = capturedLines.get(target);
          if (lastLine) {
            const truncated = lastLine.slice(0, 55);
            output += `         ${ANSI.dim}${truncated}${lastLine.length > 55 ? "..." : ""}${ANSI.reset}\n`;
          }
        }
      }
    }
    output += "\n";
  }

  // Footer with keybinds
  output += `${ANSI.dim}Enter:attach  x:kill  ↑↓/jk:navigate${ANSI.reset}\n`;

  return output;
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

  // Handle keyboard input
  process.stdin.on("data", async (key: string) => {
    const code = key.charCodeAt(0);

    // Handle escape sequences (arrow keys)
    if (key === "\x1b[A" || key === "k") {
      // Up arrow or k
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      needsRefresh = true;
    } else if (key === "\x1b[B" || key === "j") {
      // Down arrow or j
      state.selectedIndex = Math.min(state.sessions.length - 1, state.selectedIndex + 1);
      needsRefresh = true;
    } else if (key === "q" || code === 3) {
      // q or Ctrl+C
      cleanup();
    } else if (key === "h" || key === "?") {
      state.showHelp = !state.showHelp;
      needsRefresh = true;
    } else if (key === "l") {
      state.showLastLine = !state.showLastLine;
      needsRefresh = true;
    } else if (key === "s") {
      state.showStats = !state.showStats;
      needsRefresh = true;
    } else if (key === "r") {
      needsRefresh = true;
    } else if ((key === "\r" || key === "\n" || key === "a") && state.sessions.length > 0) {
      // Enter or 'a' - attach to selected session
      const session = state.sessions[state.selectedIndex];
      if (session) {
        await attachToSession(session.name);
        // After returning from tmux, restart raw mode and refresh
        setupRawMode();
        process.stdout.write(ANSI.hideCursor);
        needsRefresh = true;
      }
    } else if (key === "x" && state.sessions.length > 0) {
      // Kill selected session
      const session = state.sessions[state.selectedIndex];
      if (session) {
        await killSession(session.name);
        state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.sessions.length - 2));
        needsRefresh = true;
      }
    } else if (state.showHelp) {
      // Any key closes help
      state.showHelp = false;
      needsRefresh = true;
    }
  });

  // Main loop
  while (true) {
    const now = Date.now();

    if (needsRefresh || now - lastRefresh >= state.intervalMs) {
      // Refresh session list
      state.sessions = await listSessions(state.filter);

      // Clamp selected index
      if (state.sessions.length > 0) {
        state.selectedIndex = Math.min(state.selectedIndex, state.sessions.length - 1);
      } else {
        state.selectedIndex = 0;
      }

      const output = await renderSessions(state);
      process.stdout.write(ANSI.clear);
      process.stdout.write(output);

      lastRefresh = now;
      needsRefresh = false;
    }

    await Bun.sleep(100); // Short sleep for responsive key handling
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
    const output = await renderSessions(state);

    process.stdout.write(ANSI.clear);
    process.stdout.write(output);

    if (once) break;
    await Bun.sleep(state.intervalMs);
  }

  process.stdout.write(ANSI.showCursor);
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      filter: { type: "string", short: "f" },
      interval: { type: "string", short: "i", default: "2000" },
      "last-line": { type: "boolean", short: "l" },
      stats: { type: "boolean", short: "s" },
      once: { type: "boolean", short: "o" },
      "no-interactive": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`agentwatch-minimal watcher

Usage:
  bun run watch.ts [options]

Options:
  -f, --filter        Filter sessions by prefix (e.g., awm)
  -i, --interval      Refresh interval in ms (default: 2000)
  -l, --last-line     Show last line of each pane
  -s, --stats         Show CPU/memory stats for each pane
  -o, --once          Run once and exit (no refresh loop)
  --no-interactive    Disable interactive mode (no keyboard input)
  -h, --help          Show this help

Interactive Keybindings:
  j/↓       Move selection down
  k/↑       Move selection up
  Enter/a   Attach to selected session
  x         Kill selected session
  l         Toggle last-line display
  s         Toggle stats display
  r         Refresh now
  h/?       Toggle help
  q         Quit

Examples:
  bun run watch.ts --filter awm
  bun run watch.ts --filter awm --last-line --stats
  bun run watch.ts --once --no-interactive
`);
    process.exit(0);
  }

  const state: WatchState = {
    filter: values.filter,
    intervalMs: parseInt(values.interval!, 10),
    showLastLine: values["last-line"] ?? false,
    showStats: values.stats ?? false,
    showHelp: false,
    selectedIndex: 0,
    sessions: [],
  };

  const once = values.once ?? false;
  const noInteractive = values["no-interactive"] ?? false;

  if (once || noInteractive || !process.stdin.isTTY) {
    await nonInteractiveLoop(state, once);
  } else {
    await interactiveLoop(state);
  }
}

main().catch(console.error);
