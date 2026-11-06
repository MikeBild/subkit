import { roleErrorRejection } from "../../../api/operations/rbac-representation.ts";
import { HttpError } from "../../errors.ts";

export function mapRoleError(err: unknown): never {
  const rejection = roleErrorRejection(err);
  throw new HttpError(rejection.status, rejection.code, rejection.message);
}
