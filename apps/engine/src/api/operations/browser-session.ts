import type { ResolvedPrincipal } from "../../auth/types.ts";
import { type Rejection, reject } from "./index.ts";

/**
 * Pure check: a person signed in to the Cockpit through a browser session.
 * Returns the principal when it qualifies, otherwise a 403
 * `human_confirmation_required` rejection as a value. Operations return the
 * rejection instead of throwing, so the api layer never reaches into http/.
 */
export function requireBrowserSession(
  principal: ResolvedPrincipal,
  message: string,
): ResolvedPrincipal | Rejection {
  if (principal.kind !== "user" || principal.auth_source?.kind !== "browser_session")
    return reject.status(403, "human_confirmation_required", message);
  return principal;
}
