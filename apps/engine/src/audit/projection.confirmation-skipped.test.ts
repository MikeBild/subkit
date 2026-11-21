import { describe, expect, test } from "bun:test";
import { projectAuditEntry } from "./projection.ts";
import { AuditAction, type AuditEntry } from "./types.ts";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const AUTHORITY = "44444444-4444-4444-8444-444444444444";
const JOB = "66666666-6666-4666-8666-666666666666";

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ts: new Date("2026-11-19T10:15:30.000Z"),
    tenant_id: "22222222-2222-4222-8222-222222222222",
    actor_type: "user",
    actor_id: "55555555-5555-4555-8555-555555555555",
    action: AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
    resource_type: "conversation",
    resource_id: CONVERSATION,
    result: "success",
    trace_id: "trace",
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason: "authority_covered",
    metadata: {
      tool: "run_workflow",
      conversation_id: CONVERSATION,
      environment: "prod",
      resolver_reason: "authority_covered",
      covering_authority_id: AUTHORITY,
      input: { recipient: "private-recipient-canary" },
    },
    ...overrides,
  };
}

describe("audit projection of a skipped confirmation", () => {
  test("shows the tool, the environment, why it was skipped and the covering approval", () => {
    const projected = projectAuditEntry(entry());
    expect(projected.details).toEqual({
      tool: "run_workflow",
      environment: "prod",
      resolver_reason: "authority_covered",
      covering_authority_id: AUTHORITY,
    });
    expect(projected.reason).toBe("authority_covered");
    expect(JSON.stringify(projected)).not.toContain("private-recipient-canary");
  });

  test("a step that ran inside a job shows the job it belonged to", () => {
    const projected = projectAuditEntry(
      entry({
        reason: "user_instruction",
        metadata: { tool: "call_connector", resolver_reason: "user_instruction", job_id: JOB },
      }),
    );
    expect(projected.details).toEqual({
      tool: "call_connector",
      resolver_reason: "user_instruction",
      job_id: JOB,
    });
    expect(projected.reason).toBe("user_instruction");
  });

  test("a job id that is not an id stays hidden", () => {
    for (const job_id of ["job-1", "run_2026", 42, null]) {
      const projected = projectAuditEntry(entry({ metadata: { tool: "call_connector", job_id } }));
      expect(projected.details).toEqual({ tool: "call_connector" });
    }
  });

  test("an unknown reason and unlisted metadata stay hidden", () => {
    const projected = projectAuditEntry(
      entry({ reason: "private-reason-canary", metadata: { tool: "run_workflow", note: "x" } }),
    );
    expect(projected.details).toEqual({ tool: "run_workflow" });
    expect(projected.reason).toBeNull();
  });
});
