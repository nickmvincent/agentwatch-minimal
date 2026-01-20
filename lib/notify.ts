import type { HookEntry } from "./types";

export type NotificationConfig = {
  desktop?: boolean;
  webhook?: string;
  filter?: string[]; // Only notify for these events
  titleTemplate?: string; // Custom title template with placeholders
  messageTemplate?: string; // Custom message template with placeholders
};

// Available template placeholders:
// {dir} - last directory name from cwd
// {event} - hook event type
// {tool} - tool name (if tool event)
// {file} - filename from file_path (if present)
// {cmd} - first 50 chars of command (if Bash)
// {pattern} - pattern (if Grep/Glob)
// {message} - notification message (if present)
// {prompt} - user prompt (if UserPromptSubmit)
// {reason} - stop reason (if Stop/SubagentStop)
// {session} - truncated session ID (last 8 chars)
export const DEFAULT_TITLE_TEMPLATE = "{dir}: {event}";
export const DEFAULT_MESSAGE_TEMPLATE = "{tool}: {detail}";

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

/** Extract last directory name from a path */
function getLastDirName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || parts[parts.length - 2] || "";
}

/** Extract all template variables from a hook entry */
function extractTemplateVars(hook: HookEntry): Record<string, string> {
  const payload = hook.payload;
  const input = payload.tool_input as Record<string, unknown> | undefined;

  // Core variables
  const vars: Record<string, string> = {
    event: hook.event,
    dir: payload.cwd ? getLastDirName(String(payload.cwd)) : "agentwatch",
    tool: payload.tool_name ? String(payload.tool_name) : "",
    file: input?.file_path ? getLastDirName(String(input.file_path)) : "",
    cmd: input?.command ? String(input.command).slice(0, 50) : "",
    pattern: input?.pattern ? String(input.pattern) : "",
    message: payload.message ? String(payload.message).slice(0, 80) : "",
    prompt: payload.prompt ? String(payload.prompt).slice(0, 60) : "",
    reason: payload.reason ? String(payload.reason) : "",
    session: payload.session_id ? `...${String(payload.session_id).slice(-8)}` : "",
  };

  // Compute {detail} - smart default based on what's available
  if (vars.file) {
    vars.detail = vars.file;
  } else if (vars.cmd) {
    vars.detail = vars.cmd;
  } else if (vars.pattern) {
    vars.detail = vars.pattern;
  } else if (vars.message) {
    vars.detail = vars.message;
  } else if (vars.prompt) {
    vars.detail = `Prompt: ${vars.prompt}`;
  } else if (vars.reason) {
    vars.detail = vars.reason;
  } else if (hook.event === "Stop" || hook.event === "SubagentStop") {
    vars.detail = "Agent finished";
  } else if (hook.event === "SessionStart" || hook.event === "SessionEnd") {
    vars.detail = vars.session || hook.event;
  } else {
    // Fallback - exclude noisy fields from JSON dump
    const { session_id, cwd, tool_input, ...rest } = payload;
    vars.detail = JSON.stringify(rest).slice(0, 60);
  }

  return vars;
}

/** Apply a template string with variable substitution */
function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined && val !== "" ? val : "";
  }).replace(/:\s*$/, "").replace(/^\s*:\s*/, "").trim(); // Clean up empty placeholders
}

/** Format a hook entry for notification */
export function formatHookNotification(
  hook: HookEntry,
  titleTemplate?: string,
  messageTemplate?: string
): { title: string; message: string } {
  const vars = extractTemplateVars(hook);

  // Use templates or smart defaults
  const titleTpl = titleTemplate || DEFAULT_TITLE_TEMPLATE;
  const messageTpl = messageTemplate || DEFAULT_MESSAGE_TEMPLATE;

  let title = applyTemplate(titleTpl, vars);
  let message = applyTemplate(messageTpl, vars);

  // Ensure we always have something meaningful
  if (!title || title === ":") title = `${vars.dir}: ${vars.event}`;
  if (!message || message === ":") message = vars.detail || vars.event;

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

  const { title, message } = formatHookNotification(
    hook,
    config.titleTemplate,
    config.messageTemplate
  );

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
