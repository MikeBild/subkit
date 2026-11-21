import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  authorizationContextFromPrincipal,
  ExecutionAuthorizationContextSchema,
  rehydrateExecutionPrincipal,
} from "../authorization-context.ts";
import { callerFromPrincipal } from "../caller-context.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const INSTALLATION = "44444444-4444-4444-8444-444444444444";

const runner: ResolvedPrincipal = {
  provider: "device_runner",
  kind: "user",
  id: USER,
  tenant_id: TENANT,
  roles: ["member"],
  auth_source: { kind: "device_runner", device_id: DEVICE, installation_id: INSTALLATION },
};

const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be read for a runner credential");
    },
  },
) as Db;

describe("a device runner credential never carries execution authority", () => {
  test("the recorded source shape is known to the schema", () => {
    expect(
      ExecutionAuthorizationContextSchema.safeParse({
        source: { kind: "device_runner", device_id: DEVICE, installation_id: INSTALLATION },
      }).success,
    ).toBe(true);
  });

  test("capturing a runner principal for a queued run is refused", () => {
    expect(() => authorizationContextFromPrincipal(runner)).toThrow(
      expect.objectContaining({ code: "execution_authentication_unavailable" }),
    );
  });

  test("a recorded runner source is refused before any lookup", async () => {
    const caller = callerFromPrincipal(runner, TENANT);
    await expect(
      rehydrateExecutionPrincipal(untouchedDb, caller, {
        source: { kind: "device_runner", device_id: DEVICE, installation_id: INSTALLATION },
      }),
    ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  });
});
