import type { ConnectorAuthState } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import type { RenewalWay } from "@/pages/connector-detail-model";

export type ConnectorStripKind =
  | "signInFailed"
  | "expired"
  | "off"
  | "unreachable"
  | "notSignedIn"
  | "incomplete"
  | "signedIn"
  | "tested"
  | "connected"
  | "notRequired"
  | "unproven";

export type ConnectorStripAction =
  | { kind: "retry"; way: Exclude<RenewalWay, null> }
  | { kind: "renew"; way: Exclude<RenewalWay, null> }
  | { kind: "enable" }
  | { kind: "recheck" }
  | { kind: "complete"; way: Exclude<RenewalWay, null>; first: boolean };

export interface ConnectorStrip {
  kind: ConnectorStripKind;
  tone: "ok" | "warn" | "error";
  action: ConnectorStripAction | null;
  lower: ConnectorStripKind[];
}

export interface ConnectorStripInput {
  auth: ConnectorAuthState;
  way: RenewalWay;
  enabled: boolean;
  health: string | null;
  probe: { ok: boolean } | null;
  missingScopes: number;
  returned: boolean;
  signInFailed: boolean;
  rights: { write: boolean; test: boolean };
}

export const CONNECTOR_STRIP_KEYS: Record<ConnectorStripKind, TranslationKey> = {
  signInFailed: "connectorStrip.state.signInFailed",
  expired: "connectorStrip.state.expired",
  off: "connectorStrip.state.off",
  unreachable: "connectorStrip.state.unreachable",
  notSignedIn: "connectorStrip.state.notSignedIn",
  incomplete: "connectorStrip.state.incomplete",
  signedIn: "connectorState.signedIn",
  tested: "connectorStrip.state.tested",
  connected: "connectorStrip.state.connected",
  notRequired: "connectorStrip.state.ready",
  unproven: "connectorStrip.state.unproven",
};

export function connectorStripActionKey(action: ConnectorStripAction): TranslationKey {
  switch (action.kind) {
    case "retry":
      return "connectorStrip.action.signInAgain";
    case "renew":
      return "connectorCredentials.renew";
    case "enable":
      return "connectorState.enable";
    case "recheck":
      return "connectorStrip.action.recheck";
    case "complete":
      return action.way === "key"
        ? "connectorStrip.action.enterCredentials"
        : action.first
          ? "connectorCredentials.signIn"
          : "connectorCredentials.renew";
  }
}

export function connectorStrip(input: ConnectorStripInput): ConnectorStrip {
  const candidates: { kind: ConnectorStripKind; action: ConnectorStripAction | null }[] = [];
  if (input.signInFailed)
    candidates.push({
      kind: "signInFailed",
      action: input.way ? { kind: "retry", way: input.way } : null,
    });
  if (input.auth === "expired")
    candidates.push({
      kind: "expired",
      action: input.way ? { kind: "renew", way: input.way } : null,
    });
  if (!input.enabled)
    candidates.push({ kind: "off", action: input.rights.write ? { kind: "enable" } : null });
  const unreachable =
    (input.probe !== null && !input.probe.ok && input.auth !== "expired") ||
    (input.probe === null && input.health === "degraded");
  if (unreachable)
    candidates.push({
      kind: "unreachable",
      action: input.rights.test ? { kind: "recheck" } : null,
    });
  if (input.auth === "credentials_missing" || input.missingScopes > 0)
    candidates.push({
      kind: input.auth === "credentials_missing" ? "notSignedIn" : "incomplete",
      action: input.way
        ? { kind: "complete", way: input.way, first: input.auth === "credentials_missing" }
        : null,
    });
  const [top, ...rest] = candidates;
  if (top) {
    const tone =
      top.kind === "signInFailed" || top.kind === "expired" || top.kind === "unreachable"
        ? "error"
        : "warn";
    return { kind: top.kind, tone, action: top.action, lower: rest.map((entry) => entry.kind) };
  }
  const calm: ConnectorStripKind = input.returned
    ? "signedIn"
    : input.probe?.ok
      ? "tested"
      : input.auth === "not_required"
        ? "notRequired"
        : input.auth === "connected"
          ? "connected"
          : "unproven";
  return { kind: calm, tone: "ok", action: null, lower: [] };
}

export function connectorExpiry(credentials: unknown, environment: unknown): string | null {
  if (!Array.isArray(credentials) || typeof environment !== "string") return null;
  for (const credential of credentials) {
    if (!credential || typeof credential !== "object" || credential.environment !== environment)
      continue;
    const expiry = credential.oauth2_expires_at;
    if (typeof expiry === "string" && Number.isFinite(Date.parse(expiry))) return expiry;
  }
  return null;
}
