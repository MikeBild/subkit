import type { ScreenshotCapability } from "@/features/feedback/model/feedback";

export const FEEDBACK_BRIDGE_VERSION = 2;
export const CAPTURE_TIMEOUT_MS = 4000;

export interface FeedbackBridge {
  screenshot: ScreenshotCapability;
  diagnostics(): Promise<unknown>;
  captureWindow(): Promise<string | null>;
  onFeedbackRequested(listener: () => void): () => void;
  diagnosticsConsent(): Promise<boolean | null>;
}

function screenshotCapability(candidate: unknown): ScreenshotCapability {
  const capabilities =
    candidate && typeof candidate === "object"
      ? (candidate as { screenshot?: unknown }).screenshot
      : null;
  const flags =
    capabilities && typeof capabilities === "object"
      ? (capabilities as Record<string, unknown>)
      : {};
  return {
    masksSecretFields: flags.masksSecretFields === true,
    masksVisibleText: flags.masksVisibleText === true,
  };
}

export function feedbackBridgeOf(candidate: unknown): FeedbackBridge | null {
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as Record<string, unknown>;
  const version = bridge.protocolVersion;
  if (typeof version !== "number" || version < FEEDBACK_BRIDGE_VERSION) return null;
  const { diagnostics, captureWindow, onFeedbackRequested, desktopSettings } = bridge;
  if (typeof diagnostics !== "function" || typeof captureWindow !== "function") return null;
  return {
    screenshot: screenshotCapability(bridge.capabilities),
    diagnostics: async () => (await diagnostics.call(bridge)) as unknown,
    captureWindow: async () => {
      const png: unknown = await captureWindow.call(bridge);
      return typeof png === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(png) ? png : null;
    },
    diagnosticsConsent: async () => {
      if (typeof desktopSettings !== "function") return null;
      const settings: unknown = await desktopSettings.call(bridge);
      const consent =
        settings && typeof settings === "object"
          ? (settings as { shareDiagnostics?: unknown }).shareDiagnostics
          : undefined;
      return typeof consent === "boolean" ? consent : null;
    },
    onFeedbackRequested: (listener) => {
      if (typeof onFeedbackRequested !== "function") return () => {};
      const stop: unknown = onFeedbackRequested.call(bridge, listener);
      return typeof stop === "function" ? () => void stop() : () => {};
    },
  };
}

export function feedbackBridge(): FeedbackBridge | null {
  return typeof window === "undefined"
    ? null
    : feedbackBridgeOf((window as unknown as { subkitDesktop?: unknown }).subkitDesktop);
}

export function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}
