import {
  type AdmissionContext,
  admissionRejection,
} from "../../../api/operations/execution-admission.ts";
import { HttpError } from "../../errors.ts";

export async function admissionRefusal(error: unknown, context: AdmissionContext): Promise<never> {
  const rejection = await admissionRejection(error, context);
  throw new HttpError(
    rejection.status,
    rejection.code,
    rejection.message,
    rejection.details ? { details: rejection.details } : {},
  );
}
