import { runtimeSecretVersions } from "../db/schema/index.ts";

export const SECRET_VERSION_COLUMNS = {
  name: runtimeSecretVersions.name,
  version: runtimeSecretVersions.version,
  ciphertext: runtimeSecretVersions.ciphertext,
  iv: runtimeSecretVersions.iv,
  auth_tag: runtimeSecretVersions.auth_tag,
  created_by: runtimeSecretVersions.created_by,
  created_at: runtimeSecretVersions.created_at,
  revoked_at: runtimeSecretVersions.revoked_at,
  pending_since: runtimeSecretVersions.pending_since,
  prepared_by: runtimeSecretVersions.prepared_by,
  pending_bindings: runtimeSecretVersions.pending_bindings,
};
