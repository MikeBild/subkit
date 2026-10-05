import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import {
  assignableRoles,
  permissionGroups,
  permissionLabel,
  personRefusal,
  roleChange,
  roleChangeNotes,
  roleLabel,
  roleName,
} from "@/pages/admin-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

describe("roles", () => {
  test("a built-in role is named", () => {
    expect(roleLabel("admin", de)).toEqual({ text: de("role.admin"), machine: false });
  });

  test("a role this build has no word for is shown as the machine value, not as unknown", () => {
    expect(roleLabel("auditor", de)).toEqual({ text: "auditor", machine: true });
    expect(roleLabel("auditor", de).text).not.toBe(de("common.unknown"));
  });
});

describe("permissions", () => {
  test("a known resource and action read as one phrase", () => {
    const label = permissionLabel("workflow:run", de);
    expect(label.machine).toBe(false);
    expect(label.text).toBe(
      de("permission.label", {
        resource: de("resource.workflows.title"),
        action: de("permission.action.run"),
      }),
    );
  });

  test("a half this build cannot name keeps the whole token", () => {
    expect(permissionLabel("workflow:frobnicate", de)).toEqual({
      text: "workflow:frobnicate",
      machine: true,
    });
    expect(permissionLabel("telemetry:read", de)).toEqual({
      text: "telemetry:read",
      machine: true,
    });
  });
});

const ENGINE_PERMISSIONS = (
  JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../engine/src/rbac/permissions.json"), "utf8"),
  ) as Array<{ name: string; resource_type: string }>
).map((entry) => entry.name);

describe("the engine's permission catalogue", () => {
  test("is read (a moved file must not turn this into a vacuous pass)", () => {
    expect(ENGINE_PERMISSIONS.length).toBeGreaterThan(50);
  });

  for (const locale of ["de", "en"] as const) {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate(locale, key, values);

    test(`every permission has a ${locale} name`, () => {
      const unnamed = ENGINE_PERMISSIONS.filter((name) => permissionLabel(name, t).machine);
      expect(unnamed).toEqual([]);
    });

    test(`no two permissions share a ${locale} name`, () => {
      const seen = new Map<string, string>();
      for (const name of ENGINE_PERMISSIONS) {
        const text = permissionLabel(name, t).text;
        expect(seen.get(text), `${name} reads like ${seen.get(text)}`).toBeUndefined();
        seen.set(text, name);
      }
    });

    test(`no ${locale} name is a word for unknown`, () => {
      for (const name of ENGINE_PERMISSIONS)
        expect(permissionLabel(name, t).text).not.toContain(t("common.unknown"));
    });
  }
});

describe("roles a person holds", () => {
  const roles = [
    { id: "r-admin", name: "admin", is_builtin: true },
    { id: "r-member", name: "member", is_builtin: true },
    { id: "r-enduser", name: "enduser", is_builtin: true },
    { id: "r-metrics", name: "metrics_scraper", is_builtin: true },
    { id: "r-portal", name: "portal_token_user", is_builtin: true },
    { id: "r-auditor", name: "Revision", is_builtin: false },
    { id: "r-analyst", name: "Analyst", is_builtin: false },
  ];

  test("a custom role is named by its own name, as prose", () => {
    expect(roleName("Revision", roles, de)).toEqual({ text: "Revision", machine: false });
  });

  test("a built-in role is named in the reader's language", () => {
    expect(roleName("admin", roles, de)).toEqual({ text: de("role.admin"), machine: false });
  });

  test("a role nobody defined stays the machine value", () => {
    expect(roleName("ghost", roles, de)).toEqual({ text: "ghost", machine: true });
  });

  test("a person may hold the person roles and every custom role — not machine roles", () => {
    expect(assignableRoles(roles).map((role) => role.name)).toEqual([
      "admin",
      "member",
      "enduser",
      "Analyst",
      "Revision",
    ]);
  });

  test("a role change says what is gained and what is lost", () => {
    expect(roleChange(["workflow:read", "workflow:run"], ["workflow:read", "rbac:write"])).toEqual({
      gained: ["rbac:write"],
      lost: ["workflow:run"],
    });
    expect(roleChange(["a"], ["a"])).toEqual({ gained: [], lost: [] });
  });
});

describe("what a role change says beyond its permissions", () => {
  test("leaving admin always says people and role management go with it", () => {
    expect(roleChangeNotes({ from: "admin", to: "Revision", isSelf: false })).toEqual([
      "leavesAdmin",
    ]);
    expect(roleChangeNotes({ from: "admin", to: "member", isSelf: true })).toEqual([
      "selfLeavesAdmin",
    ]);
    expect(roleChangeNotes({ from: "member", to: "Revision", isSelf: true })).toEqual(["self"]);
    expect(roleChangeNotes({ from: "member", to: "admin", isSelf: false })).toEqual([]);
  });

  test("a refusal says why — the last administrator in words", () => {
    expect(personRefusal({ code: "last_admin", message: "x" }, de)).toBe(
      de("people.refusal.lastAdmin"),
    );
    expect(personRefusal({ code: "teapot", message: "short and stout" }, de)).toBe(
      de("people.refusal.engine", { reason: "short and stout" }),
    );
    expect(personRefusal(null, de)).toBe(de("people.roleUpdateFailed"));
  });
});

describe("a role's permissions are read by area", () => {
  test("each area is one group, named once, holding only its actions", () => {
    const groups = permissionGroups(
      ["workflow:run", "connection:read", "workflow:read", "audit:read"],
      de,
    );
    expect(groups.map((group) => group.area.text)).toEqual(
      [de("nav.audit"), "Kontoverbindungen", de("resource.workflows.title")].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    const workflow = groups.find((group) => group.key === "workflow");
    expect(workflow?.items.map((item) => item.text)).toEqual([
      de("permission.action.read"),
      de("permission.action.run"),
    ]);
  });

  test("the old on-behalf label is gone from the vocabulary", () => {
    expect(permissionLabel("connection:read", de).text).not.toContain("in deinem Namen");
  });

  test("an unknown permission stays visible as itself", () => {
    const [group] = permissionGroups(["novel:thing"], de);
    expect(group?.items[0]).toEqual({ text: "novel:thing", machine: true });
  });
});
