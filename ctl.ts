import { parseArgs } from "util";
import { listSessions, killSession } from "./lib/tmux";
import { readSessionMeta, buildSessionMetaMap, markSessionDone } from "./lib/sessions";
import { readJsonlTail, expandHome } from "./lib/jsonl";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR } from "./lib/types";
import type { HookEntry, SessionMetaEntry } from "./lib/types";

const USAGE = `agentwatch-ctl - CLI for agentwatch operations

Usage:
  bun run ctl.ts <command> [options]

Commands:
  sessions [--filter PREFIX] [--json]     List sessions with metadata
  session <name> [--json]                 Get single session detail
  done <name>                             Mark session done
  kill <name>                             Kill session
  hooks [--limit N] [--event TYPE] [--json]  List recent hooks

Options:
  -d, --data-dir PATH   Data directory (default: ${DEFAULT_DATA_DIR})
  -p, --port PORT       Hooks server port for HTTP mode (default: ${DEFAULT_HOOKS_PORT})
  --http                Use HTTP API instead of direct file access
  --json                Output as JSON
  -h, --help            Show this help

Examples:
  bun run ctl.ts sessions
  bun run ctl.ts sessions --filter awm --json
  bun run ctl.ts session awm_abc123
  bun run ctl.ts done awm_abc123
  bun run ctl.ts kill awm_abc123
  bun run ctl.ts hooks --limit 20 --event PostToolUse
`;

type SessionListItem = {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
  activity?: number;
  meta: SessionMetaEntry | null;
};

async function cmdSessions(options: {
  filter?: string;
  json: boolean;
  dataDir: string;
  http: boolean;
  port: number;
}): Promise<void> {
  if (options.http) {
    const url = `http://localhost:${options.port}/sessions${options.filter ? `?filter=${encodeURIComponent(options.filter)}` : ""}`;
    const res = await fetch(url);
    const data = await res.json() as { ok: boolean; sessions: SessionListItem[]; total: number };
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      printSessions(data.sessions);
    }
    return;
  }

  const sessions = await listSessions(options.filter);
  const entries = await readSessionMeta(options.dataDir).catch(() => []);
  const metaMap = buildSessionMetaMap(entries);

  const result: SessionListItem[] = sessions.map((s) => ({
    name: s.name,
    windows: s.windows,
    attached: s.attached,
    created: s.created,
    activity: s.activity,
    meta: metaMap.get(s.name) ?? null,
  }));

  if (options.json) {
    console.log(JSON.stringify({ ok: true, sessions: result, total: result.length }, null, 2));
  } else {
    printSessions(result);
  }
}

function printSessions(sessions: SessionListItem[]): void {
  if (sessions.length === 0) {
    console.log("No sessions found");
    return;
  }

  for (const s of sessions) {
    const attached = s.attached ? "●" : "○";
    const status = s.meta?.status === "done" ? " [done]" : "";
    const agent = s.meta?.agent ? ` (${s.meta.agent})` : "";
    const created = s.created ? ` ${formatAge(s.created)}` : "";
    console.log(`${attached} ${s.name}${agent}${created}${status}`);
    if (s.meta?.promptPreview) {
      console.log(`   ${s.meta.promptPreview.slice(0, 60)}${s.meta.promptPreview.length > 60 ? "..." : ""}`);
    }
  }
}

