const listeners = new Set<(target: string) => void>();
const pending: string[] = [];

export function announceLaunch(target: unknown): void {
  if (typeof target !== "string" || !target) return;
  if (listeners.size === 0) {
    pending.push(target);
    return;
  }
  for (const listener of listeners) listener(target);
}

export function onLaunch(listener: (target: string) => void): () => void {
  listeners.add(listener);
  for (const target of pending.splice(0)) listener(target);
  return () => {
    listeners.delete(listener);
  };
}
