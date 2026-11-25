import { describe, expect, test } from "bun:test";
import {
  type ConversationAccessRow,
  type ConversationViewer,
  canDeleteConversation,
  canReadConversation,
  canSeeConversation,
  canWriteConversation,
  conversationAccessRowOf,
  conversationViewerOf,
  conversationWriteRefusal,
  moveConversationVisibility,
  visibilityTransitions,
} from "./access.ts";
import { ACCESS_CASES, OTHER_TENANT, OWNER } from "./access-fixtures.ts";

describe("conversation access table", () => {
  for (const c of ACCESS_CASES) {
    test(c.name, () => {
      expect(canReadConversation(c.viewer, c.row)).toBe(c.read);
      expect(canWriteConversation(c.viewer, c.row)).toBe(c.write);
      expect(canDeleteConversation(c.viewer, c.row)).toBe(c.delete);
      expect(canSeeConversation(c.viewer, c.row)).toBe(c.read || c.viewer.is_admin);
    });
  }

  test("a writer can always read, except the owner of a sealed task run (unchanged rule)", () => {
    for (const c of ACCESS_CASES)
      if (c.write && c.kind !== "sealedTaskRun") expect(c.read).toBe(true);
  });

  test("another tenant never gets anything", () => {
    const row: ConversationAccessRow = {
      tenant_id: "t1",
      owner_id: OTHER_TENANT.id,
      visibility: "team",
      task_run: null,
    };
    expect(canReadConversation(OTHER_TENANT, row)).toBe(false);
    expect(canDeleteConversation(OTHER_TENANT, row)).toBe(false);
    expect(canSeeConversation({ ...OTHER_TENANT, is_admin: true }, row)).toBe(false);
  });
});

describe("conversationWriteRefusal", () => {
  const privateRow: ConversationAccessRow = {
    tenant_id: "t1",
    owner_id: OWNER.id,
    visibility: "private",
    task_run: null,
  };
  const stranger: ConversationViewer = { id: "u2", tenant_id: "t1", is_admin: false };

  test("the owner may write", () => {
    expect(conversationWriteRefusal(OWNER, privateRow)).toBeNull();
  });

  test("a foreign private conversation is not found, so its existence stays hidden", () => {
    expect(conversationWriteRefusal(stranger, privateRow)).toBe("not_found");
    expect(conversationWriteRefusal({ ...stranger, is_admin: true }, privateRow)).toBe("not_found");
  });

  test("a shared conversation is read-only for others", () => {
    expect(conversationWriteRefusal(stranger, { ...privateRow, visibility: "team" })).toBe(
      "read_only",
    );
  });
});

describe("visibility state machine", () => {
  const row: ConversationAccessRow = {
    tenant_id: "t1",
    owner_id: OWNER.id,
    visibility: "private",
    task_run: null,
  };

  test("the transition table has exactly share and unshare", () => {
    expect(visibilityTransitions).toEqual({
      private: { share: "team" },
      team: { unshare: "private" },
    });
  });

  test("the owner shares a private conversation and takes it back", () => {
    expect(moveConversationVisibility(OWNER, row, "share")).toEqual({
      kind: "moved",
      visibility: "team",
    });
    expect(moveConversationVisibility(OWNER, { ...row, visibility: "team" }, "unshare")).toEqual({
      kind: "moved",
      visibility: "private",
    });
  });

  test("sharing twice or unsharing a private conversation is rejected as a value", () => {
    expect(moveConversationVisibility(OWNER, { ...row, visibility: "team" }, "share")).toEqual({
      kind: "rejected",
      reason: "already_shared",
    });
    expect(moveConversationVisibility(OWNER, row, "unshare")).toEqual({
      kind: "rejected",
      reason: "already_private",
    });
  });

  test("a stranger cannot see a private conversation, so sharing it is not found", () => {
    const admin: ConversationViewer = { id: "a1", tenant_id: "t1", is_admin: true };
    expect(moveConversationVisibility(admin, row, "share")).toEqual({
      kind: "rejected",
      reason: "not_found",
    });
  });

  test("a teammate reading a shared conversation still cannot unshare it", () => {
    const mate: ConversationViewer = { id: "u2", tenant_id: "t1", is_admin: false };
    expect(moveConversationVisibility(mate, { ...row, visibility: "team" }, "unshare")).toEqual({
      kind: "rejected",
      reason: "not_owner",
    });
  });

  test("a task-run conversation is never shared", () => {
    expect(
      moveConversationVisibility(OWNER, { ...row, task_run: { sealed: false } }, "share"),
    ).toEqual({ kind: "rejected", reason: "task_run" });
  });
});

describe("facts from rows and principals", () => {
  test("an admin role becomes is_admin", () => {
    expect(conversationViewerOf({ id: "u", tenant_id: "t", roles: ["admin"] }).is_admin).toBe(true);
    expect(conversationViewerOf({ id: "u", tenant_id: "t", roles: ["member"] }).is_admin).toBe(
      false,
    );
  });

  test("an unknown visibility falls back to private", () => {
    expect(
      conversationAccessRowOf({ tenant_id: "t", owner_id: null, visibility: "odd", draft: null })
        .visibility,
    ).toBe("private");
  });

  test("a task-run marker in the draft becomes task_run facts", () => {
    const sealed = conversationAccessRowOf({
      tenant_id: "t",
      owner_id: "u",
      visibility: "private",
      draft: { session: { task_run: "not-a-marker" } },
    });
    expect(sealed.task_run).toEqual({ sealed: true });
  });
});
