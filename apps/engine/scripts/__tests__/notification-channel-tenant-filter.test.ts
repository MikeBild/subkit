import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { auditTenantFilterFromText } from "../audit/tenant-filter-ast.ts";

test("notification channel queries expose their tenant predicates to the audit", () => {
  const source = readFileSync(
    new URL("../../src/notifications/admin/channels.ts", import.meta.url),
    "utf8",
  );
  expect(auditTenantFilterFromText(source)).toEqual([]);
});
