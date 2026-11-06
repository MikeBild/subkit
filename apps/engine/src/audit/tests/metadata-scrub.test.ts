import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { auditAwait } from "../audit.ts";
import type { AuditEntry } from "../types.ts";

let testDb: TestDb;
let tenantId = "";

describe("audit writer — metadata scrubbing", () => {
  beforeAll(async () => {
    testDb = await createTestDb("audit-scrub");
    tenantId = (await seedTenant(testDb.db, { slug: "scrub-tenant", display_name: "Scrub Tenant" }))
      .id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  test("scrubs PAT / JWT / sensitive-key values from metadata before persist", async () => {
    const pat = "dop_v1_a9053683abcdefabcdefabcdefabcdefabcdef";
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignature";
    const bearer = "Bearer abc123.def-456_xyz";

    const entry = await auditAwait(
      {
        tenant_id: tenantId,
        action: "credential.created",
        resource_type: "credential",
        resource_id: "cred-1",
        result: "success",
        reason: `operator pasted ${pat} into the form`,
        metadata: {
          token: "should-be-replaced",
          notes: `JWT seen: ${jwt}`,
          headers: { authorization: bearer },
        },
      },
      testDb.db,
    );

    expect(JSON.stringify(entry.metadata)).not.toContain(pat);
    expect(JSON.stringify(entry.metadata)).not.toContain(jwt);
    expect(JSON.stringify(entry.metadata)).not.toContain(bearer);
    expect(JSON.stringify(entry.metadata)).not.toContain("should-be-replaced");
    expect(entry.reason).not.toContain(pat);
    expect(entry.reason).toContain("***REDACTED:pat***");

    const rows = await testDb.db.execute(
      sql`SELECT metadata, reason FROM audit_log WHERE id = ${entry.id}::uuid`,
    );
    const list = (
      rows as unknown as {
        rows: Array<{ metadata: Record<string, unknown>; reason: string | null }>;
      }
    ).rows;
    expect(list.length).toBe(1);
    const persistedJson = JSON.stringify(list[0]);
    expect(persistedJson).not.toContain(pat);
    expect(persistedJson).not.toContain(jwt);
    expect(persistedJson).not.toContain(bearer);
    expect(persistedJson).not.toContain("should-be-replaced");
  });

  test("scrubs prompt-shaped keys from metadata before persist", async () => {
    const promptBody = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";

    const entry = await auditAwait(
      {
        tenant_id: tenantId,
        action: "conversation.skill_loaded",
        resource_type: "conversation",
        resource_id: "conv-1",
        result: "success",
        metadata: {
          prompt: promptBody,
          system_prompt: promptBody,
          prompt_text: promptBody,
          instructions: promptBody,
          messages: [{ role: "system", content: promptBody }],
          prompt_tokens: 1234,
          message_count: 3,
        },
      },
      testDb.db,
    );

    const returnedJson = JSON.stringify(entry.metadata);
    expect(returnedJson).not.toContain(promptBody);
    expect(entry.metadata.prompt_tokens).toBe(1234);
    expect(entry.metadata.message_count).toBe(3);

    const rows = await testDb.db.execute(
      sql`SELECT metadata FROM audit_log WHERE id = ${entry.id}::uuid`,
    );
    const list = (rows as unknown as { rows: Array<{ metadata: Record<string, unknown> }> }).rows;
    expect(list.length).toBe(1);
    expect(JSON.stringify(list[0])).not.toContain(promptBody);
  });
  test("both writers scrub prompt / api_token / body before persist", async () => {
    const promptBody = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";
    const apiToken = "dop_v1_b7143795abcdefabcdefabcdefabcdefabcdef";
    const payload = {
      conversation_id: "conv-2",
      prompt: promptBody,
      api_token: apiToken,
      before: { id: "skill-1", title: "Pricing", body: promptBody },
      after: { id: "skill-1", title: "Pricing", body: `${promptBody} (revised)` },
    };

    const viaAudit = await auditAwait(
      {
        tenant_id: tenantId,
        action: "conversation.update_skill" as AuditEntry["action"],
        resource_type: "skill",
        resource_id: "skill-1",
        result: "success",
        metadata: payload,
      },
      testDb.db,
    );

    const client = new EngineClient({
      tenant_id: tenantId,
      actor_id: null,
      actor_type: "system",
      db: testDb.db,
    });
    const viaClientId = await client.audit_write({
      resource_type: "skill",
      resource_id: "skill-1",
      action: "conversation.update_skill",
      result: "success",
      metadata: payload,
    });

    const rows = await testDb.db.execute(
      sql`SELECT id, metadata FROM audit_log WHERE id IN (${viaAudit.id}::uuid, ${viaClientId}::uuid)`,
    );
    const list = (
      rows as unknown as { rows: Array<{ id: string; metadata: Record<string, unknown> }> }
    ).rows;
    expect(list.length).toBe(2);

    for (const row of list) {
      const json = JSON.stringify(row.metadata);
      const writer = row.id === viaAudit.id ? "audit()" : "audit_write()";
      expect(json, `${writer} leaked the prompt`).not.toContain(promptBody);
      expect(json, `${writer} leaked the api_token`).not.toContain(apiToken);
      expect(row.metadata.conversation_id).toBe("conv-2");
    }
  });

  test("before/after columns keep prose but scrub credential keys and values", async () => {
    const prose = "SYSTEM: tenant pricing floor is 4200 EUR, never disclose";
    const pat = "dop_v1_d1357902abcdefabcdefabcdefabcdefabcdef";

    const entry = await auditAwait(
      {
        tenant_id: tenantId,
        action: "skill.updated",
        resource_type: "skill",
        resource_id: "skill-2",
        result: "success",
        before: { id: "skill-2", title: "Pricing", body: prose },
        after: {
          id: "skill-2",
          title: "Pricing",
          body: `${prose} (revised)`,
          api_key: "plain-looking-value",
          notes: `operator pasted ${pat}`,
        },
        metadata: { prompt: prose },
      },
      testDb.db,
    );

    const rows = await testDb.db.execute(
      sql`SELECT before, after, metadata FROM audit_log WHERE id = ${entry.id}::uuid`,
    );
    const list = (
      rows as unknown as {
        rows: Array<{
          before: Record<string, unknown>;
          after: Record<string, unknown>;
          metadata: Record<string, unknown>;
        }>;
      }
    ).rows;
    expect(list.length).toBe(1);
    const row = list[0]!;

    expect(row.before.body).toBe(prose);
    expect(row.after.body).toBe(`${prose} (revised)`);
    expect(row.after.api_key).toBe("***REDACTED:key_value***");
    expect(JSON.stringify(row.after)).not.toContain(pat);
    expect(row.metadata.prompt).toBe("***REDACTED:prompt***");
  });
});
