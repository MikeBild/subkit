import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../../audit/types.ts";
import { tenants } from "../../db/schema/index.ts";
import { can } from "../evaluator.ts";
import {
  claimOperatorTenantIfUnassigned,
  isOperatorPrincipal,
  OperatorTenantMissingError,
  operatorTenant,
  operatorTenantId,
  tenantIsOperator,
} from "../operator.ts";
import {
  AT,
  addTenant,
  setOperator,
  useAccessDb,
  userPrincipal,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("operator_principal", 20_261_111);

let operatorId: string;
let regularId: string;

const adminOf = (tenantId: string, extra = {}) =>
  userPrincipal(tenantId, "00000000-0000-4000-8000-0000000000ad", ["admin"], extra);

async function clearOperator(): Promise<void> {
  await h.db.update(tenants).set({ is_operator: false }).where(eq(tenants.is_operator, true));
}

beforeAll(async () => {
  operatorId = await addTenant(h, "op-main");
  regularId = await addTenant(h, "op-regular");
});

beforeEach(async () => {
  await clearOperator();
  await h.db.update(tenants).set({ deleted_at: null }).where(eq(tenants.id, operatorId));
  await setOperator(h, operatorId, true);
});

describe("tenantIsOperator", () => {
  test("only the flagged live tenant is the operator", async () => {
    expect(await tenantIsOperator(h.db, operatorId)).toBe(true);
    expect(await tenantIsOperator(h.db, regularId)).toBe(false);
    expect(await tenantIsOperator(h.db, h.nextId())).toBe(false);
  });

  test("a deleted operator tenant is no longer the operator", async () => {
    await h.db.update(tenants).set({ deleted_at: AT }).where(eq(tenants.id, operatorId));
    expect(await tenantIsOperator(h.db, operatorId)).toBe(false);
    expect(await operatorTenant(h.db)).toBeNull();
    expect(await operatorTenantId(h.db)).toBeNull();
  });
});

describe("operatorTenant", () => {
  test("returns the live operator tenant's id and slug", async () => {
    expect(await operatorTenant(h.db)).toEqual({ id: operatorId, slug: "op-main" });
    expect(await operatorTenantId(h.db)).toBe(operatorId);
  });

  test("returns nothing when no tenant is the operator", async () => {
    await clearOperator();
    expect(await operatorTenant(h.db)).toBeNull();
    expect(await operatorTenantId(h.db)).toBeNull();
  });
});

describe("isOperatorPrincipal", () => {
  test("a principal of the operator tenant is the operator, one of another tenant is not", async () => {
    expect(await isOperatorPrincipal(h.db, adminOf(operatorId))).toBe(true);
    expect(await isOperatorPrincipal(h.db, adminOf(regularId))).toBe(false);
  });

  test("a product caller in the operator tenant is never the operator", async () => {
    expect(await isOperatorPrincipal(h.db, adminOf(operatorId, { product_id: "prod-1" }))).toBe(
      false,
    );
  });

  test("a portal token in the operator tenant is never the operator", async () => {
    expect(await isOperatorPrincipal(h.db, adminOf(operatorId, { provider: "portal_token" }))).toBe(
      false,
    );
  });

  test("the system tenant is never the operator, even when flagged", async () => {
    await clearOperator();
    await h.db
      .insert(tenants)
      .values({ id: SYSTEM_TENANT_ID, slug: "system", display_name: "system", is_operator: true })
      .onConflictDoUpdate({ target: tenants.id, set: { is_operator: true } });
    try {
      expect(await tenantIsOperator(h.db, SYSTEM_TENANT_ID)).toBe(true);
      expect(await isOperatorPrincipal(h.db, adminOf(SYSTEM_TENANT_ID))).toBe(false);
    } finally {
      await setOperator(h, SYSTEM_TENANT_ID, false);
    }
  });

  test("the answer is remembered per principal object, a new object reads again", async () => {
    const principal = adminOf(operatorId);
    expect(await isOperatorPrincipal(h.db, principal)).toBe(true);
    await clearOperator();
    expect(await isOperatorPrincipal(h.db, principal)).toBe(true);
    expect(await isOperatorPrincipal(h.db, adminOf(operatorId))).toBe(false);
  });

  test("a failed lookup is not remembered", async () => {
    const principal = adminOf(operatorId);
    const failed = await h.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 / 0`).catch(() => undefined);
        return isOperatorPrincipal(tx, principal).then(
          () => "resolved",
          () => "rejected",
        );
      })
      .catch(() => "rejected");
    expect(failed).toBe("rejected");
    expect(await isOperatorPrincipal(h.db, principal)).toBe(true);
  });
});

describe("claimOperatorTenantIfUnassigned for the system tenant", () => {
  test("the system tenant can never claim the free operator slot", async () => {
    await clearOperator();
    await h.db
      .insert(tenants)
      .values({ id: SYSTEM_TENANT_ID, slug: "system", display_name: "system" })
      .onConflictDoNothing();
    const claimed = await h.db.transaction((tx) =>
      claimOperatorTenantIfUnassigned(tx, SYSTEM_TENANT_ID),
    );
    expect(claimed).toBe(false);
    expect(await tenantIsOperator(h.db, SYSTEM_TENANT_ID)).toBe(false);
    expect(await operatorTenant(h.db)).toBeNull();
  });
});

describe("OperatorTenantMissingError", () => {
  test("carries a stable error code", () => {
    const error = new OperatorTenantMissingError("tenant slug 'x' not found");
    expect(error.code).toBe("operator_tenant_missing");
    expect(error.message).toBe("tenant slug 'x' not found");
  });
});

describe("operator boundary in can()", () => {
  test("an admin outside the operator tenant is refused an operator-only permission", async () => {
    expect(
      await can(h.db, {
        tenant_id: regularId,
        principal: adminOf(regularId),
        permission: "metrics:read",
      }),
    ).toEqual({
      allow: false,
      reason: "operator_boundary:operator_only",
      source: "operator_boundary",
      detail: { required: "metrics:read", cause: "operator_only" },
    });
  });

  test("the boundary names the resource it refused", async () => {
    const resource = { type: "workflow", id: "a0000000-0000-4000-8000-00000000000a" };
    const decision = await can(h.db, {
      tenant_id: regularId,
      principal: adminOf(regularId),
      permission: "system:restart",
      resource,
      quiet: true,
    });
    expect(decision.detail).toEqual({
      required: "system:restart",
      resource,
      cause: "operator_only",
    });
  });

  test("an admin of the operator tenant holds an operator-only permission", async () => {
    expect(
      await can(h.db, {
        tenant_id: operatorId,
        principal: adminOf(operatorId),
        permission: "metrics:read",
      }),
    ).toEqual({ allow: true, source: "builtin_admin" });
  });

  test("losing the operator flag closes the boundary for new principals", async () => {
    await clearOperator();
    const decision = await can(h.db, {
      tenant_id: operatorId,
      principal: adminOf(operatorId),
      permission: "settings:write:global",
      quiet: true,
    });
    expect(decision.source).toBe("operator_boundary");
  });
});
