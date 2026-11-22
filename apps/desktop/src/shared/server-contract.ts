import { safeServerPath } from "./server-address.ts";

export const DESCRIPTOR_PATH = "/.well-known/service-descriptor.json";
export const EVENTS_STREAM_PATH = "/v1/cockpit/events/stream";
export const ATTENTION_PATH = "/v1/attention";
export const DEFAULT_COCKPIT_PATH = "/cockpit";
export const MIN_SERVER_VERSION = "12.1.0";
export const LOGIN_CALLBACK = "subkit://callback";
export const CODE_CHALLENGE_METHOD = "S256";
export const DEVICE_LABEL_MAX = 64;

export interface LoginPaths {
  start: string;
  session: string;
}

export const DEFAULT_LOGIN_PATHS: LoginPaths = {
  start: "/v1/identity/desktop-login/start",
  session: "/v1/identity/desktop-session",
};

export interface DesktopClientInfo {
  minVersion: string | null;
  login: LoginPaths;
  loginSupported: boolean;
  callbacks: string[];
  feedbackPath: string | null;
  anonymousFeedbackPath: string | null;
}

export interface ServiceDescriptor {
  version: string;
  desktop: DesktopClientInfo | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loginCallbacks(login: Record<string, unknown> | null): string[] {
  const listed = login?.callbacks;
  if (Array.isArray(listed))
    return listed.filter((entry): entry is string => typeof entry === "string").slice(0, 8);
  const single = login?.callback;
  if (single === undefined) return [LOGIN_CALLBACK];
  return typeof single === "string" ? [single] : [];
}

export function acceptsCallback(desktop: DesktopClientInfo | null, callback: string): boolean {
  return Boolean(desktop?.loginSupported && desktop.callbacks.includes(callback));
}

export function parseDescriptor(json: unknown): ServiceDescriptor | null {
  const root = record(json);
  if (!root || typeof root.version !== "string" || !root.version.trim()) return null;
  const desktop = record(record(root.clients)?.desktop);
  if (!desktop) return { version: root.version.trim(), desktop: null };
  const login = record(desktop.login);
  const methods = login?.code_challenge_methods;
  const feedback = safeServerPath(desktop.feedback_path, "");
  const anonymousFeedback = safeServerPath(desktop.anonymous_feedback_path, "");
  return {
    version: root.version.trim(),
    desktop: {
      minVersion: typeof desktop.min_version === "string" ? desktop.min_version.trim() : null,
      login: {
        start: safeServerPath(login?.start, DEFAULT_LOGIN_PATHS.start),
        session: safeServerPath(login?.session, DEFAULT_LOGIN_PATHS.session),
      },
      loginSupported:
        methods === undefined ||
        (Array.isArray(methods) && methods.includes(CODE_CHALLENGE_METHOD)),
      callbacks: loginCallbacks(login),
      feedbackPath: feedback || null,
      anonymousFeedbackPath: anonymousFeedback || null,
    },
  };
}

export interface LoginStartParams {
  challenge: string;
  state: string;
  deviceId: string;
  deviceLabel: string;
  callback: string;
  appVersion: string;
}

export function loginStartUrl(origin: string, paths: LoginPaths, params: LoginStartParams): string {
  const url = new URL(`${origin}${paths.start}`);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", CODE_CHALLENGE_METHOD);
  url.searchParams.set("state", params.state);
  url.searchParams.set("device_id", params.deviceId);
  url.searchParams.set("device_label", deviceLabel(params.deviceLabel));
  url.searchParams.set("redirect_uri", params.callback);
  url.searchParams.set("app_version", appVersionParam(params.appVersion));
  return url.toString();
}

export function appVersionParam(raw: string): string {
  return raw.trim().replace(/^v/, "").split("+")[0] ?? "";
}

export function deviceLabel(raw: string): string {
  const clean = [...raw.replace(/\p{Cc}/gu, "").trim()].slice(0, DEVICE_LABEL_MAX).join("").trim();
  return clean || "SubKit Desktop";
}

export interface DesktopSession {
  installationId: string;
  cockpitPath: string;
}

const INSTALLATION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function parseDesktopSession(json: unknown): DesktopSession | null {
  const root = record(json);
  if (!root) return null;
  const id = root.installation_id;
  if (typeof id !== "string" || !INSTALLATION_ID.test(id)) return null;
  const path = safeServerPath(root.cockpit_path, "");
  if (apiBase(path) !== `/cockpit/i/${id}/api`) return null;
  return { installationId: id, cockpitPath: path };
}

const INSTALLATION_PATH = /^(\/cockpit\/i\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/|$)/i;

export function apiBase(cockpitPath: string | null): string {
  const match = cockpitPath ? INSTALLATION_PATH.exec(cockpitPath) : null;
  return match ? `${match[1]}/api` : "";
}

export function apiUrl(origin: string, cockpitPath: string | null, path: string): string {
  return `${origin}${apiBase(cockpitPath)}${path}`;
}

export type AuthFailure = "expired" | "revoked";

export const REVOKED_CODE = "installation_revoked";

export function classifyAuthFailure(status: number, body: unknown): AuthFailure | null {
  if (status === 401) return "expired";
  return status === 403 && record(body)?.code === REVOKED_CODE ? "revoked" : null;
}

export type ExchangeFailure = "expired" | "rejected" | "unreachable" | "outdated";

export const APP_OUTDATED_STATUS = 426;

export function classifyExchangeFailure(status: number): ExchangeFailure {
  if (status === 401) return "expired";
  if (status === APP_OUTDATED_STATUS) return "outdated";
  if (status === 400 || status === 403) return "rejected";
  return "unreachable";
}

export function attentionHint(data: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  const value = record(payload)?.attention_id;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

export type Delivery = "held" | "critical_only";

export function deliveryHint(data: string): Delivery | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  const value = record(payload)?.delivery;
  return value === "held" || value === "critical_only" ? value : null;
}

export interface DeliveryMemory {
  value: Delivery | null;
  at: number;
}

export const DELIVERY_MEMORY_MS = 90_000;
export const NO_DELIVERY_MEMORY: DeliveryMemory = { value: null, at: 0 };

export function rememberDelivery(
  memory: DeliveryMemory,
  eventName: string,
  data: string,
  now: number,
): DeliveryMemory {
  const hint = deliveryHint(data);
  if (eventName === "hello" || eventName === "ping" || hint) return { value: hint, at: now };
  return memory;
}

export function deliveryNow(memory: DeliveryMemory, now: number): Delivery | null {
  return now - memory.at <= DELIVERY_MEMORY_MS ? memory.value : null;
}

export type StreamReaction = "ignore" | "sync" | "announce" | "session" | "shutdown";

export const SESSION_ENDED_EVENT = "session.ended";
export const SERVER_SHUTDOWN_EVENT = "server.shutdown";

export function streamReaction(eventName: string): StreamReaction {
  if (eventName === "ping") return "ignore";
  if (eventName === SERVER_SHUTDOWN_EVENT) return "shutdown";
  if (eventName === SESSION_ENDED_EVENT) return "session";
  return eventName === "hello" ? "sync" : "announce";
}

export function sessionEnded(data: string): AuthFailure {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return "expired";
  }
  const root = record(payload);
  const status = typeof root?.status === "number" ? root.status : 401;
  return classifyAuthFailure(status, root) ?? "expired";
}

export const DEFAULT_HEARTBEAT_MS = 25_000;
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 120_000;

export function helloHeartbeat(data: string): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  const value = record(payload)?.heartbeat_ms;
  return typeof value === "number" && value >= HEARTBEAT_MIN_MS && value <= HEARTBEAT_MAX_MS
    ? value
    : null;
}

export function idleTimeoutFor(heartbeatMs: number | null): number {
  return (heartbeatMs ?? DEFAULT_HEARTBEAT_MS) * 3;
}
