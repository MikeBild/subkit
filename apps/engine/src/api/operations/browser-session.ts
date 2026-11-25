import type { ResolvedPrincipal } from "../../auth/index.ts";
import { type Rejection, reject } from "./index.ts";

export function requireBrowserSession(
  principal: ResolvedPrincipal,
  message: string,
): ResolvedPrincipal | Rejection {
  if (principal.kind !== "user" || principal.auth_source?.kind !== "browser_session")
    return reject.status(403, "human_confirmation_required", message);
  return principal;
}
