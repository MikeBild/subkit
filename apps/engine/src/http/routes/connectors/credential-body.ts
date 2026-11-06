import {
  type CredentialBodyInput,
  credentialValueOf,
  type StaticCredentialValue,
} from "../../../api/operations/connector-credentials.ts";
import { isRejection } from "../../../api/operations/index.ts";
import { BadRequestError } from "../../errors.ts";

export function credentialBodyToValue(body: CredentialBodyInput): StaticCredentialValue {
  const value = credentialValueOf(body);
  if (isRejection(value)) throw new BadRequestError(value.message);
  return value;
}
