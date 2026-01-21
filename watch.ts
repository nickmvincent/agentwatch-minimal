import { parseArgs } from "util";
import { Hono } from "hono";
import { serve } from "bun";
import {
  listSessions,
  capturePanes,
  getProcessStatsBatch,
  detectAgentsBatch,
  killSession,
  type DetectedAgent,
} from "./lib/tmux";
import { createId } from "./lib/ids";
import { appendJsonl, readJsonlTail, expandHome } from "./lib/jsonl";
import { notifyHook, type NotificationConfig, DEFAULT_TITLE_TEMPLATE, DEFAULT_MESSAGE_TEMPLATE } from "./lib/notify";
import { formatHookPayload } from "./lib/hooks";
import type { TmuxSessionInfo, ProcessStats, HookEntry, SessionMetaEntry } from "./lib/types";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR } from "./lib/types";
import { appendSessionMeta, buildSessionMetaMap, readSessionMeta, markSessionDone } from "./lib/sessions";

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
  PreToolUse: ANSI.cyan,
  PostToolUse: ANSI.green,
  PostToolUseFailure: ANSI.red,
  PermissionRequest: ANSI.yellow,
  SessionStart: ANSI.green,
  SessionEnd: ANSI.dim,
  Stop: ANSI.red,
  SubagentStop: ANSI.red,
  UserPromptSubmit: ANSI.blue,
  Notification: ANSI.yellow,
};

// Known agent process names
const AGENT_COMMANDS = new Set(["claude", "codex", "gemini", "node", "bun"]);

function isAgentCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return AGENT_COMMANDS.has(cmd.toLowerCase());
}

type SortMode = "name" | "created" | "activity";

const REFRESH_PRESETS = [1000, 2000, 5000, 10000] as const;

// Filter popup options - all Claude Code hook event types
const FILTER_OPTIONS = [
  // Tool-related events
  { key: "PreToolUse", label: "PreToolUse", short: "pre" },
  { key: "PostToolUse", label: "PostToolUse", short: "post" },
  { key: "PostToolUseFailure", label: "PostToolUseFailure", short: "fail" },
  { key: "PermissionRequest", label: "PermissionRequest", short: "perm" },
  // Session lifecycle
  { key: "SessionStart", label: "SessionStart", short: "start" },
  { key: "SessionEnd", label: "SessionEnd", short: "end" },
  { key: "Stop", label: "Stop", short: "stop" },
  { key: "SubagentStop", label: "SubagentStop", short: "sub" },
  // User interaction
  { key: "UserPromptSubmit", label: "UserPromptSubmit", short: "prompt" },
  { key: "Notification", label: "Notification", short: "notif" },
] as const;

type FocusPanel = "sessions" | "hooks";

