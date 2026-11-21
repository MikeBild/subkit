import { expect, test } from "bun:test";
import {
  AUDIT_AREAS,
  auditAreaParams,
  auditCorrelationFromUrl,
  auditCountKey,
  auditFilterFromUrl,
  auditLinkParams,
  auditResultFromUrl,
  auditScopeParams,
  auditTraceFromUrl,
  initialAuditFilter,
  isAuditScope,
  normalizedAuditScope,
} from "./audit-filter.ts";

test("audit areas publish the complete stable resource vocabulary", () => {
  expect(AUDIT_AREAS).toEqual({
    all: [],
    runs: ["execution", "execution_step"],
    workflows: [
      "workflow",
      "workflow_version",
      "workflow_execution_authority",
      "workflow_schedule",
    ],
    connectors: ["connector", "credential", "connection"],
    knowledge: ["knowledge_source", "knowledge_source_version", "skill", "skill_candidate"],
    files: ["file"],
    conversations: ["conversation", "conversation_elicitation"],
    tasks: ["task", "task_run", "task_grant"],
    people: [
      "user",
      "user_identity",
      "group",
      "role",
      "resource_grant",
      "api_key",
      "system_account",
      "mcp_oauth_client",
    ],
  });
  expect(auditAreaParams("runs")).toEqual({ resource_types: "execution,execution_step" });
  expect(auditAreaParams("workflows")).toEqual({
    resource_types: "workflow,workflow_version,workflow_execution_authority,workflow_schedule",
  });
  expect(auditAreaParams("connectors")).toEqual({
    resource_types: "connector,credential,connection",
  });
  expect(auditAreaParams("knowledge")).toEqual({
    resource_types: "knowledge_source,knowledge_source_version,skill,skill_candidate",
  });
  expect(auditAreaParams("files")).toEqual({ resource_types: "file" });
  expect(auditAreaParams("conversations")).toEqual({
    resource_types: "conversation,conversation_elicitation",
  });
  expect(auditAreaParams("people")).toEqual({
    resource_types:
      "user,user_identity,group,role,resource_grant,api_key,system_account,mcp_oauth_client",
  });
});

test("audit filter scopes preserve their only permitted server constraints", () => {
  expect(isAuditScope("all")).toBe(true);
  expect(isAuditScope("other")).toBe(false);
  expect(auditScopeParams("decisions").action).toContain("approval.granted");
  expect(auditScopeParams("operations")).toEqual({ actor_type: "system" });
  expect(auditScopeParams("all")).toEqual({});
  expect(normalizedAuditScope("decisions", "approval.granted,unknown.action", "")).toBe("all");
  expect(normalizedAuditScope("operations", "", "person")).toBe("all");
  expect(normalizedAuditScope("decisions", "approval.granted", "")).toBe("decisions");
});

test("audit filter distinguishes an implicit default window from linked and explicit windows", () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const defaultFilter = initialAuditFilter("", now);
  expect(auditCountKey("", defaultFilter, 1, false)).toBe("audit.countWindow.one");
  expect(auditCountKey("", defaultFilter, 2, true)).toBe("audit.countWindowMore");
  expect(auditCountKey("", defaultFilter, 2, false)).toBe("audit.countWindow");
  const explicit = auditFilterFromUrl("?ts_from=2026-11-01T00:00:00Z");
  expect(auditCountKey("?ts_from=2026-11-01T00:00:00Z", explicit, 1, false)).toBe(
    "audit.count.one",
  );
  const linked = auditFilterFromUrl("?trace_id=trace-1");
  expect(auditCountKey("?trace_id=trace-1", linked, 2, true)).toBe("audit.countMore");
  expect(auditAreaParams("all")).toEqual({});
  expect(auditAreaParams("people").resource_types).toContain("mcp_oauth_client");
});

test("audit links emit only present filter fields and accept only catalog results", () => {
  expect(auditResultFromUrl("?result=success")).toBe("success");
  expect(auditResultFromUrl("?result=unknown")).toBeNull();
  expect(
    auditLinkParams({
      resourceType: "workflow",
      resourceId: "workflow-1",
      traceId: "trace-1",
      scope: "operations",
      actions: ["workflow.created"],
      tsFrom: "2026-11-01T00:00:00.000Z",
      tsTo: "2026-11-02T00:00:00.000Z",
    }),
  ).toEqual({
    resource_type: "workflow",
    resource_id: "workflow-1",
    trace_id: "trace-1",
    action: "workflow.created",
    ts_from: "2026-11-01T00:00:00.000Z",
    ts_to: "2026-11-02T00:00:00.000Z",
  });
});

