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
  rebindPushSubscriptionBinding,
  savePushSubscription,
} from "@/api/cockpit-installations";
import { announceLaunch } from "@/features/pwa";
import {
  browserPushRegistration,
  clearInstallationInput,
  enableBrowserPush,
  installationCapabilities,
  installationWorkerController,
  mountInstallationManifest,
  pushDeviceId,
  rebindPushSubscription,
  registerInstallationWorker,
  releaseBrowserPush,
  restoreBrowserPush,
  vapidApplicationServerKey,
} from "./installation-browser";
import { installationId } from "./installation-context";
import {
  INSTALLATION_FILE_COUNT,
  type InstallationIncoming,
  validateInstallationIncoming,
} from "./installation-input";

interface InstallationIdentity {
  tenantId: string;
  userId: string;
}

interface InstallationIncomingReceipt extends InstallationIncoming, InstallationIdentity {}

interface InstallationContextValue {
  available: boolean;
  capabilities: ReturnType<typeof installationCapabilities>;
  incoming: InstallationIncomingReceipt | null;
  incomingError: "sign-in" | "retry" | "unavailable" | null;
  stageIncoming(value: InstallationIncoming): void;
  clearIncoming(): void;
  pushScope: "installation" | "browser";
  pushSubscribed: boolean | null;
  handledByApp: boolean;
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
    setConsumer(
      consumer: (params: { files?: readonly LaunchFileHandle[]; targetURL?: string }) => void,
    ): void;
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
  const worker =
    installationWorkerController(navigator.serviceWorker?.controller) ?? registration?.active;
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
  const pushScope = available ? "installation" : "browser";
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
  const [handledByApp, setHandledByApp] = useState(false);
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
    setHandledByApp(false);
  }, [identity.tenantId, identity.userId]);

  useEffect(() => {
    if (available || !capabilities.push) return;
    let active = true;
    const restore = async () => {
      try {
        const bound = await restoreBrowserPush({
          container: navigator.serviceWorker,
          origin: window.location.origin,
          pathname: window.location.pathname,
          permission: Notification.permission,
          status: pushSubscriptionStatus,
          prepare: preparePushSubscription,
          rebind: (subscription) => rebindPushSubscriptionBinding(subscription, pushDeviceId()),
        });
        if (bound && active) setPushSubscribed(true);
      } catch {
        // Restoring push is best effort: the settings page offers a manual subscribe.
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [available, capabilities.push, identity.tenantId, identity.userId]);

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
    const current = () => active && generation.current === currentGeneration;
    const rebind = async (registration: ServiceWorkerRegistration) => {
      try {
        const bound = await rebindPushSubscription({
          registration,
          permission: Notification.permission,
          status: pushSubscriptionStatus,
          prepare: preparePushSubscription,
          save: (subscription) => savePushSubscription(subscription, { device: pushDeviceId() }),
        });
        if (bound && current()) setPushSubscribed(true);
      } catch {
        // Rebinding push is best effort: the settings page offers a manual subscribe.
      }
    };
    const register = async () => {
      let registration: ServiceWorkerRegistration | null | undefined;
      try {
        registration = await registerInstallationWorker();
      } catch {
        if (current()) setIncomingError("unavailable");
        return;
      }
      if (!current()) return;
      takeIncoming(registration);
      if (registration && installationCapabilities().push) void rebind(registration);
    };
    void register();
    takeIncoming();
    const launchQueue = window as LaunchQueueWindow;
    launchQueue.launchQueue?.setConsumer((params) => {
      if (!params.files?.length) {
        announceLaunch(params.targetURL);
        return;
      }
      const launch = async (files: readonly LaunchFileHandle[]) => {
        try {
          const value = await incomingFromLaunchFiles(files);
          if (active && generation.current === currentGeneration) stageIncoming(value);
        } catch {
          if (active && generation.current === currentGeneration) setIncomingError("retry");
        }
      };
      void launch(params.files ?? []);
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
    if (!available && !capabilities.push) return false;
    const status = await pushSubscriptionStatus(available ? null : pushDeviceId());
    setPushSubscribed(status.subscribed);
    if (!available) setHandledByApp(!status.subscribed && status.handled_by_app);
    return status.subscribed;
  }, [available, capabilities.push]);
  const enablePush = useCallback(async () => {
    if (!capabilities.push) return false;
    if (!available) {
      const enabled = await enableBrowserPush({
        container: navigator.serviceWorker,
        pathname: window.location.pathname,
        requestPermission: () => Notification.requestPermission(),
        prepare: preparePushSubscription,
        save: (subscription, device) => savePushSubscription(subscription, { device }),
        device: () => pushDeviceId(),
      });
      setPushSubscribed(enabled);
      return enabled;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushSubscribed(false);
      return false;
    }
    const registration = await registerInstallationWorker();
    if (!registration) return false;
    const device = pushDeviceId();
    const { public_key } = await preparePushSubscription();
    const release = async () => {
      try {
        await releaseBrowserPush(navigator.serviceWorker, window.location.origin, public_key);
      } catch {
        // Releasing the old browser subscription is best effort; the new one is already saved.
      }
    };
    const rebound = await rebindPushSubscription({
      registration,
      permission,
      status: async () => ({ subscribed: false }),
      prepare: async () => ({ public_key }),
      save: (subscription) => savePushSubscription(subscription, { device }),
    });
    if (rebound) {
      setPushSubscribed(true);
      void release();
      return true;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidApplicationServerKey(public_key),
    });
    try {
      await savePushSubscription(subscription, { device });
    } catch (error) {
      try {
        await subscription.unsubscribe();
      } catch {
        // The save already failed; that error is the one to report.
      }
      throw error;
    }
    setPushSubscribed(true);
    void release();
    return true;
  }, [available, capabilities.push]);
  const disablePush = useCallback(async () => {
    if (!available && !capabilities.push) return;
    const registration = available
      ? await navigator.serviceWorker?.getRegistration(`${location.origin}${location.pathname}`)
      : await browserPushRegistration(navigator.serviceWorker, location.origin);
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    await deletePushSubscription();
    setPushSubscribed(false);
  }, [available, capabilities.push]);
  const value = useMemo<InstallationContextValue>(
    () => ({
      available,
      capabilities,
      incoming,
      incomingError,
      stageIncoming,
      clearIncoming,
      pushScope,
      pushSubscribed,
      handledByApp,
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
      pushScope,
      pushSubscribed,
      handledByApp,
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
