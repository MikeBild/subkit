import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let source: HttpTestServer;
let target: HttpTestServer;
let memberKey = "";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedMemberKey(srv: HttpTestServer): Promise<string> {
  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-packages@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const plaintext = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`; // allow-random: test only
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: plaintext.slice(0, 12),
    token_sha256: sha256Hex(plaintext),
    scopes: ["*"],
  });
  return plaintext;
}

function call(
  srv: HttpTestServer,
  method: string,
  path: string,
  body?: unknown,
  key = srv.apiKey,
): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  source = await createHttpTestServer("pkg-source");
  target = await createHttpTestServer("pkg-target");
  memberKey = await seedMemberKey(target);
  const created = await call(source, "POST", "/v1/skills", {
    scope: "global",
    title: "Package Tone",
    body: "Answer in short sentences.",
  });
  expect(created.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await source?.cleanup();
  await target?.cleanup();
}, 60_000);

describe("package routes", () => {
  test("a member is denied every package route", async () => {
    const fid = "fid_00000000-0000-4000-8000-000000000000";
    const denied = await Promise.all([
      call(target, "POST", "/v1/packages/export", {}, memberKey),
      call(target, "GET", `/v1/packages/archives/${fid}`, undefined, memberKey),
      call(target, "POST", "/v1/packages/import/preview", { archive_file_id: fid }, memberKey),
      call(
        target,
        "POST",
        "/v1/packages/import/apply",
        { archive_file_id: fid, expected_plan_digest: "0".repeat(64) },
        memberKey,
      ),
      call(target, "GET", "/v1/packages/installs", undefined, memberKey),
      call(
        target,
        "GET",
        "/v1/packages/installs/00000000-0000-4000-8000-000000000000",
        undefined,
        memberKey,
      ),
    ]);
    expect(denied.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  test("export, download, preview and apply move a skill to another engine", async () => {
    const exported = await call(source, "POST", "/v1/packages/export", { kinds: ["skill"] });
    expect(exported.status).toBe(201);
    const result = (await exported.json()) as {
      file_id: string;
      sha256: string;
      size_bytes: number;
      items_summary: Record<string, number>;
    };
    expect(result.file_id).toMatch(/^fid_[0-9a-f-]{36}$/);
    expect(result.items_summary.skill).toBeGreaterThanOrEqual(1);
    expect(result.items_summary.workflow).toBe(0);

    const download = await call(source, "GET", `/v1/packages/archives/${result.file_id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("x-subkit-sha256")).toBe(result.sha256);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(result.size_bytes);
    expect(sha256Hex(bytes)).toBe(result.sha256);
    const generic = await call(source, "GET", `/v1/files/${result.file_id}/content`);
    expect(generic.status).toBe(404);

    const form = new FormData();
    form.append("archive", new Blob([bytes], { type: "application/zip" }), "source.zip");
    const preview = await fetch(`${target.baseUrl}/v1/packages/import/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}` },
      body: form,
    });
    expect(preview.status).toBe(200);
    const previewed = (await preview.json()) as {
      archive_file_id: string;
      plan: {
        plan_digest: string;
        items: { kind: string; key: string; action: string }[];
        summary: Record<string, number>;
      };
    };
    expect(previewed.archive_file_id).toMatch(/^fid_/);
    const uploadAudit = await target.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, target.tenantId),
          eq(auditLog.action, "file.created"),
          eq(auditLog.resource_id, previewed.archive_file_id.slice("fid_".length)),
        ),
      );
    expect(uploadAudit).toHaveLength(1);
    expect(previewed.plan.items).toContainEqual(
      expect.objectContaining({ kind: "skill", key: "package-tone", action: "create" }),
    );

    const again = await call(target, "POST", "/v1/packages/import/preview", {
      archive_file_id: previewed.archive_file_id,
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { plan: { plan_digest: string } };
    expect(againBody.plan.plan_digest).toBe(previewed.plan.plan_digest);

    const stale = await call(target, "POST", "/v1/packages/import/apply", {
      archive_file_id: previewed.archive_file_id,
      expected_plan_digest: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as {
      code: string;
      details: { plan: { plan_digest: string } };
    };
    expect(staleBody.code).toBe("package_plan_changed");
    expect(staleBody.details.plan.plan_digest).toBe(previewed.plan.plan_digest);

    const applied = await call(target, "POST", "/v1/packages/import/apply", {
      archive_file_id: previewed.archive_file_id,
      expected_plan_digest: previewed.plan.plan_digest,
    });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as {
      install_id: string | null;
      items: { kind: string; key: string; action: string }[];
    };
    expect(appliedBody.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(appliedBody.items).toContainEqual(
      expect.objectContaining({ kind: "skill", key: "package-tone", action: "create" }),
    );

    const installs = await call(target, "GET", "/v1/packages/installs");
    expect(installs.status).toBe(200);
    const list = (await installs.json()) as {
      items: { id: string; archive_file_id: string | null }[];
    };
    expect(list.items.map((item) => item.id)).toContain(String(appliedBody.install_id));
    expect(list.items[0]?.archive_file_id).toBe(previewed.archive_file_id);

    const detail = await call(target, "GET", `/v1/packages/installs/${appliedBody.install_id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { items: { kind: string; item_key: string }[] };
    expect(detailBody.items).toContainEqual(
      expect.objectContaining({ kind: "skill", item_key: "package-tone" }),
    );

    const replay = await call(target, "POST", "/v1/packages/import/preview", {
      archive_file_id: previewed.archive_file_id,
    });
    const replayBody = (await replay.json()) as { plan: { summary: Record<string, number> } };
    expect(replayBody.plan.summary.create).toBe(0);
  });

  test("invalid archives and unknown ids are rejected", async () => {
    const form = new FormData();
    form.append("archive", new Blob(["not a zip archive"]), "broken.zip");
    const broken = await fetch(`${target.baseUrl}/v1/packages/import/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}` },
      body: form,
    });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { code: string }).code).toMatch(/^package_/);

    const missing = await call(
      target,
      "GET",
      "/v1/packages/archives/fid_00000000-0000-4000-8000-000000000000",
    );
    expect(missing.status).toBe(404);

    const notFid = await call(target, "GET", "/v1/packages/archives/not-a-file");
    expect(notFid.status).toBe(400);

    const noInstall = await call(
      target,
      "GET",
      "/v1/packages/installs/00000000-0000-4000-8000-000000000000",
    );
    expect(noInstall.status).toBe(404);
  });
});
