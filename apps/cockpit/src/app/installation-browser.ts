import { cockpitBasePath, installationId } from "./installation-context";

export function installationCapabilities() {
  const available = typeof window !== "undefined" && window.isSecureContext;
  return {
    installation: available && "serviceWorker" in navigator,
    clipboard: available && Boolean(navigator.clipboard?.readText),
    push:
      available &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
    fileOpen: available && "showOpenFilePicker" in window,
    fileSave: available && "showSaveFilePicker" in window,
    fileLaunch: available && "launchQueue" in window,
  };
}

export async function registerInstallationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!installationId() || !installationCapabilities().installation) return null;
  const scope = `${cockpitBasePath()}/`;
  const registration = await navigator.serviceWorker.register(`${scope}sw.js`, {
    scope,
    updateViaCache: "none",
  });
  return await activeRegistration(registration, "installation_worker_unavailable");
}

async function activeRegistration(
  registration: ServiceWorkerRegistration,
  unavailable: string,
): Promise<ServiceWorkerRegistration> {
  if (registration.active?.state === "activated") return registration;
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error(unavailable);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", changed);
    };
    const changed = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      } else if (worker.state === "redundant") {
        cleanup();
        reject(new Error(unavailable));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(unavailable));
    }, 10_000);
    worker.addEventListener("statechange", changed);
    changed();
  });
  return registration;
}

export function mountInstallationManifest(): () => void {
  if (!installationId()) return () => {};
  const link = document.createElement("link");
  link.rel = "manifest";
  link.crossOrigin = "use-credentials";
  link.href = `${cockpitBasePath()}/manifest.webmanifest`;
  document.head.append(link);
  return () => link.remove();
}

export function clearInstallationInput(): void {
  installationWorkerController(navigator.serviceWorker?.controller)?.postMessage({
    type: "clear-incoming",
  });
}

export function vapidApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("invalid_push_key");
  return bytes;
}

function sameServerKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.byteLength === expected.byteLength &&
    bytes.every((byte, index) => byte === expected[index])
  );
}

export async function rebindPushSubscription(input: {
  registration: Pick<ServiceWorkerRegistration, "pushManager">;
  permission: NotificationPermission;
  status(): Promise<{ subscribed: boolean }>;
  prepare(): Promise<{ public_key: string }>;
  save(subscription: PushSubscription): Promise<void>;
}): Promise<boolean> {
  if (input.permission !== "granted") return false;
  const existing = await input.registration.pushManager.getSubscription();
  if (!existing) return false;
  const serverKey = vapidApplicationServerKey((await input.prepare()).public_key);
  if (sameServerKey(existing.options.applicationServerKey, serverKey)) {
    if ((await input.status()).subscribed) return true;
    await input.save(existing);
    return true;
  }
  await existing.unsubscribe();
  const renewed = await input.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });
  await input.save(renewed);
  return true;
}

const BROWSER_PUSH_SCOPE = "/cockpit/";
const PUSH_DEVICE_KEY = "subkit.push-device";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkerRegistrar = Pick<ServiceWorkerContainer, "register">;
type WorkerLookup = Pick<ServiceWorkerContainer, "getRegistration">;
type WorkerListing = Pick<ServiceWorkerContainer, "getRegistrations">;

interface DeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export async function registerBrowserPushWorker(
  container: WorkerRegistrar = navigator.serviceWorker,
  pathname = window.location.pathname,
): Promise<ServiceWorkerRegistration | null> {
  if (installationId(pathname)) return null;
  const registration = await container.register(`${BROWSER_PUSH_SCOPE}sw.js`, {
    scope: BROWSER_PUSH_SCOPE,
    updateViaCache: "none",
  });
  return await activeRegistration(registration, "browser_push_worker_unavailable");
}

export async function browserPushRegistration(
  container: WorkerLookup | undefined = navigator.serviceWorker,
  origin = window.location.origin,
): Promise<ServiceWorkerRegistration | null> {
  const registration = await container?.getRegistration(BROWSER_PUSH_SCOPE);
  return registration?.scope === `${origin}${BROWSER_PUSH_SCOPE}` ? registration : null;
}

