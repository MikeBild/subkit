import type { Config } from "./schema.ts";

export const PROCESS_BINDING_PATHS = [
  "database.url",
  "storage.backend",
  "storage.filesystem.root",
  "deployment.mode",
] as const;

const REMEDIES: Record<(typeof PROCESS_BINDING_PATHS)[number], string> = {
  "database.url": "rotate DATABASE_URL and restart replicas instead",
  "storage.backend": "set OBJECT_STORAGE_BACKEND and OBJECT_STORAGE_ROOT and restart instead",
  "storage.filesystem.root":
    "set OBJECT_STORAGE_BACKEND and OBJECT_STORAGE_ROOT and restart instead",
  "deployment.mode": "set SUBKIT_DEPLOYMENT_MODE and restart instead",
};

export const LOCAL_DEVICE_PROFILE = {
  pool_max: 6,
  queue_concurrency: 2,
} as const;

export function isProcessBindingPath(path: string): boolean {
  return (PROCESS_BINDING_PATHS as readonly string[]).includes(path);
}

export function processBindingRefusal(path: string): string | null {
  if (!isProcessBindingPath(path)) return null;
  return `${path} is a bootstrap-only process binding; ${REMEDIES[path as keyof typeof REMEDIES]}`;
}

export function applyLocalWorkspaceProfile(config: Config): void {
  if (config.deployment.mode !== "local_workspace") return;
  config.database.pool_max = Math.min(config.database.pool_max, LOCAL_DEVICE_PROFILE.pool_max);
  config.queue.concurrency = Math.min(
    config.queue.concurrency,
    LOCAL_DEVICE_PROFILE.queue_concurrency,
  );
}

export function bindProcessBindings(target: Config, process: Config): void {
  target.database.url = process.database.url;
  target.storage.backend = process.storage.backend;
  target.storage.filesystem = {
    ...target.storage.filesystem,
    root: process.storage.filesystem.root,
  };
  target.deployment.mode = process.deployment.mode;
  applyLocalWorkspaceProfile(target);
}
