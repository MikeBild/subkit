// Principals for builders that read per person (attention, the health digest).

import type { ResolvedPrincipal } from "../auth/types.ts";

/** A fixed id for a principal whose own rows (conversations) a test does not seed. */
export const TEST_ADMIN_ID = "00000000-0000-4000-8000-0000000000ad";

/** An admin of `tenant_id` — every permission, through the built-in admin role. */
export function adminPrincipal(tenant_id: string, id: string = TEST_ADMIN_ID): ResolvedPrincipal {
  return { provider: "api_key", kind: "user", id, tenant_id, roles: ["admin"] };
}
