import { describe, expect, test } from "bun:test";
import {
  activityTone,
  canAddToWorkspace,
  canOnItem,
  createBody,
  deleteConsequenceKey,
  draftProblems,
  emptyDraft,
  emptyKey,
  groupByKind,
  hasHandle,
  itemsInScope,
  itemsMatching,
  lastUsedLabel,
  REVEAL_SECONDS,
  revealedRows,
  revealState,
  rotateBody,
  type VaultDraft,
  type VaultItem,
  valueProblem,
  vaultErrorKey,
  vaultFieldLabel,
  vaultHandle,
  vaultHandles,
  vaultNameError,
  vaultNameProblem,
  withoutValues,
} from "@/features/vault/model/vault";
import { CATALOGS } from "@/lib/i18n";

function item(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "crm-token",
    kind: "secret",
    scope: "workspace",
    environment: "prod",
    description: null,
    version: 1,
    connector: null,
    template_slug: null,
    fields: ["token"],
    metadata: {},
    origins: [],
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-01T08:00:00.000Z",
    rotated_at: null,
    last_used_at: null,
    ...overrides,
  };
}

function draft(overrides: Partial<VaultDraft> = {}): VaultDraft {
  return { ...emptyDraft(true), name: "crm-token", token: "t0k", ...overrides };
}

describe("vault names", () => {
  test("follow the handle grammar, trimmed, and keep me for personal handles", () => {
    expect(vaultNameProblem("crm-token")).toBeNull();
    expect(vaultNameProblem("  crm_token2 ")).toBeNull();
    expect(vaultNameProblem("0")).toBeNull();
    expect(vaultNameProblem("a".repeat(63))).toBeNull();
    expect(vaultNameProblem("")).toBe("empty");
    expect(vaultNameProblem("   ")).toBe("empty");
    expect(vaultNameProblem("me")).toBe("reserved");
    expect(vaultNameProblem("a".repeat(64))).toBe("invalid");
    expect(vaultNameProblem("CRM")).toBe("invalid");
    expect(vaultNameProblem("-crm")).toBe("invalid");
    expect(vaultNameProblem("crm.token")).toBe("invalid");
  });

  test("map each problem to a message that names the next step", () => {
    expect(vaultNameError("crm-token")).toBeNull();
    expect(vaultNameError("")).toBe("vault.name.empty");
    expect(vaultNameError("me")).toBe("vault.name.reserved");
    expect(vaultNameError("Crm Token")).toBe("vault.name.invalid");
    expect(CATALOGS.de["vault.name.reserved"]).toContain("Wähle einen anderen Namen");
  });
});

describe("handles", () => {
  test("a workspace item, a personal item and the fields of a login", () => {
    expect(vaultHandle(item())).toBe(`\${secret.crm-token}`);
    expect(vaultHandle(item({ scope: "person" }))).toBe(`\${secret.me.crm-token}`);
    expect(vaultHandle(item({ name: "erp" }), "password")).toBe(`\${secret.erp.password}`);
    expect(vaultHandles(item())).toEqual([{ field: null, handle: `\${secret.crm-token}` }]);
    expect(vaultHandles(item({ kind: "login", name: "erp", scope: "person" }))).toEqual([
      { field: "username", handle: `\${secret.me.erp.username}` },
      { field: "password", handle: `\${secret.me.erp.password}` },
    ]);
  });

  test("known fields carry a label and unknown ones keep their key", () => {
    expect(vaultFieldLabel("token")).toBe("vault.field.token");
    expect(vaultFieldLabel("client_id")).toBeNull();
    expect(revealedRows({ username: "mira", client_id: "abc" })).toEqual([
      { field: "username", label: "vault.field.username", value: "mira" },
      { field: "client_id", label: null, value: "abc" },
    ]);
  });
});

