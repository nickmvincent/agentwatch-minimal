import { Hono } from "hono";
import { serve } from "bun";
import { createId } from "./lib/ids";
import { appendJsonl, readJsonlTail, expandHome } from "./lib/jsonl";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR, type HookEntry } from "./lib/types";
import { parseArgs } from "util";

const app = new Hono();

let dataDir = DEFAULT_DATA_DIR;
let hooksFile = () => `${dataDir}/hooks.jsonl`;

// POST /hooks/:event - Log a hook event
app.post("/hooks/:event", async (c) => {
  const event = c.req.param("event");
  const payload = await c.req.json().catch(() => ({}));

  const entry: HookEntry = {
    id: createId("hook"),
    timestamp: new Date().toISOString(),
    event,
    payload,
  };

  await appendJsonl(hooksFile(), entry);
  console.log(`[hook] ${event}: ${JSON.stringify(payload).slice(0, 100)}`);

  // Return empty object = approved (no blocking)
  return c.json({});
});

// GET /hooks/recent - Get recent hooks
app.get("/hooks/recent", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const event = c.req.query("event");

  let hooks = await readJsonlTail<HookEntry>(hooksFile(), limit * 2);

  if (event) {
    hooks = hooks.filter((h) => h.event === event);
  }

  return c.json({
    ok: true,
    hooks: hooks.slice(-limit),
    total: hooks.length,
  });
});

// GET /hooks/health - Health check
app.get("/hooks/health", (c) => {
  return c.json({ ok: true, service: "agentwatch-minimal-hooks" });
});

// GET / - Root info
app.get("/", (c) => {
  return c.json({
    service: "agentwatch-minimal-hooks",
    endpoints: [
      "POST /hooks/:event",
      "GET /hooks/recent",
      "GET /hooks/health",
    ],
    dataFile: expandHome(hooksFile()),
  });
});

// CLI entry point
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: String(DEFAULT_HOOKS_PORT) },
      "data-dir": { type: "string", short: "d", default: DEFAULT_DATA_DIR },
    },
  });

  const port = parseInt(values.port!, 10);
  dataDir = values["data-dir"]!;

  console.log(`agentwatch-minimal hooks server`);
  console.log(`  Port: ${port}`);
  console.log(`  Data: ${expandHome(hooksFile())}`);
  console.log();

  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Listening on http://localhost:${port}`);
}

export default app;
