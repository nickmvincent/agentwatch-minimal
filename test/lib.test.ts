import { describe, test, expect } from "bun:test";
import { createId, createSessionName } from "../lib/ids";
import { expandHome } from "../lib/jsonl";
import { isShellPrompt, filterMeaningfulLines } from "../lib/tmux";
import { formatHookPayload } from "../lib/hooks";
import { formatHookNotification } from "../lib/notify";
import { makePromptPreview, normalizeTag, buildSessionMetaMap } from "../lib/sessions";
import { DEFAULT_SESSION_PREFIX, DEFAULT_HOOKS_PORT, type SessionMetaEntry } from "../lib/types";
import { homedir } from "os";

describe("ids", () => {
  test("createId generates unique IDs with prefix", () => {
    const id1 = createId("test");
    const id2 = createId("test");
    expect(id1).toMatch(/^test_[a-z0-9]+_[a-z0-9]+$/);
    expect(id1).not.toBe(id2);
  });

  test("createId uses default prefix", () => {
    const id = createId();
    expect(id).toMatch(/^id_[a-z0-9]+_[a-z0-9]+$/);
  });

  test("createSessionName generates tmux-friendly names", () => {
    const name = createSessionName("awm", "claude");
    expect(name).toMatch(/^awm-claude-[a-z0-9]+$/);
  });

  test("createSessionName works with different agents", () => {
    const names = ["claude", "codex", "gemini"].map((agent) =>
      createSessionName("test", agent)
    );
    expect(names[0]).toContain("-claude-");
    expect(names[1]).toContain("-codex-");
    expect(names[2]).toContain("-gemini-");
  });
});

