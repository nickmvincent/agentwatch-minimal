export function createId(prefix = "id"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

export function createSessionName(prefix: string, agent: string): string {
  const timestamp = Date.now().toString(36);
  return `${prefix}-${agent}-${timestamp}`;
}