describe("the list", () => {
  const items = [
    item({ id: "1", name: "zeta", environment: "prod" }),
    item({ id: "2", name: "zeta", environment: "dev" }),
    item({ id: "3", name: "alpha" }),
    item({ id: "4", name: "erp", kind: "login", scope: "person" }),
    item({
      id: "5",
      name: "hubspot",
      kind: "connector",
      connector: { id: "c1", slug: "hubspot", display_name: "HubSpot" },
    }),
    item({ id: "6", name: "google", kind: "template_client", template_slug: "google" }),
  ];

  test("filters by scope", () => {
    expect(itemsInScope(items, "person").map((entry) => entry.id)).toEqual(["4"]);
    expect(itemsInScope(items, "workspace")).toHaveLength(5);
  });

  test("search matches name, description, connector and template, ignoring case and spaces", () => {
    const described = [...items, item({ id: "7", name: "mail", description: "SMTP Relay" })];
    const ids = (search: string) => itemsMatching(described, search).map((entry) => entry.id);
    expect(ids("")).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(ids("  ")).toHaveLength(7);
    expect(ids(" ZETA ")).toEqual(["1", "2"]);
    expect(ids("relay")).toEqual(["7"]);
    expect(ids("hubSpot")).toEqual(["5"]);
    expect(ids("goog")).toEqual(["6"]);
    expect(ids("nothing")).toEqual([]);
  });

  test("groups by kind in a fixed order, sorted by name and environment, without empty groups", () => {
    const groups = groupByKind(itemsInScope(items, "workspace"));
    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ["secret", "vault.kind.secret"],
      ["connector", "vault.kind.connector"],
      ["template_client", "vault.kind.template_client"],
    ]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["3", "2", "1"]);
    expect(groupByKind([])).toEqual([]);
  });

  test("names the last use, or says it was never used", () => {
    expect(lastUsedLabel(item())).toEqual({ key: "vault.neverUsed", at: null });
    expect(lastUsedLabel(item({ last_used_at: "2026-11-20T08:00:00.000Z" }))).toEqual({
      key: "vault.lastUsed",
      at: "2026-11-20T08:00:00.000Z",
    });
    expect(CATALOGS.de["vault.neverUsed"]).toBe("Noch nie genutzt");
  });

  test("the empty state says what to do for each view", () => {
    expect(emptyKey("workspace", 0, true)).toBe("vault.empty.body");
    expect(emptyKey("person", 3, false)).toBe("vault.empty.person");
    expect(emptyKey("workspace", 3, true)).toBe("vault.empty.workspace");
    expect(emptyKey("workspace", 3, false)).toBe("vault.empty.workspaceReadOnly");
  });
});

describe("who may do what", () => {
  test("own items are always manageable, but only secrets and logins take a new value", () => {
    const own = item({ scope: "person" });
    for (const action of ["read", "write", "rotate", "delete", "reveal"] as const)
      expect(canOnItem(own, action, [])).toBe(true);
    expect(canOnItem(item({ scope: "person", kind: "connector" }), "rotate", [])).toBe(false);
  });

  test("shared items follow the vault rights", () => {
    expect(canOnItem(item(), "reveal", [])).toBe(false);
    expect(canOnItem(item(), "reveal", ["vault:reveal"])).toBe(true);
    expect(canOnItem(item(), "rotate", ["vault:rotate"])).toBe(true);
    expect(canOnItem(item(), "delete", ["vault:read"])).toBe(false);
    expect(canOnItem(item({ kind: "login" }), "write", ["vault:write"])).toBe(true);
    expect(canOnItem(item({ kind: "template_client" }), "write", ["vault:write"])).toBe(false);
    expect(canOnItem(item({ kind: "connector" }), "delete", ["vault:delete"])).toBe(true);
  });

  test("a shared entry needs the write right, a personal one does not", () => {
    expect(canAddToWorkspace(["vault:write"])).toBe(true);
    expect(canAddToWorkspace(["vault:read"])).toBe(false);
    expect(emptyDraft(true).scope).toBe("workspace");
    expect(emptyDraft(false).scope).toBe("person");
  });
});

describe("the add and replace forms", () => {
  test("check the name and the values of the chosen kind", () => {
    expect(draftProblems(draft())).toEqual({ name: null, value: null });
    expect(draftProblems(draft({ name: "me", token: "" }))).toEqual({
      name: "vault.name.reserved",
      value: "vault.value.missingToken",
    });
    expect(valueProblem({ kind: "login", token: "", username: " ", password: "pw" })).toBe(
      "vault.value.missingLogin",
    );
    expect(valueProblem({ kind: "login", token: "", username: "mira", password: "" })).toBe(
      "vault.value.missingLogin",
    );
    expect(valueProblem({ kind: "login", token: "", username: "mira", password: "pw" })).toBeNull();
  });

  test("send only the fields of the kind, trimmed, without an empty description", () => {
    expect(createBody(draft({ name: " crm-token ", description: "  " }))).toEqual({
      kind: "secret",
      name: "crm-token",
      scope: "workspace",
      environment: "prod",
      token: "t0k",
    });
    expect(
      createBody(
        draft({
          kind: "login",
          name: "erp",
          scope: "person",
          environment: "dev",
          description: " ERP ",
          username: " mira ",
          password: " pw ",
        }),
      ),
    ).toEqual({
      kind: "login",
      name: "erp",
      scope: "person",
      environment: "dev",
      description: "ERP",
      username: "mira",
      password: " pw ",
    });
    expect(rotateBody({ kind: "secret", token: "new", username: "x", password: "y" })).toEqual({
      token: "new",
    });
    expect(rotateBody({ kind: "login", token: "x", username: " mira ", password: "pw" })).toEqual({
      username: "mira",
      password: "pw",
    });
  });

  test("forget the values and keep the rest", () => {
    expect(withoutValues(draft({ username: "mira", password: "pw" }))).toEqual(
      draft({ token: "", username: "", password: "" }),
    );
  });
});