describe("jsonl", () => {
  test("expandHome expands tilde", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/foo")).toBe(`${homedir()}/foo`);
    expect(expandHome("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  test("expandHome preserves absolute paths", () => {
    expect(expandHome("/absolute")).toBe("/absolute");
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
  });

  test("expandHome preserves relative paths", () => {
    expect(expandHome("relative")).toBe("relative");
    expect(expandHome("./relative")).toBe("./relative");
  });
});

describe("types", () => {
  test("DEFAULT_SESSION_PREFIX is awm", () => {
    expect(DEFAULT_SESSION_PREFIX).toBe("awm");
  });

  test("DEFAULT_HOOKS_PORT is 8702", () => {
    expect(DEFAULT_HOOKS_PORT).toBe(8702);
  });
});

describe("tmux helpers", () => {
  test("isShellPrompt detects common prompts", () => {
    // Should match shell prompts
    expect(isShellPrompt("$ ")).toBe(true);
    expect(isShellPrompt("% ")).toBe(true);
    expect(isShellPrompt("> ")).toBe(true);
    expect(isShellPrompt(">>> ")).toBe(true);
    expect(isShellPrompt("user@host$ ")).toBe(true);
    expect(isShellPrompt("(venv) $ ")).toBe(true);
    expect(isShellPrompt("... ")).toBe(true);

    // Should not match actual content
    expect(isShellPrompt("echo hello")).toBe(false);
    expect(isShellPrompt("Running tests...")).toBe(false);
    expect(isShellPrompt("Error: something failed")).toBe(false);
    expect(isShellPrompt("")).toBe(false);
  });

  test("filterMeaningfulLines removes prompts and empty lines", () => {
    const lines = [
      "$ ",
      "echo hello",
      "",
      "hello",
      "% ",
      "Running...",
      ">>> ",
    ];
    const result = filterMeaningfulLines(lines);
    expect(result).toEqual(["echo hello", "hello", "Running..."]);
  });

  test("filterMeaningfulLines handles all empty/prompt input", () => {
    expect(filterMeaningfulLines(["$ ", "% ", ""])).toEqual([]);
  });
});

describe("hooks", () => {
  test("formatHookPayload formats tool use events", () => {
    const payload = {
      cwd: "/home/user/project",
      tool_name: "Read",
      tool_input: { file_path: "/home/user/project/src/index.ts" },
    };
    const result = formatHookPayload(payload);
    expect(result).toContain("project");
    expect(result).toContain("Read");
    expect(result).toContain("index.ts");
  });

  test("formatHookPayload formats Bash commands", () => {
    const payload = {
      cwd: "/home/user/myapp",
      tool_name: "Bash",
      tool_input: { command: "npm test --coverage" },
    };
    const result = formatHookPayload(payload);
    expect(result).toContain("myapp");
    expect(result).toContain("Bash");
    expect(result).toContain("npm test");
  });

  test("formatHookPayload formats notifications", () => {
    const payload = {
      message: "Task completed successfully",
      notification_type: "info",
    };
    const result = formatHookPayload(payload);
    expect(result).toContain("Task completed");
    expect(result).toContain("[info]");
  });

  test("formatHookPayload truncates long output", () => {
    const payload = {
      message: "A".repeat(100),
    };
    const result = formatHookPayload(payload, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("…");
  });
});

describe("notify", () => {
  test("formatHookNotification uses default templates", () => {
    const hook = {
      id: "hook_123",
      timestamp: "2024-01-01T00:00:00Z",
      event: "PostToolUse",
      payload: {
        cwd: "/home/user/myproject",
        tool_name: "Read",
        tool_input: { file_path: "/home/user/myproject/README.md" },
      },
    };
    const { title, message } = formatHookNotification(hook);
    expect(title).toContain("myproject");
    expect(title).toContain("PostToolUse");
    expect(message).toContain("Read");
  });

  test("formatHookNotification uses custom templates", () => {
    const hook = {
      id: "hook_123",
      timestamp: "2024-01-01T00:00:00Z",
      event: "PreToolUse",
      payload: {
        cwd: "/projects/app",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      },
    };
    const { title, message } = formatHookNotification(
      hook,
      "Agent: {tool}",
      "Command: {cmd}"
    );
    expect(title).toBe("Agent: Bash");
    expect(message).toContain("npm install");
  });

  test("formatHookNotification handles missing fields gracefully", () => {
    const hook = {
      id: "hook_123",
      timestamp: "2024-01-01T00:00:00Z",
      event: "SessionStart",
      payload: {},
    };
    const { title, message } = formatHookNotification(hook);
    // Should not throw and should have some content
    expect(title.length).toBeGreaterThan(0);
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("sessions", () => {
  test("makePromptPreview truncates long prompts", () => {
    const short = "Fix the bug";
    expect(makePromptPreview(short)).toBe("Fix the bug");

    const long = "A".repeat(200);
    const result = makePromptPreview(long, 50);
    expect(result.length).toBe(50);
    expect(result).toEndWith("...");
  });

  test("makePromptPreview collapses whitespace", () => {
    const prompt = "Fix   the\n\nbug\there";
    expect(makePromptPreview(prompt)).toBe("Fix the bug here");
  });

  test("normalizeTag handles various inputs", () => {
    expect(normalizeTag(undefined)).toBeUndefined();
    expect(normalizeTag("")).toBeUndefined();
    expect(normalizeTag("   ")).toBeUndefined();
    expect(normalizeTag("valid")).toBe("valid");
    expect(normalizeTag("  trimmed  ")).toBe("trimmed");
  });

  test("buildSessionMetaMap creates map from entries", () => {
    const entries: SessionMetaEntry[] = [
      {
        id: "s1",
        timestamp: "2024-01-01T00:00:00Z",
        sessionName: "awm-claude-abc",
        agent: "claude",
        source: "launch",
      },
      {
        id: "s2",
        timestamp: "2024-01-02T00:00:00Z",
        sessionName: "awm-codex-def",
        agent: "codex",
        source: "launch",
      },
    ];
    const map = buildSessionMetaMap(entries);
    expect(map.size).toBe(2);
    expect(map.get("awm-claude-abc")?.agent).toBe("claude");
    expect(map.get("awm-codex-def")?.agent).toBe("codex");
  });

  test("buildSessionMetaMap uses most recent entry for duplicates", () => {
    const entries: SessionMetaEntry[] = [
      {
        id: "s1",
        timestamp: "2024-01-01T00:00:00Z",
        sessionName: "awm-claude-abc",
        agent: "claude",
        status: "running",
        source: "launch",
      },
      {
        id: "s2",
        timestamp: "2024-01-02T00:00:00Z",
        sessionName: "awm-claude-abc",
        agent: "claude",
        status: "done",
        source: "watch",
      },
    ];
    const map = buildSessionMetaMap(entries);
    expect(map.size).toBe(1);
    expect(map.get("awm-claude-abc")?.status).toBe("done");
  });
});
