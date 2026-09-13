import { describe, expect, test } from "bun:test";

import * as auditModule from "../audit.ts";

describe("audit module surface", () => {
  test("exports only writeAudit — no update or delete helpers", () => {
    const names = Object.keys(auditModule);
    // writeAudit is the only exported writer. `sql` is re-exported for
    // ergonomic reasons but is not an audit-mutation surface.
    expect(names).toContain("writeAudit");
    expect(names).not.toContain("updateAudit");
    expect(names).not.toContain("deleteAudit");
    expect(names).not.toContain("removeAudit");
    expect(names).not.toContain("purgeAudit");
  });

  test("writeAudit is a function", () => {
    expect(typeof auditModule.writeAudit).toBe("function");
  });

  test("no export name contains update/delete/remove/purge", () => {
    const names = Object.keys(auditModule);
    for (const name of names) {
      if (name === "sql") continue;
      expect(name.toLowerCase()).not.toMatch(/update|delete|remove|purge/);
    }
  });
});
