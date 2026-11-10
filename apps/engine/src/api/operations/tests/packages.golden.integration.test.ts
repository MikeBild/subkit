import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../../db/schema/index.ts";
import { OPENAPI_INFO } from "../../../http/openapi.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/packages.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const MISSING_FILE = `fid_${MISSING}`;

let source: HttpTestServer;
let target: HttpTestServer;
let deniedKey: string;
let exportedFileId: string;
let archiveBytes: Uint8Array<ArrayBuffer>;
let previewFileId: string;
let planDigest: string;
let installId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(source.tenantId, "<source-tenant>")
    .replaceAll(target.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, "<sha256>")
    .replace(/"(size_bytes|size_bytes_bucket)":\d+/g, '"$1":"<size>"')
    .replace(/"(sha256_prefix)":"[0-9a-f]+"/g, '"$1":"<prefix>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(
    (golden[name] as string).replaceAll(
      JSON.stringify("<engine-version>"),
      JSON.stringify(OPENAPI_INFO.version),
    ),
  );
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key: string | null = target.apiKey,
  srv: HttpTestServer = target,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

function auditRows(where: ReturnType<typeof eq | typeof inArray>) {
  return target.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, target.tenantId), where));
}

beforeAll(async () => {
  source = await createHttpTestServer("operations_packages_golden_source");
  target = await createHttpTestServer("operations_packages_golden_target");
  const [denied] = await target.db
    .insert(users)
    .values({
      tenant_id: target.tenantId,
      email: "denied-packages-operations@test.local",
      role_id: await emptyRoleId(target.db, target.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = `wf_live_${createDeterministicHexFactory(0x6c_21)(16)}`;
  await target.db.insert(apiKeys).values({
    tenant_id: target.tenantId,
    user_id: denied.id,
    prefix: deniedKey.slice(0, 12),
    token_sha256: createHash("sha256").update(deniedKey).digest("hex"),
    scopes: ["*"],
  });
  const created = await http(
    "POST",
    "/v1/skills",
    { scope: "global", title: "Package Golden Tone", body: "Answer in short sentences." },
    source.apiKey,
    source,
  );
  if (created.status !== 201) throw new Error(`skill seed failed: ${created.status}`);
}, 120_000);

afterAll(async () => {
  await source?.cleanup();
  await target?.cleanup();
}, 60_000);

describe("package operations keep their HTTP responses byte for byte", () => {
  test("export", async () => {
    const exported = await http(
      "POST",
      "/v1/packages/export",
      { kinds: ["skill"] },
      source.apiKey,
      source,
    );
    exportedFileId = (exported.body as { file_id: string }).file_id;
    record("http.export", exported);
    record(
      "http.export.invalid",
      await http("POST", "/v1/packages/export", { kinds: ["nope"] }, source.apiKey, source),
    );
  });

  test("download stays a binary route", async () => {
    const res = await fetch(`${source.baseUrl}/v1/packages/archives/${exportedFileId}`, {
      headers: { authorization: `Bearer ${source.apiKey}` },
    });
    archiveBytes = new Uint8Array(await res.arrayBuffer());
    record("http.download", {
      status: res.status,
      content_type: res.headers.get("content-type"),
      cache_control: res.headers.get("cache-control"),
      disposition: res.headers.get("content-disposition"),
    });
    record(
      "http.download.missing",
      await http("GET", `/v1/packages/archives/${MISSING_FILE}`, undefined, source.apiKey, source),
    );
    record(
      "http.download.invalid",
      await http("GET", "/v1/packages/archives/nope", undefined, source.apiKey, source),
    );
  });

  test("preview stays a multipart route", async () => {
    const form = new FormData();
    form.append("archive", new Blob([archiveBytes], { type: "application/zip" }), "golden.zip");
    const res = await fetch(`${target.baseUrl}/v1/packages/import/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}` },
      body: form,
    });
    const previewed = { status: res.status, body: parseBody(await res.text()) };
    const body = previewed.body as { archive_file_id: string; plan: { plan_digest: string } };
    previewFileId = body.archive_file_id;
    planDigest = body.plan.plan_digest;
    record("http.preview.multipart", previewed);
    record(
      "http.preview.json",
      await http("POST", "/v1/packages/import/preview", { archive_file_id: previewFileId }),
    );
    record(
      "http.preview.missing",
      await http("POST", "/v1/packages/import/preview", { archive_file_id: MISSING_FILE }),
    );
    record("http.preview.invalid", await http("POST", "/v1/packages/import/preview", {}));
  });

  test("apply", async () => {
    record(
      "http.apply.stale",
      await http("POST", "/v1/packages/import/apply", {
        archive_file_id: previewFileId,
        expected_plan_digest: "0".repeat(64),
      }),
    );
    record(
      "http.apply.missing",
      await http("POST", "/v1/packages/import/apply", {
        archive_file_id: MISSING_FILE,
        expected_plan_digest: planDigest,
      }),
    );
    record(
      "http.apply.bad-file-id",
      await http("POST", "/v1/packages/import/apply", {
        archive_file_id: "fid_nope",
        expected_plan_digest: planDigest,
      }),
    );
    record("http.apply.invalid", await http("POST", "/v1/packages/import/apply", {}));
    const applied = await http("POST", "/v1/packages/import/apply", {
      archive_file_id: previewFileId,
      expected_plan_digest: planDigest,
    });
    installId = (applied.body as { install_id: string }).install_id;
    record("http.apply", applied);
  });

  test("installs", async () => {
    record("http.installs.list", await http("GET", "/v1/packages/installs"));
    record("http.installs.get", await http("GET", `/v1/packages/installs/${installId}`));
    record("http.installs.get.missing", await http("GET", `/v1/packages/installs/${MISSING}`));
    record("http.installs.get.invalid", await http("GET", "/v1/packages/installs/nope"));
  });

  test("permission is checked before the body is validated", async () => {
    record("http.denied.export", await http("POST", "/v1/packages/export", {}, deniedKey));
    record(
      "http.denied.download",
      await http("GET", `/v1/packages/archives/${MISSING_FILE}`, undefined, deniedKey),
    );
    record("http.denied.preview", await http("POST", "/v1/packages/import/preview", {}, deniedKey));
    record("http.denied.apply", await http("POST", "/v1/packages/import/apply", {}, deniedKey));
    record(
      "http.denied.installs",
      await http("GET", "/v1/packages/installs", undefined, deniedKey),
    );
    record(
      "http.denied.install",
      await http("GET", `/v1/packages/installs/${MISSING}`, undefined, deniedKey),
    );
    record(
      "http.denied.head.installs",
      await http("HEAD", "/v1/packages/installs", undefined, deniedKey),
    );
    record(
      "http.denied.head.install",
      await http("HEAD", `/v1/packages/installs/${MISSING}`, undefined, deniedKey),
    );
    record(
      "http.denied.other-method.installs",
      await http("POST", "/v1/packages/installs", {}, deniedKey),
    );
    record(
      "http.denied.other-method.install",
      await http("DELETE", `/v1/packages/installs/${MISSING}`, undefined, deniedKey),
    );
    record(
      "http.denied.other-method.apply",
      await http("GET", "/v1/packages/import/apply", undefined, deniedKey),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("unauthenticated requests are refused", async () => {
    record(
      "http.unauthenticated.installs",
      await http("GET", "/v1/packages/installs", undefined, null),
    );
    record("http.unauthenticated.apply", await http("POST", "/v1/packages/import/apply", {}, null));
  });

  test("audit trail of the import", async () => {
    recordRows(
      "http.audit",
      await auditRows(inArray(auditLog.action, ["data.imported", "file.created", "skill.created"])),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