// State for the unified TUI
type WatchState = {
  filter: string | undefined;
  intervalMs: number;
  showLastLine: boolean;
  showStats: boolean;
  showHelp: boolean;
  showDetailedHelp: boolean;  // true = show extended documentation
  detailedHelpScrollOffset: number;
  showFilterPopup: boolean;  // true = show notification filter selector
  filterPopupIndex: number;  // cursor position in filter popup
  filterPopupSelected: Set<string>;  // temporarily selected filters
  showTemplateEditor: boolean;  // true = show template editor popup
  templateEditorField: "title" | "message";  // which field is being edited
  templateEditorValue: string;  // current edit buffer
  templateEditorCursor: number;  // cursor position in the edit field
  showHooks: boolean;
  showHookDetail: boolean;  // true = show full detail of selected hook
  agentsOnly: boolean;
  expandAll: boolean;  // false = only selected session expanded
  sortBy?: SortMode;
  focusPanel: FocusPanel;
  selectedIndex: number;
  scrollOffset: number;  // for viewport scrolling
  selectedHookIndex: number;
  hookScrollOffset: number;
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

function getEventColor(event: string): string {
  return EVENT_COLORS[event] || ANSI.blue;
}

function formatNotifyFilter(filter: string[] | undefined): string {
  if (!filter || filter.length === 0) return "all";
  if (filter.includes("PreToolUse")) return "pre";
  if (filter.includes("PostToolUse")) return "post";
  if (filter.includes("Notification")) return "notif";
  return `${filter.length}`;
}

function renderHelp(): string {
  return `
${ANSI.bold}Keybindings${ANSI.reset}
${ANSI.dim}${"─".repeat(50)}${ANSI.reset}

  ${ANSI.cyan}Navigation${ANSI.reset}
  j/↓      Move selection down
  k/↑      Move selection up
  Tab      Switch focus: sessions ↔ hooks
  Enter    Attach to session / view hook detail
  Esc      Close detail view

  ${ANSI.cyan}Display Toggles${ANSI.reset} (lowercase)
  l        Toggle last line output
  s        Toggle CPU/memory stats
  f        Toggle agents-only filter
  e        Toggle expand all sessions
  h        Toggle hooks panel
  r        Refresh now

  ${ANSI.cyan}Runtime Options${ANSI.reset} (uppercase)
  S        Cycle sort mode (none → name → created → activity)
  R        Cycle refresh interval (1s → 2s → 5s → 10s)
  N        Toggle desktop notifications
  F        Select notification filter
  T        Edit notification templates

  ${ANSI.cyan}Actions${ANSI.reset}
  x        Kill selected session
  D        Mark session done

  ${ANSI.cyan}General${ANSI.reset}
  ?        Toggle this help
  q        Quit

${ANSI.bold}d${ANSI.reset}${ANSI.dim}:more details  any other key:close${ANSI.reset}
`;
}

// Detailed help - data-driven for maintainability
// Each section documents a feature with its related state/keys
const DETAILED_HELP_SECTIONS = [
  {
    title: "Status Bar Reference",
    content: `
The TUI displays three status bars at the top:

${ANSI.bold}Line 1: Title Bar${ANSI.reset}
  agentwatch HH:MM:SS sort:MODE
  - Shows current time and active sort mode

${ANSI.bold}Line 2: Display Toggles${ANSI.reset}
  [LSFEH] l:line s:stats f:filter e:expand h:hooks ...
  - Brackets show active toggles (green=on)
  - L: Show last line of pane output
  - S: Show CPU/memory stats per pane
  - F: Filter to agent processes only (magenta when on)
  - E: Expand all sessions (vs only selected)
  - H: Show hooks panel

${ANSI.bold}Line 3: Runtime Options${ANSI.reset}
  [S:nam] [R:2s] [N:on] [F:all] S:sort R:refresh N:notify F:filter
  - S:xxx = Sort mode (--/nam/cre/act)
  - R:Xs  = Refresh interval (1s/2s/5s/10s)
  - N:on/off = Desktop notifications enabled
  - F:xxx = Notification filter (all/pre/post/err)

${ANSI.bold}Line 4: Info Bar${ANSI.reset}
  data:~/.agentwatch | hooks::8702 | sessions:N
  - Data directory location
  - Hooks server port
  - Total session count`,
  },
  {
    title: "Sort Modes (S key)",
    content: `
Press ${ANSI.bold}S${ANSI.reset} to cycle through sort modes:

  ${ANSI.cyan}none${ANSI.reset} (--) : tmux default order
  ${ANSI.cyan}name${ANSI.reset} (nam): Alphabetical by session name
  ${ANSI.cyan}created${ANSI.reset} (cre): Newest sessions first
  ${ANSI.cyan}activity${ANSI.reset} (act): Most recently active first

Sort mode persists until changed or session ends.`,
  },
  {
    title: "Refresh Interval (R key)",
    content: `
Press ${ANSI.bold}R${ANSI.reset} to cycle through refresh intervals:

  ${ANSI.cyan}1s${ANSI.reset}  : Fast updates, higher CPU
  ${ANSI.cyan}2s${ANSI.reset}  : Default balance
  ${ANSI.cyan}5s${ANSI.reset}  : Relaxed updates
  ${ANSI.cyan}10s${ANSI.reset} : Minimal updates

Press ${ANSI.bold}r${ANSI.reset} (lowercase) to force immediate refresh.`,
  },
  {
    title: "Desktop Notifications (N key)",
    content: `
Press ${ANSI.bold}N${ANSI.reset} to toggle desktop notifications on/off.

When enabled, hooks received by the server trigger system
notifications via terminal-notifier (macOS) or notify-send (Linux).

Use with ${ANSI.bold}F${ANSI.reset} key to filter which events notify.`,
  },
  {
    title: "Notification Filter (F key)",
    content: `
Press ${ANSI.bold}F${ANSI.reset} to open filter selector (only when N:on).

Filter options:
  ${ANSI.cyan}all${ANSI.reset}   : Notify on all hook events
  ${ANSI.cyan}pre${ANSI.reset}   : Only PreToolUse events
  ${ANSI.cyan}post${ANSI.reset}  : Only PostToolUse events
  ${ANSI.cyan}notif${ANSI.reset} : Only Notification events

Use arrow keys to select, Enter to confirm, Esc to cancel.`,
  },
  {
    title: "Hooks Panel (h key)",
    content: `
Press ${ANSI.bold}h${ANSI.reset} to toggle the hooks panel.

The hooks panel shows recent webhook events received on the
embedded server (default port 8702).

${ANSI.bold}Hook Types:${ANSI.reset}
  ${ANSI.cyan}PreToolUse${ANSI.reset}        : Before tool execution (cyan)
  ${ANSI.green}PostToolUse${ANSI.reset}       : After tool execution (green)
  ${ANSI.red}PostToolUseFailure${ANSI.reset}: Tool execution failed (red)
  ${ANSI.yellow}PermissionRequest${ANSI.reset} : Permission requested (yellow)
  ${ANSI.yellow}Notification${ANSI.reset}      : Notification events (yellow)

Press ${ANSI.bold}Tab${ANSI.reset} to switch focus between sessions and hooks.
Press ${ANSI.bold}Enter${ANSI.reset} on a hook to see full JSON payload.`,
  },
  {
    title: "Session Management",
    content: `
${ANSI.bold}Attach to Session${ANSI.reset}
  Press ${ANSI.bold}Enter${ANSI.reset} or ${ANSI.bold}a${ANSI.reset} to attach to selected session.
  Returns to watch view when you detach (Ctrl-b d).

${ANSI.bold}Kill Session${ANSI.reset}
  Press ${ANSI.bold}x${ANSI.reset} to kill selected session immediately.
  No confirmation - use carefully.

${ANSI.bold}Mark Done${ANSI.reset}
  Press ${ANSI.bold}D${ANSI.reset} to mark session as done.
  - Renames session to "name-done"
  - Updates metadata with status=done
  - Session remains visible but marked`,
  },
  {
    title: "Display Toggles Reference",
    content: `
${ANSI.bold}l${ANSI.reset} - Last Line Output
  Shows the last line from each pane's terminal output.
  Useful for seeing agent progress at a glance.

${ANSI.bold}s${ANSI.reset} - Stats (CPU/Memory)
  Shows cpu:X% mem:XM for each pane's process.
  Updates each refresh cycle.

${ANSI.bold}f${ANSI.reset} - Filter (Agents Only)
  When on (magenta F), only shows sessions/panes
  running known agent commands: claude, codex, gemini, node, bun

${ANSI.bold}e${ANSI.reset} - Expand All
  When on, shows all session details.
  When off, only selected session is expanded.

${ANSI.bold}h${ANSI.reset} - Hooks Panel
  Toggles the hooks side panel on/off.`,
  },
  {
    title: "Command Line Options",
    content: `
${ANSI.bold}Filtering & Display${ANSI.reset}
  -f, --filter PREFIX   Filter sessions by name prefix
  -A, --all             Show all sessions (not just agents)
  --no-expand           Start with sessions collapsed
  --sort MODE           Initial sort: name, created, activity
  --no-last-line        Hide pane output
  --no-stats            Hide CPU/memory stats

${ANSI.bold}Hooks Server${ANSI.reset}
  --hooks-port PORT     Server port (default: 8702)
  --no-hooks            Disable hooks server
  --hooks-daemon        Run hooks server only (no TUI)
  --forward-to URL      Forward hooks to another server

${ANSI.bold}Notifications${ANSI.reset}
  --notify-desktop      Enable desktop notifications
  --notify-webhook URL  Forward to webhook URL
  --notify-filter LIST  Comma-separated event types
  --notify-title-template TPL    Custom title template (e.g. "{dir}: {event}")
  --notify-message-template TPL  Custom message template (e.g. "{tool}: {detail}")

${ANSI.bold}Other${ANSI.reset}
  -i, --interval MS     Refresh interval (default: 2000)
  -d, --data-dir PATH   Data directory
  -o, --once            Run once and exit
  --no-interactive      Disable interactive mode`,
  },
  {
    title: "Data Files",
    content: `
agentwatch stores data in the data directory (default: ~/.agentwatch):

${ANSI.bold}hooks.jsonl${ANSI.reset}
  Append-only log of all received webhook events.
  Each line is a JSON object with: id, timestamp, event, payload

${ANSI.bold}sessions.jsonl${ANSI.reset}
  Session metadata from launch.ts and manual operations.
  Tracks: sessionName, agent, cwd, tag, status, promptPreview

Files use JSONL format (one JSON object per line) for
append-friendly logging and easy parsing.`,
  },
];

function renderDetailedHelp(state: WatchState): string {
  const termHeight = process.stdout.rows || 24;
  const termWidth = process.stdout.columns || 80;
  const maxVisibleLines = termHeight - 4;  // Header + footer

  // Build all content lines
  const allLines: string[] = [];
  allLines.push(`${ANSI.bold}Detailed Documentation${ANSI.reset}`);
  allLines.push(`${ANSI.dim}${"─".repeat(Math.min(60, termWidth - 4))}${ANSI.reset}`);
  allLines.push("");

  for (const section of DETAILED_HELP_SECTIONS) {
    allLines.push(`${ANSI.bold}${ANSI.cyan}## ${section.title}${ANSI.reset}`);
    const contentLines = section.content.trim().split("\n");
    allLines.push(...contentLines);
    allLines.push("");
  }

  // Apply scroll offset
  const scrollOffset = Math.min(
    state.detailedHelpScrollOffset,
    Math.max(0, allLines.length - maxVisibleLines)
  );
  const visibleLines = allLines.slice(scrollOffset, scrollOffset + maxVisibleLines);

  let output = "";
  for (const line of visibleLines) {
    output += line + "\n";
  }

  // Scroll indicators
  if (scrollOffset > 0) {
    output = `${ANSI.dim}↑ ${scrollOffset} lines above${ANSI.reset}\n` + output;
  }
  if (scrollOffset + maxVisibleLines < allLines.length) {
    output += `${ANSI.dim}↓ ${allLines.length - scrollOffset - maxVisibleLines} lines below${ANSI.reset}\n`;
  }

  output += `\n${ANSI.dim}j/k:scroll  q/Esc:back${ANSI.reset}`;
  return output;
}

function renderFilterPopup(state: WatchState): string {
  let output = "";
  output += `${ANSI.bold}Notification Filter${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(35)}${ANSI.reset}\n`;
  output += `${ANSI.dim}Select which events to notify on:${ANSI.reset}\n\n`;

  for (let i = 0; i < FILTER_OPTIONS.length; i++) {
    const opt = FILTER_OPTIONS[i];
    const isSelected = state.filterPopupSelected.has(opt.key);
    const isCursor = i === state.filterPopupIndex;

    const cursor = isCursor ? `${ANSI.yellow}▶${ANSI.reset}` : " ";
    const checkbox = isSelected ? `${ANSI.green}[✓]${ANSI.reset}` : `${ANSI.dim}[ ]${ANSI.reset}`;
    const label = isCursor ? `${ANSI.bold}${opt.label}${ANSI.reset}` : opt.label;

    output += `  ${cursor} ${checkbox} ${label}\n`;
  }

  output += `\n${ANSI.dim}${"─".repeat(35)}${ANSI.reset}\n`;

  // Show preview of current selection
  const selected = Array.from(state.filterPopupSelected);
  const preview = selected.length === 0 ? "all events" :
    selected.length === FILTER_OPTIONS.length ? "all events" :
    selected.map(s => FILTER_OPTIONS.find(o => o.key === s)?.short ?? s).join(", ");
  output += `${ANSI.dim}Current: ${preview}${ANSI.reset}\n\n`;

  output += `${ANSI.dim}↑↓/jk:move  Space:toggle  Enter:apply  Esc:cancel${ANSI.reset}`;
  return output;
}

function renderTemplateEditor(state: WatchState): string {
  let output = "";
  output += `${ANSI.bold}Notification Templates${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(50)}${ANSI.reset}\n\n`;

  // Show available placeholders
  output += `${ANSI.dim}Available placeholders:${ANSI.reset}\n`;
  output += `${ANSI.dim}  {dir}     - directory name from cwd${ANSI.reset}\n`;
  output += `${ANSI.dim}  {event}   - hook event type${ANSI.reset}\n`;
  output += `${ANSI.dim}  {tool}    - tool name (if tool event)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {file}    - filename (if file operation)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {cmd}     - command (if Bash, truncated)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {pattern} - pattern (if Grep/Glob)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {message} - notification message${ANSI.reset}\n`;
  output += `${ANSI.dim}  {prompt}  - user prompt (if UserPromptSubmit)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {reason}  - stop reason (if Stop event)${ANSI.reset}\n`;
  output += `${ANSI.dim}  {session} - truncated session ID${ANSI.reset}\n`;
  output += `${ANSI.dim}  {detail}  - smart default (best available info)${ANSI.reset}\n\n`;

  output += `${ANSI.dim}${"─".repeat(50)}${ANSI.reset}\n\n`;

  // Title template
  const titleActive = state.templateEditorField === "title";
  const titleValue = titleActive ? state.templateEditorValue : (state.notifyConfig.titleTemplate || DEFAULT_TITLE_TEMPLATE);
  const titleLabel = titleActive ? `${ANSI.yellow}▶${ANSI.reset} ${ANSI.bold}Title:${ANSI.reset}` : `  ${ANSI.dim}Title:${ANSI.reset}`;

  if (titleActive) {
    // Show cursor in the edit field
    const beforeCursor = titleValue.slice(0, state.templateEditorCursor);
    const afterCursor = titleValue.slice(state.templateEditorCursor);
    output += `${titleLabel} ${beforeCursor}${ANSI.inverse} ${ANSI.reset}${afterCursor}\n`;
  } else {
    output += `${titleLabel} ${ANSI.dim}${titleValue}${ANSI.reset}\n`;
  }

  output += "\n";

  // Message template
  const msgActive = state.templateEditorField === "message";
  const msgValue = msgActive ? state.templateEditorValue : (state.notifyConfig.messageTemplate || DEFAULT_MESSAGE_TEMPLATE);
  const msgLabel = msgActive ? `${ANSI.yellow}▶${ANSI.reset} ${ANSI.bold}Message:${ANSI.reset}` : `  ${ANSI.dim}Message:${ANSI.reset}`;

  if (msgActive) {
    const beforeCursor = msgValue.slice(0, state.templateEditorCursor);
    const afterCursor = msgValue.slice(state.templateEditorCursor);
    output += `${msgLabel} ${beforeCursor}${ANSI.inverse} ${ANSI.reset}${afterCursor}\n`;
  } else {
    output += `${msgLabel} ${ANSI.dim}${msgValue}${ANSI.reset}\n`;
  }

  output += `\n${ANSI.dim}${"─".repeat(50)}${ANSI.reset}\n`;
  output += `${ANSI.dim}Tab:switch field  Enter:save  Esc:cancel  Ctrl+R:reset${ANSI.reset}`;
  return output;
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
  const { showLastLine, showStats, selectedIndex, filter, agentsOnly, expandAll, focusPanel, showHooks } = state;
  const sessions = state.visibleSessions;
  let { scrollOffset } = state;
  const now = Math.floor(Date.now() / 1000);
  const isFocused = focusPanel === "sessions";

  const lines: string[] = [];

  // Header with focus indicator
  const focusIndicator = (showHooks && isFocused) ? `${ANSI.green}▶${ANSI.reset} ` : (showHooks ? "  " : "");
  let header = `${focusIndicator}${ANSI.bold}Sessions${ANSI.reset}`;
  if (filter) header += ` ${ANSI.dim}(${filter})${ANSI.reset}`;
  if (agentsOnly) header += ` ${ANSI.magenta}[agents]${ANSI.reset}`;
  if (!expandAll) header += ` ${ANSI.dim}[collapsed]${ANSI.reset}`;
  if (showHooks && isFocused) header += ` ${ANSI.dim}Tab:hooks${ANSI.reset}`;
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

  // Reserve 2 lines for scroll indicators (↑ more / ↓ N more)
  const effectiveMaxLines = Math.max(1, maxLines - 2);

  if (selectedLineIndex !== -1) {
    if (selectedLineIndex < scrollOffset) {
      scrollOffset = selectedLineIndex;
    } else if (selectedLineIndex >= scrollOffset + effectiveMaxLines) {
      scrollOffset = selectedLineIndex - effectiveMaxLines + 1;
    }
  }

  const maxOffset = Math.max(0, contentCount - effectiveMaxLines);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  state.scrollOffset = scrollOffset;

  // Scroll to keep selection visible
  const visibleContent = contentLines.slice(scrollOffset, scrollOffset + effectiveMaxLines);
  const scrollIndicator = scrollOffset > 0 ? `${ANSI.dim}↑ more${ANSI.reset}` : "";
  const moreBelow = scrollOffset + effectiveMaxLines < contentLines.length
    ? `${ANSI.dim}↓ ${contentLines.length - scrollOffset - effectiveMaxLines} more${ANSI.reset}`
    : "";

  const result = [lines[0], lines[1]];
  if (scrollIndicator) result.push(scrollIndicator);
  result.push(...visibleContent);
  if (moreBelow) result.push(moreBelow);

  return result.join("\n") + "\n";
}

function renderHooks(state: WatchState): string {
  const hooks = state.recentHooks;
  const isFocused = state.focusPanel === "hooks";

  let output = "";
  const focusIndicator = isFocused ? `${ANSI.green}▶${ANSI.reset} ` : "  ";
  output += `${focusIndicator}${ANSI.bold}Hooks${ANSI.reset} ${ANSI.dim}(:${state.hooksPort})${ANSI.reset}`;
  output += ` ${ANSI.dim}${hooks.length} total${ANSI.reset}`;
  if (isFocused) output += ` ${ANSI.dim}Tab:sessions Enter:detail${ANSI.reset}`;
  output += "\n";
  output += `${ANSI.dim}${"─".repeat(40)}${ANSI.reset}\n`;

  if (hooks.length === 0) {
    output += `${ANSI.dim}No hooks yet${ANSI.reset}\n`;
    output += `${ANSI.dim}Listening on :${state.hooksPort}${ANSI.reset}\n`;
    return output;
  }

  // Show most recent first, with selection indicator
  const reversed = [...hooks].reverse().slice(0, 15);
  for (let i = 0; i < reversed.length; i++) {
    const hook = reversed[i];
    const isSelected = isFocused && i === state.selectedHookIndex;
    const color = getEventColor(hook.event);
    const time = formatTimestamp(hook.timestamp);
    const eventShort = hook.event;
    const payloadStr = formatHookPayload(hook.payload);

    const selectMark = isSelected ? `${ANSI.inverse}►${ANSI.reset}` : " ";
    const lineColor = isSelected ? ANSI.bold : "";
    const lineReset = isSelected ? ANSI.reset : "";

    output += `${selectMark}${lineColor}${ANSI.dim}${time}${ANSI.reset} `;
    output += `${lineColor}${color}${eventShort.padEnd(5)}${ANSI.reset} `;
    output += `${lineColor}${ANSI.dim}${payloadStr}${ANSI.reset}${lineReset}\n`;
  }

  return output;
}

function renderHookDetail(state: WatchState): string {
  const hooks = [...state.recentHooks].reverse();
  const hook = hooks[state.selectedHookIndex];

  if (!hook) {
    return `${ANSI.bold}No hook selected${ANSI.reset}\n\nPress Esc or q to go back.`;
  }

  const termHeight = process.stdout.rows || 24;
  const termWidth = process.stdout.columns || 80;

  let output = "";
  output += `${ANSI.bold}Hook Detail${ANSI.reset} ${ANSI.dim}(Esc/q:back j/k:scroll)${ANSI.reset}\n`;
  output += `${ANSI.dim}${"─".repeat(Math.min(70, termWidth - 2))}${ANSI.reset}\n\n`;

  // Header info
  const color = getEventColor(hook.event);
  output += `${ANSI.bold}Event:${ANSI.reset}     ${color}${hook.event}${ANSI.reset}\n`;
  output += `${ANSI.bold}Time:${ANSI.reset}      ${hook.timestamp}\n`;
  output += `${ANSI.bold}ID:${ANSI.reset}        ${ANSI.dim}${hook.id}${ANSI.reset}\n`;
  output += "\n";

  // Pretty print payload
  output += `${ANSI.bold}Payload:${ANSI.reset}\n`;
  const payloadJson = JSON.stringify(hook.payload, null, 2);
  const payloadLines = payloadJson.split("\n");

  // Apply scroll offset
  const maxVisibleLines = termHeight - 12;  // Reserve space for header/footer
  const scrollOffset = Math.min(state.hookScrollOffset, Math.max(0, payloadLines.length - maxVisibleLines));
  const visibleLines = payloadLines.slice(scrollOffset, scrollOffset + maxVisibleLines);

  for (const line of visibleLines) {
    // Basic syntax highlighting for JSON
    const highlighted = line
      .replace(/"([^"]+)":/g, `${ANSI.cyan}"$1"${ANSI.reset}:`)  // keys
      .replace(/: "([^"]*)"/g, `: ${ANSI.green}"$1"${ANSI.reset}`)  // string values
      .replace(/: (\d+)/g, `: ${ANSI.yellow}$1${ANSI.reset}`)  // numbers
      .replace(/: (true|false|null)/g, `: ${ANSI.magenta}$1${ANSI.reset}`);  // booleans/null
    output += `  ${highlighted}\n`;
  }

  if (scrollOffset > 0) {
    output = output.replace("\n\n", `\n${ANSI.dim}↑ ${scrollOffset} lines above${ANSI.reset}\n\n`);
  }
  if (scrollOffset + maxVisibleLines < payloadLines.length) {
    output += `${ANSI.dim}↓ ${payloadLines.length - scrollOffset - maxVisibleLines} lines below${ANSI.reset}\n`;
  }

  return output;
}

