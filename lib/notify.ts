import type { HookEntry } from "./types";

export type NotificationConfig = {
  desktop?: boolean;
  webhook?: string;
  filter?: string[]; // Only notify for these events
};

/** Send a desktop notification (macOS) */
export async function sendDesktopNotification(
  title: string,
  message: string
): Promise<boolean> {
  try {
    // macOS: use osascript
    if (process.platform === "darwin") {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }

    // Linux: try notify-send
    if (process.platform === "linux") {
      const proc = Bun.spawn(["notify-send", title, message], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }

    return false;
  } catch {
    return false;
  }
}

/** Send a webhook notification */
export async function sendWebhookNotification(
  url: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Format a hook entry for notification */
export function formatHookNotification(hook: HookEntry): { title: string; message: string } {
  const title = `agentwatch: ${hook.event}`;

  // Extract useful info from payload
  let message = "";
  const payload = hook.payload;

  if (payload.tool_name) {
    const tool = payload.tool_name as string;
    const input = payload.tool_input as Record<string, unknown> | undefined;

    if (input?.file_path) {
      message = `${tool}: ${input.file_path}`;
    } else if (input?.command) {
      message = `${tool}: ${String(input.command).slice(0, 50)}`;
    } else if (input?.pattern) {
      message = `${tool}: ${input.pattern}`;
    } else {
      message = tool;
    }
  } else {
    message = JSON.stringify(payload).slice(0, 100);
  }

  return { title, message };
}

/** Notify about a hook entry based on config */
export async function notifyHook(
  hook: HookEntry,
  config: NotificationConfig
): Promise<void> {
  // Check if we should notify for this event
  if (config.filter && config.filter.length > 0) {
    if (!config.filter.includes(hook.event)) return;
  }

  const { title, message } = formatHookNotification(hook);

  const promises: Promise<unknown>[] = [];

  if (config.desktop) {
    promises.push(sendDesktopNotification(title, message));
  }

  if (config.webhook) {
    promises.push(
      sendWebhookNotification(config.webhook, {
        ...hook,
        formatted: { title, message },
      })
    );
  }

  await Promise.all(promises);
}