function formatAge(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

async function cmdSession(name: string, options: {
  json: boolean;
  dataDir: string;
  http: boolean;
  port: number;
}): Promise<void> {
  if (options.http) {
    const url = `http://localhost:${options.port}/sessions/${encodeURIComponent(name)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else if (!data.ok) {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    } else {
      printSessionDetail(data.session);
    }
    return;
  }

  const sessions = await listSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) {
    console.error(`Error: Session "${name}" not found`);
    process.exit(1);
  }

  const entries = await readSessionMeta(options.dataDir).catch(() => []);
  const metaMap = buildSessionMetaMap(entries);

  const result = {
    name: session.name,
    windows: session.windows,
    attached: session.attached,
    created: session.created,
    activity: session.activity,
    windowList: session.windowList,
    meta: metaMap.get(session.name) ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify({ ok: true, session: result }, null, 2));
  } else {
    printSessionDetail(result);
  }
}

function printSessionDetail(session: SessionListItem & { windowList?: unknown[] }): void {
  const attached = session.attached ? "● attached" : "○ detached";
  console.log(`Session: ${session.name}`);
  console.log(`Status: ${attached}`);
  console.log(`Windows: ${session.windows}`);
  if (session.created) console.log(`Created: ${new Date(session.created * 1000).toISOString()}`);
  if (session.activity) console.log(`Activity: ${new Date(session.activity * 1000).toISOString()}`);

  if (session.meta) {
    console.log(`\nMetadata:`);
    if (session.meta.agent) console.log(`  Agent: ${session.meta.agent}`);
    if (session.meta.status) console.log(`  Status: ${session.meta.status}`);
    if (session.meta.cwd) console.log(`  CWD: ${session.meta.cwd}`);
    if (session.meta.tag) console.log(`  Tag: ${session.meta.tag}`);
    if (session.meta.promptPreview) console.log(`  Prompt: ${session.meta.promptPreview}`);
  }
}

async function cmdDone(name: string, options: {
  dataDir: string;
  http: boolean;
  port: number;
}): Promise<void> {
  if (options.http) {
    const url = `http://localhost:${options.port}/sessions/${encodeURIComponent(name)}/done`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json() as { ok: boolean; newName?: string; error?: string };
    if (!data.ok) {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
    console.log(`Marked done: ${name} → ${data.newName}`);
    return;
  }

  const sessions = await listSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) {
    console.error(`Error: Session "${name}" not found`);
    process.exit(1);
  }

  const entries = await readSessionMeta(options.dataDir).catch(() => []);
  const metaMap = buildSessionMetaMap(entries);
  const meta = metaMap.get(session.name);

  const result = await markSessionDone(options.dataDir, session.name, meta);
  if (!result) {
    console.error(`Error: Failed to mark session done`);
    process.exit(1);
  }

  console.log(`Marked done: ${name} → ${result.newName}`);
}

async function cmdKill(name: string, options: {
  http: boolean;
  port: number;
}): Promise<void> {
  if (options.http) {
    const url = `http://localhost:${options.port}/sessions/${encodeURIComponent(name)}/kill`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json() as { ok: boolean; killed?: string; error?: string };
    if (!data.ok) {
      console.error(`Error: ${data.error}`);
      process.exit(1);
    }
    console.log(`Killed: ${data.killed}`);
    return;
  }

  const killed = await killSession(name);
  if (!killed) {
    console.error(`Error: Failed to kill session "${name}"`);
    process.exit(1);
  }

  console.log(`Killed: ${name}`);
}

async function cmdHooks(options: {
  limit: number;
  event?: string;
  json: boolean;
  dataDir: string;
  http: boolean;
  port: number;
}): Promise<void> {
  if (options.http) {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit));
    if (options.event) params.set("event", options.event);
    const url = `http://localhost:${options.port}/hooks/recent?${params}`;
    const res = await fetch(url);
    const data = await res.json() as { ok: boolean; hooks: HookEntry[]; total: number };
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      printHooks(data.hooks);
    }
    return;
  }

  const hooksFile = `${expandHome(options.dataDir)}/hooks.jsonl`;
  let hooks = await readJsonlTail<HookEntry>(hooksFile, options.limit * 2).catch(() => []);
  if (options.event) {
    hooks = hooks.filter((h) => h.event === options.event);
  }
  hooks = hooks.slice(-options.limit);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, hooks, total: hooks.length }, null, 2));
  } else {
    printHooks(hooks);
  }
}

function printHooks(hooks: HookEntry[]): void {
  if (hooks.length === 0) {
    console.log("No hooks found");
    return;
  }

  for (const h of hooks.slice().reverse()) {
    const time = new Date(h.timestamp).toLocaleTimeString("en-US", { hour12: false });
    const payload = formatHookPayload(h.payload);
    console.log(`${time} ${h.event.padEnd(15)} ${payload}`);
  }
}

function formatHookPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];

  if (payload.cwd) {
    const cwdParts = String(payload.cwd).split("/");
    const lastDir = cwdParts[cwdParts.length - 1] || cwdParts[cwdParts.length - 2] || "";
    if (lastDir) parts.push(lastDir);
  }

  if (payload.tool_name) {
    const tool = payload.tool_name as string;
    const input = payload.tool_input as Record<string, unknown> | undefined;
    let toolInfo = tool;

    if (input) {
      if ((tool === "Read" || tool === "Write" || tool === "Edit") && input.file_path) {
        const path = String(input.file_path).split("/").pop() || "";
        toolInfo = `${tool}:${path}`;
      } else if (tool === "Bash" && input.command) {
        const cmd = String(input.command).slice(0, 30);
        toolInfo = `${tool}:${cmd}${String(input.command).length > 30 ? "…" : ""}`;
      }
    }
    parts.push(toolInfo);
  }

  if (payload.message) {
    const msg = String(payload.message).slice(0, 40);
    parts.push(msg + (String(payload.message).length > 40 ? "…" : ""));
  }

  return parts.join(" ") || JSON.stringify(payload).slice(0, 50);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "data-dir": { type: "string", short: "d", default: DEFAULT_DATA_DIR },
      port: { type: "string", short: "p", default: String(DEFAULT_HOOKS_PORT) },
      http: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      filter: { type: "string", short: "f" },
      limit: { type: "string", short: "l", default: "50" },
      event: { type: "string", short: "e" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = positionals[0];
  const dataDir = values["data-dir"]!;
  const port = parseInt(values.port!, 10);
  const http = values.http ?? false;
  const json = values.json ?? false;

  switch (command) {
    case "sessions":
      await cmdSessions({ filter: values.filter, json, dataDir, http, port });
      break;

    case "session":
      if (!positionals[1]) {
        console.error("Error: session name required");
        process.exit(1);
      }
      await cmdSession(positionals[1], { json, dataDir, http, port });
      break;

    case "done":
      if (!positionals[1]) {
        console.error("Error: session name required");
        process.exit(1);
      }
      await cmdDone(positionals[1], { dataDir, http, port });
      break;

    case "kill":
      if (!positionals[1]) {
        console.error("Error: session name required");
        process.exit(1);
      }
      await cmdKill(positionals[1], { http, port });
      break;

    case "hooks":
      await cmdHooks({
        limit: parseInt(values.limit!, 10),
        event: values.event,
        json,
        dataDir,
        http,
        port,
      });
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
