import { parseArgs } from "util";
import { createId, createSessionName } from "./lib/ids";
import {
  type AgentType,
  type LaunchedSession,
  AGENT_COMMANDS,
  DEFAULT_SESSION_PREFIX,
} from "./lib/types";

function parseAgents(input: string): AgentType[] {
  const valid: AgentType[] = ["claude", "codex", "gemini"];
  return input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AgentType => valid.includes(s as AgentType));
}

async function launchAgent(
  agent: AgentType,
  prompt: string,
  cwd: string,
  prefix: string
): Promise<LaunchedSession> {
  const sessionName = createSessionName(prefix, agent);
  const id = createId("launch");

  // Build command with prompt as argument
  // Claude: claude "prompt"
  // Codex: codex "prompt"
  // Gemini: gemini "prompt"
  const baseCmd = AGENT_COMMANDS[agent][0];
  const escapedPrompt = prompt.replace(/'/g, "'\"'\"'"); // Escape single quotes for shell
  const fullCmd = `${baseCmd} '${escapedPrompt}'`;

  // Create tmux session with the command
  const proc = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd, fullCmd],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create tmux session: ${stderr}`);
  }

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
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`agentwatch-minimal launcher

Usage:
  bun run launch.ts "your prompt" [options]

Options:
  -a, --agents    Comma-separated agents: claude,codex,gemini (default: claude)
  -c, --cwd       Working directory for agents
  -p, --prefix    Session name prefix (default: awm)
  -h, --help      Show this help

Examples:
  bun run launch.ts "Fix the auth bug" --agents claude,codex
  bun run launch.ts "Write tests" --agents claude --cwd /path/to/project
`);
    process.exit(0);
  }

  const prompt = positionals.join(" ");
  const agents = parseAgents(values.agents!);
  const cwd = values.cwd ?? process.cwd();
  const prefix = values.prefix!;

  if (agents.length === 0) {
    console.error("Error: No valid agents specified");
    process.exit(1);
  }

  console.log(`Launching ${agents.length} agent(s) with prompt:`);
  console.log(`  "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);
  console.log(`  Agents: ${agents.join(", ")}`);
  console.log(`  CWD: ${cwd}`);
  console.log();

  const launched: LaunchedSession[] = [];

  for (const agent of agents) {
    try {
      console.log(`Starting ${agent}...`);
      const session = await launchAgent(agent, prompt, cwd, prefix);
      launched.push(session);
      console.log(`  Session: ${session.sessionName}`);
    } catch (err) {
      console.error(`  Failed: ${err}`);
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