async function renderDisplay(state: WatchState): Promise<string> {
  const { showLastLine, showStats, showHelp, showDetailedHelp, showFilterPopup, showHooks, showHookDetail, agentsOnly, expandAll, sortBy } = state;
  const sessions = state.visibleSessions;

  if (showDetailedHelp) {
    return renderDetailedHelp(state);
  }

  if (showHelp) {
    return renderHelp();
  }

  if (showFilterPopup) {
    return renderFilterPopup(state);
  }

  if (state.showTemplateEditor) {
    return renderTemplateEditor(state);
  }

  if (showHookDetail) {
    return renderHookDetail(state);
  }

  let output = "";
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });

  // Calculate available lines for sessions panel
  const termHeight = process.stdout.rows || 24;
  const headerLines = 6;  // header, indicators, runtime options, info bar, separator, blank
  const footerLines = 2;  // footer + blank
  const hooksHeaderLines = 3;  // if hooks panel shown
  const availableLines = termHeight - headerLines - footerLines;
  const maxSessionLines = showHooks ? Math.floor(availableLines * 0.7) : availableLines;

  // Header
  const sortLabel = sortBy ? ` ${ANSI.dim}sort:${sortBy}${ANSI.reset}` : "";
  output += `${ANSI.bold}agentwatch${ANSI.reset} ${ANSI.dim}${now}${ANSI.reset}${sortLabel}\n`;

  // Helper for on/off indicators with color
  const onOff = (isOn: boolean) => isOn
    ? `${ANSI.green}[on]${ANSI.reset}`
    : `${ANSI.dim}[off]${ANSI.reset}`;

  // Display toggles line (lowercase keys)
  output += `l:last-line ${onOff(showLastLine)}  `;
  output += `s:stats ${onOff(showStats)}  `;
  output += `f:agents-only ${onOff(agentsOnly)}  `;
  output += `e:expand-all ${onOff(expandAll)}  `;
  output += `h:hooks ${onOff(showHooks)}\n`;

  // Runtime options line (uppercase keys)
  const sortDisplayLabel = state.sortBy ?? "none";
  const sortColor = state.sortBy ? ANSI.green : ANSI.dim;
  output += `S:sort ${sortColor}[${sortDisplayLabel}]${ANSI.reset}  `;

  const intervalLabel = `${state.intervalMs / 1000}s`;
  output += `R:refresh ${ANSI.cyan}[${intervalLabel}]${ANSI.reset}  `;

  output += `N:notify ${onOff(state.notifyConfig.desktop)}  `;

  if (state.notifyConfig.desktop) {
    const filterLabel = formatNotifyFilter(state.notifyConfig.filter);
    output += `F:event-filter ${ANSI.cyan}[${filterLabel}]${ANSI.reset}  `;
    output += `T:template  `;
  }

  output += `${ANSI.dim}D:done ?:help q:quit${ANSI.reset}\n`;

  // Info bar
  const shortDir = state.dataDir.replace(process.env.HOME || "~", "~");
  output += `${ANSI.dim}data:${shortDir} | hooks::${state.hooksPort} | sessions:${state.sessions.length}${ANSI.reset}\n`;

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
  output += `\n${ANSI.dim}Enter:attach x:kill D:done ↑↓/jk:nav${state.hooksEnabled ? ` │ hooks::${state.hooksPort}` : ""}${ANSI.reset}\n`;

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

  // Shared handler for both /hooks/:event and /api/hooks/:event
  const handleHook = async (event: string, payload: Record<string, unknown>) => {
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
  };

  // Support both /hooks/:event and /api/hooks/:event (for Claude Code compatibility)
  app.post("/hooks/:event", async (c) => {
    const event = c.req.param("event");
    const payload = await c.req.json().catch(() => ({}));
    await handleHook(event, payload);
    return c.json({});
  });

  app.post("/api/hooks/:event", async (c) => {
    const event = c.req.param("event");
    const payload = await c.req.json().catch(() => ({}));
    await handleHook(event, payload);
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

  // Session management endpoints
  app.get("/sessions", async (c) => {
    const filter = c.req.query("filter");
    const sessions = await listSessions(filter);
    const entries = await readSessionMeta(state.dataDir).catch(() => []);
    const metaMap = buildSessionMetaMap(entries);

    const result = sessions.map((s) => ({
      name: s.name,
      windows: s.windows,
      attached: s.attached,
      created: s.created,
      activity: s.activity,
      meta: metaMap.get(s.name) ?? null,
    }));

    return c.json({ ok: true, sessions: result, total: result.length });
  });

  app.get("/sessions/:name", async (c) => {
    const name = c.req.param("name");
    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ ok: false, error: "Session not found" }, 404);
    }

    const entries = await readSessionMeta(state.dataDir).catch(() => []);
    const metaMap = buildSessionMetaMap(entries);

    return c.json({
      ok: true,
      session: {
        name: session.name,
        windows: session.windows,
        attached: session.attached,
        created: session.created,
        activity: session.activity,
        windowList: session.windowList,
        meta: metaMap.get(session.name) ?? null,
      },
    });
  });

  app.post("/sessions/:name/done", async (c) => {
    const name = c.req.param("name");
    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ ok: false, error: "Session not found" }, 404);
    }

    const entries = await readSessionMeta(state.dataDir).catch(() => []);
    const metaMap = buildSessionMetaMap(entries);
    const meta = metaMap.get(session.name);

    const result = await markSessionDone(state.dataDir, session.name, meta);
    if (!result) {
      return c.json({ ok: false, error: "Failed to mark session done" }, 500);
    }

    // Update local state
    state.sessionMeta.set(result.newName, result.entry);

    return c.json({ ok: true, newName: result.newName, entry: result.entry });
  });

  app.post("/sessions/:name/kill", async (c) => {
    const name = c.req.param("name");
    const sessions = await listSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ ok: false, error: "Session not found" }, 404);
    }

    const killed = await killSession(session.name);
    if (!killed) {
      return c.json({ ok: false, error: "Failed to kill session" }, 500);
    }

    return c.json({ ok: true, killed: session.name });
  });

  app.get("/", (c) => c.json({
    service: "agentwatch",
    endpoints: [
      "POST /hooks/:event",
      "POST /api/hooks/:event",
      "GET /hooks/recent",
      "GET /hooks/health",
      "GET /sessions",
      "GET /sessions/:name",
      "POST /sessions/:name/done",
      "POST /sessions/:name/kill",
    ],
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
    const maxSessionIndex = Math.max(0, state.visibleSessions.length - 1);
    const maxHookIndex = Math.max(0, state.recentHooks.length - 1);

    // Escape closes detail view or help
    if (key === "\x1b" || key === "\x1b\x1b") {
      if (state.showTemplateEditor) {
        state.showTemplateEditor = false;
        needsRefresh = true;
        return;
      }
      if (state.showFilterPopup) {
        state.showFilterPopup = false;
        needsRefresh = true;
        return;
      }
      if (state.showDetailedHelp) {
        state.showDetailedHelp = false;
        state.detailedHelpScrollOffset = 0;
        needsRefresh = true;
        return;
      }
      if (state.showHookDetail) {
        state.showHookDetail = false;
        needsRefresh = true;
        return;
      }
      if (state.showHelp) {
        state.showHelp = false;
        needsRefresh = true;
        return;
      }
    }

    // Filter popup - j/k to navigate, space to toggle, enter to apply
    if (state.showFilterPopup) {
      if (key === "\x1b[A" || key === "k") {
        state.filterPopupIndex = Math.max(0, state.filterPopupIndex - 1);
        needsRefresh = true;
      } else if (key === "\x1b[B" || key === "j") {
        state.filterPopupIndex = Math.min(FILTER_OPTIONS.length - 1, state.filterPopupIndex + 1);
        needsRefresh = true;
      } else if (key === " ") {
        // Toggle current selection
        const opt = FILTER_OPTIONS[state.filterPopupIndex];
        if (state.filterPopupSelected.has(opt.key)) {
          state.filterPopupSelected.delete(opt.key);
        } else {
          state.filterPopupSelected.add(opt.key);
        }
        needsRefresh = true;
      } else if (key === "\r" || key === "\n") {
        // Apply selection
        const selected = Array.from(state.filterPopupSelected);
        state.notifyConfig.filter = selected.length === 0 || selected.length === FILTER_OPTIONS.length
          ? undefined
          : selected;
        state.showFilterPopup = false;
        needsRefresh = true;
      } else if (key === "q") {
        state.showFilterPopup = false;
        needsRefresh = true;
      }
      return;
    }

    // Template editor - Tab to switch fields, Enter to save, text editing
    if (state.showTemplateEditor) {
      if (key === "\t") {
        // Save current field and switch
        if (state.templateEditorField === "title") {
          state.notifyConfig.titleTemplate = state.templateEditorValue || undefined;
          state.templateEditorField = "message";
          state.templateEditorValue = state.notifyConfig.messageTemplate || DEFAULT_MESSAGE_TEMPLATE;
        } else {
          state.notifyConfig.messageTemplate = state.templateEditorValue || undefined;
          state.templateEditorField = "title";
          state.templateEditorValue = state.notifyConfig.titleTemplate || DEFAULT_TITLE_TEMPLATE;
        }
        state.templateEditorCursor = state.templateEditorValue.length;
        needsRefresh = true;
      } else if (key === "\r" || key === "\n") {
        // Save both templates
        if (state.templateEditorField === "title") {
          state.notifyConfig.titleTemplate = state.templateEditorValue || undefined;
        } else {
          state.notifyConfig.messageTemplate = state.templateEditorValue || undefined;
        }
        state.showTemplateEditor = false;
        needsRefresh = true;
      } else if (key === "\x12") {  // Ctrl+R - reset to defaults
        state.notifyConfig.titleTemplate = undefined;
        state.notifyConfig.messageTemplate = undefined;
        state.templateEditorValue = state.templateEditorField === "title" ? DEFAULT_TITLE_TEMPLATE : DEFAULT_MESSAGE_TEMPLATE;
        state.templateEditorCursor = state.templateEditorValue.length;
        needsRefresh = true;
      } else if (key === "\x7f" || key === "\b") {  // Backspace
        if (state.templateEditorCursor > 0) {
          state.templateEditorValue =
            state.templateEditorValue.slice(0, state.templateEditorCursor - 1) +
            state.templateEditorValue.slice(state.templateEditorCursor);
          state.templateEditorCursor--;
          needsRefresh = true;
        }
      } else if (key === "\x1b[D") {  // Left arrow
        if (state.templateEditorCursor > 0) {
          state.templateEditorCursor--;
          needsRefresh = true;
        }
      } else if (key === "\x1b[D" || key === "\x1b[C") {  // Right arrow
        if (key === "\x1b[C" && state.templateEditorCursor < state.templateEditorValue.length) {
          state.templateEditorCursor++;
          needsRefresh = true;
        }
      } else if (key === "q") {
        state.showTemplateEditor = false;
        needsRefresh = true;
      } else if (code >= 32 && code < 127) {  // Printable ASCII
        state.templateEditorValue =
          state.templateEditorValue.slice(0, state.templateEditorCursor) +
          key +
          state.templateEditorValue.slice(state.templateEditorCursor);
        state.templateEditorCursor++;
        needsRefresh = true;
      }
      return;
    }

    // Detailed help view - q/Esc closes, j/k scrolls
    if (state.showDetailedHelp) {
      if (key === "q") {
        state.showDetailedHelp = false;
        state.detailedHelpScrollOffset = 0;
        needsRefresh = true;
      } else if (key === "\x1b[A" || key === "k") {
        state.detailedHelpScrollOffset = Math.max(0, state.detailedHelpScrollOffset - 1);
        needsRefresh = true;
      } else if (key === "\x1b[B" || key === "j") {
        state.detailedHelpScrollOffset += 1;
        needsRefresh = true;
      }
      return;
    }

    // Help view - 'd' shows details, other keys close
    if (state.showHelp) {
      if (key === "d") {
        state.showHelp = false;
        state.showDetailedHelp = true;
        state.detailedHelpScrollOffset = 0;
      } else {
        state.showHelp = false;
      }
      needsRefresh = true;
      return;
    }

    // Hook detail view - Esc/q closes, j/k scrolls
    if (state.showHookDetail) {
      if (key === "q") {
        state.showHookDetail = false;
        needsRefresh = true;
      } else if (key === "\x1b[A" || key === "k") {
        state.hookScrollOffset = Math.max(0, state.hookScrollOffset - 1);
        needsRefresh = true;
      } else if (key === "\x1b[B" || key === "j") {
        state.hookScrollOffset += 1;
        needsRefresh = true;
      }
      return;
    }

    // Tab toggles focus between sessions and hooks
    if (key === "\t" && state.showHooks && state.hooksEnabled) {
      state.focusPanel = state.focusPanel === "sessions" ? "hooks" : "sessions";
      needsRefresh = true;
      return;
    }

    // Navigation - depends on focused panel
    if (key === "\x1b[A" || key === "k") {
      if (state.focusPanel === "hooks") {
        state.selectedHookIndex = Math.max(0, state.selectedHookIndex - 1);
      } else {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      }
      needsRefresh = true;
    } else if (key === "\x1b[B" || key === "j") {
      if (state.focusPanel === "hooks") {
        state.selectedHookIndex = Math.min(maxHookIndex, state.selectedHookIndex + 1);
      } else {
        state.selectedIndex = Math.min(maxSessionIndex, state.selectedIndex + 1);
      }
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
      if (!state.showHooks) state.focusPanel = "sessions";
      needsRefresh = true;
    } else if (key === "f") {
      state.agentsOnly = !state.agentsOnly;
      needsRefresh = true;
    } else if (key === "e") {
      state.expandAll = !state.expandAll;
      needsRefresh = true;
    } else if (key === "r") {
      needsRefresh = true;
    } else if (key === "\r" || key === "\n" || key === "a") {
      if (state.focusPanel === "hooks" && state.recentHooks.length > 0) {
        // Show hook detail
        state.showHookDetail = true;
        state.hookScrollOffset = 0;
        needsRefresh = true;
      } else if (state.focusPanel === "sessions" && state.visibleSessions.length > 0) {
        const session = state.visibleSessions[state.selectedIndex];
        if (session) {
          await attachToSession(session.name);
          setupRawMode();
          process.stdout.write(ANSI.hideCursor);
          needsRefresh = true;
        }
      }
    } else if (key === "x" && state.focusPanel === "sessions" && state.visibleSessions.length > 0) {
      const session = state.visibleSessions[state.selectedIndex];
      if (session) {
        await killSession(session.name);
        needsRefresh = true;
      }
    } else if (key === "D" && state.focusPanel === "sessions" && state.visibleSessions.length > 0) {
      const session = state.visibleSessions[state.selectedIndex];
      if (session) {
        const meta = state.sessionMeta.get(session.name);
        try {
          const result = await markSessionDone(state.dataDir, session.name, meta);
          if (result) {
            state.sessionMeta.set(result.newName, result.entry);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Warning: failed to mark session done: ${msg}`);
        }
        needsRefresh = true;
      }
    } else if (key === "S") {
      const modes: (SortMode | undefined)[] = [undefined, "name", "created", "activity"];
      const idx = modes.indexOf(state.sortBy);
      state.sortBy = modes[(idx + 1) % modes.length];
      needsRefresh = true;
    } else if (key === "R") {
      const idx = REFRESH_PRESETS.indexOf(state.intervalMs as typeof REFRESH_PRESETS[number]);
      state.intervalMs = REFRESH_PRESETS[(idx + 1) % REFRESH_PRESETS.length];
      needsRefresh = true;
    } else if (key === "N") {
      state.notifyConfig.desktop = !state.notifyConfig.desktop;
      needsRefresh = true;
    } else if (key === "F" && state.notifyConfig.desktop) {
      // Open filter popup with current selection
      state.showFilterPopup = true;
      state.filterPopupIndex = 0;
      state.filterPopupSelected = new Set(state.notifyConfig.filter ?? []);
      needsRefresh = true;
    } else if (key === "T" && state.notifyConfig.desktop) {
      // Open template editor
      state.showTemplateEditor = true;
      state.templateEditorField = "title";
      state.templateEditorValue = state.notifyConfig.titleTemplate || DEFAULT_TITLE_TEMPLATE;
      state.templateEditorCursor = state.templateEditorValue.length;
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
      "notify-title-template": { type: "string" },
      "notify-message-template": { type: "string" },
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
  --notify-title-template     Custom title template (placeholders: {dir}, {event}, etc.)
  --notify-message-template   Custom message template (placeholders: {tool}, {detail}, etc.)

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
    showDetailedHelp: false,
    detailedHelpScrollOffset: 0,
    showFilterPopup: false,
    filterPopupIndex: 0,
    filterPopupSelected: new Set(),
    showTemplateEditor: false,
    templateEditorField: "title",
    templateEditorValue: "",
    templateEditorCursor: 0,
    showHooks: hooksEnabled,
    showHookDetail: false,
    agentsOnly: !values.all,       // ON by default (filter to agents), --all or -A to show all
    expandAll: !values["no-expand"],  // ON by default (all expanded), --no-expand to collapse
    sortBy,
    focusPanel: "sessions",
    selectedIndex: 0,
    scrollOffset: 0,
    selectedHookIndex: 0,
    hookScrollOffset: 0,
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
      titleTemplate: values["notify-title-template"],
      messageTemplate: values["notify-message-template"],
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
