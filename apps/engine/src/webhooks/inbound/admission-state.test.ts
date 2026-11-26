import { describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { holdInboundAdmission } from "./admission-state.ts";

describe("inbound admission state", () => {
  test("a failed admission record is logged and never fails the delivery", async () => {
    const unavailable = {
      transaction: () => Promise.reject(new Error("database unavailable")),
    } as unknown as Db;
    await expect(
      holdInboundAdmission(
        unavailable,
        { tenant_id: "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b", id: "hook", workflow_id: "wf" },
        0,
        "execution_authority_required",
      ),
    ).resolves.toBeUndefined();
  });
});
