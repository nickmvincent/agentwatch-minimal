export type AgentType = "claude" | "codex" | "gemini";

export type LaunchConfig = {
  prompt: string;
  agents: AgentType[];
  cwd?: string;
  sessionPrefix?: string;
};

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

export type WatchOptions = {
  filter?: string;
  refreshIntervalMs?: number;
  showLastLine?: boolean;
  tui?: boolean;
};

export type HookEntry = {
  id: string;
  timestamp: string;
  event: string;
  payload: Record<string, unknown>;
};

export type ProcessStats = {
  pid: number;
  cpu: number;     // percentage
  memory: number;  // percentage
  rss: number;     // KB
};

export type HooksConfig = {
  port: number;
  dataDir: string;
};

export const AGENT_COMMANDS: Record<AgentType, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  gemini: ["gemini"],
};

export const DEFAULT_SESSION_PREFIX = "awm";
export const DEFAULT_HOOKS_PORT = 8750;
export const DEFAULT_DATA_DIR = "~/.agentwatch-minimal";
