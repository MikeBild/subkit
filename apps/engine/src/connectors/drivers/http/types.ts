import type { ConnectionAuthorityIdentity } from "../../../credentials/authority-metadata.ts";
import type { CredentialUseSnapshot } from "../../../credentials/index.ts";
import type { DecryptedCredential } from "../../../credentials/types.ts";
import type { ManualRedirectPolicy } from "../../core/http-request.ts";

export interface ResolvedConnectorCredential {
  credential_snapshot?: CredentialUseSnapshot;
  credential: DecryptedCredential | null;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority?: ConnectionAuthorityIdentity | null;
  oauth2_refreshed: boolean;
}

export type RequestDispatchPolicy = ManualRedirectPolicy;

export interface HttpDispatchObservation {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  unsupported_body?: boolean;
  body_encoding?: "multipart";
  body_bytes?: number;
}

export interface HttpExecutionResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  url: string;
  body_raw?: Buffer;
}
