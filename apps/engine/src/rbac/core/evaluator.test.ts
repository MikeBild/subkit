import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  credentialCeilingCause,
  deriveConnectorAccessLevel,
  evaluatePermission,
  matchesPortalTokenAllowlist,
  type PermissionFacts,
  type PermissionRequest,
} from "./evaluator.ts";

const request: PermissionRequest = { permission: "workflow:run", portal_token: false };
const facts: PermissionFacts = {
  operator_allowed: true,
  builtin_admin: false,
  permission_known: true,
  resource_grant: false,
  group_grant: false,
  role_grant: false,
};

test("ceiling and operator boundaries outrank every allow source", () => {
  expect(
    evaluatePermission(request, {
      ...facts,
      credential_ceiling_cause: "scope_not_granted",
      builtin_admin: true,
      role_grant: true,
    }).source,
  ).toBe("credential_ceiling");
  expect(
    evaluatePermission(request, {
      ...facts,
      operator_allowed: false,
      builtin_admin: true,
      role_grant: true,
    }).source,
  ).toBe("operator_boundary");
});

test("evaluates grants in resource, group, role and portal precedence order", () => {
  expect(
    evaluatePermission(request, {
      ...facts,
      resource_grant: true,
      group_grant: true,
      role_grant: true,
    }).source,
  ).toBe("resource_grant");
  expect(
    evaluatePermission(request, { ...facts, group_grant: true, role_grant: true }).source,
  ).toBe("group");
  expect(evaluatePermission(request, { ...facts, role_grant: true }).source).toBe("role");
  expect(
    evaluatePermission(
      {
        ...request,
        portal_token: true,
        resource: { type: "workflow", id: "w" },
        portal_workflow_allowlist: ["w"],
      },
      facts,
    ).source,
  ).toBe("portal_token_allowlist");
});

test("derives connector access without mutating decisions", () => {
  const read = { allow: true };
  const write = { allow: false };
  expect(deriveConnectorAccessLevel(read, write)).toBe("read-only");
  expect(read).toEqual({ allow: true });
});

test("keeps the unknown-permission decision shape free of deny detail", () => {
  expect(evaluatePermission(request, { ...facts, permission_known: false })).toEqual({
    allow: false,
    reason: "permission_unknown:workflow:run",
  });
});

test("attaches resource denial detail for a known non-portal permission", () => {
  expect(
    evaluatePermission({ ...request, resource: { type: "workflow", id: "w" } }, facts),
  ).toMatchObject({
    allow: false,
    reason: "permission_denied:workflow:run",
    detail: { resource: { type: "workflow", id: "w" }, cause: "no_matching_grant" },
  });
});

test("covers every credential ceiling without letting lower grants override it", () => {
  for (const [facts, cause] of [
    [
      { product_limited: true, product_permission_allowed: false },
      "product_permission_not_granted",
    ],
    [{ scope_limited: true, scope_allows_permission: false }, "scope_not_granted"],
    [{ connector_allowlist: ["other"] }, "connector_not_in_allowlist"],
    [{ workflow_allowlist: ["other"] }, "workflow_not_in_allowlist"],
  ] as const) {
    const scoped = facts.connector_allowlist
      ? { ...request, resource: { type: "connector", id: "wanted" } }
      : facts.workflow_allowlist
        ? { ...request, resource: { type: "workflow", id: "wanted" } }
        : request;
    expect(
      credentialCeilingCause(scoped, {
        product_limited: false,
        product_permission_allowed: true,
        scope_limited: false,
        scope_allows_permission: true,
        ...facts,
      }),
    ).toBe(cause);
  }
});

test("portal allowlists distinguish workflow resources and conversation grants", () => {
  const portal = (
    permission: string,
    allow: readonly string[] | "all",
    resource?: { type: string; id: string },
  ) =>
    evaluatePermission(
      {
        permission,
        portal_token: true,
        portal_workflow_allowlist: allow,
        ...(resource ? { resource } : {}),
      },
      facts,
    );
  expect(portal("workflow:run", [], { type: "workflow", id: "w" }).allow).toBe(false);
  expect(portal("workflow:run", "all", { type: "connector", id: "w" }).allow).toBe(false);
  expect(portal("workflow:run", ["w"], { type: "workflow", id: "w" }).allow).toBe(true);
  expect(portal("conversation:read", [], undefined).allow).toBe(false);
  expect(portal("conversation:write", ["w"], undefined).allow).toBe(true);
  expect(portal("unknown:read", "all", undefined).allow).toBe(false);
});

test("grant precedence and connector projection are total and immutable", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (resource, group, role) => {
      const result = evaluatePermission(request, {
        ...facts,
        resource_grant: resource,
        group_grant: group,
        role_grant: role,
      });
      expect(result.source).toBe(
        resource ? "resource_grant" : group ? "group" : role ? "role" : undefined,
      );
    }),
    { seed: 20261109, numRuns: 32 },
  );
  expect(deriveConnectorAccessLevel({ allow: false }, { allow: false })).toBe("none");
  expect(deriveConnectorAccessLevel({ allow: true }, { allow: true })).toBe("read-write");
});

test("conversation portal permissions require a nonempty workflow allowlist", () => {
  for (const permission of ["conversation:read", "conversation:write", "conversation:cancel"]) {
    for (const allowlist of [[], ["workflow"], "all"] as const) {
      const req = { permission, portal_token: true, portal_workflow_allowlist: allowlist };
      const expected = allowlist === "all" || allowlist.length > 0;
      expect(matchesPortalTokenAllowlist(req)).toBe(expected);
      expect(evaluatePermission(req, facts).allow).toBe(expected);
    }
    expect(matchesPortalTokenAllowlist({ permission, portal_token: true })).toBe(false);
    expect(
      matchesPortalTokenAllowlist({
        permission,
        portal_token: false,
        portal_workflow_allowlist: ["workflow"],
      }),
    ).toBe(false);
  }
  expect(
    matchesPortalTokenAllowlist({
      permission: "conversation:delete",
      portal_token: true,
      portal_workflow_allowlist: ["workflow"],
    }),
  ).toBe(false);
});

test("credentials within their explicit ceilings are not rejected", () => {
  const ceiling = {
    product_limited: true,
    product_permission_allowed: true,
    scope_limited: true,
    scope_allows_permission: true,
  };
  expect(credentialCeilingCause(request, ceiling)).toBeNull();
  for (const type of ["connector", "workflow"]) {
    const scoped = { permission: "workflow:read", resource: { type, id: "allowed" } };
    expect(credentialCeilingCause(scoped, ceiling)).toBeNull();
    expect(
      credentialCeilingCause(scoped, {
        ...ceiling,
        connector_allowlist: "all",
        workflow_allowlist: "all",
      }),
    ).toBeNull();
    expect(
      credentialCeilingCause(scoped, {
        ...ceiling,
        connector_allowlist: ["allowed"],
        workflow_allowlist: ["allowed"],
      }),
    ).toBeNull();
  }
});