export function pushDeviceId(
  storage: DeviceStorage | null = typeof localStorage === "undefined" ? null : localStorage,
  create: () => string = () => crypto.randomUUID(),
): string | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(PUSH_DEVICE_KEY);
    if (stored && UUID.test(stored)) return stored;
    const created = create();
    storage.setItem(PUSH_DEVICE_KEY, created);
    return created;
  } catch {
    return null;
  }
}

export async function installationPushHandlesDevice(
  container: WorkerListing | undefined,
  tenantInstallationId: string | null,
): Promise<boolean> {
  if (!container || !tenantInstallationId) return false;
  const suffix = `/cockpit/i/${tenantInstallationId}/`;
  for (const registration of await container.getRegistrations()) {
    if (!new URL(registration.scope).pathname.endsWith(suffix)) continue;
    if (await registration.pushManager.getSubscription()) return true;
  }
  return false;
}

export function installationWorkerController<Worker extends Pick<ServiceWorker, "scriptURL">>(
  controller: Worker | null | undefined,
  pathname = window.location.pathname,
  origin = window.location.origin,
): Worker | null {
  if (!controller || !installationId(pathname)) return null;
  return controller.scriptURL === `${origin}${cockpitBasePath(pathname)}/sw.js` ? controller : null;
}

export async function rebindBrowserPushSubscription(input: {
  registration: Pick<ServiceWorkerRegistration, "pushManager">;
  permission: NotificationPermission;
  status(): Promise<{ subscribed: boolean }>;
  prepare(): Promise<{ public_key: string }>;
  rebind(subscription: PushSubscription): Promise<boolean>;
}): Promise<boolean> {
  if (input.permission !== "granted") return false;
  const existing = await input.registration.pushManager.getSubscription();
  if (!existing) return false;
  const serverKey = vapidApplicationServerKey((await input.prepare()).public_key);
  if (!sameServerKey(existing.options.applicationServerKey, serverKey)) {
    await existing.unsubscribe();
    return false;
  }
  if ((await input.status()).subscribed) return true;
  if (await input.rebind(existing)) return true;
  await existing.unsubscribe();
  return false;
}

export async function restoreBrowserPush(input: {
  container: WorkerLookup | undefined;
  origin: string;
  pathname: string;
  permission: NotificationPermission;
  status(): Promise<{ subscribed: boolean }>;
  prepare(): Promise<{ public_key: string }>;
  rebind(subscription: PushSubscription): Promise<boolean>;
}): Promise<boolean> {
  if (installationId(input.pathname) || input.permission !== "granted") return false;
  const registration = await browserPushRegistration(input.container, input.origin);
  if (!registration) return false;
  return await rebindBrowserPushSubscription({
    registration,
    permission: input.permission,
    status: input.status,
    prepare: input.prepare,
    rebind: input.rebind,
  });
}

export async function enableBrowserPush(input: {
  container: WorkerRegistrar;
  pathname: string;
  requestPermission(): Promise<NotificationPermission>;
  prepare(): Promise<{ public_key: string }>;
  save(subscription: PushSubscription, device: string | null): Promise<void>;
  device(): string | null;
}): Promise<boolean> {
  if (installationId(input.pathname)) return false;
  if ((await input.requestPermission()) !== "granted") return false;
  const registration = await registerBrowserPushWorker(input.container, input.pathname);
  if (!registration) return false;
  const serverKey = vapidApplicationServerKey((await input.prepare()).public_key);
  const existing = await registration.pushManager.getSubscription();
  const reusable = existing && sameServerKey(existing.options.applicationServerKey, serverKey);
  if (existing && !reusable) await existing.unsubscribe();
  const subscription =
    reusable && existing
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: serverKey,
        });
  try {
    await input.save(subscription, input.device());
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  return true;
}

export async function releaseBrowserPush(
  container: WorkerLookup | undefined,
  origin: string,
): Promise<boolean> {
  const registration = await browserPushRegistration(container, origin);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  await subscription.unsubscribe();
  return true;
}
