import { describe, test, expect } from "bun:test";
import { createId, createSessionName } from "../lib/ids";
import { expandHome } from "../lib/jsonl";
import { DEFAULT_SESSION_PREFIX, DEFAULT_HOOKS_PORT } from "../lib/types";
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
