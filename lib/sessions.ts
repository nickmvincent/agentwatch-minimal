import { appendJsonl } from "./jsonl";
import { createId } from "./ids";
import { DEFAULT_DATA_DIR, type SessionMetaEntry } from "./types";

const SESSIONS_FILE = "sessions.jsonl";

function normalizeDataDir(dataDir: string): string {
  return dataDir.endsWith("/") ? dataDir.slice(0, -1) : dataDir;
}

export function getSessionsFile(dataDir: string = DEFAULT_DATA_DIR): string {
  return `${normalizeDataDir(dataDir)}/${SESSIONS_FILE}`;
}

export function makePromptPreview(prompt: string, maxLen = 120): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

export function normalizeTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function appendSessionMeta(
  dataDir: string,
  entry: Omit<SessionMetaEntry, "id" | "timestamp">
): Promise<SessionMetaEntry> {
  const full: SessionMetaEntry = {
    id: createId("session"),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  await appendJsonl(getSessionsFile(dataDir), full);
  return full;
}

export async function readSessionMeta(dataDir: string): Promise<SessionMetaEntry[]> {
  const file = Bun.file(getSessionsFile(dataDir));
  const exists = await file.exists();
  if (!exists) return [];

  const text = await file.text();
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as SessionMetaEntry);
}

export function buildSessionMetaMap(entries: SessionMetaEntry[]): Map<string, SessionMetaEntry> {
  const map = new Map<string, SessionMetaEntry>();
  // Most recent entry per session wins
  for (const entry of entries) {
    map.set(entry.sessionName, entry);
  }
  return map;
}

