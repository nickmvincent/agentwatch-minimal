import { parseArgs } from "util";
import { Hono } from "hono";
import { serve } from "bun";
import {
  listSessions,
  capturePanes,
  getProcessStatsBatch,
  detectAgentsBatch,
  killSession,
  renameSession,
  hasSession,
  type DetectedAgent,
} from "./lib/tmux";
import { createId } from "./lib/ids";
import { appendJsonl, readJsonlTail, expandHome } from "./lib/jsonl";
import { notifyHook, type NotificationConfig } from "./lib/notify";
import type { TmuxSessionInfo, ProcessStats, HookEntry, SessionMetaEntry } from "./lib/types";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR } from "./lib/types";
import { appendSessionMeta, buildSessionMetaMap, readSessionMeta } from "./lib/sessions";

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

type SortMode = "name" | "created" | "activity";

// State for the unified TUI
type WatchState = {
  filter: string | undefined;
  intervalMs: number;
  showLastLine: boolean;
  showStats: boolean;
  showHelp: boolean;
  showHooks: boolean;
  agentsOnly: boolean;
  expandAll: boolean;  // false = only selected session expanded
  sortBy?: SortMode;
  selectedIndex: number;
  scrollOffset: number;  // for viewport scrolling
  sessions: TmuxSessionInfo[];
  visibleSessions: TmuxSessionInfo[];
  sessionMeta: Map<string, SessionMetaEntry>;
  agentCache: Map<string, string>;  // session name -> detected agent (persists across refreshes)
  recentHooks: HookEntry[];
  hooksPort: number;
  hooksEnabled: boolean;
  forwardUrls: string[];  // URLs to forward hooks to
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
  e        Toggle expand all sessions
  h        Toggle hooks panel
  r        Refresh now

  ${ANSI.cyan}Actions${ANSI.reset}
  x        Kill selected session
  d        Mark session done

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

function getFilteredWindows(session: TmuxSessionInfo, agentsOnly: boolean) {
  if (!agentsOnly) return session.windowList;
  return session.windowList
    .map(w => ({ ...w, panes: w.panes.filter(p => isAgentCommand(p.command)) }))
    .filter(w => w.panes.length > 0);
}

function countAgentPanes(session: TmuxSessionInfo): number {
  return session.windowList.reduce((sum, w) =>
    sum + w.panes.filter(p => isAgentCommand(p.command)).length, 0);
}

function parseSortMode(input: string | undefined): SortMode | undefined {
  if (!input) return undefined;
  const normalized = input.toLowerCase();
  if (normalized === "name" || normalized === "created" || normalized === "activity") {
    return normalized;
  }
  return undefined;
}

function sortSessions(sessions: TmuxSessionInfo[], sortBy?: SortMode): TmuxSessionInfo[] {
  if (!sortBy) return sessions;
  const sorted = [...sessions];
  if (sortBy === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === "created") {
    sorted.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  } else if (sortBy === "activity") {
    sorted.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
  }
  return sorted;
}

function getVisibleSessions(sessions: TmuxSessionInfo[], agentsOnly: boolean): TmuxSessionInfo[] {
  if (!agentsOnly) return sessions;
  return sessions.filter((session) => getFilteredWindows(session, true).length > 0);
}

function shortId(id: string, maxLen = 8): string {
  const parts = id.split("_");
  const base = parts.length > 1 ? parts[1] : id;
  return base.length > maxLen ? base.slice(0, maxLen) : base;
}

function truncateLine(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen - 3)}...`;
}

function formatSessionMeta(meta: SessionMetaEntry | undefined): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.tag) parts.push(`tag:${meta.tag}`);
  if (meta.status) parts.push(`status:${meta.status}`);
  if (meta.taskId) parts.push(meta.taskId);
  if (meta.planId) parts.push(`plan:${shortId(meta.planId)}`);
  const label = parts.length > 0 ? `[${parts.join(" ")}]` : "";
  const preview = meta.promptPreview ?? "";
  const combined = `${label} ${preview}`.trim();
  return combined.length > 0 ? combined : undefined;
}

// Color for each agent type
const AGENT_COLORS: Record<string, string> = {
  claude: ANSI.magenta,
  codex: ANSI.cyan,
  gemini: ANSI.yellow,
};

function getSessionAgent(
  session: TmuxSessionInfo,
  meta: SessionMetaEntry | undefined,
  detectedAgents: Map<number, DetectedAgent>,
  agentCache: Map<string, string>,
  agentsOnly: boolean
): string | undefined {
  // Priority 1: metadata from launch.ts
  if (meta?.agent) return meta.agent;

  // Priority 2: check cache (persists across refreshes)
  const cached = agentCache.get(session.name);
  if (cached) return cached;

  // Priority 3: detect from process tree and cache result
  const windows = getFilteredWindows(session, agentsOnly);
  for (const window of windows) {
    for (const pane of window.panes) {
      if (pane.panePid) {
        const detected = detectedAgents.get(pane.panePid);
        if (detected) {
          agentCache.set(session.name, detected.agent);
          return detected.agent;
        }
      }
    }
  }

  return undefined;
}

function renderSessions(
  state: WatchState,
  capturedLines: Map<string, string | undefined>,
  processStats: Map<number, ProcessStats>,
  detectedAgents: Map<number, DetectedAgent>,
  maxLines: number
): string {
  const { showLastLine, showStats, selectedIndex, filter, agentsOnly, expandAll } = state;
  const sessions = state.visibleSessions;
  let { scrollOffset } = state;
  const now = Math.floor(Date.now() / 1000);

  const lines: string[] = [];

  // Header
  let header = `${ANSI.bold}Sessions${ANSI.reset}`;
  if (filter) header += ` ${ANSI.dim}(${filter})${ANSI.reset}`;
  if (agentsOnly) header += ` ${ANSI.magenta}[agents]${ANSI.reset}`;
  if (!expandAll) header += ` ${ANSI.dim}[collapsed]${ANSI.reset}`;
  lines.push(header);
  lines.push(`${ANSI.dim}${"─".repeat(35)}${ANSI.reset}`);

  if (sessions.length === 0) {
    lines.push(`${ANSI.dim}No sessions found${ANSI.reset}`);
    return lines.join("\n") + "\n";
  }

  const contentStart = lines.length;
  let selectedLineIndex = -1;

  // Build session entries
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const filteredWindows = getFilteredWindows(session, agentsOnly);

    const isSelected = i === selectedIndex;
    const isExpanded = expandAll || isSelected;
    const meta = state.sessionMeta.get(session.name);

    const attachIcon = session.attached ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`;
    const durationSec = session.created ? now - session.created : 0;
    const durationStr = durationSec > 0 ? `${ANSI.dim}${formatDuration(durationSec)}${ANSI.reset}` : "";
    const statusBadge = meta?.status === "done" ? `${ANSI.dim}[done]${ANSI.reset}` : "";

    // Detect agent for this session
    const agentName = getSessionAgent(session, meta, detectedAgents, state.agentCache, agentsOnly);
    const agentColor = agentName ? (AGENT_COLORS[agentName] || ANSI.blue) : "";
    const agentBadge = agentName ? `${agentColor}[${agentName}]${ANSI.reset}` : "";

    const selectMark = isSelected ? `${ANSI.inverse}►${ANSI.reset}` : " ";
    const namePart = isSelected
      ? `${ANSI.bold}${ANSI.yellow}${session.name}${ANSI.reset}`
      : `${ANSI.bold}${session.name}${ANSI.reset}`;

    // Collapsed: show summary with agent badge
    if (!isExpanded) {
      const lineIndex = lines.length - contentStart;
      if (isSelected) selectedLineIndex = lineIndex;
      lines.push(`${selectMark}${attachIcon} ${namePart} ${agentBadge} ${durationStr}${statusBadge ? ` ${statusBadge}` : ""}`.trimEnd());
      continue;
    }

    // Expanded: show full details with agent badge
    const lineIndex = lines.length - contentStart;
    if (isSelected) selectedLineIndex = lineIndex;
    lines.push(`${selectMark}${attachIcon} ${namePart} ${agentBadge} ${durationStr}${statusBadge ? ` ${statusBadge}` : ""}`.trimEnd());

    const metaLine = formatSessionMeta(meta);
    if (metaLine) {
      lines.push(`   ${ANSI.dim}${truncateLine(metaLine, 80)}${ANSI.reset}`);
    }

    for (const window of filteredWindows) {
      const showWindowLine = filteredWindows.length > 1 || window.panes.length > 1;
      if (showWindowLine) {
        const windowActive = window.active ? `${ANSI.yellow}*${ANSI.reset}` : " ";
        lines.push(`   ${windowActive}${window.index}:${ANSI.cyan}${window.name}${ANSI.reset}`);
      }

      for (const pane of window.panes) {
        const indent = showWindowLine ? "    " : "  ";
        const paneActive = pane.active ? `${ANSI.green}›${ANSI.reset}` : " ";
        const cmdStr = pane.command ? `${ANSI.blue}${pane.command}${ANSI.reset}` : "";
        const statsStr = showStats && pane.panePid ? ` ${formatStats(processStats.get(pane.panePid))}` : "";

        // Show detected agent for this specific pane if different from session agent
        const paneDetected = pane.panePid ? detectedAgents.get(pane.panePid) : undefined;
        const paneAgentStr = paneDetected && paneDetected.agent !== agentName
          ? ` ${AGENT_COLORS[paneDetected.agent] || ANSI.blue}(${paneDetected.agent})${ANSI.reset}`
          : "";

        lines.push(`${indent}${paneActive}${cmdStr}${paneAgentStr}${statsStr}`);

        if (showLastLine) {
          const target = `${session.name}:${window.index}.${pane.paneIndex}`;
          const lastLine = capturedLines.get(target);
          if (lastLine) {
            const truncated = lastLine.slice(0, 38);
            lines.push(`${indent} ${ANSI.dim}${truncated}${lastLine.length > 38 ? "…" : ""}${ANSI.reset}`);
          }
        }
      }
    }
  }

  // Apply viewport scrolling if content exceeds maxLines
  const contentLines = lines.slice(contentStart);  // Skip header
  const contentCount = contentLines.length;
  if (contentCount <= maxLines) {
    state.scrollOffset = 0;
    return lines.join("\n") + "\n";
  }

  if (selectedLineIndex !== -1) {
    if (selectedLineIndex < scrollOffset) {
      scrollOffset = selectedLineIndex;
    } else if (selectedLineIndex >= scrollOffset + maxLines) {
      scrollOffset = selectedLineIndex - maxLines + 1;
    }
  }

  const maxOffset = Math.max(0, contentCount - maxLines);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  state.scrollOffset = scrollOffset;

  // Scroll to keep selection visible
  const visibleContent = contentLines.slice(scrollOffset, scrollOffset + maxLines);
  const scrollIndicator = scrollOffset > 0 ? `${ANSI.dim}↑ more${ANSI.reset}` : "";
  const moreBelow = scrollOffset + maxLines < contentLines.length
    ? `${ANSI.dim}↓ ${contentLines.length - scrollOffset - maxLines} more${ANSI.reset}`
    : "";

  const result = [lines[0], lines[1]];
  if (scrollIndicator) result.push(scrollIndicator);
  result.push(...visibleContent);
  if (moreBelow) result.push(moreBelow);

  return result.join("\n") + "\n";
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
  const { showLastLine, showStats, showHelp, showHooks, agentsOnly, expandAll, sortBy } = state;
  const sessions = state.visibleSessions;

  if (showHelp) {
    return renderHelp();
  }

  let output = "";
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });

  // Calculate available lines for sessions panel
  const termHeight = process.stdout.rows || 24;
  const headerLines = 4;  // header, indicators, separator, blank
  const footerLines = 2;  // footer + blank
  const hooksHeaderLines = 3;  // if hooks panel shown
  const availableLines = termHeight - headerLines - footerLines;
  const maxSessionLines = showHooks ? Math.floor(availableLines * 0.7) : availableLines;

  // Header
  const sortLabel = sortBy ? ` ${ANSI.dim}sort:${sortBy}${ANSI.reset}` : "";
  output += `${ANSI.bold}agentwatch${ANSI.reset} ${ANSI.dim}${now}${ANSI.reset}${sortLabel}\n`;

  // Status indicators
  const indicators = [];
  if (showLastLine) indicators.push(`${ANSI.green}L${ANSI.reset}`);
  if (showStats) indicators.push(`${ANSI.green}S${ANSI.reset}`);
  if (agentsOnly) indicators.push(`${ANSI.magenta}F${ANSI.reset}`);
  if (expandAll) indicators.push(`${ANSI.green}E${ANSI.reset}`);
  if (showHooks) indicators.push(`${ANSI.green}H${ANSI.reset}`);

  output += `${ANSI.dim}[${indicators.join("")}] l:line s:stats f:filter e:expand h:hooks d:done ?:help q:quit${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(70)}${ANSI.reset}\n\n`;

  // Collect pane data (only for expanded sessions to save resources)
  const paneTargets: string[] = [];
  const panePids: number[] = [];
  const pidsNeedingDetection: number[] = [];  // Only for sessions without known agent

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const isExpanded = expandAll || i === state.selectedIndex;
    const windows = getFilteredWindows(session, agentsOnly);
    const meta = state.sessionMeta.get(session.name);

    // Only collect PIDs for agent detection if we don't already know the agent
    const needsDetection = !meta?.agent && !state.agentCache.has(session.name);
    if (needsDetection) {
      for (const window of windows) {
        for (const pane of window.panes) {
          if (pane.panePid) pidsNeedingDetection.push(pane.panePid);
        }
      }
    }

    if (!isExpanded) continue;  // Skip collapsed sessions for detailed data

    for (const window of windows) {
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

  const [capturedLines, processStats, detectedAgents] = await Promise.all([
    showLastLine ? capturePanes(paneTargets) : Promise.resolve(new Map<string, string | undefined>()),
    showStats ? getProcessStatsBatch(panePids) : Promise.resolve(new Map<number, ProcessStats>()),
    pidsNeedingDetection.length > 0 ? detectAgentsBatch(pidsNeedingDetection) : Promise.resolve(new Map<number, DetectedAgent>()),
  ]);

  const sessionsContent = renderSessions(state, capturedLines, processStats, detectedAgents, maxSessionLines);

  if (showHooks && state.hooksEnabled) {
    const hooksContent = renderHooks(state);
    output += renderTwoColumn(state, sessionsContent, hooksContent);
  } else {
    output += sessionsContent;
  }

  // Footer
  output += `\n${ANSI.dim}Enter:attach x:kill d:done ↑↓/jk:nav${state.hooksEnabled ? ` │ hooks::${state.hooksPort}` : ""}${ANSI.reset}\n`;

  return output;
}

