import type { TranslationKey } from "./i18n";

export type ConnectorAuthState =
  | "connected"
  | "expired"
  | "credentials_missing"
  | "not_required"
  | "unproven";

export interface ConnectorAuthInput {
  auth_type?: string | null;
  driver?: string | null;
  health_state?: string | null;
  needs_reauth?: boolean | null;
  auth_failed_at?: string | null;
}

export type CredentialEvidence = {
  mode: string;
  connection: { state: "valid" | "expiring" | "expired" | "unreadable" } | null;
} | null;

export interface ProbeOutcome {
  ok: boolean;
  error_code?: string;
}

const STORED_AUTH_TYPES = new Set([
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "oauth2_private_key",
  "signed_jwt",
  "aws_sigv4",
]);

export function credentialIsStored(connector: ConnectorAuthInput): boolean {
  return STORED_AUTH_TYPES.has(connector.auth_type ?? "") && connector.driver !== "postgres";
}

const LABELS: Record<ConnectorAuthState, TranslationKey> = {
  connected: "connectors.auth.connected",
  expired: "connectors.auth.expired",
  credentials_missing: "connectors.auth.credentialsMissing",
  not_required: "connectors.auth.notRequired",
  unproven: "connectors.auth.unproven",
};

export function connectorAuthState(
  connector: ConnectorAuthInput,
  probe?: ProbeOutcome | null,
  credential?: CredentialEvidence,
): ConnectorAuthState {
  if (probe) {
    if (probe.ok) return connector.auth_type === "none" ? "not_required" : "connected";
    if (probe.error_code === "credential_missing") return "credentials_missing";
    if (probe.error_code === "credential_expired" || probe.error_code === "credential_invalid")
      return "expired";
  }
  if (connector.needs_reauth === true || connector.health_state === "needs_reauth")
    return "expired";
  const grant = credential?.connection?.state;
  if (grant === "expired" || grant === "unreadable") return "expired";
  if (connector.auth_type === "none") return "not_required";
  if (credential === null && credentialIsStored(connector)) return "credentials_missing";
  if (connector.health_state === "ok" && !connector.auth_failed_at) return "connected";
  return "unproven";
}

export function authStateLabel(state: ConnectorAuthState): TranslationKey {
  return LABELS[state];
}

export function needsRenewal(state: ConnectorAuthState): boolean {
  return state === "expired" || state === "credentials_missing";
}

const HEALTH_LABELS: Record<string, TranslationKey> = {
  ok: "connectors.healthState.ok",
  degraded: "connectors.healthState.degraded",
  needs_update: "connectors.healthState.needsUpdate",
  needs_reauth: "connectors.healthState.needsReauth",
  needs_attention: "connectors.healthState.needsAttention",
};

export function connectorHealthLabel(healthState: string): TranslationKey | null {
  return HEALTH_LABELS[healthState] ?? null;
}
