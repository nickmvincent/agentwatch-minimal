import type { TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo, AgentType, ProcessStats } from "./types";
import { AGENT_CONFIGS } from "./types";

/** Escape a string for safe use in single-quoted shell argument */
export function escapeShellArg(str: string): string {
  return str.replace(/'/g, "'\"'\"'");
}

// Cache for tmuxHasServer check (valid for 5 seconds)
let hasServerCache: { value: boolean; timestamp: number } | null = null;
const HAS_SERVER_CACHE_TTL = 5000;

export async function runTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

export async function tmuxHasServer(): Promise<boolean> {
  // Return cached value if still valid
  if (hasServerCache && Date.now() - hasServerCache.timestamp < HAS_SERVER_CACHE_TTL) {
    return hasServerCache.value;
  }

  try {
    const proc = Bun.spawn(["tmux", "list-sessions"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const result = proc.exitCode === 0;
    hasServerCache = { value: result, timestamp: Date.now() };
    return result;
  } catch {
    hasServerCache = { value: false, timestamp: Date.now() };
    return false;
  }
}

export async function listSessions(filter?: string): Promise<TmuxSessionInfo[]> {
  const hasServer = await tmuxHasServer();
  if (!hasServer) return [];

  // Fetch sessions and all panes in parallel (2 tmux calls instead of N+M)
  const sessionFormat = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}";
  const paneFormat = "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_idle}";

  const [sessionOutput, paneOutput] = await Promise.all([
    runTmux(["list-sessions", "-F", sessionFormat]),
    runTmux(["list-panes", "-a", "-F", paneFormat]),
  ]);

  if (!sessionOutput) return [];

  // Build session map
  const sessionMap = new Map<string, TmuxSessionInfo>();

  for (const line of sessionOutput.split("\n")) {
    const [name, windows, attached, created, activity] = line.split("\t");
    if (filter && !name.startsWith(filter)) continue;

    sessionMap.set(name, {
      name,
      windows: parseInt(windows, 10),
      attached: attached === "1",
      created: parseInt(created, 10),
      activity: parseInt(activity, 10),
      windowList: [],
    });
  }

  // Build window map for grouping panes
  const windowMap = new Map<string, TmuxWindowInfo>();

  // Parse all panes and populate sessions
  if (paneOutput) {
    for (const line of paneOutput.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 11) continue;

      const [sessionName, windowIndex, windowName, windowActive, paneIndex, paneId, panePid, paneActive, command, cwd, idle] = parts;

      const session = sessionMap.get(sessionName);
      if (!session) continue; // Session filtered out

      const windowKey = `${sessionName}:${windowIndex}`;
      let window = windowMap.get(windowKey);

      if (!window) {
        window = {
          sessionName,
          index: parseInt(windowIndex, 10),
          name: windowName,
          active: windowActive === "1",
          panes: [],
        };
        windowMap.set(windowKey, window);
        session.windowList.push(window);
      }

      window.panes.push({
        sessionName,
        windowIndex: parseInt(windowIndex, 10),
        windowName,
        paneIndex: parseInt(paneIndex, 10),
        paneId,
        panePid: panePid ? parseInt(panePid, 10) : undefined,
        active: paneActive === "1",
        command,
        cwd,
        idleSeconds: idle && !isNaN(parseInt(idle, 10)) ? parseInt(idle, 10) : undefined,
      });
    }
  }

  return Array.from(sessionMap.values());
}

export async function listWindows(sessionName: string): Promise<TmuxWindowInfo[]> {
  const format = "#{window_index}\t#{window_name}\t#{window_active}";
  const output = await runTmux(["list-windows", "-t", sessionName, "-F", format]);
  if (!output) return [];

  const windows: TmuxWindowInfo[] = [];

  for (const line of output.split("\n")) {
    const [index, name, active] = line.split("\t");
    const panes = await listPanes(sessionName, parseInt(index, 10), name);

    windows.push({
      sessionName,
      index: parseInt(index, 10),
      name,
      active: active === "1",
      panes,
    });
  }

  return windows;
}

