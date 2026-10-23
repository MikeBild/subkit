import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { FILE_VERSION_RETENTION, parseFileIdOrThrow } from "../../api/files-schemas.ts";
import {
  apiKeys,
  auditLog,
  files,
  fileVersions,
  roles,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { removeStoredFile } from "../../files/remove-stored-file.ts";
import { storageKey } from "../../files/resolver.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";

const nextHex = createDeterministicHexFactory(0xf11e5e);

let srv: HttpTestServer;
let portalKey: string;
let otherTenantKey: string;

type Version = {
  version: number;
  current: boolean;
  filename: string;
  size_bytes: number;
  restored_from: number | null;
  uploaded_by: { kind: string; id: string } | null;
  replaced_at: string | null;
};

function request(method: string, path: string, bearer: string, body?: unknown) {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function upload(text: string, filename: string): Promise<{ id: string }> {
  const response = await request("POST", "/v1/files/inline", srv.apiKey, {
    filename,
    content_type: "text/plain",
    content_base64: Buffer.from(text).toString("base64"),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function replace(id: string, text: string, filename: string) {
  return request("POST", `/v1/files/${id}/replace`, srv.apiKey, {
    filename,
    content_type: "text/plain",
    content_base64: Buffer.from(text).toString("base64"),
  });
}

async function versions(id: string): Promise<Version[]> {
  const response = await request("GET", `/v1/files/${id}/versions`, srv.apiKey);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Version[] }).items;
}

async function keyFor(token: string, tenantId: string, roleId: string, email: string) {
  const [user] = await srv.db
    .insert(users)
    .values({ tenant_id: tenantId, email, role_id: roleId })
    .returning();
  if (!user) throw new Error("seed user");
  await srv.db.insert(apiKeys).values({
    tenant_id: tenantId,
    user_id: user.id,
    prefix: token.slice(0, 12),
    token_sha256: createHash("sha256").update(token).digest("hex"),
    scopes: ["*"],
  });
}

function token(): string {
  return `wf_live_${Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32)}`;
}

beforeAll(async () => {
  srv = await createHttpTestServer("files-versions-http");
  const [portalRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "portal_token_user")))
    .limit(1);
  if (!portalRole) throw new Error("portal_token_user role not seeded");
  portalKey = token();
  await keyFor(portalKey, srv.tenantId, portalRole.id, "portal@files-versions.local");
  const [other] = await srv.db
    .insert(tenants)
    .values({ slug: "versions-other", display_name: "Versions Other" })
    .returning();
  if (!other) throw new Error("seed tenant");
  otherTenantKey = token();
  await keyFor(
    otherTenantKey,
    other.id,
    await builtinRoleId(srv.db, "admin"),
    "admin@versions-other.local",
  );
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("file versions", () => {
  test("a replace keeps the earlier content as a version with its uploader", async () => {
    const file = await upload("first draft", "notes.txt");
    expect((await replace(file.id, "second draft", "notes-v2.txt")).status).toBe(200);
    const items = await versions(file.id);
    expect(items.map((item) => [item.version, item.current, item.filename])).toEqual([
      [2, true, "notes-v2.txt"],
      [1, false, "notes.txt"],
    ]);
    expect(items[0]?.uploaded_by).toEqual({ kind: "user", id: srv.userId });
    expect(items[0]?.replaced_at).toBeNull();
    expect(items[1]?.replaced_at).not.toBeNull();
    const earlier = await request("GET", `/v1/files/${file.id}/versions/1/content`, srv.apiKey);
    expect(earlier.status).toBe(200);
    expect(await earlier.text()).toBe("first draft");
    const current = await request("GET", `/v1/files/${file.id}/versions/2/content`, srv.apiKey);
    expect(await current.text()).toBe("second draft");
    const meta = (await (await request("GET", `/v1/files/${file.id}`, srv.apiKey)).json()) as {
      version: number;
    };
    expect(meta.version).toBe(2);
    const audits = await srv.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, parseFileIdOrThrow(file.id)),
        ),
      );
    expect(audits.find((row) => row.action === "file.replaced")?.metadata).toMatchObject({
      version: 2,
    });
    expect(
      audits.some(
        (row) =>
          row.action === "file.downloaded" &&
          (row.metadata as { version?: number } | null)?.version === 1,
      ),
    ).toBe(true);
  });

  test("restore brings back earlier content as a new version and keeps the replaced one", async () => {
    const file = await upload("alpha content", "plan.txt");
    expect((await replace(file.id, "beta content", "plan.txt")).status).toBe(200);
    const restored = await request("POST", `/v1/files/${file.id}/versions/1/restore`, srv.apiKey);
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { version: number }).version).toBe(3);
    const content = await request("GET", `/v1/files/${file.id}/content`, srv.apiKey);
    expect(await content.text()).toBe("alpha content");
    const items = await versions(file.id);
    expect(items.map((item) => [item.version, item.restored_from])).toEqual([
      [3, 1],
      [2, null],
      [1, null],
    ]);
    const rows = await srv.db
      .select({ storage_uri: fileVersions.storage_uri })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.tenant_id, srv.tenantId),
          eq(fileVersions.file_id, parseFileIdOrThrow(file.id)),
        ),
      );
    const [current] = await srv.db
      .select({ storage_uri: files.storage_uri })
      .from(files)
      .where(eq(files.id, parseFileIdOrThrow(file.id)));
    const keys = [...rows.map((row) => row.storage_uri), current?.storage_uri];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("restore refuses the current version, unknown versions and readers", async () => {
    const file = await upload("gamma content", "gamma.txt");
    expect((await replace(file.id, "delta content", "gamma.txt")).status).toBe(200);
    const current = await request("POST", `/v1/files/${file.id}/versions/2/restore`, srv.apiKey);
    expect(current.status).toBe(409);
    const unknown = await request("POST", `/v1/files/${file.id}/versions/9/restore`, srv.apiKey);
    expect(unknown.status).toBe(404);
    const reader = await request("POST", `/v1/files/${file.id}/versions/1/restore`, portalKey);
    expect(reader.status).toBe(403);
  });

  test("restore refuses content another file now holds", async () => {
    const file = await upload("epsilon content", "epsilon.txt");
    expect((await replace(file.id, "zeta content", "epsilon.txt")).status).toBe(200);
    await upload("epsilon content", "copy.txt");
    const response = await request("POST", `/v1/files/${file.id}/versions/1/restore`, srv.apiKey);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("duplicate_content");
  });

  test("another tenant cannot list, read or restore versions", async () => {
    const file = await upload("eta content", "eta.txt");
    expect((await replace(file.id, "theta content", "eta.txt")).status).toBe(200);
    for (const [method, path] of [
      ["GET", `/v1/files/${file.id}/versions`],
      ["GET", `/v1/files/${file.id}/versions/1/content`],
      ["POST", `/v1/files/${file.id}/versions/1/restore`],
    ] as const) {
      const response = await request(method, path, otherTenantKey);
      expect(response.status).toBe(404);
    }
  });

  test("a deleted file shows no versions", async () => {
    const file = await upload("iota content", "iota.txt");
    expect((await replace(file.id, "kappa content", "iota.txt")).status).toBe(200);
    expect((await request("DELETE", `/v1/files/${file.id}`, srv.apiKey)).status).toBe(204);
    const response = await request("GET", `/v1/files/${file.id}/versions`, srv.apiKey);
    expect(response.status).toBe(404);
  });

  test("removing a stored file removes every version object", async () => {
    const file = await upload("lambda content", "lambda.txt");
    expect((await replace(file.id, "mu content", "lambda.txt")).status).toBe(200);
    expect((await replace(file.id, "nu content", "lambda.txt")).status).toBe(200);
    const fileId = parseFileIdOrThrow(file.id);
    const rows = await srv.db
      .select({ storage_uri: fileVersions.storage_uri })
      .from(fileVersions)
      .where(and(eq(fileVersions.tenant_id, srv.tenantId), eq(fileVersions.file_id, fileId)));
    const [current] = await srv.db
      .select({ storage_uri: files.storage_uri })
      .from(files)
      .where(eq(files.id, fileId));
    const keys = [...rows, ...(current ? [current] : [])].map((row) => storageKey(row.storage_uri));
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(await getObjectStore().head(key)).not.toBeNull();
    expect(await removeStoredFile(srv.db, srv.tenantId, fileId)).toBeDefined();
    for (const key of keys) expect(await getObjectStore().head(key)).toBeNull();
    const left = await srv.db
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(and(eq(fileVersions.tenant_id, srv.tenantId), eq(fileVersions.file_id, fileId)));
    expect(left).toHaveLength(0);
  });

  test("only the newest earlier versions are kept and pruned objects are removed", async () => {
    const file = await upload("revision 0", "retained.txt");
    const fileId = parseFileIdOrThrow(file.id);
    const [first] = await srv.db
      .select({ storage_uri: files.storage_uri })
      .from(files)
      .where(eq(files.id, fileId));
    for (let index = 1; index <= FILE_VERSION_RETENTION + 1; index++)
      expect((await replace(file.id, `revision ${index}`, "retained.txt")).status).toBe(200);
    const items = await versions(file.id);
    expect(items).toHaveLength(FILE_VERSION_RETENTION + 1);
    expect(items[0]?.version).toBe(FILE_VERSION_RETENTION + 2);
    expect(items.at(-1)?.version).toBe(2);
    expect(await getObjectStore().head(storageKey(first?.storage_uri ?? ""))).toBeNull();
  });

  test("parallel replaces each keep the content they replaced", async () => {
    const file = await upload("omicron content", "parallel.txt");
    const responses = await Promise.all([
      replace(file.id, "pi content", "parallel.txt"),
      replace(file.id, "rho content", "parallel.txt"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const items = await versions(file.id);
    expect(items.map((item) => item.version)).toEqual([3, 2, 1]);
  });
});
