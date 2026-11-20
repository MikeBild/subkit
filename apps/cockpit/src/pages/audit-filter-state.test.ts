import { expect, test } from "bun:test";
import {
  ACCESS_TYPES,
  auditFilterFromSearch,
  EMPTY,
  SOURCES,
  validUrlUuid,
} from "./audit-filter-state";

const now = Date.parse("2026-11-08T12:00:00Z");
const id = "11111111-2222-3333-4444-555555555555";

test("a fresh audit filter takes its time and timezone explicitly", () => {
  const filter = auditFilterFromSearch("", now, "UTC");
  expect(filter.fromInstant).toBe("2026-10-09T12:00:00.000Z");
  expect(filter.from).toBe("2026-10-09T12:00");
  expect(filter.to).toBe("");
  expect(filter.scope).toBe("all");
  expect(auditFilterFromSearch("", now, "Europe/Berlin").from).toBe("2026-10-09T14:00");
});

test("deep links preserve independent identity and resource filters", () => {
  const search = new URLSearchParams({
    resource_type: "workflow",
    resource_id: id,
    actor_type: "user",
    actor_id: id,
    api_key_id: id,
    session_id: id,
    execution_id: id,
    conversation_id: id,
    workflow_id: id,
    task_id: id,
    task_run_id: id,
    access_type: "api_key",
    oauth_client_id: "client_a.b:c-1",
    origin_source: "cli",
    execution_source: "queue",
    result: "denied",
    ts_from: "2026-11-01T00:00:00Z",
    ts_to: "2026-11-02T01:00:00Z",
  });
  const filter = auditFilterFromSearch(`?${search}`, now, "UTC");
  expect(filter).toMatchObject({
    resourceType: "workflow",
    resourceId: id,
    resourceQuery: id,
    actorType: "user",
    actorId: id,
    apiKeyId: id,
    sessionId: id,
    executionId: id,
    conversationId: id,
    workflowId: id,
    taskId: id,
    taskRunId: id,
    accessType: "api_key",
    oauthClientId: "client_a.b:c-1",
    originSource: "cli",
    executionSource: "queue",
    result: "denied",
    from: "2026-11-01T00:00",
    to: "2026-11-02T01:00",
  });
});

test("untrusted URL enums and identifiers cannot become query filters", () => {
  const filter = auditFilterFromSearch(
    "?actor_type=administrator&actor_id=invalid&api_key_id=x&session_id=x&execution_id=x&conversation_id=x&workflow_id=x&task_id=x&task_run_id=x&access_type=other&origin_source=other&execution_source=other&oauth_client_id=%3Cscript%3E&result=other",
    now,
    "UTC",
  );
  for (const key of [
    "actorType",
    "actorId",
    "apiKeyId",
    "sessionId",
    "executionId",
    "conversationId",
    "workflowId",
    "taskId",
    "taskRunId",
    "accessType",
    "originSource",
    "executionSource",
    "oauthClientId",
    "result",
  ] as const)
    expect(filter[key]).toBe("");
  expect(validUrlUuid(null)).toBe("");
  expect(validUrlUuid("")).toBe("");
  expect(validUrlUuid(id.toUpperCase())).toBe(id.toUpperCase());
  expect(validUrlUuid(`${id}x`)).toBe("");
});

test("all supported access, source, actor and result alternatives round-trip", () => {
  expect(ACCESS_TYPES).toEqual([
    "api_key",
    "browser_session",
    "mcp_oauth",
    "token_exchange",
    "external_bearer",
    "task_run",
    "portal_token",
  ]);
  for (const access of ACCESS_TYPES)
    expect(auditFilterFromSearch(`?access_type=${access}`, now, "UTC").accessType).toBe(access);
  for (const source of SOURCES) {
    const filter = auditFilterFromSearch(
      `?origin_source=${source}&execution_source=${source}`,
      now,
      "UTC",
    );
    expect(filter.originSource).toBe(source);
    expect(filter.executionSource).toBe(source);
  }
  for (const actor of ["user", "system_account", "system", "unknown"])
    expect(auditFilterFromSearch(`?actor_type=${actor}`, now, "UTC").actorType).toBe(actor);
  for (const result of ["success", "denied", "error"])
    expect(auditFilterFromSearch(`?result=${result}`, now, "UTC").result).toBe(result);
});

test("reset clears every persisted filter and restores the all-events scope", () => {
  expect(EMPTY).toEqual({
    scope: "all",
    resourceType: "",
    resourceId: "",
    resourceQuery: "",
    actorType: "",
    actorId: "",
    apiKeyId: "",
    sessionId: "",
    accessType: "",
    oauthClientId: "",
    originSource: "",
    executionSource: "",
    executionId: "",
    conversationId: "",
    workflowId: "",
    taskId: "",
    taskRunId: "",
    result: "",
    action: "",
    traceId: "",
    correlationId: "",
    from: "",
    to: "",
    fromChoice: "",
    toChoice: "",
    fromInstant: "",
    toInstant: "",
  });
  expect(auditFilterFromSearch("", now, "UTC")).toEqual({
    ...EMPTY,
    from: "2026-10-09T12:00",
    fromChoice: "2026-10-09T12:00:00.000Z",
    fromInstant: "2026-10-09T12:00:00.000Z",
  });
});

test("the source selector offers the complete public source vocabulary", () => {
  const supported = [
    "ui",
    "chat",
    "cli",
    "mcp",
    "api",
    "webhook",
    "scheduler",
    "tool-chain",
    "queue",
  ] as const;
  expect(SOURCES).toEqual(supported);
  for (const source of supported) {
    expect(
      auditFilterFromSearch(`?origin_source=${source}&execution_source=${source}`, now, "UTC"),
    ).toMatchObject({ originSource: source, executionSource: source });
  }
});

test("identifiers must match the entire URL value", () => {
  expect(validUrlUuid(`x${id}`)).toBe("");
  for (const client of ["!valid", "valid!", "a".repeat(129)]) {
    expect(
      auditFilterFromSearch(`?oauth_client_id=${encodeURIComponent(client)}`, now, "UTC")
        .oauthClientId,
    ).toBe("");
  }
  const correlation = "abcdef0123456789abcdef0123456789";
  const linked = auditFilterFromSearch(`?trace_id=${id}&correlation_id=${correlation}`, now, "UTC");
  expect(linked.traceId).toBe(id);
  expect(linked.fromInstant).toBe("");
  expect(linked.correlationId).toBe(correlation);
});

test("multiple linked actions retain their comma separator", () => {
  expect(
    auditFilterFromSearch("?action=workflow.created,workflow.updated", now, "UTC").action,
  ).toBe("workflow.created,workflow.updated");
});