test("audit URL boundaries reject whitespace, overlong tokens, malformed instants, and partial identifiers", () => {
  const at128 = "a".repeat(128);
  const at129 = "a".repeat(129);
  expect(auditFilterFromUrl(`?resource_type=%20workflow%20&resource_id=${at128}`)).toMatchObject({
    resourceType: "workflow",
    resourceId: at128,
  });
  const invalid = [
    `?resource_type=${at129}`,
    "?resource_type=workflow%2Funsafe",
    "?resource_type=workflow&resource_id=%20",
    "?ts_from=2026-11-09T12:00:00Zsuffix",
    "?ts_from=2026-11-09",
    "?ts_from=%2B002026-01-01T00%3A00Z",
    "?ts_from=2026-01-01T00%3A00Z%00",
    "?ts_from=2026-11-09T12:00:00%2B1:00",
    "?ts_from=2026-11-09T12:00:00Z&ts_to=2026-99-99T12:00:00Z",
    "?trace_id=trace%20id",
    `?trace_id=${at129}`,
  ];
  for (const query of invalid) {
    const parsed = auditFilterFromUrl(query);
    if (query.includes("resource_type=") && !query.includes("resource_id"))
      expect(parsed.resourceType).toBeNull();
    if (query.includes("ts_from") && !query.includes("ts_to")) expect(parsed.tsFrom).toBeNull();
    if (query.includes("trace_id")) expect(parsed.traceId).toBeNull();
  }
  expect(auditFilterFromUrl("?ts_from=2026-11-09T12:00:00.1%2B01:30").tsFrom).toBe(
    "2026-11-09T10:30:00.100Z",
  );
  expect(auditFilterFromUrl(`?trace_id=${at128}`).traceId).toBe(at128);
  expect(auditFilterFromUrl(`?correlation_id=${"a".repeat(32)}x`).traceId).toBeNull();
  expect(auditFilterFromUrl("?ts_from=%202026-11-09T12:00Z%20").tsFrom).toBe(
    "2026-11-09T12:00:00.000Z",
  );
  expect(auditFilterFromUrl("?ts_from=2026-11-09T12:00Z").tsFrom).toBe("2026-11-09T12:00:00.000Z");
  expect(auditFilterFromUrl("?ts_from=2026-11-09T12:00:00.12Z").tsFrom).toBe(
    "2026-11-09T12:00:00.120Z",
  );
});

test("audit actions retain only bounded normalized tokens and scopes stay isolated", () => {
  expect(isAuditScope("decisions")).toBe(true);
  expect(isAuditScope("operations")).toBe(true);
  expect(normalizedAuditScope("all", "unknown.action", "person")).toBe("all");
  expect(normalizedAuditScope("operations", "", "system")).toBe("operations");
  const actions = Array.from({ length: 33 }, (_, index) => `event_${index}`);
  const filter = auditFilterFromUrl(
    `?action=%20plain%20,${actions.join(",")},${"a".repeat(97)},bad..path`,
  );
  expect(filter.actions).toEqual(["plain", ...actions].slice(0, 32));
  expect(auditFilterFromUrl("?action=plain").actions).toEqual(["plain"]);
  expect(auditResultFromUrl("?result=")).toBeNull();
  expect(auditResultFromUrl("")).toBeNull();
  expect(auditFilterFromUrl("")).toMatchObject({ resourceType: null, actions: [] });
  expect(auditFilterFromUrl("").actions).toEqual([]);
  expect(auditTraceFromUrl("?trace_id=%20trace%20")).toBe("trace");
  expect(auditTraceFromUrl("?trace_id=trace%2Funsafe")).toBeNull();
  expect(auditCorrelationFromUrl(`?correlation_id=${"a".repeat(32)}`)).toBe("a".repeat(32));
  expect(auditCorrelationFromUrl(`?correlation_id=x${"a".repeat(32)}`)).toBeNull();
  expect(auditCorrelationFromUrl(`?correlation_id=${"a".repeat(32)}x`)).toBeNull();
  expect(normalizedAuditScope("all", "", "person")).toBe("all");
});

test("audit links retain exact delimiters, action limits, and each non-default count boundary", () => {
  expect(auditScopeParams("decisions")).toEqual({
    action:
      "patch_candidate.approved,patch_candidate.rejected,skill_candidate.approved,skill_candidate.rejected,approval.granted,approval.approved,approval.rejected,approval.declined,workflow.authority_granted,workflow.authority_revoked,workflow.authority_expiry_removed,task.authority_granted,task.authority_revoked,policy.denied,approval.dispatch_denied,execution.boundary_refused,rbac.role_created,rbac.role_deleted,rbac.permission_granted,rbac.permission_revoked,rbac.user_role_assigned,rbac.user_role_revoked,user.created,user.deleted,user.role_changed,api_key.issued,api_key.revoked,workflow.deleted,workflow.version_restored,knowledge_source.restored,schedule.created,schedule.deleted,connector.deleted,secret.version_created,secret.version_revoked,settings.changed",
  });
  expect(normalizedAuditScope("decisions", "", "")).toBe("decisions");
  expect(normalizedAuditScope("operations", "", "")).toBe("operations");
  expect(normalizedAuditScope("operations", "unrecognized.action", "system")).toBe("operations");
  expect(normalizedAuditScope("decisions", "", "person")).toBe("decisions");
  const at96 = `a.${"b".repeat(94)}`;
  expect(auditFilterFromUrl(`?action=,${at96},${"a".repeat(97)}`).actions).toEqual([at96]);

  const defaultFilter = initialAuditFilter("", Date.parse("2026-11-09T12:00:00.000Z"));
  const linked = { ...defaultFilter, resourceId: "workflow-1" };
  expect(auditCountKey("", linked, 2, false)).toBe("audit.count");
  expect(auditCountKey("", { ...defaultFilter, tsTo: "2026-11-10T00:00:00.000Z" }, 2, false)).toBe(
    "audit.count",
  );
  expect(auditCountKey("?ts_to=", defaultFilter, 2, false)).toBe("audit.count");
  expect(auditCountKey("", { ...defaultFilter, traceId: "trace-1" }, 2, false)).toBe("audit.count");
  expect(auditCountKey(`?correlation_id=${"a".repeat(32)}`, defaultFilter, 2, false)).toBe(
    "audit.count",
  );
});
