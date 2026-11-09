import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideUserChange } from "./user-change.ts";

test("absent and identical updates cause neither writes nor audit changes", () => {
  const current = { role_id: "admin", display_name: "Mike" };
  for (const command of [{}, { role_id: "admin" }, { display_name: "Mike" }, { ...current }])
    expect(decideUserChange(current, command)).toEqual({ kind: "unchanged" });
});

test("role and profile changes are independent and retain explicitly supplied unchanged fields", () => {
  const current = { role_id: "admin", display_name: "Mike" };
  expect(decideUserChange(current, { role_id: "member", display_name: "Mike" })).toEqual({
    kind: "apply",
    patch: { role_id: "member", display_name: "Mike" },
    role_changed: true,
    profile_changed: false,
    next_role_id: "member",
  });
  expect(decideUserChange(current, { display_name: null })).toEqual({
    kind: "apply",
    patch: { display_name: null },
    role_changed: false,
    profile_changed: true,
    next_role_id: "admin",
  });
  expect(decideUserChange({ role_id: "member", display_name: null }, { display_name: "" })).toEqual(
    {
      kind: "apply",
      patch: { display_name: "" },
      role_changed: false,
      profile_changed: true,
      next_role_id: "member",
    },
  );
  expect(decideUserChange(current, { role_id: "", display_name: "other" })).toEqual({
    kind: "apply",
    patch: { role_id: "", display_name: "other" },
    role_changed: true,
    profile_changed: true,
    next_role_id: "",
  });
});

test("decision is immutable and repeating its applied patch is a no-op", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.string(),
      fc.option(fc.string(), { nil: null }),
      (role, nextRole, name) => {
        const current = Object.freeze({ role_id: role, display_name: name });
        const command = Object.freeze({ role_id: nextRole, display_name: name });
        const snapshot = JSON.stringify({ current, command });
        const result = decideUserChange(current, command);
        if (result.kind === "apply") {
          expect(result.patch).not.toBe(command);
          expect(decideUserChange({ ...current, ...result.patch }, command)).toEqual({
            kind: "unchanged",
          });
        } else expect(nextRole).toBe(role);
        expect(JSON.stringify({ current, command })).toBe(snapshot);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
