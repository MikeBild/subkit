import { onSessionExpired } from "@/api/transport";
import { cockpitApiHref, cockpitBasePath, installationId } from "@/app/installation-context";

const CACHE_PREFIX = "subkit-cockpit:";
const RELEASE_TIMEOUT_MS = 2500;

interface ReleaseRegistration {
  scope: string;
  pushManager?: { getSubscription(): Promise<{ unsubscribe(): Promise<boolean> } | null> };
  unregister(): Promise<boolean>;
}

interface ReleaseInput {
  origin: string;
  scopePath: string;
  unregister: boolean;
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> } | undefined;
  registration(scope: string): Promise<ReleaseRegistration | null | undefined>;
  clearBadge(): Promise<unknown>;
}

interface ReleaseResult {
  unsubscribed: boolean;
  caches: string[];
  unregistered: boolean;
}

export function ownCacheNames(names: readonly string[], scopePath: string): string[] {
  const own = `${CACHE_PREFIX}${scopePath}:`;
  return names.filter((name) => name.startsWith(own));
}

async function attempt<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch {
    return fallback;
  }
}

export async function releaseDeviceState(input: ReleaseInput): Promise<ReleaseResult> {
  await attempt(input.clearBadge, undefined);
  const found = await attempt(() => input.registration(input.scopePath), null);
  const registration = found && found.scope === `${input.origin}${input.scopePath}` ? found : null;
  const unsubscribed = await attempt(async () => {
    const subscription = await registration?.pushManager?.getSubscription();
    return subscription ? await subscription.unsubscribe() : false;
  }, false);
  const store = input.caches;
  const removed = store
    ? await attempt(async () => {
        const names = ownCacheNames(await store.keys(), input.scopePath);
        for (const name of names) await store.delete(name);
        return names;
      }, [])
    : [];
  const unregistered =
    input.unregister && registration
      ? await attempt(() => registration.unregister(), false)
      : false;
  return { unsubscribed, caches: removed, unregistered };
}

function releaseHere(unregister: boolean): Promise<ReleaseResult | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const container = navigator.serviceWorker;
  const release = releaseDeviceState({
    origin: window.location.origin,
    scopePath: `${cockpitBasePath()}/`,
    unregister,
    caches: typeof caches === "undefined" ? undefined : caches,
    registration: async (scope) => (await container?.getRegistration(scope)) ?? null,
    clearBadge: async () => await navigator.clearAppBadge?.(),
  });
  return Promise.race([
    release,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RELEASE_TIMEOUT_MS)),
  ]);
}

export async function releaseOnSignOut(): Promise<void> {
  await releaseHere(false).catch(() => null);
}

export function revokedRefusal(status: number, body: unknown): boolean {
  if (status !== 403 || !body || typeof body !== "object") return false;
  return (body as { code?: unknown }).code === "installation_revoked";
}

async function installationRevoked(): Promise<boolean> {
  const response = await fetch(cockpitApiHref("/v1/cockpit/bootstrap"), {
    credentials: "same-origin",
    cache: "no-store",
  });
  return revokedRefusal(response.status, await response.json().catch(() => null));
}

export async function releaseAfterSessionEnd(): Promise<void> {
  if (typeof navigator !== "undefined") await navigator.clearAppBadge?.().catch(() => {});
  if (!installationId()) return;
  if (await installationRevoked().catch(() => false)) await releaseHere(true).catch(() => null);
}

export function guardDeviceState(): () => void {
  return onSessionExpired(() => void releaseAfterSessionEnd().catch(() => {}));
}
