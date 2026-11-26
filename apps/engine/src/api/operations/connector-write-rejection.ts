import {
  type ConnectorWriteRejection,
  connectorWriteRejectionDetails,
} from "../../connectors/index.ts";
import { type Rejection, type RejectionStatus, reject } from "./index.ts";

const STATUS: Readonly<Record<ConnectorWriteRejection["code"], RejectionStatus>> = {
  connector_template_unknown: 400,
  connector_template_conflict: 409,
};

export function connectorWriteRejectionStatus(
  code: ConnectorWriteRejection["code"],
): RejectionStatus {
  return STATUS[code];
}

export function connectorWriteRejection(rejection: ConnectorWriteRejection): Rejection {
  return reject.status(
    connectorWriteRejectionStatus(rejection.code),
    rejection.code,
    rejection.message,
    connectorWriteRejectionDetails(rejection),
  );
}