describe("reveal timer", () => {
  const at = 1_000_000;
  test("shows the values for thirty seconds, then hides them again", () => {
    expect(REVEAL_SECONDS).toBe(30);
    expect(revealState(null, at)).toEqual({ visible: false, secondsLeft: 0 });
    expect(revealState(at, at)).toEqual({ visible: true, secondsLeft: 30 });
    expect(revealState(at, at + 500)).toEqual({ visible: true, secondsLeft: 30 });
    expect(revealState(at, at + 29_001)).toEqual({ visible: true, secondsLeft: 1 });
    expect(revealState(at, at + 30_000)).toEqual({ visible: false, secondsLeft: 0 });
    expect(revealState(at, at + 45_000)).toEqual({ visible: false, secondsLeft: 0 });
    expect(revealState(at, at - 5_000)).toEqual({ visible: true, secondsLeft: 30 });
    expect(revealState(at, at + 4_000, 5)).toEqual({ visible: true, secondsLeft: 1 });
  });
});

describe("errors", () => {
  test("each answer of the engine names its next step", () => {
    expect(vaultErrorKey({ status: 403, code: "forbidden" })).toBe("vault.error.forbidden");
    expect(vaultErrorKey({ status: 404, code: "not_found" })).toBe("vault.error.notFound");
    expect(vaultErrorKey({ status: 409, code: "vault_item_exists" })).toBe("vault.error.exists");
    expect(vaultErrorKey({ code: "vault_item_exists" })).toBe("vault.error.exists");
    expect(vaultErrorKey({ status: 422, code: "vault_item_unreadable" })).toBe(
      "vault.error.unreadable",
    );
    expect(vaultErrorKey({ code: "vault_item_unreadable" }, "login")).toBe(
      "vault.error.unreadable",
    );
    expect(vaultErrorKey({ status: 422 }, "connector")).toBe("vault.error.unreadableConnector");
    expect(vaultErrorKey({ status: 422 }, "template_client")).toBe(
      "vault.error.unreadableTemplate",
    );
    expect(vaultErrorKey({ status: 400, code: "bad_request" })).toBe("vault.error.invalid");
    expect(vaultErrorKey({ status: 500 })).toBe("vault.error.generic");
    expect(vaultErrorKey(new Error("offline"))).toBe("vault.error.generic");
    expect(vaultErrorKey(null)).toBe("vault.error.generic");
    expect(vaultErrorKey("nope")).toBe("vault.error.generic");
    expect(CATALOGS.de["vault.error.unreadable"]).toStartWith(
      "Dieser Eintrag lässt sich mit dem aktuellen Schlüssel nicht öffnen",
    );
  });
});

describe("connector and template items", () => {
  test("have no handle, and deleting them names what really breaks", () => {
    expect(hasHandle("secret")).toBe(true);
    expect(hasHandle("login")).toBe(true);
    expect(hasHandle("connector")).toBe(false);
    expect(hasHandle("template_client")).toBe(false);
    expect(deleteConsequenceKey("secret")).toBe("vault.delete.consequence");
    expect(deleteConsequenceKey("login")).toBe("vault.delete.consequence");
    expect(deleteConsequenceKey("connector")).toBe("vault.delete.connectorConsequence");
    expect(deleteConsequenceKey("template_client")).toBe("vault.delete.templateConsequence");
  });
});

describe("activity", () => {
  test("marks what was denied or failed", () => {
    expect(activityTone("success")).toBe("ok");
    expect(activityTone("denied")).toBe("warn");
    expect(activityTone("error")).toBe("error");
    expect(activityTone("other")).toBe("neutral");
  });
});