// Forward hook to another server (fire and forget)
async function forwardHook(url: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const fullUrl = url.endsWith("/") ? `${url}${event}` : `${url}/${event}`;
    await fetch(fullUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),  // 2s timeout
    });
  } catch {
    // Silently ignore forwarding errors
  }
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

    // Forward to other servers (fire and forget)
    for (const url of state.forwardUrls) {
      forwardHook(url, event, payload).catch(() => {});
    }

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

async function markSessionDone(state: WatchState, session: TmuxSessionInfo): Promise<void> {
  const oldName = session.name;
  let newName = oldName;
  let renamedFrom: string | undefined;

  if (!oldName.endsWith("-done")) {
    newName = `${oldName}-done`;
    if (await hasSession(newName)) {
      newName = `${newName}-${Date.now().toString(36)}`;
    }
    const renamed = await renameSession(oldName, newName);
    if (!renamed) return;
    renamedFrom = oldName;
  }

  const meta = state.sessionMeta.get(oldName);
  try {
    const entry = await appendSessionMeta(state.dataDir, {
      sessionName: newName,
      agent: meta?.agent,
      promptPreview: meta?.promptPreview,
      cwd: meta?.cwd,
      tag: meta?.tag,
      planId: meta?.planId,
      taskId: meta?.taskId,
      status: "done",
      renamedFrom,
      source: "watch",
    });
    state.sessionMeta.set(newName, entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to write session metadata: ${msg}`);
  }
}

async function refreshState(state: WatchState): Promise<void> {
  const sessions = await listSessions(state.filter);
  const sorted = sortSessions(sessions, state.sortBy);
  state.sessions = sorted;
  state.visibleSessions = getVisibleSessions(sorted, state.agentsOnly);

  const entries = await readSessionMeta(state.dataDir).catch(() => []);
  state.sessionMeta = buildSessionMetaMap(entries);

  if (state.visibleSessions.length > 0) {
    state.selectedIndex = Math.min(state.selectedIndex, state.visibleSessions.length - 1);
  } else {
    state.selectedIndex = 0;
  }
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
    const maxIndex = Math.max(0, state.visibleSessions.length - 1);

    if (key === "\x1b[A" || key === "k") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      needsRefresh = true;
    } else if (key === "\x1b[B" || key === "j") {
      state.selectedIndex = Math.min(maxIndex, state.selectedIndex + 1);
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
    } else if (key === "e") {
      state.expandAll = !state.expandAll;
      needsRefresh = true;
    } else if (key === "r") {
      needsRefresh = true;
    } else if ((key === "\r" || key === "\n" || key === "a") && state.visibleSessions.length > 0) {
      const session = state.visibleSessions[state.selectedIndex];
      if (session) {
        await attachToSession(session.name);
        setupRawMode();
        process.stdout.write(ANSI.hideCursor);
        needsRefresh = true;
      }
    } else if (key === "x" && state.visibleSessions.length > 0) {
      const session = state.visibleSessions[state.selectedIndex];
      if (session) {
        await killSession(session.name);
        needsRefresh = true;
      }
    } else if (key === "d" && state.visibleSessions.length > 0) {
      const session = state.visibleSessions[state.selectedIndex];
      if (session) {
        await markSessionDone(state, session);
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
      await refreshState(state);
      state.recentHooks = hooksBuffer;

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
    await refreshState(state);
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
  if (state.forwardUrls.length > 0) {
    console.log(`  Forwarding to: ${state.forwardUrls.join(", ")}`);
  }
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
      all: { type: "boolean", short: "A" },  // show all sessions, not just agents
      "no-expand": { type: "boolean" },      // collapse sessions by default
      sort: { type: "string" },
      hooks: { type: "boolean", default: true },
      "hooks-port": { type: "string", default: String(DEFAULT_HOOKS_PORT) },
      "hooks-daemon": { type: "boolean" },
      "no-hooks": { type: "boolean" },
      "forward-to": { type: "string", multiple: true },
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
  -A, --all           Show all sessions (default: agents only)
  --no-expand         Collapse sessions (default: all expanded)
  --sort              Sort sessions: name, created, activity
  --no-last-line      Hide pane output (shown by default)
  --no-stats          Hide CPU/memory stats (shown by default)

  --hooks-port        Hooks server port (default: ${DEFAULT_HOOKS_PORT})
  --no-hooks          Disable embedded hooks server
  --hooks-daemon      Run only hooks server (no TUI, headless)
  --forward-to        Forward hooks to URL (can specify multiple)

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
  d         Mark session done
  l         Toggle last-line display
  s         Toggle stats display
  f         Toggle agents-only filter
  h         Toggle hooks panel
  r         Refresh now
  ?         Toggle help
  q         Quit

Examples:
  bun run watch.ts                          # agents only, all expanded
  bun run watch.ts --filter awm             # filter to awm prefix
  bun run watch.ts --all                    # show all sessions
  bun run watch.ts --no-expand              # collapse sessions
  bun run watch.ts --no-stats --no-last-line
  bun run watch.ts --hooks-daemon
`);
    process.exit(0);
  }

  const hooksEnabled = !values["no-hooks"];
  const hooksPort = parseInt(values["hooks-port"]!, 10);
  const isDaemon = values["hooks-daemon"] ?? false;
  const sortBy = parseSortMode(values.sort);

  if (values.sort && !sortBy) {
    console.error("Error: --sort must be one of: name, created, activity");
    process.exit(1);
  }

  const forwardUrls = values["forward-to"] ?? [];

  const state: WatchState = {
    filter: values.filter,
    intervalMs: parseInt(values.interval!, 10),
    showLastLine: !values["no-last-line"],  // ON by default
    showStats: !values["no-stats"],          // ON by default
    showHelp: false,
    showHooks: hooksEnabled,
    agentsOnly: !values.all,       // ON by default (filter to agents), --all or -A to show all
    expandAll: !values["no-expand"],  // ON by default (all expanded), --no-expand to collapse
    sortBy,
    selectedIndex: 0,
    scrollOffset: 0,
    sessions: [],
    visibleSessions: [],
    sessionMeta: new Map(),
    agentCache: new Map(),
    recentHooks: [],
    hooksPort,
    hooksEnabled,
    forwardUrls,
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
