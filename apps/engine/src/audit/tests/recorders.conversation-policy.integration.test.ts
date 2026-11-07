import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { queryAuditLog } from "../query.ts";
import { recordConversationSkillLoaded } from "../recorders/conversation.ts";
import {
  recordChatPaletteSurfaceEnforced,
  recordToolPolicyConfirmationRequired,
} from "../recorders/policy.ts";
import { fetchRow, tenantId, testDb, useRecorderDb } from "../recorders/recorders-fixtures.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../types.ts";

useRecorderDb();

const uuid = createDeterministicUuidFactory(0xc0de5);

describe("recordConversationSkillLoaded", () => {
  test("a first load is recorded as skill_loaded on the conversation by the acting user", async () => {
    const conversationId = uuid();
    const skillId = uuid();
    const userId = uuid();
    const entry = await recordConversationSkillLoaded({
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: userId,
      executor: testDb.db,
      conversation_id: conversationId,
      skill_id: skillId,
      skill_slug: "invoice-rules",
      skill_title: "Invoice rules",
      already_loaded: false,
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONVERSATION_SKILL_LOADED);
    expect(row?.resource_type).toBe("conversation");
    expect(row?.resource_id).toBe(conversationId);
    expect(row?.result).toBe("success");
    expect(row?.reason).toBe("skill_loaded");
    expect(row?.actor_type).toBe("user");
    expect(row?.actor_id).toBe(userId);
    expect(row?.metadata).toEqual({
      skill_id: skillId,
      skill_slug: "invoice-rules",
      skill_title: "Invoice rules",
      already_loaded: false,
    });
  });

  test("loading an already loaded skill is recorded as a re-promotion", async () => {
    const entry = await recordConversationSkillLoaded({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: uuid(),
      skill_id: uuid(),
      skill_slug: "invoice-rules",
      skill_title: "Invoice rules",
      already_loaded: true,
    });
    const row = await fetchRow(entry.id);
    expect(row?.reason).toBe("skill_re_promoted");
    expect(((row?.metadata ?? {}) as Record<string, unknown>).already_loaded).toBe(true);
    expect(row?.actor_type).toBe("system");
  });

  test("the row is invisible to another tenant", async () => {
    const conversationId = uuid();
    await recordConversationSkillLoaded({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: conversationId,
      skill_id: uuid(),
      skill_slug: "s",
      skill_title: "S",
      already_loaded: false,
    });
    const foreign = await queryAuditLog(testDb.db, {
      tenant_id: SYSTEM_TENANT_ID,
      conversation_id: conversationId,
    });
    expect(foreign.items).toEqual([]);
  });
});

describe("recordChatPaletteSurfaceEnforced", () => {
  test("records the read-only palette with the request source on the conversation", async () => {
    const conversationId = uuid();
    const entry = await recordChatPaletteSurfaceEnforced({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: conversationId,
      request_source: "mcp",
    });
    const row = await fetchRow(entry.id);
    expect(row?.action).toBe(AuditAction.CONVERSATION_PALETTE_SURFACE_ENFORCED);
    expect(row?.resource_type).toBe("conversation");
    expect(row?.resource_id).toBe(conversationId);
    expect(row?.result).toBe("success");
    expect(row?.reason).toBe("chat_provider_without_chat_surface");
    expect(row?.metadata).toEqual({
      conversation_id: conversationId,
      request_source: "mcp",
      palette: "chat_read_only",
    });
  });
});

describe("recordToolPolicyConfirmationRequired", () => {
  test("records a denial with the full policy decision and the environment when given", async () => {
    const conversationId = uuid();
    const entry = await recordToolPolicyConfirmationRequired({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: conversationId,
      tool: "delete_connector",
      mode: "confirm_before_execution",
      confirmation_kind: null,
      resolver_reason: null,
      environment: null,
    });
    const row = await fetchRow(entry.id);
    expect(row?.reason).toBe("confirm_before_execution");
    expect(row?.resource_type).toBe("conversation");
    expect(row?.resource_id).toBe(conversationId);
    expect(row?.metadata).toEqual({
      conversation_id: conversationId,
      tool: "delete_connector",
      mode: "confirm_before_execution",
      confirmation_kind: null,
      resolver_reason: null,
      environment: null,
    });
  });

  test("an omitted environment is left out of the metadata", async () => {
    const entry = await recordToolPolicyConfirmationRequired({
      tenant_id: tenantId,
      actor_id: null,
      executor: testDb.db,
      conversation_id: uuid(),
      tool: "run_workflow",
      mode: "confirm_before_execution",
      confirmation_kind: "run",
      resolver_reason: "tenant_policy",
    });
    const row = await fetchRow(entry.id);
    expect(row?.result).toBe("denied");
    expect("environment" in entry.metadata).toBe(false);
    expect("environment" in ((row?.metadata ?? {}) as Record<string, unknown>)).toBe(false);
    expect(((row?.metadata ?? {}) as Record<string, unknown>).confirmation_kind).toBe("run");
  });
});
