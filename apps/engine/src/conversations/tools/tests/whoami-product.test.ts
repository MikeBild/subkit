import { describe, expect, test } from "bun:test";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { whoamiTool } from "../engine-api/identity.ts";
import type { ToolContext } from "../index.ts";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000a1";

function ctx(principal: ToolContext["principal"]): ToolContext {
  return {
    tenant_id: TENANT_ID,
    principal,
    engineClient: {
      context: { actor_id: ACTOR_ID },
      identity: { whoami: async () => ({ id: TENANT_ID, slug: "default" }) },
    },
  } as unknown as ToolContext;
}

describe("whoami tool product_id", () => {
  test("names the app a product principal signed in to", async () => {
    const result = await whoamiTool.execute(
      ctx({ ...adminPrincipal(TENANT_ID, ACTOR_ID), product_id: "app" }),
      {},
    );
    expect(result).toEqual({
      ok: true,
      data: { tenant: { id: TENANT_ID, slug: "default" }, actor_id: ACTOR_ID, product_id: "app" },
    });
  });

  test("is null for a caller without a product", async () => {
    const result = await whoamiTool.execute(ctx(adminPrincipal(TENANT_ID, ACTOR_ID)), {});
    expect((result as { data: { product_id: unknown } }).data.product_id).toBeNull();
  });

  test("is null without a principal", async () => {
    const result = await whoamiTool.execute(ctx(null), {});
    expect((result as { data: { product_id: unknown } }).data.product_id).toBeNull();
  });
});
