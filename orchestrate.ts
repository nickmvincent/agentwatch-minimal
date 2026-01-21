import { parseArgs } from "util";
import { createId, createSessionName } from "./lib/ids";
import { launchAgentSession, hasSession } from "./lib/tmux";
import { appendSessionMeta, makePromptPreview, normalizeTag } from "./lib/sessions";
import { expandHome } from "./lib/jsonl";
import {
  type AgentType,
  type SubTask,
  type OrchestrationPlan,
  DEFAULT_DATA_DIR,
  DEFAULT_SESSION_PREFIX,
} from "./lib/types";
import { dirname } from "path";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";

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

type AgentFlags = Partial<Record<AgentType, string[]>>;

function parseFlags(input: string | undefined): string[] {
  if (!input) return [];
  return input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

async function readPromptInput(promptFile: string): Promise<string> {
  if (promptFile === "-") {
    return readFileSync(0, "utf8");
  }
  return Bun.file(expandHome(promptFile)).text();
}

function normalizeAgent(agent: string | undefined, index: number): AgentType {
  const normalized = (agent ?? "").toLowerCase();
  if (normalized === "claude" || normalized === "codex" || normalized === "gemini") {
    return normalized;
  }
  throw new Error(`Task ${index + 1} has invalid agent: ${agent}`);
}

function normalizeTasks(rawTasks: Array<Partial<SubTask> & { agent?: string }>): SubTask[] {
  return rawTasks.map((task, i) => {
    if (!task.prompt) {
      throw new Error(`Task ${i + 1} is missing a prompt`);
    }
    return {
      id: task.id ?? `task_${i + 1}`,
      description: task.description ?? `task_${i + 1}`,
      agent: normalizeAgent(task.agent, i),
      prompt: task.prompt,
      dependencies: task.dependencies ?? [],
    };
  });
}

async function loadPlanFromFile(
  filePath: string,
  fallbackPrompt: string
): Promise<OrchestrationPlan> {
  const contents = await Bun.file(expandHome(filePath)).text();
  const parsed = JSON.parse(contents) as Partial<OrchestrationPlan> | Array<Partial<SubTask>>;

  if (Array.isArray(parsed)) {
    const tasks = normalizeTasks(parsed);
    return {
      id: createId("plan"),
      originalPrompt: fallbackPrompt || "plan-file",
      decomposedAt: new Date().toISOString(),
      tasks,
      orchestratorAgent: "claude",
    };
  }

  const tasks = normalizeTasks(parsed.tasks ?? []);
  return {
    id: parsed.id ?? createId("plan"),
    originalPrompt: parsed.originalPrompt ?? fallbackPrompt || "plan-file",
    decomposedAt: parsed.decomposedAt ?? new Date().toISOString(),
    tasks,
    orchestratorAgent: parsed.orchestratorAgent ?? "claude",
  };
}

async function savePlanToFile(plan: OrchestrationPlan, filePath: string): Promise<void> {
  const expanded = expandHome(filePath);
  await mkdir(dirname(expanded), { recursive: true });
  await Bun.write(expanded, JSON.stringify(plan, null, 2));
}

async function launchSubTask(
  task: SubTask,
  cwd: string,
  prefix: string,
  agentFlags: AgentFlags = {},
  dataDir: string,
  tag: string | undefined,
  planId: string
): Promise<string> {
  const sessionName = createSessionName(prefix, `${task.agent}-${task.id}`);
  await launchAgentSession(task.agent, task.prompt, sessionName, cwd, agentFlags[task.agent] || []);
  try {
    await appendSessionMeta(dataDir, {
      sessionName,
      agent: task.agent,
      promptPreview: makePromptPreview(task.prompt),
      cwd,
      tag,
      planId,
      taskId: task.id,
      source: "orchestrate",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to write session metadata: ${msg}`);
  }
  return sessionName;
}

const POLL_INTERVAL_MS = 5000;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      cwd: { type: "string", short: "c" },
      prefix: { type: "string", short: "p", default: DEFAULT_SESSION_PREFIX },
      "dry-run": { type: "boolean", short: "n" },
      wait: { type: "boolean", short: "w" },
      "prompt-file": { type: "string" },
      "plan-file": { type: "string" },
      "save-plan": { type: "string" },
      "data-dir": { type: "string", short: "d", default: DEFAULT_DATA_DIR },
      tag: { type: "string" },
      "claude-flags": { type: "string" },
      "codex-flags": { type: "string" },
      "gemini-flags": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const hasPromptInput = positionals.length > 0 || values["prompt-file"];
  const hasPlanFile = Boolean(values["plan-file"]);

  if (values.help || (!hasPromptInput && !hasPlanFile)) {
    console.log(`agentwatch-minimal orchestrator

Usage:
  bun run orchestrate.ts "complex task description" [options]

Options:
  -c, --cwd           Working directory for agents
  -p, --prefix        Session name prefix (default: awm)
  -n, --dry-run       Show decomposition plan without launching agents
  -w, --wait          Wait for dependencies and launch dependent tasks automatically
  --prompt-file       Read task prompt from file ("-" for stdin)
  --plan-file         Use an existing plan JSON instead of Claude decomposition
  --save-plan         Save plan JSON to a file
  -d, --data-dir      Data directory for session metadata (default: ${DEFAULT_DATA_DIR})
  --tag               Tag to label sessions
  --claude-flags      Extra flags for Claude agents
  --codex-flags       Extra flags for Codex agents
  --gemini-flags      Extra flags for Gemini agents
  -h, --help          Show this help

Examples:
  bun run orchestrate.ts "Build a REST API with auth, validation, and tests"
  bun run orchestrate.ts "Refactor the payment module" --dry-run
  bun run orchestrate.ts "Complex task" --wait --gemini-flags "--yolo"
  bun run orchestrate.ts --prompt-file ./task.txt --save-plan ./plan.json
`);
    process.exit(0);
  }

  if (values["prompt-file"] && positionals.length > 0) {
    console.error("Error: Provide either a prompt string or --prompt-file, not both.");
    process.exit(1);
  }

  let prompt = positionals.join(" ");
  if (values["prompt-file"]) {
    prompt = await readPromptInput(values["prompt-file"]!);
  }

  const cwd = values.cwd ?? process.cwd();
  const prefix = values.prefix!;
  const dryRun = values["dry-run"] ?? false;
  const waitForDeps = values.wait ?? false;
  const dataDir = values["data-dir"]!;
  const tag = normalizeTag(values.tag);

  // Parse agent-specific flags
  const agentFlags: AgentFlags = {
    claude: parseFlags(values["claude-flags"]),
    codex: parseFlags(values["codex-flags"]),
    gemini: parseFlags(values["gemini-flags"]),
  };

  console.log("═".repeat(60));
  console.log("agentwatch-minimal orchestrator");
  console.log("═".repeat(60));
  console.log();
  if (prompt) {
    console.log(`Task: "${prompt}"`);
  } else if (values["plan-file"]) {
    console.log(`Task: "plan-file"`);
  }
  console.log(`CWD: ${cwd}`);
  console.log();

  // Decompose the task
  let plan: OrchestrationPlan;
  if (values["plan-file"]) {
    plan = await loadPlanFromFile(values["plan-file"]!, prompt);
  } else {
    const tasks = await decomposeWithClaude(prompt);
    plan = {
      id: createId("plan"),
      originalPrompt: prompt,
      decomposedAt: new Date().toISOString(),
      tasks,
      orchestratorAgent: "claude",
    };
  }

  if (values["save-plan"]) {
    const savePath = values["save-plan"]!;
    await savePlanToFile(plan, savePath);
    console.log(`Saved plan to ${expandHome(savePath)}`);
  }

  console.log("─".repeat(60));
  console.log(`Decomposed into ${plan.tasks.length} sub-task(s):`);
  console.log("─".repeat(60));
  console.log();

  for (const task of plan.tasks) {
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

  // Separate independent and dependent tasks
  const independent = plan.tasks.filter(
    (t) => !t.dependencies || t.dependencies.length === 0
  );
  const dependent = plan.tasks.filter(
    (t) => t.dependencies && t.dependencies.length > 0
  );

  console.log("─".repeat(60));
  console.log(`Launching ${independent.length} independent task(s) in parallel...`);
  console.log("─".repeat(60));
  console.log();

  // Track launched sessions: taskId -> sessionName
  const launched: Map<string, string> = new Map();
  // Track completed tasks (session no longer exists)
  const completed: Set<string> = new Set();

  // Launch independent tasks in parallel
  const independentResults = await Promise.allSettled(
    independent.map((task) => launchSubTask(task, cwd, prefix, agentFlags, dataDir, tag, plan.id))
  );

  for (let i = 0; i < independentResults.length; i++) {
    const result = independentResults[i];
    const task = independent[i];
    if (result.status === "fulfilled") {
      launched.set(task.id, result.value);
      console.log(`  [${task.id}] ${task.description} -> ${result.value}`);
    } else {
      console.error(`  [${task.id}] Failed: ${result.reason}`);
    }
  }

  if (dependent.length > 0) {
    console.log();
    console.log(`${dependent.length} task(s) have dependencies:`);
    for (const task of dependent) {
      console.log(`  [${task.id}] depends on: ${task.dependencies!.join(", ")}`);
    }

    if (waitForDeps) {
      console.log();
      console.log("─".repeat(60));
      console.log("Waiting for dependencies to complete...");
      console.log("─".repeat(60));

      const pending = new Set(dependent.map((t) => t.id));

      while (pending.size > 0) {
        // Check which launched tasks have completed (session gone)
        for (const [taskId, sessionName] of launched) {
          if (!completed.has(taskId)) {
            const stillRunning = await hasSession(sessionName);
            if (!stillRunning) {
              completed.add(taskId);
              console.log(`  [${taskId}] completed`);
            }
          }
        }

        // Find tasks whose dependencies are all completed
        for (const task of dependent) {
          if (!pending.has(task.id)) continue;
          const deps = task.dependencies ?? [];
          const allDepsComplete = deps.every((d) => completed.has(d));

          if (allDepsComplete) {
            pending.delete(task.id);
            try {
              console.log(`  [${task.id}] dependencies ready, launching...`);
              const sessionName = await launchSubTask(task, cwd, prefix, agentFlags, dataDir, tag, plan.id);
              launched.set(task.id, sessionName);
              console.log(`  [${task.id}] ${task.description} -> ${sessionName}`);
            } catch (err) {
              console.error(`  [${task.id}] Failed: ${err}`);
            }
          }
        }

        if (pending.size > 0) {
          await Bun.sleep(POLL_INTERVAL_MS);
        }
      }
    } else {
      console.log();
      console.log("Run with --wait to auto-launch dependent tasks, or launch manually:");
      for (const task of dependent) {
        console.log(`  bun run launch.ts "${task.prompt.slice(0, 50)}..." --agents ${task.agent}`);
      }
    }
  }

  console.log();
  console.log("═".repeat(60));
  console.log("Sessions created:");
  for (const [, sessionName] of launched) {
    console.log(`  tmux attach -t ${sessionName}`);
  }
  console.log();
  console.log("Watch all sessions:");
  console.log(`  bun run watch.ts --filter ${prefix}`);
}

main().catch(console.error);
