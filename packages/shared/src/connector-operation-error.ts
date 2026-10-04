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
