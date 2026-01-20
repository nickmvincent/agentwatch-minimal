import type { HookEntry } from "./types";

/**
 * Format a hook payload for display, extracting relevant info based on event type.
 */
export function formatHookPayload(payload: Record<string, unknown>, maxLen = 50): string {
  const parts: string[] = [];

  // Extract cwd (last directory name)
  if (payload.cwd) {
    const cwdParts = String(payload.cwd).split("/");
    const lastDir = cwdParts[cwdParts.length - 1] || cwdParts[cwdParts.length - 2] || "";
    if (lastDir) parts.push(lastDir);
  }

  // For tool use events, show tool name and relevant input
  if (payload.tool_name) {
    const tool = payload.tool_name as string;
    const input = payload.tool_input as Record<string, unknown> | undefined;
    let toolInfo = tool;

    if (input) {
      if ((tool === "Read" || tool === "Write" || tool === "Edit") && input.file_path) {
        const path = String(input.file_path).split("/").pop() || "";
        toolInfo = `${tool}:${path}`;
      } else if (tool === "Bash" && input.command) {
        const cmd = String(input.command).slice(0, 20);
        toolInfo = `${tool}:${cmd}${String(input.command).length > 20 ? "…" : ""}`;
      } else if ((tool === "Grep" || tool === "Glob") && input.pattern) {
        toolInfo = `${tool}:${String(input.pattern).slice(0, 15)}`;
      }
    }
    parts.push(toolInfo);
  }

  // For notifications, show message and type
  if (payload.message) {
    const msg = String(payload.message).slice(0, 30);
    parts.push(msg + (String(payload.message).length > 30 ? "…" : ""));
  }

  if (payload.notification_type) {
    parts.push(`[${payload.notification_type}]`);
  }

  // For user prompts, show truncated prompt
  if (payload.prompt && !payload.tool_name) {
    const prompt = String(payload.prompt).slice(0, 25);
    parts.push(`"${prompt}${String(payload.prompt).length > 25 ? "…" : ""}"`);
  }

  if (parts.length === 0) {
    const str = JSON.stringify(payload);
    return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + "…";
  }

  const result = parts.join(" ");
  return result.length <= maxLen ? result : result.slice(0, maxLen - 1) + "…";
}