export async function listPanes(
  sessionName: string,
  windowIndex: number,
  windowName = ""
): Promise<TmuxPaneInfo[]> {
  const target = `${sessionName}:${windowIndex}`;
  const format = "#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_idle}";
  const output = await runTmux(["list-panes", "-t", target, "-F", format]);
  if (!output) return [];

  const panes: TmuxPaneInfo[] = [];

  for (const line of output.split("\n")) {
    const [index, id, pid, active, command, cwd, idle] = line.split("\t");
    panes.push({
      sessionName,
      windowIndex,
      windowName,
      paneIndex: parseInt(index, 10),
      paneId: id,
      panePid: pid ? parseInt(pid, 10) : undefined,
      active: active === "1",
      command,
      cwd,
      idleSeconds: idle && !isNaN(parseInt(idle, 10)) ? parseInt(idle, 10) : undefined,
    });
  }

  return panes;
}

/** Common shell prompt patterns to filter out */
const SHELL_PROMPT_PATTERNS = [
  /^\s*[\$%>»›]\s*$/,           // Just a prompt character
  /^\s*\S+[\$%#>]\s*$/,         // user@host$ or path$
  /^\s*>>>\s*$/,                // Python REPL
  /^\s*\.\.\.\s*$/,             // Continuation prompt
  /^\s*\(.*\)\s*[\$%>]\s*$/,    // (venv) $
  /^\s*\[\d+\]\s*[\$%>]\s*$/,   // [1] $ (job control)
];

/** Check if a line looks like a shell prompt */
export function isShellPrompt(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return SHELL_PROMPT_PATTERNS.some(p => p.test(trimmed));
}

/** Filter lines to only meaningful content (not prompts or empty) */
export function filterMeaningfulLines(lines: string[]): string[] {
  return lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (isShellPrompt(line)) return false;
    return true;
  });
}

export async function capturePane(
  target: string,
  lines = 10
): Promise<string | undefined> {
  try {
    const output = await runTmux([
      "capture-pane",
      "-t",
      target,
      "-p",
      "-S",
      `-${lines}`,
    ]);
    // Return last meaningful line (not a shell prompt)
    const meaningful = filterMeaningfulLines(output.split("\n"));
    return meaningful.at(-1);
  } catch {
    return undefined;
  }
}

/** Capture last N meaningful lines from a pane (filters prompts and empty lines) */
export async function capturePaneLines(
  target: string,
  maxLines = 3,
  captureLines = 20
): Promise<string[]> {
  try {
    const output = await runTmux([
      "capture-pane",
      "-t",
      target,
      "-p",
      "-S",
      `-${captureLines}`,
    ]);
    const meaningful = filterMeaningfulLines(output.split("\n"));
    return meaningful.slice(-maxLines);
  } catch {
    return [];
  }
}

/** Capture full pane content (all lines) */
export async function capturePaneFull(
  target: string,
  lines = 50
): Promise<string> {
  try {
    return await runTmux([
      "capture-pane",
      "-t",
      target,
      "-p",
      "-S",
      `-${lines}`,
    ]);
  } catch {
    return "";
  }
}

