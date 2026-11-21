import { HttpError } from "../http/errors.ts";
import { type ConfirmerRefusal, NOTHING_CHANGED } from "./core/local-confirmation.ts";

const REFUSAL_MESSAGES: Readonly<Record<ConfirmerRefusal | "unchecked", string>> = {
  device_runner: "A device runner never confirms a local step.",
  no_person: "Only a person confirms a local step.",
  no_browser_session: "Confirm a local step in Cockpit or in the desktop app while signed in.",
  not_owner: "Only the person who started this job confirms its local steps.",
  missing_permission: "Your role does not allow confirming local steps.",
  unchecked: "A local step is confirmed only through its confirmation card.",
};

export class LocalConfirmationForbiddenError extends HttpError {
  readonly refusal: ConfirmerRefusal | "unchecked";
  constructor(refusal: ConfirmerRefusal | "unchecked") {
    super(
      403,
      "local_confirmation_forbidden",
      `${REFUSAL_MESSAGES[refusal]} ${NOTHING_CHANGED.en}`,
      { details: { refusal } },
    );
    this.name = "LocalConfirmationForbiddenError";
    this.refusal = refusal;
  }
}

export class LocalConfirmationExpiredError extends HttpError {
  constructor() {
    super(
      409,
      "local_confirmation_expired",
      `The time to confirm this local step has run out. ${NOTHING_CHANGED.en}`,
      { details: { message: NOTHING_CHANGED } },
    );
    this.name = "LocalConfirmationExpiredError";
  }
}
