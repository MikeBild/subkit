import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openInstall(): void {
  publish(true);
}

export function closeInstall(): void {
  publish(false);
}

export function useInstallOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
}
