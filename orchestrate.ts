import { parseArgs } from "util";
import { createId, createSessionName } from "./lib/ids";
import {
  type AgentType,
  type SubTask,
  type OrchestrationPlan,
  AGENT_COMMANDS,
  DEFAULT_SESSION_PREFIX,
} from "./lib/types";

const DECOMPOSITION_PROMPT = `You are a task decomposer. Given a complex task, break it down into independent sub-tasks that can be worked on in parallel by different coding agents.

For each sub-task, specify:
1. A short description (2-5 words)
2. The recommended agent: "claude", "codex", or "gemini"
3. The detailed prompt to give that agent
4. Dependencies (IDs of tasks that must complete first, or empty array for independent tasks)

Output ONLY a JSON array, no other text:
[
  {
    "description": "Short task name",
    "agent": "claude",
    "prompt": "Detailed instructions for the agent...",
    "dependencies": []
  }
]

Guidelines:
- Prefer "claude" for complex reasoning, refactoring, debugging
- Prefer "codex" for straightforward code generation, tests
- Prefer "gemini" for research, documentation, exploration
- Make tasks as independent as possible to maximize parallelism
- Each task should be completable in a single agent session

Task to decompose:
`;

async function decomposeWithClaude(prompt: string): Promise<SubTask[]> {
  const fullPrompt = DECOMPOSITION_PROMPT + prompt;

  console.log("Asking Claude to decompose the task...\n");

  const proc = Bun.spawn(["claude", "-p", fullPrompt], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Claude exited with code ${exitCode}: ${stderr}`);
  }

  // Extract JSON from response
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("Claude output:", output);
    throw new Error("Could not find JSON array in Claude response");
  }

  const tasks = JSON.parse(jsonMatch[0]) as Array<{
    description: string;
    agent: AgentType;
    prompt: string;
    dependencies?: string[];
  }>;

  return tasks.map((task, i) => ({
    id: `task_${i + 1}`,
    description: task.description,
    agent: task.agent,
    prompt: task.prompt,
    dependencies: task.dependencies ?? [],
  }));
}

async function launchSubTask(
  task: SubTask,
  cwd: string,
  prefix: string
): Promise<string> {
  const sessionName = createSessionName(prefix, `${task.agent}-${task.id}`);

  // Build command with prompt as argument
  const baseCmd = AGENT_COMMANDS[task.agent][0];
  const escapedPrompt = task.prompt.replace(/'/g, "'\"'\"'");
  const fullCmd = `${baseCmd} '${escapedPrompt}'`;

  // Create tmux session with the command
  const proc = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd, fullCmd],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create session: ${stderr}`);
  }

  return sessionName;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      cwd: { type: "string", short: "c" },
      prefix: { type: "string", short: "p", default: DEFAULT_SESSION_PREFIX },
      "dry-run": { type: "boolean", short: "n" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`agentwatch-minimal orchestrator

Usage:
  bun run orchestrate.ts "complex task description" [options]

Options:
  -c, --cwd       Working directory for agents
  -p, --prefix    Session name prefix (default: awm)
  -n, --dry-run   Show decomposition plan without launching agents
  -h, --help      Show this help

Examples:
  bun run orchestrate.ts "Build a REST API with auth, validation, and tests"
  bun run orchestrate.ts "Refactor the payment module" --dry-run
`);
    process.exit(0);
  }

  const prompt = positionals.join(" ");
  const cwd = values.cwd ?? process.cwd();
  const prefix = values.prefix!;
  const dryRun = values["dry-run"] ?? false;

  console.log("═".repeat(60));
  console.log("agentwatch-minimal orchestrator");
  console.log("═".repeat(60));
  console.log();
  console.log(`Task: "${prompt}"`);
  console.log(`CWD: ${cwd}`);
  console.log();

  // Decompose the task
  const tasks = await decomposeWithClaude(prompt);

  const plan: OrchestrationPlan = {
    id: createId("plan"),
    originalPrompt: prompt,
    decomposedAt: new Date().toISOString(),
    tasks,
    orchestratorAgent: "claude",
  };

  console.log("─".repeat(60));
  console.log(`Decomposed into ${tasks.length} sub-task(s):`);
  console.log("─".repeat(60));
  console.log();

  for (const task of tasks) {
    console.log(`[${task.id}] ${task.description}`);
    console.log(`  Agent: ${task.agent}`);
    console.log(`  Prompt: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? "..." : ""}`);
    if (task.dependencies && task.dependencies.length > 0) {
      console.log(`  Depends on: ${task.dependencies.join(", ")}`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("─".repeat(60));
    console.log("Dry run - no agents launched");
    console.log(`Plan ID: ${plan.id}`);
    return;
  }

  // Launch independent tasks (no dependencies)
  const independent = tasks.filter(
    (t) => !t.dependencies || t.dependencies.length === 0
  );
  const dependent = tasks.filter(
    (t) => t.dependencies && t.dependencies.length > 0
  );

  console.log("─".repeat(60));
  console.log(`Launching ${independent.length} independent task(s)...`);
  console.log("─".repeat(60));
  console.log();

  const launched: Map<string, string> = new Map();

  for (const task of independent) {
    try {
      const sessionName = await launchSubTask(task, cwd, prefix);
      launched.set(task.id, sessionName);
      console.log(`  [${task.id}] ${task.description} -> ${sessionName}`);
    } catch (err) {
      console.error(`  [${task.id}] Failed: ${err}`);
    }
  }

  if (dependent.length > 0) {
    console.log();
    console.log(`Note: ${dependent.length} task(s) have dependencies:`);
    for (const task of dependent) {
      console.log(`  [${task.id}] depends on: ${task.dependencies!.join(", ")}`);
    }
    console.log();
    console.log("Launch these manually after dependencies complete:");
    for (const task of dependent) {
      const sessionName = createSessionName(prefix, `${task.agent}-${task.id}`);
      console.log(`  bun run launch.ts "${task.prompt.slice(0, 50)}..." --agents ${task.agent}`);
    }
  }

  console.log();
  console.log("═".repeat(60));
  console.log("Sessions created:");
  for (const [taskId, sessionName] of launched) {
    console.log(`  tmux attach -t ${sessionName}`);
  }
  console.log();
  console.log("Watch all sessions:");
  console.log(`  bun run watch.ts --filter ${prefix}`);
}

main().catch(console.error);
