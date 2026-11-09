import { expect, test } from "bun:test";
import { parseIssueAdminKeyArgs } from "./issue-admin-key.ts";

test("issue-admin-key CLI parser keeps the default tenant and honors an explicit tenant", () => {
  expect(parseIssueAdminKeyArgs([])).toEqual({ tenantSlug: "default" });
  expect(parseIssueAdminKeyArgs(["--tenant", "acme"])).toEqual({ tenantSlug: "acme" });
  expect(parseIssueAdminKeyArgs(["--tenant", "first", "--tenant", "last"])).toEqual({
    tenantSlug: "last",
  });
});
