import type { ConnectorAuthState } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import type { RenewalWay } from "@/pages/connector-detail-model";

/**
 * What a connector's status strip says, top state first (spec D15):
 * Anmeldung abgelaufen › Abgeschaltet › Nicht erreichbar › Zugangsdaten
 * unvollständig › ok. Only the top state gets its action; the rest are
 * counted. Switched off sits right under a lost sign-in: signing in never
 * switches a connector on, so after the sign-in it is the next thing to do.
 */
export type ConnectorStripKind =
  | "expired"
  | "off"
  | "unreachable"
  | "incomplete"
  | "signedIn"
  | "tested"
  | "connected"
  | "notRequired"
  | "unproven";

export type ConnectorStripAction =
  /** Signs in again — at the provider, through the account connection, or with a new key. */
  | { kind: "renew"; way: Exclude<RenewalWay, null> }
  | { kind: "enable" }
  | { kind: "recheck" }
  /** A first sign-in, or one that completes withheld permissions. */
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
  /** The engine's health verdict of the connector. */
  health: string | null;
  /** The reader's own test, once run. */
  probe: { ok: boolean } | null;
  /** Permissions the provider withheld. */
  missingScopes: number;
  /** The page was opened by the sign-in callback's redirect. */
  returned: boolean;
  rights: { write: boolean; test: boolean };
}

export const CONNECTOR_STRIP_KEYS: Record<ConnectorStripKind, TranslationKey> = {
  expired: "connectorStrip.state.expired",
  off: "connectorStrip.state.off",
  unreachable: "connectorStrip.state.unreachable",
  incomplete: "connectorStrip.state.incomplete",
  signedIn: "connectorState.signedIn",
  tested: "connectorStrip.state.tested",
  // The sign-in's own word ("Verbunden") stands in "Verbindung"; the strip
  // says whether the connector is ready.
  connected: "connectorStrip.state.ready",
  notRequired: "connectorStrip.state.ready",
  unproven: "connectorStrip.state.unproven",
};

export function connectorStripActionKey(action: ConnectorStripAction): TranslationKey {
  switch (action.kind) {
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
      kind: "incomplete",
      action: input.way
        ? { kind: "complete", way: input.way, first: input.auth === "credentials_missing" }
        : null,
    });
  const [top, ...rest] = candidates;
  if (top) {
    const tone = top.kind === "expired" || top.kind === "unreachable" ? "error" : "warn";
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
