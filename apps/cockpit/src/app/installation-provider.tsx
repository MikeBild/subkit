import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deletePushSubscription,
  preparePushSubscription,
  pushSubscriptionStatus,
  savePushSubscription,
} from "@/api/cockpit-installations";
import {
  clearInstallationInput,
  installationCapabilities,
  mountInstallationManifest,
  registerInstallationWorker,
  vapidApplicationServerKey,
} from "./installation-browser";
import { installationId } from "./installation-context";
import {
  INSTALLATION_FILE_COUNT,
  type InstallationIncoming,
  validateInstallationIncoming,
} from "./installation-input";

export interface InstallationIdentity {
  tenantId: string;
  userId: string;
}

export interface InstallationIncomingReceipt extends InstallationIncoming, InstallationIdentity {}

export interface InstallationContextValue {
  available: boolean;
  capabilities: ReturnType<typeof installationCapabilities>;
  incoming: InstallationIncomingReceipt | null;
  incomingError: "sign-in" | "retry" | "unavailable" | null;
  stageIncoming(value: InstallationIncoming): void;
  clearIncoming(): void;
  pushSubscribed: boolean | null;
  refreshPushSubscription(): Promise<boolean>;
  enablePush(): Promise<boolean>;
  disablePush(): Promise<void>;
}

const InstallationContext = createContext<InstallationContextValue | null>(null);

interface LaunchFileHandle {
  getFile(): Promise<File>;
}

interface LaunchQueueWindow extends Window {
  launchQueue?: {
    setConsumer(consumer: (params: { files?: readonly LaunchFileHandle[] }) => void): void;
  };
}

function isIncoming(
  value: unknown,
  identity: InstallationIdentity,
): value is InstallationIncomingReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<InstallationIncomingReceipt>;
  if (receipt.tenantId !== identity.tenantId || receipt.userId !== identity.userId) return false;
  if (
    typeof receipt.title !== "string" ||
    typeof receipt.text !== "string" ||
    typeof receipt.url !== "string" ||
    !Array.isArray(receipt.files) ||
    !receipt.files.every((file) => file instanceof File)
  )
    return false;
  try {
    validateInstallationIncoming({
      title: receipt.title,
      text: receipt.text,
      url: receipt.url,
      files: receipt.files,
    });
    return true;
  } catch {
    return false;
  }
}

function incomingId(search = window.location.search): string | null {
  const value = new URLSearchParams(search).get("incoming");
  return value && /^[0-9a-f-]{8,}$/i.test(value) ? value : null;
}

function requestIncoming(registration?: ServiceWorkerRegistration | null): boolean {
  const id = incomingId();
  if (!id) return false;
  const worker = navigator.serviceWorker?.controller ?? registration?.active;
  if (!worker) return false;
  worker.postMessage({ type: "take-incoming", id });
  return true;
}

export async function incomingFromLaunchFiles(
  handles: readonly LaunchFileHandle[],
): Promise<InstallationIncoming> {
  if (handles.length > INSTALLATION_FILE_COUNT) throw new Error("incoming_too_many_files");
  const files = await Promise.all(handles.map(async (handle) => await handle.getFile()));
  const value = { title: "", text: "", url: "", files };
  validateInstallationIncoming(value);
  return value;
}

