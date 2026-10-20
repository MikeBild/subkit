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
  if (registration.active?.state === "activated") return registration;
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error("installation_worker_unavailable");
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
        reject(new Error("installation_worker_unavailable"));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("installation_worker_unavailable"));
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
  if (!installationId()) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-incoming" });
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
