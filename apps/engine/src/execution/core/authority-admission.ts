import { isDeepStrictEqual } from "node:util";

interface RequestIdentity {
  readonly step_id: string;
  readonly configuration_digest: string;
  readonly credential_id: string | null;
  readonly credential_revision: number | null;
  readonly connection_authority: Readonly<{ id: string; revision: number }> | null;
}

export function findAuthorizedEffect<
  T extends Readonly<{
    step_id: string;
    configuration_digest: string;
    call_path?: readonly string[] | undefined;
  }>,
>(
  effects: readonly T[],
  snapshot: Pick<RequestIdentity, "step_id" | "configuration_digest">,
  path: readonly string[],
): T | undefined {
  return effects.find(
    (candidate) =>
      candidate.step_id === snapshot.step_id &&
      candidate.configuration_digest === snapshot.configuration_digest &&
      isDeepStrictEqual(candidate.call_path ?? [], path),
  );
}

export function referenceWithinBoundary(
  reference: Readonly<{
    connector_id: string;
    configuration_digest: string;
    credential_id: string | null;
    credential_revision: number | null;
  }>,
  connectorId: string | null,
  snapshot: Pick<RequestIdentity, "configuration_digest" | "credential_id" | "credential_revision">,
): boolean {
  return (
    reference.connector_id === connectorId &&
    reference.configuration_digest === snapshot.configuration_digest &&
    (reference.credential_id === null ||
      (reference.credential_id === snapshot.credential_id &&
        reference.credential_revision === snapshot.credential_revision))
  );
}

export function credentialWithinBoundary(
  snapshot: Pick<RequestIdentity, "credential_id" | "credential_revision" | "connection_authority">,
  expectedDigest: string | null | undefined,
  available: Readonly<{
    digest: string;
    primary: Readonly<{ id: string; revision: number }> | null | undefined;
    connection: Readonly<{ id: string; revision: number }> | null;
  }> | null,
): boolean {
  return (
    available !== null &&
    available.digest === expectedDigest &&
    available.primary?.id === snapshot.credential_id &&
    available.primary?.revision === snapshot.credential_revision &&
    isDeepStrictEqual(available.connection, snapshot.connection_authority)
  );
}

export function governingExecutionCanDispatch(status: string, aborted: boolean): boolean {
  return !aborted && (status === "queued" || status === "running");
}
