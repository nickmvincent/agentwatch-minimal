import { Hono } from "hono";
import { serve } from "bun";
import { createId } from "./lib/ids";
import { appendJsonl, readJsonlTail, expandHome } from "./lib/jsonl";
import { DEFAULT_HOOKS_PORT, DEFAULT_DATA_DIR, type HookEntry } from "./lib/types";
import { notifyHook, type NotificationConfig } from "./lib/notify";
import { parseArgs } from "util";

const app = new Hono();

let dataDir = DEFAULT_DATA_DIR;
let hooksFile = () => `${dataDir}/hooks.jsonl`;
let notifyConfig: NotificationConfig = {};

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

  // Send notification if configured (don't await - fire and forget)
  if (notifyConfig.desktop || notifyConfig.webhook) {
    notifyHook(entry, notifyConfig).catch(() => {});
  }

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
      "notify-desktop": { type: "boolean" },
      "notify-webhook": { type: "string" },
      "notify-filter": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`agentwatch-minimal hooks server

Usage:
  bun run hooks.ts [options]

Options:
  -p, --port           Server port (default: ${DEFAULT_HOOKS_PORT})
  -d, --data-dir       Data directory (default: ${DEFAULT_DATA_DIR})
  --notify-desktop     Send desktop notifications for hooks
  --notify-webhook     Send webhooks to URL for each hook
  --notify-filter      Comma-separated event types to notify (e.g., pre-tool-use,error)
  -h, --help           Show this help

Examples:
  bun run hooks.ts
  bun run hooks.ts --notify-desktop
  bun run hooks.ts --notify-webhook https://example.com/webhook
  bun run hooks.ts --notify-desktop --notify-filter pre-tool-use
`);
    process.exit(0);
  }

  const port = parseInt(values.port!, 10);
  dataDir = values["data-dir"]!;

  // Configure notifications
  notifyConfig = {
    desktop: values["notify-desktop"] ?? false,
    webhook: values["notify-webhook"],
    filter: values["notify-filter"]?.split(",").map((s) => s.trim()),
  };

  console.log(`agentwatch-minimal hooks server`);
  console.log(`  Port: ${port}`);
  console.log(`  Data: ${expandHome(hooksFile())}`);
  if (notifyConfig.desktop) console.log(`  Desktop notifications: enabled`);
  if (notifyConfig.webhook) console.log(`  Webhook: ${notifyConfig.webhook}`);
  if (notifyConfig.filter) console.log(`  Notify filter: ${notifyConfig.filter.join(", ")}`);
  console.log();

  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Listening on http://localhost:${port}`);
}

export default app;
