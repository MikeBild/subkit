import { DomainRefusal } from "../logging/index.ts";
import {
  type ConnectorWriteOutcome,
  type ConnectorWriteRejection,
  connectorWriteRejectionDetails,
} from "./core/write-rejection.ts";

export class ConnectorWriteRejectedError extends DomainRefusal {
  declare readonly code: ConnectorWriteRejection["code"];
  readonly rejection: ConnectorWriteRejection;
  readonly details: Record<string, unknown> | undefined;

  constructor(rejection: ConnectorWriteRejection) {
    super(rejection.code, rejection.message);
    this.name = "ConnectorWriteRejectedError";
    this.rejection = rejection;
    this.details = connectorWriteRejectionDetails(rejection);
  }
}

export function connectorWriteValue<T>(outcome: ConnectorWriteOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new ConnectorWriteRejectedError(outcome.rejection);
}
