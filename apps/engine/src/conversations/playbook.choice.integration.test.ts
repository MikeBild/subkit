import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversationToolCalls } from "../db/schema/index.ts";
import { openedElicitation } from "../test-helpers/elicitations.ts";
import { createElicitation, resolveElicitation } from "./elicitations.ts";
import {
  PlaybookConflictError,
  readPlaybook,
  settlePlaybookAtTurnEnd,
  updatePlaybook,
} from "./playbook.ts";
import type { PlaybookScope } from "./playbook-evidence.ts";
import {
  actorId,
  call,
  fixture,
  plan,
  principal,
  scope,
  step,
  tenantId,
  timestamp,
  usePlaybookSetup,
} from "./playbook-fixtures.ts";
import { getConversation } from "./service/get.ts";

usePlaybookSetup();

describe("persisted playbook evidence and lifecycle", () => {
  describe("an answered choice advances its playbook step", () => {
    const question = "In welcher Umgebung soll der Ablauf laufen?";
    const nextLabel = "Gewünschte Betriebsumgebung fachlich festlegen";
    const options = [
      { value: "prod", label: "PROD-Betrieb" },
      { value: "dev", label: "DEV-Betrieb" },
    ];
    async function prepared(context: PlaybookScope) {
      await updatePlaybook(fixture.db, context, {
        expected_revision: 0,
        plan: plan([
          {
            ...step({ kind: "assessment", description: "Betriebsumgebung", result: null }),
            id: "target",
            progress: "waiting_for_input",
            next_action: { label: nextLabel, owner: "Betreiber", elicitation_id: null },
          },
        ]),
      });
    }
    async function choice(
      context: PlaybookScope,
      tool_name: "ask_user_choice" | "ask_user_confirm",
      playbook_step_id: string,
    ) {
      const toolCallId = await call(context, tool_name, {}, "pending");
      return createElicitation(
        {
          tenant_id: tenantId,
          conversation_id: context.conversation_id,
          tool_call_id: toolCallId,
          tool_name,
          summary: question,
          input:
            tool_name === "ask_user_choice"
              ? { question, options, playbook_step_id }
              : { question, playbook_step_id },
          actor_id: actorId,
          expires_at: timestamp(60_000),
        },
        fixture.db,
      ).then(openedElicitation);
    }
    async function answer(id: string, output: unknown) {
      return resolveElicitation(
        { tenant_id: tenantId, id, output, decided_by: { id: actorId, kind: "user" } },
        fixture.db,
      );
    }

    test("records the selected label, clears the next action, audits and finalizes the call", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "target");
      expect((await answer(decision.id, { value: "prod" })).kind).toBe("resolved");
      const view = await readPlaybook(fixture.db, context);
      expect(view?.revision).toBe(2);
      expect(view?.steps[0]?.next_action).toBeNull();
      expect(view?.steps[0]?.reason).toContain("PROD-Betrieb");
      expect(view?.steps[0]?.status).toBe("in_progress");
      expect(view?.next_action?.label ?? null).not.toBe(nextLabel);
      expect(view?.status).not.toBe("prepared");
      const audits = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.resource_id, context.conversation_id),
            eq(auditLog.reason, "playbook_decision_applied"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("conversation.updated");
      const [toolCall] = await fixture.db
        .select({ outcome: conversationToolCalls.outcome })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, tenantId),
            eq(conversationToolCalls.id, decision.tool_call_id ?? ""),
          ),
        );
      expect(toolCall?.outcome).toBe("ok");
      await expect(
        updatePlaybook(fixture.db, context, {
          expected_revision: 1,
          plan: plan([step({ kind: "assessment", description: "Neu", result: null })]),
        }),
      ).rejects.toBeInstanceOf(PlaybookConflictError);
      const detail = await getConversation(
        tenantId,
        context.conversation_id,
        fixture.db,
        principal,
      );
      const history = detail?.tool_calls.find((item) => item.id === decision.tool_call_id);
      expect(history?.outcome).toBe("ok");
      expect(history?.output).toMatchObject({ status: "resolved", elicitation_id: decision.id });
    });

    test("an unknown step leaves the playbook unchanged", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "missing");
      await answer(decision.id, { value: "prod" });
      const view = await readPlaybook(fixture.db, context);
      expect(view?.revision).toBe(1);
      expect(view?.steps[0]?.next_action?.label).toBe(nextLabel);
    });

    test("a confirmation answer leaves the playbook unchanged", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_confirm", "target");
      await answer(decision.id, { confirmed: true });
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
    });

    test("a cancelled choice finalizes the call as denied without touching the playbook", async () => {
      const context = await scope();
      await prepared(context);
      const decision = await choice(context, "ask_user_choice", "target");
      await resolveElicitation(
        {
          tenant_id: tenantId,
          id: decision.id,
          output: null,
          decided_by: { id: actorId, kind: "user" },
          status: "cancelled",
        },
        fixture.db,
      );
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
      const [toolCall] = await fixture.db
        .select({ outcome: conversationToolCalls.outcome })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, tenantId),
            eq(conversationToolCalls.id, decision.tool_call_id ?? ""),
          ),
        );
      expect(toolCall?.outcome).toBe("denied");
    });

    test("a choice in another conversation leaves this playbook unchanged", async () => {
      const context = await scope();
      const other = await scope();
      await prepared(context);
      await prepared(other);
      const decision = await choice(other, "ask_user_choice", "target");
      await answer(decision.id, { value: "prod" });
      expect((await readPlaybook(fixture.db, context))?.revision).toBe(1);
      expect((await readPlaybook(fixture.db, other))?.revision).toBe(2);
    });
  });
});

describe("a turn that ends", () => {
  test("leaves no step spinning: work in progress now waits for the user, audited once", async () => {
    const context = await scope();
    await updatePlaybook(fixture.db, context, {
      expected_revision: 0,
      plan: plan([
        {
          ...step({ kind: "resource_observed", resource: { type: "execution", id: actorId } }),
          progress: "in_progress",
        },
      ]),
    });
    expect((await readPlaybook(fixture.db, context))?.steps[0]?.status).toBe("in_progress");
    const settle = () =>
      settlePlaybookAtTurnEnd(fixture.db, {
        tenant_id: tenantId,
        conversation_id: context.conversation_id,
        actor: { actor_type: "user", actor_id: actorId },
        request_source: "ui",
      });
    expect(await settle()).toBe(2);
    const view = await readPlaybook(fixture.db, context);
    expect(view?.steps[0]?.status).toBe("waiting_for_input");
    expect(view?.revision).toBe(2);
    expect(await settle()).toBeNull();
    const audits = await fixture.db
      .select({ reason: auditLog.reason })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, context.conversation_id)),
      );
    expect(audits.filter((row) => row.reason === "playbook_turn_settled")).toHaveLength(1);
  });
});
