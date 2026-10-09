import { expect, test } from "bun:test";
import { approvalRequesterIdentity } from "./approval-portal.ts";

const tenant_id = "10000000-0000-4000-8000-000000000001";
const principal_id = "10000000-0000-4000-8000-000000000002";
const caller = {
  tenantId: tenant_id,
  principalId: principal_id,
  principalKind: "system_account",
  provider: "api_key",
  productId: null,
};

test("requester kind comes only from the persisted matching caller snapshot", () => {
  expect(approvalRequesterIdentity({ tenant_id, principal_id, caller_context: caller })).toEqual({
    kind: "system_account",
    id: principal_id,
  });
  expect(
    approvalRequesterIdentity({
      tenant_id,
      principal_id,
      caller_context: { ...caller, principalKind: "user" },
    }),
  ).toEqual({ kind: "user", id: principal_id });
});

test("missing, malformed and mismatched requester provenance stays unknown", () => {
  for (const caller_context of [
    null,
    {},
    { ...caller, tenantId: principal_id },
    { ...caller, principalId: tenant_id },
    { ...caller, principalKind: "admin" },
  ]) {
    expect(approvalRequesterIdentity({ tenant_id, principal_id, caller_context })).toBeNull();
  }
});
