import type { LiveStatus } from "./connectivity";

export const DESKTOP_STATUS_PROTOCOL = 6;

export type DesktopBannerKind = "offline" | "expired" | "revoked" | "server-too-old";

export interface DesktopBanner {
  kind: DesktopBannerKind;
  tone: "warning" | "danger";
  title: string;
  body: string;
  ask: string | null;
}

export interface DesktopStatus {
  banner: DesktopBanner | null;
  update: { version: string; ready: boolean } | null;
}

export interface DesktopStatusBridge {
  status(): Promise<unknown>;
  onStatus(listener: (status: unknown) => void): () => void;
  recheckServer(): Promise<void>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

export function desktopStatusBridgeOf(candidate: unknown): DesktopStatusBridge | null {
  const bridge = record(candidate);
  if (!bridge) return null;
  const { protocolVersion, status, onStatus, recheckServer } = bridge;
  if (typeof protocolVersion !== "number" || protocolVersion < DESKTOP_STATUS_PROTOCOL) return null;
  if (typeof status !== "function" || typeof onStatus !== "function") return null;
  if (typeof recheckServer !== "function") return null;
  return {
    status: async () => (await status.call(bridge)) as unknown,
    onStatus: (listener) => {
      const stop: unknown = onStatus.call(bridge, listener);
      return typeof stop === "function" ? () => void stop() : () => {};
    },
    recheckServer: async () => {
      await recheckServer.call(bridge);
    },
  };
}

const KINDS: readonly DesktopBannerKind[] = ["offline", "expired", "revoked", "server-too-old"];

function bannerOf(value: unknown): DesktopBanner | null {
  const b = record(value);
  if (!b) return null;
  const { kind, tone, title, body, ask } = b;
  if (typeof kind !== "string" || !KINDS.includes(kind as DesktopBannerKind)) return null;
  if (tone !== "warning" && tone !== "danger") return null;
  if (typeof title !== "string" || !title.trim()) return null;
  return {
    kind: kind as DesktopBannerKind,
    tone,
    title: title.trim(),
    body: typeof body === "string" ? body.trim() : "",
    ask: kind === "server-too-old" && typeof ask === "string" && ask.trim() ? ask.trim() : null,
  };
}

function updateOf(value: unknown): DesktopStatus["update"] {
  const u = record(value);
  if (!u || typeof u.version !== "string" || !u.version.trim()) return null;
  return { version: u.version.trim(), ready: u.ready === true };
}

export function parseDesktopStatus(value: unknown): DesktopStatus {
  const s = record(value);
  return { banner: bannerOf(s?.banner), update: updateOf(s?.update) };
}

export type DesktopNotice =
  | { type: "banner"; banner: DesktopBanner; code: string }
  | { type: "update"; version: string; ready: boolean }
  | null;

const CODE: Record<DesktopBannerKind, string> = {
  offline: "server_offline",
  expired: "auth_expired",
  revoked: "device_revoked",
  "server-too-old": "server_too_old",
};

export function desktopNotice(status: DesktopStatus, connection: LiveStatus): DesktopNotice {
  const banner = status.banner?.kind === "offline" && connection === "live" ? null : status.banner;
  if (banner) return { type: "banner", banner, code: CODE[banner.kind] };
  if (status.update) return { type: "update", ...status.update };
  return null;
}
