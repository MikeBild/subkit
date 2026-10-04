import type { ResolvedPrincipal } from "../auth/types.ts";

export const TEST_ADMIN_ID = "00000000-0000-4000-8000-0000000000ad";

export function adminPrincipal(tenant_id: string, id: string = TEST_ADMIN_ID): ResolvedPrincipal {
  return { provider: "api_key", kind: "user", id, tenant_id, roles: ["admin"] };
}
