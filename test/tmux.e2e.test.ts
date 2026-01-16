import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  createSession,
  killSession,
  hasSession,
  listSessions,
  listWindows,
  listPanes,
  sendKeys,
  capturePane,
  capturePaneFull,
  capturePanes,
  launchAgentSession,
  tmuxHasServer,
  escapeShellArg,
} from "../lib/tmux";

const TEST_PREFIX = "awm-test";
const createdSessions: string[] = [];

// Helper to track sessions for cleanup
function trackSession(name: string) {
  createdSessions.push(name);
  return name;
}

// Clean up all test sessions
async function cleanupSessions() {
  for (const name of createdSessions) {
    await killSession(name).catch(() => {});
  }
  createdSessions.length = 0;
}

afterEach(async () => {
  await cleanupSessions();
});

describe("tmux e2e", () => {
  describe("escapeShellArg", () => {
    test("escapes single quotes", () => {
      expect(escapeShellArg("hello")).toBe("hello");
      expect(escapeShellArg("it's")).toBe("it'\"'\"'s");
      expect(escapeShellArg("a'b'c")).toBe("a'\"'\"'b'\"'\"'c");
    });
  });

  describe("session lifecycle", () => {
    test("createSession creates a session", async () => {
      const name = trackSession(`${TEST_PREFIX}-create-${Date.now()}`);
      const result = await createSession(name);
      expect(result).toBe(true);

      const exists = await hasSession(name);
      expect(exists).toBe(true);
    });

    test("hasSession returns false for non-existent session", async () => {
      const exists = await hasSession(`${TEST_PREFIX}-nonexistent-${Date.now()}`);
      expect(exists).toBe(false);
    });

    test("killSession removes a session", async () => {
      const name = trackSession(`${TEST_PREFIX}-kill-${Date.now()}`);
      await createSession(name);

      const killed = await killSession(name);
      expect(killed).toBe(true);

      const exists = await hasSession(name);
      expect(exists).toBe(false);

      // Remove from tracking since already killed
      createdSessions.pop();
    });

    test("listSessions includes created session", async () => {
      const name = trackSession(`${TEST_PREFIX}-list-${Date.now()}`);
      await createSession(name);

      const sessions = await listSessions(TEST_PREFIX);
      const found = sessions.find((s) => s.name === name);
      expect(found).toBeDefined();
      expect(found!.windows).toBeGreaterThanOrEqual(1);
    });
  });

  describe("windows and panes", () => {
    test("listWindows returns windows for session", async () => {
      const name = trackSession(`${TEST_PREFIX}-windows-${Date.now()}`);
      await createSession(name);

      const windows = await listWindows(name);
      expect(windows.length).toBeGreaterThanOrEqual(1);
      expect(windows[0].sessionName).toBe(name);
      expect(windows[0].panes.length).toBeGreaterThanOrEqual(1);
    });

    test("listPanes returns panes with correct windowName", async () => {
      const name = trackSession(`${TEST_PREFIX}-panes-${Date.now()}`);
      await createSession(name);

      const windows = await listWindows(name);
      const panes = windows[0].panes;

      expect(panes.length).toBeGreaterThanOrEqual(1);
      expect(panes[0].sessionName).toBe(name);
      expect(panes[0].windowIndex).toBe(windows[0].index);
      // windowName should be populated (not empty)
      expect(panes[0].windowName).toBe(windows[0].name);
    });
  });

  describe("sendKeys and capturePane", () => {
    test("sendKeys sends text to pane", async () => {
      const name = trackSession(`${TEST_PREFIX}-sendkeys-${Date.now()}`);
      await createSession(name);

      // Send an echo command
      await sendKeys(name, 'echo "TESTOUTPUT123"');

      // Wait for command to execute
      await Bun.sleep(500);

      // Capture full output and verify
      const output = await capturePaneFull(name, 20);
      expect(output).toContain("TESTOUTPUT123");
    });

    test("capturePaneFull captures full content", async () => {
      const name = trackSession(`${TEST_PREFIX}-full-${Date.now()}`);
      await createSession(name);

      await sendKeys(name, 'echo "LINE_ONE"');
      await sendKeys(name, 'echo "LINE_TWO"');
      await Bun.sleep(500);

      const output = await capturePaneFull(name, 30);
      expect(output).toContain("LINE_ONE");
      expect(output).toContain("LINE_TWO");
    });

    test("capturePanes captures multiple panes in parallel", async () => {
      const name1 = trackSession(`${TEST_PREFIX}-capture1-${Date.now()}`);
      const name2 = trackSession(`${TEST_PREFIX}-capture2-${Date.now()}`);

      await createSession(name1);
      await createSession(name2);

      await sendKeys(name1, 'echo "OUTPUT_A"');
      await sendKeys(name2, 'echo "OUTPUT_B"');
      await Bun.sleep(500);

      // capturePanes uses capturePane which returns last line
      const targets = [`${name1}:0.0`, `${name2}:0.0`];
      const results = await capturePanes(targets);

      expect(results.size).toBe(2);
      // Verify we got results for both targets (may be undefined if pane is empty)
      expect(results.has(targets[0])).toBe(true);
      expect(results.has(targets[1])).toBe(true);
    });
  });

  describe("launchAgentSession", () => {
    test("launches session with echo command (mock agent)", async () => {
      // Temporarily override AGENT_COMMANDS not possible, so we test with a direct session
      const name = trackSession(`${TEST_PREFIX}-agent-${Date.now()}`);

      // Create session with a command directly (simulating what launchAgentSession does)
      const proc = Bun.spawn(
        ["tmux", "new-session", "-d", "-s", name, "echo 'Agent started'; sleep 2"],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      expect(proc.exitCode).toBe(0);

      const exists = await hasSession(name);
      expect(exists).toBe(true);

      await Bun.sleep(300);
      const output = await capturePane(name, 10);
      expect(output).toContain("Agent started");
    });
  });
});
