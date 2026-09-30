import type { CredentialAuthorityMetadata } from "../credentials/authority-metadata.ts";

/** Why a connector cannot serve a run in its environment. `missing` and
 *  `too_many_references` are decided by the caller that looks the connector
 *  up; the rest are read off a connector it found. */
export type ConnectorUnavailability =
  | "missing"
  | FoundConnectorUnavailability
  | "too_many_references";

/** Why a connector that exists cannot serve. */
export type FoundConnectorUnavailability = "disabled" | "needs_reauth" | "credential_unavailable";

/**
 * The one predicate that decides whether a found connector can serve a run.
 *
 * The run dialog's pre-check (the authority preview) and the admission that
 * refuses the run with 409 both ask this, so the two can never disagree about
 * which connector is in the way or why. `credentialRequired` is the caller's
 * to state: the preview asks it for any connector with an auth type, the
 * admission also for a `{{cred.<slug>}}` placeholder on one without.
 * Metadata only — no token is decrypted and no OAuth exchange started.
 */
export function connectorUnavailability(
  connector: { enabled: boolean; needs_reauth: boolean },
  credential: Pick<CredentialAuthorityMetadata, "available"> | null | undefined,
  credentialRequired: boolean,
): FoundConnectorUnavailability | null {
  if (!connector.enabled) return "disabled";
  if (connector.needs_reauth) return "needs_reauth";
  if (credentialRequired && !credential?.available) return "credential_unavailable";
  return null;
}
