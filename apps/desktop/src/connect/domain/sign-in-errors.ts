import type { ErrorCause } from "@ui/lib/errors";

export type SignInErrorCase =
  | "serverUnreachable"
  | "notSubkit"
  | "serverTooOld"
  | "appTooOld"
  | "loginUnsupported"
  | "signinCancelled"
  | "signinExpired"
  | "signinRejected"
  | "signinOutdated"
  | "signinUnreachable"
  | "browserFailed";

export const SIGN_IN_ERRORS: Record<SignInErrorCase, { cause: ErrorCause; code: string }> = {
  serverUnreachable: { cause: "timeout", code: "unreachable" },
  notSubkit: { cause: "schema_mismatch", code: "not_subkit" },
  serverTooOld: { cause: "version_unsupported", code: "server_too_old" },
  appTooOld: { cause: "version_unsupported", code: "app_too_old" },
  loginUnsupported: { cause: "version_unsupported", code: "login_unsupported" },
  signinCancelled: { cause: "auth_failed", code: "cancelled" },
  signinExpired: { cause: "auth_failed", code: "expired" },
  signinRejected: { cause: "auth_failed", code: "rejected" },
  signinOutdated: { cause: "version_unsupported", code: "outdated" },
  signinUnreachable: { cause: "timeout", code: "unreachable" },
  browserFailed: { cause: "unclassified", code: "browser-failed" },
};
