import { describe, expect, test } from "bun:test";
import {
  auditIdentityOptions,
  auditInitiatingSource,
  auditRecordedAccess,
  groupLoadedAudit,
  localDateTimeInput,
  type TimelineEntry,
  utcChoiceForInstant,
  utcChoicesForLocalInput,
  utcFromLocalInput,
  utcFromLocalInputPreservingInstant,
  validAuditCorrelationId,
} from "./audit-timeline-model";

function entry(id: string, ts: string, overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id,
    ts,
    tenant_id: "tenant-a",
    actor_type: "user",
    actor_id: "person-a",
    action: "knowledge_source.updated",
    resource_type: "knowledge_source",
    resource_id: "source-a",
    resource_name: "Vertragsarchiv",
    result: "success",
    trace_id: null,
    ip: null,
    user_agent: null,
    reason: null,
    metadata: {},
    ...overrides,
  } as TimelineEntry;
}

describe("Audit timeline groups", () => {
  test("keeps newest-first order and groups by local IANA day", () => {
    const rows = [
      entry("a", "2026-10-18T22:30:00.000Z"),
      entry("b", "2026-10-18T21:30:00.000Z"),
      entry("c", "2026-10-18T22:30:00.000Z"),
    ];
    const groups = groupLoadedAudit(rows, "day", "Europe/Berlin");
    expect(groups.map((group) => group.key)).toEqual(["2026-10-19", "2026-10-18"]);
    expect(groups[0]?.entries.map((row) => row.id)).toEqual(["c", "a"]);
  });

  test("does not conflate actor, API key and resource identifiers", () => {
    const rows = [
      entry("a", "2026-10-19T10:00:00.000Z", {
        actor_id: "person-a",
        api_key_id: "key-a",
        resource_id: "source-a",
      }),
      entry("b", "2026-10-19T09:00:00.000Z", {
        actor_id: "person-a",
        api_key_id: "key-b",
        resource_id: "source-b",
      }),
    ];
    expect(groupLoadedAudit(rows, "actor", "UTC")).toHaveLength(1);
    expect(groupLoadedAudit(rows, "access", "UTC")).toHaveLength(2);
    expect(groupLoadedAudit(rows, "resource", "UTC")).toHaveLength(2);
  });

  test("separates browser sessions, OAuth clients and verified access types", () => {
    const rows = [
      entry("a", "2026-10-19T13:00:00.000Z", { api_key_id: "shared-id", access_type: "api_key" }),
      entry("b", "2026-10-19T12:00:00.000Z", {
        session_id: "shared-id",
        access_type: "browser_session",
      }),
      entry("c", "2026-10-19T11:00:00.000Z", {
        oauth_client_id: "shared-id",
        access_type: "mcp_oauth",
      }),
      entry("d", "2026-10-19T10:00:00.000Z", { access_type: "external_bearer" }),
      entry("e", "2026-10-19T09:00:00.000Z", { access_type: "external_bearer" }),
      entry("f", "2026-10-19T08:00:00.000Z", { metadata: { access_type: "api_key" } }),
    ];
    expect(groupLoadedAudit(rows, "access", "UTC").map((group) => group.key)).toEqual([
      "api_key:shared-id",
      "session:shared-id",
      "oauth_client:shared-id",
      "access_type:external_bearer",
      "unknown",
    ]);
  });

  test("does not infer mutation origin from an untrusted recorded source", () => {
    expect(
      auditInitiatingSource(entry("a", "2026-10-19T09:00:00Z", { request_source: "cli" })),
    ).toBeNull();
    expect(
      auditInitiatingSource(entry("b", "2026-10-19T09:00:00Z", { origin_source: "mcp" })),
    ).toBe("mcp");
  });

  test("shows historical credential references only without a verified ID of the same kind", () => {
    expect(
      auditRecordedAccess(
        entry("a", "2026-10-19T09:00:00Z", {
          recorded_api_key_id: "legacy-key",
          recorded_session_id: "legacy-session",
        }),
      ),
    ).toEqual({ apiKeyId: "legacy-key", sessionId: "legacy-session" });
    expect(
      auditRecordedAccess(
        entry("b", "2026-10-19T09:00:00Z", {
          api_key_id: "verified-key",
          session_id: "verified-session",
          recorded_api_key_id: "legacy-key",
          recorded_session_id: "legacy-session",
        }),
      ),
    ).toEqual({ apiKeyId: null, sessionId: null });
  });

  test("groups trusted origin and recorded execution IDs without consulting free metadata", () => {
    const rows = [
      entry("a", "2026-10-19T10:00:00Z", {
        origin_source: "mcp",
        execution_id: "run-a",
        metadata: { execution_id: "forged" },
      }),
      entry("b", "2026-10-19T09:00:00Z", {
        origin_source: null,
        execution_id: null,
        metadata: { execution_id: "forged" },
      }),
    ];
    expect(groupLoadedAudit(rows, "source", "UTC").map((group) => group.key)).toEqual([
      "mcp",
      "unknown",
    ]);
    expect(groupLoadedAudit(rows, "execution", "UTC").map((group) => group.key)).toEqual([
      "run-a",
      "unknown",
    ]);
  });
});

