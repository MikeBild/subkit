// R9-C1 unit test: pins the contract that a heterogeneous `rows`
// batch (some rows match, others don't) is rejected wholesale, not
// partially leaked. The integration test in `sk-bootstrap.test.ts`
// can't exercise this path because the SQL `WHERE tenant_id = ...`
// filter is correct — the helper exists to defend against a future
// refactor that drops that filter, so the test must drive the
// helper directly with synthetic rows.

import { describe, expect, test } from "bun:test";
import { enforceTenantMatch } from "../routes/identity/sk-bootstrap.ts";

describe("enforceTenantMatch (R9-C1 defensive guard)", () => {
  test("accepts the batch when every row matches", () => {
    const rows = [
      { id: "c1", tenant_id: "t-A" },
      { id: "c2", tenant_id: "t-A" },
    ];
    const result = enforceTenantMatch(rows, "t-A");
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.rows).toEqual(rows);
    }
  });

  test("rejects the WHOLE batch when row 0 matches but row N doesn't", () => {
    // The exact failure mode the previous loop+break+post-check missed.
    const rows = [
      { id: "c1", tenant_id: "t-A" },
      { id: "c2", tenant_id: "t-FOREIGN" },
    ];
    const result = enforceTenantMatch(rows, "t-A");
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.rows).toEqual([]);
      expect(result.foreign_tenant_ids).toEqual(["t-FOREIGN"]);
    }
  });

  test("rejects the WHOLE batch when row 0 itself doesn't match", () => {
    const rows = [
      { id: "c1", tenant_id: "t-FOREIGN" },
      { id: "c2", tenant_id: "t-A" },
    ];
    const result = enforceTenantMatch(rows, "t-A");
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.rows).toEqual([]);
      expect(result.foreign_tenant_ids).toEqual(["t-FOREIGN"]);
    }
  });

  test("dedups foreign tenant_ids in the rejection log", () => {
    const rows = [
      { id: "c1", tenant_id: "t-X" },
      { id: "c2", tenant_id: "t-Y" },
      { id: "c3", tenant_id: "t-X" },
    ];
    const result = enforceTenantMatch(rows, "t-A");
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.foreign_tenant_ids.sort()).toEqual(["t-X", "t-Y"]);
    }
  });

  test("empty rows are accepted (no leak possible)", () => {
    const result = enforceTenantMatch([], "t-A");
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.rows).toEqual([]);
  });
});
