import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { scrubAuditEntry } from "../scrub.ts";
import type { AuditEntry } from "../types.ts";

const KEY_ID = "33333333-3333-4333-8333-333333333333";
const PAT = "dop_v1_scrubtestabcdefabcdefabcdefabcdefabcdef";

type EntryOverrides = { [K in keyof AuditEntry]?: AuditEntry[K] | undefined };

function entry(overrides: EntryOverrides = {}): AuditEntry {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    ts: new Date(FROZEN_NOW),
    tenant_id: "55555555-5555-4555-8555-555555555555",
    actor_type: "system",
    actor_id: null,
    action: "tenant.created",
    resource_type: "tenant",
    resource_id: null,
    result: "success",
    trace_id: "",
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason: null,
    metadata: {},
    ...overrides,
  } as AuditEntry;
}

const jsonArb = fc.jsonValue({ maxDepth: 4 });
const nulStringArb = fc
  .tuple(fc.string(), fc.string())
  .map(([left, right]) => `${left}\u0000${right}`);

describe("scrubAuditEntry", () => {
  test("secrets inside arrays and nested objects of metadata are redacted", () => {
    const out = scrubAuditEntry(
      entry({
        metadata: {
          list: [{ password: "hunter2-secret" }, `Bearer ${PAT}`],
          deep: { a: { b: { api_key: "plain-key-value" } } },
        },
      }),
    );
    const blob = JSON.stringify(out.metadata);
    expect(blob).not.toContain("hunter2-secret");
    expect(blob).not.toContain(PAT);
    expect(blob).not.toContain("plain-key-value");
    expect(Array.isArray(out.metadata.list)).toBe(true);
  });

  test("NUL bytes in every free-text field become a replacement character", () => {
    const out = scrubAuditEntry(
      entry({
        resource_id: "file\u0000.txt",
        user_agent: "agent\u0000x",
        reason: "why\u0000not",
        metadata: {
          "k\u0000ey": ["a\u0000b", { inner: "c\u0000d" }],
          n: 3,
          flag: true,
          none: null,
        },
        before: { name: "old\u0000" },
        after: { names: ["new\u0000"] },
      }),
    );
    expect(out.resource_id).toBe("file�.txt");
    expect(out.user_agent).toBe("agent�x");
    expect(out.reason).toBe("why�not");
    expect(out.metadata).toEqual({
      "k�ey": ["a�b", { inner: "c�d" }],
      n: 3,
      flag: true,
      none: null,
    });
    expect(out.before).toEqual({ name: "old�" });
    expect(out.after).toEqual({ names: ["new�"] });
  });

  test("missing free-text fields stay null", () => {
    const out = scrubAuditEntry(
      entry({
        resource_id: undefined,
        user_agent: undefined,
        before: undefined,
        after: undefined,
        reason: undefined,
        metadata: undefined,
      }),
    );
    expect(out.resource_id).toBeNull();
    expect(out.user_agent).toBeNull();
    expect(out.before).toBeNull();
    expect(out.after).toBeNull();
    expect(out.reason).toBeNull();
    expect(out.metadata).toEqual({});
  });

  test("a UUID credential id survives the key-name redaction and a non-UUID one does not", () => {
    const kept = scrubAuditEntry(
      entry({ metadata: { api_key_id: KEY_ID, audit_used_api_key_id: KEY_ID } }),
    );
    expect(kept.metadata.api_key_id).toBe(KEY_ID);
    expect(kept.metadata.audit_used_api_key_id).toBe(KEY_ID);
    const dropped = scrubAuditEntry(
      entry({ metadata: { api_key_id: PAT, audit_used_api_key_id: PAT } }),
    );
    expect(JSON.stringify(dropped.metadata)).not.toContain(PAT);
  });

  test("a credential id that only contains a UUID is not restored", () => {
    for (const value of [`x${KEY_ID}`, `${KEY_ID}x`]) {
      const out = scrubAuditEntry(
        entry({ metadata: { api_key_id: value, audit_used_api_key_id: value } }),
      );
      expect(out.metadata.api_key_id).not.toEqual(value);
      expect(out.metadata.audit_used_api_key_id).not.toEqual(value);
    }
  });

  test("only the exact cli_oauth_session credential origin is restored", () => {
    const exact = scrubAuditEntry(
      entry({ metadata: { audit_credential_origin: "cli_oauth_session" } }),
    );
    expect(exact.metadata.audit_credential_origin).toBe("cli_oauth_session");
    const other = scrubAuditEntry(entry({ metadata: { audit_credential_origin: "browser" } }));
    expect(other.metadata.audit_credential_origin).not.toBe("cli_oauth_session");
  });

  test("snapshots keep prose under prompt-shaped keys while metadata does not", () => {
    const out = scrubAuditEntry(
      entry({ metadata: { prompt: "draft the reply" }, after: { prompt: "draft the reply" } }),
    );
    expect(out.after).toEqual({ prompt: "draft the reply" });
    expect(out.metadata.prompt).not.toBe("draft the reply");
  });

  test("the scrubbed entry never contains a NUL byte", () => {
    fc.assert(
      fc.property(jsonArb, nulStringArb, (value, text) => {
        const out = scrubAuditEntry(
          entry({
            reason: text,
            resource_id: text,
            user_agent: text,
            metadata: { value, text, [text]: value },
            before: { value, text },
            after: [value, text] as unknown as AuditEntry["after"],
          }),
        );
        expect(JSON.stringify(out)).not.toContain("\\u0000");
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("scrubbing twice gives the same entry as scrubbing once", () => {
    fc.assert(
      fc.property(jsonArb, fc.string(), (value, text) => {
        const once = scrubAuditEntry(
          entry({ reason: text, metadata: { value }, before: { value }, after: { text } }),
        );
        expect(scrubAuditEntry(once)).toEqual(once);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
