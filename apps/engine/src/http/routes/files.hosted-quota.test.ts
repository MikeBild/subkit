import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseFileIdOrThrow } from "../../api/files-schemas.ts";
import { setConfigKey } from "../../config/loader.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("files-hosted-quota", { operator: false, hosted: true });
  await setConfigKey("server.hosted_rate_limit.peer_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.principal_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.global_per_minute", 1000);
  await setConfigKey("storage.hosted.tenant_bytes", "10");
  await setConfigKey("storage.hosted.max_file_bytes", "6");
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
function post(path: string, body: unknown) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
}
function inline(content: string) {
  return post("/v1/files/inline", {
    filename: "quota.txt",
    content_base64: Buffer.from(content).toString("base64"),
  });
}

test("actual hosted HTTP inline and batch admission enforce a shared persistent file quota", async () => {
  const first = await inline("abcdef");
  expect(first.status).toBe(201);
  const file = (await first.json()) as { id: string };
  const duplicate = await inline("abcdef");
  expect(duplicate.status, await duplicate.text()).toBe(200);
  const oversized = await inline("abcdefg");
  expect(oversized.status).toBe(429);
  expect(await oversized.json()).toMatchObject({ code: "hosted_file_quota_exhausted" });
  expect((await inline("fedcba")).status).toBe(429);
  expect(
    (
      await fetch(`${ctx.baseUrl}/v1/files/${file.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ctx.apiKey}`, connection: "close" },
      })
    ).status,
  ).toBe(204);
  expect((await inline("fedcba")).status).toBe(429);
  expect(
    (await post("/v1/files/batch-create", { files: [{ filename: "staged.txt", size_bytes: 4 }] }))
      .status,
  ).toBe(201);
  expect(
    (
      await post("/v1/files/batch-create", {
        files: [{ filename: "over-limit.txt", size_bytes: 1 }],
      })
    ).status,
  ).toBe(429);
});

async function heldAuditFixture(label: string) {
  const isolated = await createHttpTestServer(label, {
    operator: false,
    hosted: true,
  });
  const upload = async () =>
    fetch(`${isolated.baseUrl}/v1/files/inline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${isolated.apiKey}`,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filename: "quota.txt",
        content_base64: Buffer.from("abcdef").toString("base64"),
      }),
    });
  try {
    const first = await upload();
    const firstBody = await first.text();
    expect(first.status, firstBody).toBe(201);
    const file = JSON.parse(firstBody) as { id: string };
    const fileId = parseFileIdOrThrow(file.id);
    const live = await isolated.testDb.pool.query<{
      deleted_at: Date | null;
      file_bytes: string;
      dedup_count: string;
      dedup_audits: number;
    }>(
      `SELECT f.deleted_at,
         (SELECT COALESCE(sum(size_bytes), 0)::text FROM subkit.files WHERE tenant_id = $1::uuid) AS file_bytes,
         COALESCE(d.count, 0)::text AS dedup_count,
         (SELECT count(*)::int FROM subkit.audit_log
          WHERE tenant_id = $1::uuid AND action = 'file.created' AND resource_id = $2::text
            AND metadata->>'dedup' = 'true') AS dedup_audits
       FROM subkit.files f
       LEFT JOIN subkit.files_dedup_seen d ON d.tenant_id = f.tenant_id
       WHERE f.id = $2::uuid AND f.tenant_id = $1::uuid`,
      [isolated.tenantId, fileId],
    );
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0]).toMatchObject({
      deleted_at: null,
      dedup_count: "0",
      dedup_audits: 0,
    });
    return { isolated, upload, fileId, fileWireId: file.id, before: live.rows[0]! };
  } catch (error) {
    await isolated.cleanup();
    throw error;
  }
}

async function holdTenantQuota(fixture: Awaited<ReturnType<typeof heldAuditFixture>>) {
  const holder = await fixture.isolated.testDb.pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [
    fixture.isolated.tenantId,
  ]);
  return holder;
}

function releaseAfterFirstRejectedFileAudit(
  fixture: Awaited<ReturnType<typeof heldAuditFixture>>,
  holder: Awaited<ReturnType<typeof holdTenantQuota>>,
) {
  const pool = fixture.isolated.testDb.pool as unknown as {
    query: (
      statement: { text?: unknown; values?: unknown[] } | string,
      values?: unknown[],
    ) => Promise<unknown>;
  };
  const original = pool.query;
  let released = false;
  let observed = false;
  pool.query = async (statement, values) => {
    try {
      return await original.call(pool, statement, values);
    } catch (error) {
      const text = typeof statement === "string" ? statement : statement.text;
      const parameters = typeof statement === "string" ? values : (statement.values ?? values);
      if (
        !released &&
        hostedQuotaError(error)?.code === "40001" &&
        typeof text === "string" &&
        text.includes('insert into "audit_log"') &&
        parameters?.includes("file.created") &&
        parameters.includes(fixture.fileId)
      ) {
        observed = true;
        released = true;
        await holder.query("ROLLBACK");
      }
      throw error;
    }
  };
  return {
    observed: () => observed,
    restore: () => {
      pool.query = original;
    },
  };
}

async function fileAfterRetry(fixture: Awaited<ReturnType<typeof heldAuditFixture>>) {
  const after = await fixture.isolated.testDb.pool.query<{
    deleted_at: Date | null;
    file_bytes: string;
    dedup_count: string;
    dedup_audits: number;
  }>(
    `SELECT f.deleted_at,
       (SELECT COALESCE(sum(size_bytes), 0)::text FROM subkit.files WHERE tenant_id = $1::uuid) AS file_bytes,
       COALESCE(d.count, 0)::text AS dedup_count,
       (SELECT count(*)::int FROM subkit.audit_log
        WHERE tenant_id = $1::uuid AND action = 'file.created' AND resource_id = $2::text
          AND metadata->>'dedup' = 'true') AS dedup_audits
     FROM subkit.files f
     LEFT JOIN subkit.files_dedup_seen d ON d.tenant_id = f.tenant_id
     WHERE f.id = $2::uuid AND f.tenant_id = $1::uuid`,
    [fixture.isolated.tenantId, fixture.fileId],
  );
  expect(after.rows).toHaveLength(1);
  return after.rows[0]!;
}

test("deduplicated inline upload retries only after an actual held audit quota failure", async () => {
  const fixture = await heldAuditFixture("files-hosted-quota-held-audit-retry");
  const holder = await holdTenantQuota(fixture);
  const release = releaseAfterFirstRejectedFileAudit(fixture, holder);
  try {
    const response = await fixture.upload();
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect((JSON.parse(body) as { id: string }).id).toBe(fixture.fileWireId);
    expect(release.observed()).toBe(true);
    expect(await fileAfterRetry(fixture)).toEqual({
      deleted_at: null,
      file_bytes: fixture.before.file_bytes,
      dedup_count: "1",
      dedup_audits: 1,
    });
  } finally {
    release.restore();
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await fixture.isolated.cleanup();
  }
});

test("deduplicated inline upload returns conflict after hosted audit retries exhaust", async () => {
  const fixture = await heldAuditFixture("files-hosted-quota-held-audit-exhausted");
  const holder = await holdTenantQuota(fixture);
  try {
    const response = await fixture.upload();
    const body = await response.text();
    expect(response.status, body).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ code: "conflict" });
    expect(await fileAfterRetry(fixture)).toEqual({
      deleted_at: null,
      file_bytes: fixture.before.file_bytes,
      dedup_count: "1",
      dedup_audits: 0,
    });
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await fixture.isolated.cleanup();
  }
});
