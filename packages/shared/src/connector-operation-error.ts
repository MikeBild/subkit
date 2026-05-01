// Structured driver-side error. Carries a stable `code` identifier plus
// arbitrary metadata so observability + self-healing can react without
// regex-parsing free-form messages.
//
// Driver throw sites should prefer this over bare `throw new Error(...)`.
// Wire `code` to a stable identifier (e.g. `FTP_AUTH_FAILED`,
// `SMB_PATH_NOT_FOUND`, `POSTGRES_QUERY_TIMEOUT`); operators rely on
// these strings for alerting + drift classification.

export class ConnectorOperationError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;

  constructor(code: string, message: string, metadata: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConnectorOperationError";
    this.code = code;
    this.metadata = metadata;
  }
}

export function isConnectorOperationError(err: unknown): err is ConnectorOperationError {
  return err instanceof ConnectorOperationError;
}
