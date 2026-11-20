export interface ActionFailureAction {
  label: string;
  onClick(): void;
}

export interface ActionFailure {
  id: number;
  title: string;
  body?: string;
  error?: unknown;
  action?: ActionFailureAction;
  retry?: () => void;
  scope?: string;
}

export interface ActionFailureOptions {
  body?: string;
  action?: ActionFailureAction;
  retry?: () => void;
  scope?: string;
}

export type FailureHostLevel = "base" | "page" | "overlay";

const LEVEL_RANK: Record<FailureHostLevel, number> = { base: 0, page: 1, overlay: 2 };

interface Host {
  id: number;
  level: FailureHostLevel;
  scope: string | null;
}

interface Snapshot {
  failure: ActionFailure | null;
  host: number | null;
}

let failure: ActionFailure | null = null;
let hosts: Host[] = [];
let sequence = 0;
let snapshot: Snapshot = { failure: null, host: null };
const listeners = new Set<() => void>();
const offeredRetries = new WeakMap<object, () => void>();

export function failureHost(
  registered: readonly Host[],
  scope: string | null | undefined,
): number | null {
  const scoped = scope ? registered.filter((host) => host.scope === scope) : [];
  const candidates = scoped.length > 0 ? scoped : registered.filter((host) => host.scope === null);
  let chosen: Host | null = null;
  for (const host of candidates)
    if (!chosen || LEVEL_RANK[host.level] >= LEVEL_RANK[chosen.level]) chosen = host;
  return chosen?.id ?? null;
}

let bound: number | null = null;

function publish(): void {
  const kept = failure !== null && bound !== null && hosts.some((host) => host.id === bound);
  if (!kept) bound = failure === null ? null : failureHost(hosts, failure.scope);
  snapshot = { failure, host: failure === null ? failureHost(hosts, null) : bound };
  for (const listener of listeners) listener();
}

export function offerFailureRetry(error: unknown, retry: () => void): void {
  if (typeof error === "object" && error !== null) offeredRetries.set(error, retry);
}

function offeredRetry(error: unknown): (() => void) | undefined {
  return typeof error === "object" && error !== null ? offeredRetries.get(error) : undefined;
}

export function reportFailure(
  title: string,
  error?: unknown,
  options: ActionFailureOptions = {},
): void {
  sequence += 1;
  const retry = options.retry ?? offeredRetry(error);
  failure = {
    id: sequence,
    title,
    ...(options.body ? { body: options.body } : {}),
    ...(error === undefined || error === null ? {} : { error }),
    ...(options.action ? { action: options.action } : {}),
    ...(retry ? { retry } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };
  bound = null;
  publish();
}

export function clearFailure(): void {
  if (failure === null) return;
  failure = null;
  publish();
}

export function subscribeFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function failureSnapshot(): Snapshot {
  return snapshot;
}

export function registerFailureHost(
  level: FailureHostLevel = "overlay",
  scope: string | null = null,
): { id: number; release(): void } {
  sequence += 1;
  const id = sequence;
  hosts = [...hosts, { id, level, scope }];
  publish();
  return {
    id,
    release() {
      hosts = hosts.filter((host) => host.id !== id);
      publish();
    },
  };
}
