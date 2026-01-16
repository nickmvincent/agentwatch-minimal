import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { killSession, hasSession, capturePaneFull } from "../lib/tmux";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

// These tests require a real Claude CLI and are slow/expensive
// Run with: AGENT_E2E=1 bun test test/agent.e2e.test.ts
const SKIP_AGENT_TESTS = !process.env.AGENT_E2E;

const TEST_PREFIX = "awm-agent";
const TEST_DIR = "/tmp/claude/awm-agent-test";
const createdSessions: string[] = [];
const createdFiles: string[] = [];

async function cleanupSessions() {
  for (const name of createdSessions) {
    await killSession(name).catch(() => {});
  }
  createdSessions.length = 0;
}

function cleanupFiles() {
  for (const file of createdFiles) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {}
  }
  createdFiles.length = 0;
}

beforeAll(() => {
  // Ensure test directory exists
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await cleanupSessions();
  cleanupFiles();
});

describe.skipIf(SKIP_AGENT_TESTS)("agent e2e", () => {
  test(
    "claude writes a file when prompted",
    async () => {
      const timestamp = Date.now();
      const testFile = join(TEST_DIR, `test-${timestamp}.txt`);
      const expectedContent = `HELLO_FROM_CLAUDE_${timestamp}`;
      createdFiles.push(testFile);

      const sessionName = `${TEST_PREFIX}-write-${timestamp}`;
      createdSessions.push(sessionName);

      // Launch claude with a prompt to write a specific file
      const prompt = `Write a file at ${testFile} with exactly this content (no extra text): ${expectedContent}. Then exit immediately with /exit.`;

      const proc = Bun.spawn(
        [
          "tmux",
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          TEST_DIR,
          `claude '${prompt.replace(/'/g, "'\"'\"'")}'`,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      expect(proc.exitCode).toBe(0);
      expect(await hasSession(sessionName)).toBe(true);

      // Wait for claude to process and write the file (timeout: 60s)
      const maxWait = 60000;
      const pollInterval = 2000;
      let elapsed = 0;
      let fileWritten = false;

      while (elapsed < maxWait) {
        await Bun.sleep(pollInterval);
        elapsed += pollInterval;

        if (existsSync(testFile)) {
          fileWritten = true;
          break;
        }

        // Check if session still exists (claude may have exited)
        const stillRunning = await hasSession(sessionName);
        if (!stillRunning) {
          // Session ended, check one more time
          fileWritten = existsSync(testFile);
          break;
        }
      }

      expect(fileWritten).toBe(true);

      if (fileWritten) {
        const content = await Bun.file(testFile).text();
        expect(content.trim()).toContain(expectedContent);
      }
    },
    { timeout: 90000 }
  );

  test(
    "claude executes a simple task",
    async () => {
      const timestamp = Date.now();
      const sessionName = `${TEST_PREFIX}-task-${timestamp}`;
      createdSessions.push(sessionName);

      // Simple prompt that should complete quickly
      const prompt = "What is 2+2? Answer with just the number, then exit with /exit.";

      const proc = Bun.spawn(
        [
          "tmux",
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          TEST_DIR,
          `claude '${prompt.replace(/'/g, "'\"'\"'")}'`,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      expect(proc.exitCode).toBe(0);

      // Wait a bit for claude to respond
      await Bun.sleep(15000);

      // Capture output
      const output = await capturePaneFull(sessionName, 100);

      // Should contain "4" somewhere in the output
      expect(output).toMatch(/4/);
    },
    { timeout: 30000 }
  );
});
