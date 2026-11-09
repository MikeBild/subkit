import { expect, test } from "bun:test";
import fc from "fast-check";
import { evaluateResourceAccess, type ResourceAccessFacts } from "./evaluator.ts";

const facts: ResourceAccessFacts = {
  portal_token: false,
  permission: "workflow:read",
  resource_type: "workflow",
  granted_ids: [],
};

test("hard denials cannot be overcome by tenant-wide flags, grants or portal allowlists", () => {
  for (const source of ["credential_ceiling", "operator_boundary"] as const) {
    const tenantWide = { allow: true, source };
    const result = evaluateResourceAccess(tenantWide, {
      ...facts,
      portal_token: true,
      granted_ids: ["a"],
      workflow_allowlist: "all",
    });
    expect(result.tenantWide).toBe(tenantWide);
    expect(result.any).toBe(false);
    expect(result.allows("a")).toBe(false);
  }
});

test("tenant-wide grants retain resource-specific ceilings and existing any semantics", () => {
  for (const resource_type of ["workflow", "connector", "other"]) {
    const access = evaluateResourceAccess(
      { allow: true },
      { ...facts, resource_type, workflow_allowlist: ["w"], connector_allowlist: ["c"] },
    );
    expect(access.any).toBe(true);
    expect(access.allows("w")).toBe(resource_type !== "connector");
    expect(access.allows("c")).toBe(resource_type !== "workflow");
  }
  expect(evaluateResourceAccess({ allow: true }, { ...facts, workflow_allowlist: [] }).any).toBe(
    true,
  );
  expect(evaluateResourceAccess({ allow: true }, facts).allows("any")).toBe(true);
  expect(
    evaluateResourceAccess({ allow: true }, { ...facts, workflow_allowlist: "all" }).allows("any"),
  ).toBe(true);
  expect(
    evaluateResourceAccess(
      { allow: true },
      { ...facts, portal_token: true, workflow_allowlist: [] },
    ).allows("any"),
  ).toBe(true);
});

test("resource grants cannot exceed a credential ceiling", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string()),
      fc.array(fc.string()),
      fc.string(),
      (granted, ceiling, id) => {
        const input = Object.freeze({
          ...facts,
          granted_ids: Object.freeze(granted),
          workflow_allowlist: Object.freeze(ceiling),
        });
        const result = evaluateResourceAccess({ allow: false }, input);
        expect(result.allows(id)).toBe(granted.includes(id) && ceiling.includes(id));
        expect(result.any).toBe(granted.length > 0);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});

test("portal workflow reachability is limited to read/run and a nonempty workflow allowlist", () => {
  for (const permission of ["workflow:read", "workflow:run", "workflow:write"]) {
    for (const resource_type of ["workflow", "connector"]) {
      const allowlists: ReadonlyArray<ResourceAccessFacts["workflow_allowlist"]> = [
        undefined,
        [],
        ["a"],
        "all",
      ];
      for (const workflow_allowlist of allowlists) {
        const result = evaluateResourceAccess(
          { allow: false },
          {
            ...facts,
            portal_token: true,
            permission,
            resource_type,
            ...(workflow_allowlist !== undefined ? { workflow_allowlist } : {}),
          },
        );
        const expected =
          permission !== "workflow:write" &&
          resource_type === "workflow" &&
          (workflow_allowlist === "all" || workflow_allowlist?.includes("a") === true);
        expect(result.any).toBe(expected);
        expect(result.allows("a")).toBe(expected);
      }
    }
  }
});
