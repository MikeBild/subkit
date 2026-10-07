import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { can } from "../evaluator.ts";

const principal: ResolvedPrincipal = {
  provider: "oidc",
  kind: "user",
  id: "0d15a503-ce35-460b-a03c-3f0b15bb8be5",
  tenant_id: "83042bf9-f61d-4596-aab4-8495362eb37c",
  product_id: "harmoniqs",
  roles: ["admin"],
};

describe("product principal permission ceiling", () => {
  test("an admin role cannot grant a product caller operator permissions", async () => {
    for (const permission of ["audit:read", "workflow:write", "connector:read"]) {
      const decision = await can({} as Db, {
        tenant_id: principal.tenant_id,
        principal,
        permission,
      });
      expect(decision).toMatchObject({
        allow: false,
        reason: "credential_ceiling:product_permission_not_granted",
      });
    }
  });

  test("a product caller may pass the ceiling for workflow execution and own-run access", async () => {
    for (const permission of ["workflow:run", "execution:read", "execution:abort"]) {
      const decision = await can({} as Db, {
        tenant_id: principal.tenant_id,
        principal,
        permission,
      });
      expect(decision).toEqual({ allow: true, source: "builtin_admin" });
    }
  });
});
