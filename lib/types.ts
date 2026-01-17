export type AgentType = "claude" | "codex" | "gemini";

export type LaunchedSession = {
  id: string;
  agent: AgentType;
  sessionName: string;
  prompt: string;
  cwd: string;
  startedAt: string;
};

export type SubTask = {
  id: string;
  description: string;
  agent: AgentType;
  prompt: string;
  dependencies?: string[];
};

export type OrchestrationPlan = {
  id: string;
  originalPrompt: string;
  decomposedAt: string;
  tasks: SubTask[];
  orchestratorAgent: AgentType;
};

export type TmuxPaneInfo = {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneId: string;
  panePid?: number;
  active: boolean;
  command?: string;
  cwd?: string;
  lastLine?: string;
  idleSeconds?: number;
};

export type TmuxWindowInfo = {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPaneInfo[];
};

export type TmuxSessionInfo = {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
  activity?: number;
  windowList: TmuxWindowInfo[];
};

export type HookEntry = {
  id: string;
  timestamp: string;
  event: string;
  payload: Record<string, unknown>;
};

export type SessionMetaEntry = {
  id: string;
  timestamp: string;
  sessionName: string;
  agent?: AgentType;
  promptPreview?: string;
  cwd?: string;
  tag?: string;
  planId?: string;
  taskId?: string;
  status?: "running" | "done";
  renamedFrom?: string;
  source?: "launch" | "orchestrate" | "watch";
};

export type ProcessStats = {
  pid: number;
  cpu: number;     // percentage
  memory: number;  // percentage
  rss: number;     // KB
};

export type AgentConfig = {
  command: string;
  defaultFlags?: string[];
  promptFlag?: string; // If agent needs a flag before prompt (e.g., "-p")
};

export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  claude: {
    command: "claude",
    defaultFlags: [],
  },
  codex: {
    command: "codex",
    defaultFlags: [],
  },
  gemini: {
    command: "gemini",
    defaultFlags: [], // Could add "--yolo" here for auto-approval
  },
};

export const DEFAULT_SESSION_PREFIX = "awm";
export const DEFAULT_HOOKS_PORT = 8702;
export const DEFAULT_DATA_DIR = "~/.agentwatch-minimal";
