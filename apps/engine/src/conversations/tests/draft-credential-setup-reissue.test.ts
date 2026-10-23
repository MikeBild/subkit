import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../../db/client.ts";
import {
  NATIVE_DELIVERY_TIMED_OUT,
  nativeDeliveryFailureCode,
} from "../../mcp/capabilities/conversation-native-elicitation.ts";
import {
  DRAFT_CREDENTIAL_SETUP_KIND,
  DRAFT_CREDENTIAL_SETUP_MAX_REISSUES,
  DRAFT_CREDENTIAL_SETUP_TTL_MS,
  type ReissueDeps,
  reissueExpiredDraftCredentialSetup,
} from "../draft-credential-setup.ts";

const OLD_URL = "https://engine.example.test/v1/connector-drafts/c/credentials/setup?grant=old";
const NEW_URL = "https://engine.example.test/v1/connector-drafts/c/credentials/setup?grant=new";

function fakeDb(rows: Array<{ id: string }>) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => ({ returning: async () => rows }) };
      },
    }),
  } as unknown as Db;
  return { db, writes };
}

function deps(over: Partial<ReissueDeps> = {}) {
  const audits: unknown[] = [];
  const value: ReissueDeps = {
    mint: () => ({
      ok: true,
      url: NEW_URL,
      expires_at: new Date(Date.now() + DRAFT_CREDENTIAL_SETUP_TTL_MS),
    }),
    audit: (async (entry: unknown) => {
      audits.push(entry);
      return entry;
    }) as unknown as ReissueDeps["audit"],
    ...over,
  };
  return { value, audits };
}

function setupInput(over: Record<string, unknown> = {}) {
  return {
    kind: DRAFT_CREDENTIAL_SETUP_KIND,
    setup_url: OLD_URL,
    expires_at: new Date(Date.now() - 1_000).toISOString(),
    auth_type: "bearer",
    connector_slug: "example",
    ...over,
  };
}

const principal = { kind: "user" as const, id: "u" };

function reissue(
  db: Db,
  input: unknown,
  d: ReissueDeps,
  delivery_last_error: string | null = null,
) {
  return reissueExpiredDraftCredentialSetup(
    db,
    {
      tenant_id: "t",
      conversation_id: "c",
      elicitation_id: "e",
      input,
      delivery_last_error,
      principal,
    },
    d,
  );
}

describe("an expired secure credential link is re-issued on the same pending prompt", () => {
  test("an expired link gets a fresh single-use link with the unchanged lifetime", async () => {
    const { db, writes } = fakeDb([{ id: "e" }]);
    const d = deps();
    const result = await reissue(db, setupInput(), d.value);
    if (!result.reissued) throw new Error(`expected a reissue, got ${result.reason}`);
    expect(result.input).toMatchObject({
      setup_url: NEW_URL,
      reissue_count: 1,
      kind: DRAFT_CREDENTIAL_SETUP_KIND,
    });
    expect(String(result.input.note)).toContain(NEW_URL);
    const lifetime = result.expires_at.getTime() - Date.now();
    expect(lifetime).toBeLessThanOrEqual(DRAFT_CREDENTIAL_SETUP_TTL_MS);
    expect(lifetime).toBeGreaterThan(DRAFT_CREDENTIAL_SETUP_TTL_MS - 60_000);
    expect(writes[0]).toMatchObject({ expires_at: result.expires_at });
    expect(d.audits).toHaveLength(1);
    expect(d.audits[0]).toMatchObject({
      action: "connector.credential_grant.issued",
      actor_type: "user",
      actor_id: "u",
      metadata: { reissued: true, reissue_count: 1, elicitation_id: "e" },
    });
  });

  test("a link that is still valid is left alone", async () => {
    const { db, writes } = fakeDb([{ id: "e" }]);
    const d = deps();
    const result = await reissue(
      db,
      setupInput({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
      d.value,
    );
    expect(result).toEqual({ reissued: false, reason: "still_valid" });
    expect(writes).toHaveLength(0);
    expect(d.audits).toHaveLength(0);
  });

  test("other prompts are never touched", async () => {
    const { db, writes } = fakeDb([{ id: "e" }]);
    const result = await reissue(db, { kind: "generic", question: "x" }, deps().value);
    expect(result).toEqual({ reissued: false, reason: "not_credential_setup" });
    expect(writes).toHaveLength(0);
  });

  test("re-issuing stops at the limit", async () => {
    const { db, writes } = fakeDb([{ id: "e" }]);
    const result = await reissue(
      db,
      setupInput({ reissue_count: DRAFT_CREDENTIAL_SETUP_MAX_REISSUES }),
      deps().value,
    );
    expect(result).toEqual({ reissued: false, reason: "reissue_limit" });
    expect(writes).toHaveLength(0);
  });

  test("a submitted credential is never re-issued", async () => {
    for (const state of ["url_credential_claimed", "url_completed", "url_failed"]) {
      const { db, writes } = fakeDb([{ id: "e" }]);
      const result = await reissue(db, setupInput(), deps().value, state);
      expect(result).toEqual({ reissued: false, reason: "no_longer_pending" });
      expect(writes).toHaveLength(0);
    }
  });

  test("a prompt resolved meanwhile is not re-issued or audited", async () => {
    const { db } = fakeDb([]);
    const d = deps();
    const result = await reissue(db, setupInput(), d.value);
    expect(result).toEqual({ reissued: false, reason: "no_longer_pending" });
    expect(d.audits).toHaveLength(0);
  });

  test("without a public origin nothing is re-issued", async () => {
    const { db, writes } = fakeDb([{ id: "e" }]);
    const result = await reissue(
      db,
      setupInput(),
      deps({ mint: () => ({ ok: false, error: "engine_public_url_missing" }) }).value,
    );
    expect(result).toEqual({ reissued: false, reason: "engine_public_url_missing" });
    expect(writes).toHaveLength(0);
  });
});

describe("a native form that times out stays open and is presented again", () => {
  test("a client timeout is recorded apart from a transport failure", () => {
    expect(nativeDeliveryFailureCode(new McpError(ErrorCode.RequestTimeout, "timed out"))).toBe(
      NATIVE_DELIVERY_TIMED_OUT,
    );
    expect(nativeDeliveryFailureCode(new McpError(ErrorCode.InternalError, "boom"))).toBe(
      "transport_failed",
    );
    expect(nativeDeliveryFailureCode(new Error("socket closed"))).toBe("transport_failed");
  });
});
