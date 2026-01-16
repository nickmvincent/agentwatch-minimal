import { parseArgs } from "util";
import { listSessions, capturePanes, getProcessStatsBatch } from "./lib/tmux";
import type { TmuxSessionInfo, ProcessStats } from "./lib/types";

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
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

async function renderSessions(
  sessions: TmuxSessionInfo[],
  showLastLine: boolean,
  showStats: boolean
): Promise<string> {
  let output = "";
  const now = Math.floor(Date.now() / 1000);

  output += `${ANSI.bold}agentwatch-minimal${ANSI.reset} - tmux watcher\n`;
  output += `${ANSI.dim}${new Date().toLocaleTimeString()} | ${sessions.length} session(s)${ANSI.reset}\n`;
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

  for (const session of sessions) {
    const attachIcon = session.attached ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
    const durationSec = session.created ? now - session.created : 0;
    const durationStr = durationSec > 0 ? `${ANSI.dim}(${formatDuration(durationSec)})${ANSI.reset}` : "";

    output += `${attachIcon} ${ANSI.bold}${session.name}${ANSI.reset} ${durationStr}\n`;

    for (const window of session.windowList) {
      const windowActive = window.active ? `${ANSI.yellow}*${ANSI.reset}` : " ";
      output += `  ${windowActive} ${window.index}:${ANSI.cyan}${window.name}${ANSI.reset}`;
      output += ` ${ANSI.dim}(${window.panes.length} pane${window.panes.length > 1 ? "s" : ""})${ANSI.reset}\n`;

      for (const pane of window.panes) {
        const paneActive = pane.active ? `${ANSI.green}>${ANSI.reset}` : " ";
        const idleStr = pane.idleSeconds !== undefined
          ? `${ANSI.dim}idle:${formatDuration(pane.idleSeconds)}${ANSI.reset}`
          : "";
        const cmdStr = pane.command ? `${ANSI.blue}${pane.command}${ANSI.reset}` : "";
        const statsStr = showStats && pane.panePid ? formatStats(processStats.get(pane.panePid)) : "";

        output += `    ${paneActive} ${pane.paneIndex}: ${cmdStr} ${idleStr} ${statsStr}\n`;

        if (showLastLine) {
          const target = `${session.name}:${window.index}.${pane.paneIndex}`;
          const lastLine = capturedLines.get(target);
          if (lastLine) {
            const truncated = lastLine.slice(0, 60);
            output += `      ${ANSI.dim}${truncated}${lastLine.length > 60 ? "..." : ""}${ANSI.reset}\n`;
          }
        }
      }
    }
    output += "\n";
  }

  output += `${ANSI.dim}Press Ctrl+C to exit${ANSI.reset}\n`;

  return output;
}

async function watchLoop(
  filter: string | undefined,
  intervalMs: number,
  showLastLine: boolean,
  showStats: boolean,
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
    const sessions = await listSessions(filter);
    const output = await renderSessions(sessions, showLastLine, showStats);

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
      filter: { type: "string", short: "f" },
      interval: { type: "string", short: "i", default: "2000" },
      "last-line": { type: "boolean", short: "l" },
      stats: { type: "boolean", short: "s" },
      once: { type: "boolean", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`agentwatch-minimal watcher

Usage:
  bun run watch.ts [options]

Options:
  -f, --filter      Filter sessions by prefix (e.g., awm)
  -i, --interval    Refresh interval in ms (default: 2000)
  -l, --last-line   Show last line of each pane
  -s, --stats       Show CPU/memory stats for each pane
  -o, --once        Run once and exit (no refresh loop)
  -h, --help        Show this help

Examples:
  bun run watch.ts --filter awm
  bun run watch.ts --filter awm --last-line --stats
  bun run watch.ts --interval 1000
`);
    process.exit(0);
  }

  const filter = values.filter;
  const intervalMs = parseInt(values.interval!, 10);
  const showLastLine = values["last-line"] ?? false;
  const showStats = values.stats ?? false;
  const once = values.once ?? false;

  await watchLoop(filter, intervalMs, showLastLine, showStats, once);
}

main().catch(console.error);