export function InstallationProvider({
  identity,
  children,
}: {
  identity: InstallationIdentity;
  children: ReactNode;
}) {
  const available = installationId() !== null;
  const capabilities = installationCapabilities();
  const [incoming, setIncoming] = useState<InstallationIncomingReceipt | null>(null);
  const [incomingError, setIncomingError] = useState<"sign-in" | "retry" | "unavailable" | null>(
    () => {
      const value =
        typeof window === "undefined"
          ? null
          : new URLSearchParams(window.location.search).get("incoming");
      return value === "sign-in" || value === "retry" ? value : null;
    },
  );
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const generation = useRef(0);
  const stageIncoming = useCallback(
    (value: InstallationIncoming) => {
      validateInstallationIncoming(value);
      setIncomingError(null);
      setIncoming({ ...value, tenantId: identity.tenantId, userId: identity.userId });
    },
    [identity.tenantId, identity.userId],
  );

  useEffect(() => {
    setIncoming(null);
    setPushSubscribed(null);
  }, [identity.tenantId, identity.userId]);

  useEffect(() => {
    if (!available) return;
    const currentGeneration = ++generation.current;
    let active = true;
    const unmountManifest = mountInstallationManifest();
    let requested = false;
    const takeIncoming = (registration?: ServiceWorkerRegistration | null) => {
      if (!requested) requested = requestIncoming(registration);
    };
    const receive = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      const typed = message as { type?: unknown; value?: unknown };
      if (
        active &&
        generation.current === currentGeneration &&
        typed.type === "incoming" &&
        isIncoming(typed.value, identity)
      ) {
        setIncomingError(null);
        setIncoming(typed.value);
      }
      if (
        active &&
        generation.current === currentGeneration &&
        typed.type === "incoming-unavailable"
      )
        setIncomingError("unavailable");
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    void registerInstallationWorker()
      .then((registration) => {
        if (active && generation.current === currentGeneration) takeIncoming(registration);
      })
      .catch(() => {
        if (active && generation.current === currentGeneration) setIncomingError("unavailable");
      });
    takeIncoming();
    const launchQueue = window as LaunchQueueWindow;
    launchQueue.launchQueue?.setConsumer((params) => {
      void incomingFromLaunchFiles(params.files ?? [])
        .then((value) => {
          if (active && generation.current === currentGeneration) stageIncoming(value);
        })
        .catch(() => {
          if (active && generation.current === currentGeneration) setIncomingError("retry");
        });
    });
    return () => {
      active = false;
      generation.current += 1;
      navigator.serviceWorker?.removeEventListener("message", receive);
      launchQueue.launchQueue?.setConsumer(() => {});
      clearInstallationInput();
      unmountManifest();
    };
  }, [available, identity.tenantId, identity.userId, stageIncoming]);

  const clearIncoming = useCallback(() => {
    setIncomingError(null);
    setIncoming(null);
    clearInstallationInput();
  }, []);
  const refreshPushSubscription = useCallback(async () => {
    if (!available) return false;
    const { subscribed } = await pushSubscriptionStatus();
    setPushSubscribed(subscribed);
    return subscribed;
  }, [available]);
  const enablePush = useCallback(async () => {
    if (!available || !capabilities.push) return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushSubscribed(false);
      return false;
    }
    const registration = await registerInstallationWorker();
    if (!registration) return false;
    let subscription = await registration.pushManager.getSubscription();
    let created = false;
    if (!subscription) {
      const { public_key } = await preparePushSubscription();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidApplicationServerKey(public_key),
      });
      created = true;
    }
    try {
      await savePushSubscription(subscription);
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => {});
      throw error;
    }
    setPushSubscribed(true);
    return true;
  }, [available, capabilities.push]);
  const disablePush = useCallback(async () => {
    if (!available) return;
    const registration = await navigator.serviceWorker?.getRegistration(
      `${location.origin}${location.pathname}`,
    );
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    await deletePushSubscription();
    setPushSubscribed(false);
  }, [available]);
  const value = useMemo<InstallationContextValue>(
    () => ({
      available,
      capabilities,
      incoming,
      incomingError,
      stageIncoming,
      clearIncoming,
      pushSubscribed,
      refreshPushSubscription,
      enablePush,
      disablePush,
    }),
    [
      available,
      capabilities,
      incoming,
      incomingError,
      stageIncoming,
      clearIncoming,
      pushSubscribed,
      refreshPushSubscription,
      enablePush,
      disablePush,
    ],
  );
  return <InstallationContext.Provider value={value}>{children}</InstallationContext.Provider>;
}

export function useInstallation(): InstallationContextValue {
  const context = useContext(InstallationContext);
  if (!context) throw new Error("useInstallation requires InstallationProvider");
  return context;
}

export function incomingReceiptForIdentity(
  value: unknown,
  identity: InstallationIdentity,
): InstallationIncomingReceipt | null {
  return isIncoming(value, identity) ? value : null;
}
