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
    const rows = [
      { id: "c1", tenant_id: "t-A" },
      { id: "c2", tenant_id: "t-FOREIGN" },
    ];
    const result = enforceTenantMatch(rows, "t-A");
    expect(result.rejected).toBe(true);
    if (result.rejected) {
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
      expect([...result.foreign_tenant_ids].sort()).toEqual(["t-X", "t-Y"]);
    }
  });

  test("empty rows are accepted (no leak possible)", () => {
    const result = enforceTenantMatch([], "t-A");
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.rows).toEqual([]);
  });
});
