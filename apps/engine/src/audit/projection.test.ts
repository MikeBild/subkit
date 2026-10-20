import { expect, test } from "bun:test";
import { projectAuditEntry } from "./projection.ts";
import type { AuditEntry } from "./types.ts";

const entry: AuditEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  ts: new Date("2026-10-19T10:15:30.000Z"),
  tenant_id: "22222222-2222-4222-8222-222222222222",
  actor_type: "user",
  actor_id: "33333333-3333-4333-8333-333333333333",
  action: "knowledge_source.updated",
  resource_type: "knowledge_source",
  resource_id: "44444444-4444-4444-8444-444444444444",
  result: "success",
  trace_id: "trace-verified",
  ip: "private-ip-canary",
  user_agent: "private-agent-canary",
  before: { name: "Vertragsarchiv", password: "private-before-canary", status: "draft" },
  after: { name: "Vertragsarchiv", access_token: "private-after-canary", status: "active" },
  reason: "free text private-reason-canary",
  metadata: {
    request_source: "ui",
    audit_used_api_key_id: "55555555-5555-4555-8555-555555555555",
    audit_used_session_id: "66666666-6666-4666-8666-666666666666",
    audit_access_type: "api_key",
    audit_credential_origin: "cli_oauth_session",
    execution_id: "77777777-7777-4777-8777-777777777777",
    payload: "private-metadata-canary",
  },
};

test("audit read projection exposes only recorded safe evidence", () => {
  const projected = projectAuditEntry(entry);
  expect(projected.request_source).toBe("ui");
  expect(projected.api_key_id).toBe(entry.metadata.audit_used_api_key_id);
  expect(projected.session_id).toBe(entry.metadata.audit_used_session_id);
  expect(projected.access_type).toBe("api_key");
  expect(projected.credential_origin).toBe("cli_oauth_session");
  expect(projected.execution_id).toBe(entry.metadata.execution_id);
  expect(projected.resource_name).toBe("Vertragsarchiv");
  expect(projected.changed_fields).toEqual(["status"]);
  expect(projected.changes).toEqual([{ field: "status", before: "draft", after: "active" }]);
  expect(projected.before).toBeNull();
  expect(projected.after).toBeNull();
  expect(projected.ip).toBeNull();
  expect(projected.user_agent).toBeNull();
  expect(projected.reason).toBeNull();
  expect(projected.reason_redacted).toBe(true);
  const wire = JSON.stringify(projected);
  for (const privateValue of [
    "private-ip-canary",
    "private-agent-canary",
    "private-before-canary",
    "private-after-canary",
    "private-reason-canary",
    "private-metadata-canary",
  ]) {
    expect(wire).not.toContain(privateValue);
  }
});

test("known reason is retained and legacy credential metadata is not treated as proof", () => {
  const projected = projectAuditEntry({
    ...entry,
    reason: "manual_re_issue",
    metadata: { api_key_id: "55555555-5555-4555-8555-555555555555" },
  });
  expect(projected.reason).toBe("manual_re_issue");
  expect(projected.reason_redacted).toBe(false);
  expect(projected.api_key_id).toBeNull();
});

test("missing source and private directory names are not invented", () => {
  const projected = projectAuditEntry({
    ...entry,
    resource_type: "user",
    after: { email: "private-email-canary@example.test" },
    metadata: { request_source: "forged-channel", api_key_id: "not-a-uuid" },
  });
  expect(projected.resource_name).toBeNull();
  expect(projected.request_source).toBeNull();
  expect(projected.api_key_id).toBeNull();
  expect(projected.recorded_api_key_id).toBeNull();
  expect(JSON.stringify(projected)).not.toContain("private-email-canary");
});

test("historical credential IDs remain visible only as unverified recorded values", () => {
  const projected = projectAuditEntry({
    ...entry,
    metadata: {
      api_key_id: "55555555-5555-4555-8555-555555555555",
      session_id: "66666666-6666-4666-8666-666666666666",
    },
  });
  expect(projected.api_key_id).toBeNull();
  expect(projected.session_id).toBeNull();
  expect(projected.recorded_api_key_id).toBe("55555555-5555-4555-8555-555555555555");
  expect(projected.recorded_session_id).toBe("66666666-6666-4666-8666-666666666666");
});
