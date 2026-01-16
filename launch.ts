import { parseArgs } from "util";
import { createId, createSessionName } from "./lib/ids";
import { launchAgentSession } from "./lib/tmux";
import {
  type AgentType,
  type LaunchedSession,
  DEFAULT_SESSION_PREFIX,
} from "./lib/types";

type AgentFlags = Partial<Record<AgentType, string[]>>;

function parseAgents(input: string): AgentType[] {
  const valid: AgentType[] = ["claude", "codex", "gemini"];
  return input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AgentType => valid.includes(s as AgentType));
}

function parseFlags(input: string | undefined): string[] {
  if (!input) return [];
  // Split on spaces, but respect quoted strings
  return input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

async function launchAgent(
  agent: AgentType,
  prompt: string,
  cwd: string,
  prefix: string,
  extraFlags: string[] = []
): Promise<LaunchedSession> {
  const sessionName = createSessionName(prefix, agent);
  const id = createId("launch");

  await launchAgentSession(agent, prompt, sessionName, cwd, extraFlags);

  return {
    id,
    agent,
    sessionName,
    prompt,
    cwd,
    startedAt: new Date().toISOString(),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      agents: { type: "string", short: "a", default: "claude" },
      cwd: { type: "string", short: "c" },
      prefix: { type: "string", short: "p", default: DEFAULT_SESSION_PREFIX },
      "claude-flags": { type: "string" },
      "codex-flags": { type: "string" },
      "gemini-flags": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`agentwatch-minimal launcher

Usage:
  bun run launch.ts "your prompt" [options]

Options:
  -a, --agents        Comma-separated agents: claude,codex,gemini (default: claude)
  -c, --cwd           Working directory for agents
  -p, --prefix        Session name prefix (default: awm)
  --claude-flags      Extra flags for Claude (e.g., "--dangerously-skip-permissions")
  --codex-flags       Extra flags for Codex (e.g., "--approval-mode full-auto")
  --gemini-flags      Extra flags for Gemini (e.g., "--yolo")
  -h, --help          Show this help

Examples:
  bun run launch.ts "Fix the auth bug" --agents claude,codex
  bun run launch.ts "Write tests" --agents gemini --gemini-flags "--yolo"
  bun run launch.ts "Refactor" --agents claude,codex --codex-flags "--approval-mode full-auto"
`);
    process.exit(0);
  }

  const prompt = positionals.join(" ");
  const agents = parseAgents(values.agents!);
  const cwd = values.cwd ?? process.cwd();
  const prefix = values.prefix!;

  // Parse agent-specific flags
  const agentFlags: AgentFlags = {
    claude: parseFlags(values["claude-flags"]),
    codex: parseFlags(values["codex-flags"]),
    gemini: parseFlags(values["gemini-flags"]),
  };

  if (agents.length === 0) {
    console.error("Error: No valid agents specified");
    process.exit(1);
  }

  console.log(`Launching ${agents.length} agent(s) with prompt:`);
  console.log(`  "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);
  console.log(`  Agents: ${agents.join(", ")}`);
  console.log(`  CWD: ${cwd}`);
  console.log();

  // Launch all agents in parallel
  const results = await Promise.allSettled(
    agents.map((agent) => launchAgent(agent, prompt, cwd, prefix, agentFlags[agent] || []))
  );

  const launched: LaunchedSession[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const agent = agents[i];
    if (result.status === "fulfilled") {
      launched.push(result.value);
      console.log(`Started ${agent}: ${result.value.sessionName}`);
    } else {
      console.error(`Failed ${agent}: ${result.reason}`);
    }
  }

  console.log();
  console.log("Sessions created:");
  for (const session of launched) {
    console.log(`  tmux attach -t ${session.sessionName}`);
  }

  if (launched.length > 1) {
    console.log();
    console.log("Or watch all sessions:");
    console.log(`  bun run watch.ts --filter ${prefix}`);
  }
}

main().catch(console.error);
