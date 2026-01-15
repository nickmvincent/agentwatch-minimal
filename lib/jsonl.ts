import { mkdir, appendFile, readFile } from "fs/promises";
import { dirname } from "path";
import { homedir } from "os";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) {
    return `${homedir()}/${inputPath.slice(2)}`;
  }
  return inputPath;
}

export async function appendJsonl(
  filePath: string,
  value: unknown
): Promise<void> {
  const expanded = expandHome(filePath);
  await mkdir(dirname(expanded), { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  await appendFile(expanded, line, "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const expanded = expandHome(filePath);
  try {
    const content = await readFile(expanded, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function readJsonlTail<T>(
  filePath: string,
  limit: number
): Promise<T[]> {
  const all = await readJsonl<T>(filePath);
  return all.slice(-limit);
}
