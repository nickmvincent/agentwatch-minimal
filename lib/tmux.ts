import type { TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo, AgentType, ProcessStats } from "./types";
import { AGENT_COMMANDS } from "./types";

/** Escape a string for safe use in single-quoted shell argument */
export function escapeShellArg(str: string): string {
  return str.replace(/'/g, "'\"'\"'");
}

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
  try {
    const proc = Bun.spawn(["tmux", "list-sessions"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function listSessions(filter?: string): Promise<TmuxSessionInfo[]> {
  const hasServer = await tmuxHasServer();
  if (!hasServer) return [];

  const format = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}";
  const output = await runTmux(["list-sessions", "-F", format]);
  if (!output) return [];

  const sessions: TmuxSessionInfo[] = [];

  for (const line of output.split("\n")) {
    const [name, windows, attached, created, activity] = line.split("\t");
    if (filter && !name.startsWith(filter)) continue;

    sessions.push({
      name,
      windows: parseInt(windows, 10),
      attached: attached === "1",
      created: parseInt(created, 10),
      activity: parseInt(activity, 10),
      windowList: [],
    });
  }

  // Fetch windows and panes for each session
  for (const session of sessions) {
    session.windowList = await listWindows(session.name);
  }

  return sessions;
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
      idleSeconds: parseInt(idle, 10),
    });
  }

  return panes;
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
    // Return last non-empty line
    const nonEmpty = output.split("\n").filter((l) => l.trim());
    return nonEmpty.at(-1);
  } catch {
    return undefined;
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
  cwd: string
): Promise<void> {
  const baseCmd = AGENT_COMMANDS[agent][0];
  const escapedPrompt = escapeShellArg(prompt);
  const fullCmd = `${baseCmd} '${escapedPrompt}'`;

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

/** Capture multiple panes in parallel */
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

/** Get CPU/memory stats for a process by PID */
export async function getProcessStats(pid: number): Promise<ProcessStats | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-o", "%cpu,%mem,rss", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return undefined;

    // Parse output: skip header, get values
    const lines = output.trim().split("\n");
    if (lines.length < 2) return undefined;

    const values = lines[1].trim().split(/\s+/);
    if (values.length < 3) return undefined;

    return {
      pid,
      cpu: parseFloat(values[0]) || 0,
      memory: parseFloat(values[1]) || 0,
      rss: parseInt(values[2], 10) || 0,
    };
  } catch {
    return undefined;
  }
}

/** Get stats for multiple PIDs in parallel */
export async function getProcessStatsBatch(pids: number[]): Promise<Map<number, ProcessStats>> {
  const results = await Promise.all(
    pids.map(async (pid) => {
      const stats = await getProcessStats(pid);
      return [pid, stats] as const;
    })
  );
  const map = new Map<number, ProcessStats>();
  for (const [pid, stats] of results) {
    if (stats) map.set(pid, stats);
  }
  return map;
}