describe("Audit time boundary", () => {
  test("converts an unambiguous Berlin local minute to exact UTC", () => {
    expect(utcFromLocalInput("2026-10-19T08:00", "Europe/Berlin")).toBe("2026-10-19T06:00:00.000Z");
  });

  test("rejects a skipped spring time", () => {
    expect(utcChoicesForLocalInput("2026-03-29T02:30", "Europe/Berlin")).toEqual([]);
    expect(utcFromLocalInput("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
  });

  test("requires an explicit offset for an ambiguous autumn time", () => {
    const choices = utcChoicesForLocalInput("2026-10-25T02:30", "Europe/Berlin");
    expect(choices).toEqual([
      { instant: "2026-10-25T00:30:00.000Z", offset: "UTC+02:00" },
      { instant: "2026-10-25T01:30:00.000Z", offset: "UTC+01:00" },
    ]);
    expect(utcFromLocalInput("2026-10-25T02:30", "Europe/Berlin")).toBeNull();
    expect(utcFromLocalInput("2026-10-25T02:30", "Europe/Berlin", choices[1]!.instant)).toBe(
      choices[1]!.instant,
    );
  });

  test("displays a known instant as a local input without seconds", () => {
    expect(localDateTimeInput("2026-10-19T06:00:42.321Z", "Europe/Berlin")).toBe(
      "2026-10-19T08:00",
    );
  });

  test("retains the linked exact instant until the visible minute changes", () => {
    const original = "2026-10-19T06:00:42.321Z";
    const choice = utcChoiceForInstant(original, "Europe/Berlin");
    expect(choice).toBe("2026-10-19T06:00:00.000Z");
    expect(
      utcFromLocalInputPreservingInstant("2026-10-19T08:00", "Europe/Berlin", choice, original),
    ).toBe(original);
    expect(
      utcFromLocalInputPreservingInstant("2026-10-19T08:01", "Europe/Berlin", "", original),
    ).toBe("2026-10-19T06:01:00.000Z");
  });

  test("retains the exact linked instant and offset across the autumn overlap", () => {
    const original = "2026-10-25T01:30:42.321Z";
    const choice = utcChoiceForInstant(original, "Europe/Berlin");
    expect(localDateTimeInput(original, "Europe/Berlin")).toBe("2026-10-25T02:30");
    expect(choice).toBe("2026-10-25T01:30:00.000Z");
    expect(
      utcFromLocalInputPreservingInstant("2026-10-25T02:30", "Europe/Berlin", choice, original),
    ).toBe(original);
    expect(
      utcFromLocalInputPreservingInstant(
        "2026-10-25T02:30",
        "Europe/Berlin",
        "2026-10-25T00:30:00.000Z",
        "",
      ),
    ).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("Audit operation filter", () => {
  test("accepts only the API's lowercase 32-character correlation ID format", () => {
    expect(validAuditCorrelationId("")).toBe(true);
    expect(validAuditCorrelationId("a".repeat(32))).toBe(true);
    expect(validAuditCorrelationId("A".repeat(32))).toBe(false);
    expect(validAuditCorrelationId("a".repeat(31))).toBe(false);
    expect(validAuditCorrelationId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
    expect(validAuditCorrelationId("g".repeat(32))).toBe(false);
  });
});

describe("auditIdentityOptions", () => {
  test("labels people by display_name, then email, then id", () => {
    expect(
      auditIdentityOptions(
        [
          { id: "u-1", email: "ada@example.com", display_name: "Ada Lovelace" },
          { id: "u-2", email: "grace@example.com", display_name: null },
          { id: "u-3", email: "", display_name: null },
        ],
        [{ id: "s-1", name: "Nightly bot" }],
      ),
    ).toEqual([
      { kind: "user", id: "u-1", label: "Ada Lovelace" },
      { kind: "user", id: "u-2", label: "grace@example.com" },
      { kind: "user", id: "u-3", label: "u-3" },
      { kind: "system_account", id: "s-1", label: "Nightly bot" },
    ]);
  });
});
