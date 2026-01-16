import { describe, test, expect, afterEach } from "bun:test";
import { killSession, hasSession, capturePaneFull } from "../lib/tmux";

const TEST_PREFIX = "awm-e2e";
const createdSessions: string[] = [];

async function cleanupSessions() {
  for (const name of createdSessions) {
    await killSession(name).catch(() => {});
  }
  createdSessions.length = 0;
}

afterEach(async () => {
  await cleanupSessions();
});

describe("launch.ts e2e", () => {
  test("launches a session with simple echo command", async () => {
    // Use launch.ts but with a mock "agent" by setting PATH to include our mock
    // For now, test the core flow by directly testing what launch.ts does
    const sessionName = `${TEST_PREFIX}-echo-${Date.now()}`;
    createdSessions.push(sessionName);

    // Simulate what launch.ts does - create a session with a command
    const proc = Bun.spawn(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        process.cwd(),
        "echo 'Launch test successful' && sleep 1",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    expect(await hasSession(sessionName)).toBe(true);

    // Verify content
    await Bun.sleep(300);
    const content = await capturePaneFull(sessionName);
    expect(content).toContain("Launch test successful");
  });

  test("launch.ts CLI creates session", async () => {
    const timestamp = Date.now();

    // Run launch.ts with a simple echo as the "prompt"
    // We'll use a custom prefix to track it
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "launch.ts",
        "echo TEST_FROM_LAUNCH",
        "--prefix",
        `${TEST_PREFIX}-cli`,
        "--agents",
        "claude",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
      }
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // launch.ts should succeed
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Started claude:");

    // Extract session name from output
    const match = stdout.match(/Started claude: (awm-e2e-cli-claude-\w+)/);
    expect(match).not.toBeNull();

    if (match) {
      const sessionName = match[1];
      createdSessions.push(sessionName);
      expect(await hasSession(sessionName)).toBe(true);
    }
  });
});
