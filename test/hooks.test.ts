import { describe, test, expect } from "bun:test";
import app from "../hooks";

describe("hooks server", () => {
  test("GET / returns service info", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe("agentwatch-minimal-hooks");
    expect(body.endpoints).toContain("POST /hooks/:event");
  });

  test("GET /hooks/health returns ok", async () => {
    const res = await app.request("/hooks/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("POST /hooks/:event accepts payload", async () => {
    const res = await app.request("/hooks/test-unit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true, timestamp: Date.now() }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({}); // Empty = approved
  });

  test("POST /hooks/:event accepts empty payload", async () => {
    const res = await app.request("/hooks/empty-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("GET /hooks/recent returns array", async () => {
    const res = await app.request("/hooks/recent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.hooks)).toBe(true);
  });
});
