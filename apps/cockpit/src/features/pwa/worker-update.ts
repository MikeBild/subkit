import { useSyncExternalStore } from "react";
import { cockpitBasePath, installationId } from "@/app/installation-context";

const DESCRIBE_TIMEOUT_MS = 2000;
const ACTIVATE_TIMEOUT_MS = 4000;
const UPDATE_CHECK_GAP_MS = 60_000;
const REGISTRATION_RETRY_MS = 5000;
const REGISTRATION_RETRIES = 3;

type UpdateWorker = Pick<ServiceWorker, "postMessage" | "state" | "addEventListener">;

let waiting: UpdateWorker | null = null;
let lastCheck = Number.NEGATIVE_INFINITY;
let pendingCheck: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: UpdateWorker | null): void {
  if (waiting === next) return;
  waiting = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWaitingUpdate(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => waiting !== null,
    () => false,
  );
}

export function pageRunsBuild(scripts: readonly string[], shell: unknown): boolean {
  if (!Array.isArray(shell) || scripts.length === 0) return false;
  return scripts.every((script) => shell.includes(script));
}

export function pageScripts(
  elements: Iterable<{ src: string }>,
  origin: string,
  base: string,
): string[] {
  const paths: string[] = [];
  for (const element of elements) {
    try {
      const url = new URL(element.src, base);
      if (url.origin === origin) paths.push(url.pathname);
    } catch {}
  }
  return paths;
}

function describeBuild(worker: UpdateWorker): Promise<unknown> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    try {
      worker.postMessage({ type: "describe-build" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function settleInstalledWorker(input: {
  worker: UpdateWorker;
  superseding: boolean;
  scripts: readonly string[];
  describe(worker: UpdateWorker): Promise<unknown>;
}): Promise<"ignored" | "activated" | "offered"> {
  if (input.worker.state !== "installed" || !input.superseding) return "ignored";
  const described = (await input.describe(input.worker)) as { shell?: unknown } | null;
  if (pageRunsBuild(input.scripts, described?.shell)) {
    input.worker.postMessage({ type: "activate-update" });
    return "activated";
  }
  publish(input.worker);
  return "offered";
}

async function installationRegistration(
  container: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration | null> {
  const scope = `${cockpitBasePath()}/`;
  const registration = await container.getRegistration(scope);
  return registration?.scope === `${window.location.origin}${scope}` ? registration : null;
}

export function watchInstallationWorker(): () => void {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container || !installationId()) return () => {};
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const seen = new WeakSet<ServiceWorker>();
  const track = (registration: ServiceWorkerRegistration, worker: ServiceWorker | null) => {
    if (!worker || seen.has(worker)) return;
    seen.add(worker);
    const settle = () => {
      if (disposed) return;
      void settleInstalledWorker({
        worker,
        superseding: registration.active !== null && registration.active !== worker,
        scripts: pageScripts(
          document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
          window.location.origin,
          window.location.href,
        ),
        describe: describeBuild,
      }).catch(() => {});
    };
    worker.addEventListener("statechange", settle);
    settle();
  };
  const attach = (attempt: number) => {
    void installationRegistration(container)
      .then((registration) => {
        if (disposed) return;
        if (!registration) {
          if (attempt < REGISTRATION_RETRIES)
            retry = setTimeout(() => attach(attempt + 1), REGISTRATION_RETRY_MS);
          return;
        }
        track(registration, registration.waiting);
        track(registration, registration.installing);
        registration.addEventListener("updatefound", () =>
          track(registration, registration.installing),
        );
      })
      .catch(() => {});
  };
  attach(0);
  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
  };
}

export function updateCheckDelay(now: number, last: number): number {
  return Math.max(0, last + UPDATE_CHECK_GAP_MS - now);
}

export function checkForWorkerUpdate(): void {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container || !installationId() || pendingCheck !== null) return;
  pendingCheck = setTimeout(
    () => {
      pendingCheck = null;
      lastCheck = Date.now();
      void installationRegistration(container)
        .then((registration) => registration?.update())
        .catch(() => {});
    },
    updateCheckDelay(Date.now(), lastCheck),
  );
}

export async function reloadIntoUpdate(): Promise<void> {
  const worker = waiting;
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (worker && container) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ACTIVATE_TIMEOUT_MS);
      container.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        worker.postMessage({ type: "activate-update" });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  window.location.reload();
}