export async function createSession(
  sessionName: string,
  cwd?: string
): Promise<boolean> {
  const args = ["new-session", "-d", "-s", sessionName];
  if (cwd) args.push("-c", cwd);

  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

export async function sendKeys(
  target: string,
  text: string,
  enter = true
): Promise<boolean> {
  // Use -l for literal text to handle special characters
  const args = ["send-keys", "-t", target, "-l", text];
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  if (enter) {
    const enterProc = Bun.spawn(["tmux", "send-keys", "-t", target, "Enter"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await enterProc.exited;
  }

  return proc.exitCode === 0;
}

export async function killSession(sessionName: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

export async function renameSession(oldName: string, newName: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "rename-session", "-t", oldName, newName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

export async function hasSession(sessionName: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

/** Launch an agent in a new tmux session with a prompt */
export async function launchAgentSession(
  agent: AgentType,
  prompt: string,
  sessionName: string,
  cwd: string,
  extraFlags: string[] = []
): Promise<void> {
  const config = AGENT_CONFIGS[agent];
  const escapedPrompt = escapeShellArg(prompt);

  // Build command: command [defaultFlags] [extraFlags] [promptFlag] 'prompt'
  const parts = [config.command];

  if (config.defaultFlags?.length) {
    parts.push(...config.defaultFlags);
  }

  if (extraFlags.length) {
    parts.push(...extraFlags);
  }

  if (config.promptFlag) {
    parts.push(config.promptFlag);
  }

  parts.push(`'${escapedPrompt}'`);

  const fullCmd = parts.join(" ");

  const proc = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd, fullCmd],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create tmux session: ${stderr}`);
  }
}

/** Capture multiple panes in parallel (single line each) */
export async function capturePanes(
  targets: string[],
  lines = 10
): Promise<Map<string, string | undefined>> {
  const results = await Promise.all(
    targets.map(async (target) => {
      const content = await capturePane(target, lines);
      return [target, content] as const;
    })
  );
  return new Map(results);
}

/** Capture multiple panes in parallel (multiple meaningful lines each) */
export async function capturePanesMultiline(
  targets: string[],
  maxLines = 2,
  captureLines = 20
): Promise<Map<string, string[]>> {
  const results = await Promise.all(
    targets.map(async (target) => {
      const content = await capturePaneLines(target, maxLines, captureLines);
      return [target, content] as const;
    })
  );
  return new Map(results);
}

/** Known agent binary names for detection */
const KNOWN_AGENTS: Record<string, AgentType> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

/** Get all descendant PIDs of a process using in-memory tree */
function getDescendantsFromTree(pid: number, childrenMap: Map<number, number[]>): number[] {
  const children = childrenMap.get(pid) || [];
  const descendants: number[] = [...children];
  for (const child of children) {
    descendants.push(...getDescendantsFromTree(child, childrenMap));
  }
  return descendants;
}

// Cache for process stats (refresh every 5 seconds)
let statsCache: { data: Map<number, ProcessStats>; timestamp: number } | null = null;
const STATS_CACHE_TTL = 5000;

/** Get stats for multiple PIDs efficiently with a single ps call */
export async function getProcessStatsBatch(pids: number[]): Promise<Map<number, ProcessStats>> {
  if (pids.length === 0) return new Map();

  // Return cached stats if still valid
  if (statsCache && Date.now() - statsCache.timestamp < STATS_CACHE_TTL) {
    // Filter to only requested PIDs
    const result = new Map<number, ProcessStats>();
    for (const pid of pids) {
      const cached = statsCache.data.get(pid);
      if (cached) result.set(pid, cached);
    }
    return result;
  }

  try {
    // Single ps call to get ALL processes with their parent PIDs and stats
    const proc = Bun.spawn(["ps", "-axo", "pid,ppid,%cpu,%mem,rss"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return new Map();

    // Build parent->children map and stats map
    const childrenMap = new Map<number, number[]>();
    const statsMap = new Map<number, { cpu: number; mem: number; rss: number }>();

    const lines = output.trim().split("\n");
    for (let i = 1; i < lines.length; i++) { // Skip header
      const values = lines[i].trim().split(/\s+/);
      if (values.length < 5) continue;

      const pid = parseInt(values[0], 10);
      const ppid = parseInt(values[1], 10);
      const cpu = parseFloat(values[2]) || 0;
      const mem = parseFloat(values[3]) || 0;
      const rss = parseInt(values[4], 10) || 0;

      if (isNaN(pid)) continue;

      statsMap.set(pid, { cpu, mem, rss });

      if (!isNaN(ppid)) {
        const siblings = childrenMap.get(ppid) || [];
        siblings.push(pid);
        childrenMap.set(ppid, siblings);
      }
    }

    // Calculate totals for each requested PID (including descendants)
    const result = new Map<number, ProcessStats>();
    const pidSet = new Set(pids);

    for (const pid of pidSet) {
      const ownStats = statsMap.get(pid);
      if (!ownStats) continue;

      const descendants = getDescendantsFromTree(pid, childrenMap);
      let totalCpu = ownStats.cpu;
      let totalMem = ownStats.mem;
      let totalRss = ownStats.rss;

      for (const descPid of descendants) {
        const descStats = statsMap.get(descPid);
        if (descStats) {
          totalCpu += descStats.cpu;
          totalMem += descStats.mem;
          totalRss += descStats.rss;
        }
      }

      result.set(pid, {
        pid,
        cpu: totalCpu,
        memory: totalMem,
        rss: totalRss,
      });
    }

    // Cache the results
    statsCache = { data: result, timestamp: Date.now() };
    return result;
  } catch {
    return new Map();
  }
}

/** Get CPU/memory stats for a process and all its descendants (uses batch internally) */
export async function getProcessStats(pid: number): Promise<ProcessStats | undefined> {
  const batch = await getProcessStatsBatch([pid]);
  return batch.get(pid);
}

export type DetectedAgent = {
  agent: AgentType;
  command?: string;  // Full command line if available
};

/** Detect agents for multiple PIDs efficiently with a single ps call */
export async function detectAgentsBatch(pids: number[]): Promise<Map<number, DetectedAgent>> {
  if (pids.length === 0) return new Map();

  try {
    // Single ps call to get ALL processes with their parent PIDs and commands
    const proc = Bun.spawn(["ps", "-axo", "pid,ppid,comm,args"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return new Map();

    // Build parent->children map and command info map
    const childrenMap = new Map<number, number[]>();
    const processInfo = new Map<number, { comm: string; args: string }>();

    const lines = output.trim().split("\n");
    for (let i = 1; i < lines.length; i++) { // Skip header
      const match = lines[i].trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;

      const [, pidStr, ppidStr, comm, args] = match;
      const pid = parseInt(pidStr, 10);
      const ppid = parseInt(ppidStr, 10);

      if (isNaN(pid)) continue;

      processInfo.set(pid, { comm, args: args.trim() });

      if (!isNaN(ppid)) {
        const siblings = childrenMap.get(ppid) || [];
        siblings.push(pid);
        childrenMap.set(ppid, siblings);
      }
    }

    // Check each requested PID and its descendants for known agents
    const result = new Map<number, DetectedAgent>();
    const pidSet = new Set(pids);

    for (const pid of pidSet) {
      const descendants = getDescendantsFromTree(pid, childrenMap);
      const allPids = [pid, ...descendants];

      for (const checkPid of allPids) {
        const info = processInfo.get(checkPid);
        if (!info) continue;

        const commLower = info.comm.toLowerCase();

        // Check if this is a known agent binary
        if (KNOWN_AGENTS[commLower]) {
          result.set(pid, { agent: KNOWN_AGENTS[commLower], command: info.args });
          break;
        }

        // Check args for agent names (e.g., "node /path/to/claude")
        const argsLower = info.args.toLowerCase();
        let found = false;
        for (const [name, agent] of Object.entries(KNOWN_AGENTS)) {
          if (argsLower.includes(`/${name}`) || argsLower.includes(` ${name} `)) {
            result.set(pid, { agent, command: info.args });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    return result;
  } catch {
    return new Map();
  }
}

/** Detect agent type from a pane's process tree (uses batch internally) */
export async function detectAgentFromPid(pid: number): Promise<DetectedAgent | undefined> {
  const batch = await detectAgentsBatch([pid]);
  return batch.get(pid);
}
