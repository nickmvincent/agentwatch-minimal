import type { TmuxSessionInfo, TmuxWindowInfo, TmuxPaneInfo } from "./types";

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
    const panes = await listPanes(sessionName, parseInt(index, 10));

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
  windowIndex: number
): Promise<TmuxPaneInfo[]> {
  const target = `${sessionName}:${windowIndex}`;
  const format = "#{pane_index}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_idle}";
  const output = await runTmux(["list-panes", "-t", target, "-F", format]);
  if (!output) return [];

  const panes: TmuxPaneInfo[] = [];

  for (const line of output.split("\n")) {
    const [index, id, active, command, cwd, idle] = line.split("\t");
    panes.push({
      sessionName,
      windowIndex,
      windowName: "",
      paneIndex: parseInt(index, 10),
      paneId: id,
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
