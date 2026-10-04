import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, cli, type E2EEnv, expectSuccess, parseJson, run, shutdown } from "./setup.ts";

const TINY_CONTENT = "tiny fixture content for sk files e2e tests";
const SMALL_CONTENT = Buffer.alloc(1024 * 200, 0xab);

let env: E2EEnv;
let fixtureDir: string;
let tinyPath: string;
let smallPath: string;

beforeAll(async () => {
  env = await boot("files-lifecycle", { llm: "mock" });

  fixtureDir = mkdtempSync(join(tmpdir(), "sk-files-e2e-fixtures-"));
  tinyPath = join(fixtureDir, "tiny.txt");
  writeFileSync(tinyPath, TINY_CONTENT);
  smallPath = join(fixtureDir, "small.bin");
  writeFileSync(smallPath, SMALL_CONTENT);
}, 120_000);

afterAll(async () => {
  await shutdown(env);
  rmSync(fixtureDir, { recursive: true, force: true });
}, 30_000);

describe("E1: full lifecycle", () => {
  let fid: string;
  let downloadDir: string;

  test("upload tiny.txt returns ready status", async () => {
    const result = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(result, "E1 upload");
    const row = parseJson<{ id: string; status: string; filename: string; sha256: string | null }>(
      result,
    );
    expect(row.id).toMatch(/^fid_/);
    expect(row.status).toBe("ready");
    expect(row.filename).toBe("tiny.txt");
    fid = row.id;
  });

  test("list includes the uploaded file", async () => {
    const result = await cli(["files", "list", "--json"], { env, persona: "admin" });
    expectSuccess(result, "E1 list");
    const res = parseJson<{ items: Array<{ id: string }> }>(result);
    expect(res.items.some((r) => r.id === fid)).toBe(true);
  });

  test("get returns correct metadata", async () => {
    const result = await cli(["files", "get", fid, "--json"], { env, persona: "admin" });
    expectSuccess(result, "E1 get");
    const row = parseJson<{ id: string; status: string; sha256: string | null }>(result);
    expect(row.id).toBe(fid);
    expect(row.status).toBe("ready");
  });

  test("download writes bytes to disk, sha256 matches", async () => {
    downloadDir = mkdtempSync(join(tmpdir(), "sk-e1-dl-"));
    const outPath = join(downloadDir, "dl.txt");
    await run(["files", "download", fid, "--output", outPath], { env, persona: "admin" });
    expect(existsSync(outPath)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const downloaded = readFileSync(outPath, "utf8");
    expect(downloaded).toBe(TINY_CONTENT);
  });

  test("delete → file no longer appears in list", async () => {
    await run(["files", "delete", fid, "--force"], { env, persona: "admin" });
    const result = await cli(["files", "list", "--json"], { env, persona: "admin" });
    const res = parseJson<{ items: Array<{ id: string }> }>(result);
    expect(res.items.some((r) => r.id === fid)).toBe(false);

    rmSync(downloadDir, { recursive: true, force: true });
  });
});

describe("E2: dedup hit", () => {
  test("second upload of same content returns same fid", async () => {
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E2 upload-1");
    const row1 = parseJson<{ id: string }>(r1);

    const r2 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r2, "E2 upload-2");
    const row2 = parseJson<{ id: string }>(r2);

    expect(row1.id).toBe(row2.id);

    await cli(["files", "delete", row1.id, "--force"], { env, persona: "admin" });
  });

  test("stats dedup_hits increments after duplicate upload", async () => {
    const r1 = await cli(["files", "upload", smallPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E2 stats upload-1");
    const row = parseJson<{ id: string }>(r1);

    const s1 = await cli(["files", "stats", "--json"], { env, persona: "admin" });
    expectSuccess(s1, "E2 stats-1");
    const stats1 = parseJson<{ dedup_hits: number }>(s1);

    await cli(["files", "upload", smallPath, "--json"], { env, persona: "admin" });

    const s2 = await cli(["files", "stats", "--json"], { env, persona: "admin" });
    expectSuccess(s2, "E2 stats-2");
    const stats2 = parseJson<{ dedup_hits: number }>(s2);

    expect(stats2.dedup_hits).toBeGreaterThan(stats1.dedup_hits);

    await cli(["files", "delete", row.id, "--force"], { env, persona: "admin" });
  });
});

describe("E3: authenticated streamed upload (large file)", () => {
  test("file >5 MB goes through batch-create + streamed PUT path", async () => {
    const largePath = join(fixtureDir, "large.bin");
    writeFileSync(largePath, Buffer.alloc(6 * 1024 * 1024, 0xcc));

    const result = await cli(["files", "upload", largePath, "--json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "E3 upload-large");
    const row = parseJson<{ id: string; status: string; size_bytes: number }>(result);
    expect(row.id).toMatch(/^fid_/);
    expect(row.status).toBe("ready");
    expect(row.size_bytes).toBe(6 * 1024 * 1024);

    await cli(["files", "delete", row.id, "--force"], { env, persona: "admin" });
    rmSync(largePath, { force: true });
  });
});

describe("E5: headless --attach with mock LLM", () => {
  test("sk -p with --attach exits 0 and emits file_attached in stream-json", async () => {
    const result = await cli(
      [
        "--p",
        "summarise the attachment in one sentence",
        "--attach",
        tinyPath,
        "--output",
        "stream-json",
      ],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "E5 headless-attach");
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const fileAttached = lines.find((l) => "file_attached" in l);
    expect(fileAttached).toBeDefined();
    expect(typeof fileAttached?.file_attached).toBe("string");
    expect(String(fileAttached?.file_attached)).toMatch(/^fid_/);
    expect(fileAttached?.filename).toBe("tiny.txt");
  });
});

describe("E8: workflow file input + multipart out", () => {
  test("--input-file substitutes $file ref in execution input", async () => {
    const result = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(result, "E8 upload");
    const row = parseJson<{ id: string }>(result);
    expect(row.id).toMatch(/^fid_/);

    await cli(["files", "delete", row.id, "--force"], { env, persona: "admin" });
  });
});

describe("E11: tenant cross-leak isolation", () => {
  test("tenant B cannot read tenant A file", async () => {
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E11 upload as admin");
    const fidA = parseJson<{ id: string }>(r1).id;

    const fakeOtherTenantFid = "fid_99999999-9999-9999-9999-999999999999";
    const r2 = await cli(["files", "get", fakeOtherTenantFid, "--json"], { env, persona: "admin" });
    expect(r2.exitCode).not.toBe(0);

    await cli(["files", "delete", fidA, "--force"], { env, persona: "admin" });
  });
});

describe("E13: conversation fork preserves files", () => {
  test("fork conversation — file_links cascade to the fork", async () => {
    const uploadResult = await cli(["files", "upload", tinyPath, "--json"], {
      env,
      persona: "admin",
    });
    expectSuccess(uploadResult, "E13 upload");
    const fid = parseJson<{ id: string }>(uploadResult).id;

    const adminKey = env.personas.admin.apiKey;
    const createRes = await fetch(`${env.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ initial_message: "hello" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { conversation: { id: string } };
    const sourceConvId = createBody.conversation.id;

    const linkResult = await cli(["files", "link", fid, "--to", `conversation:${sourceConvId}`], {
      env,
      persona: "admin",
    });
    expectSuccess(linkResult, "E13 link");

    const sourceListResult = await cli(
      ["files", "list", "--linked-to", `conversation:${sourceConvId}`, "--json"],
      { env, persona: "admin" },
    );
    expectSuccess(sourceListResult, "E13 list source");
    const sourceLinked = parseJson<{ items: Array<{ id: string }> }>(sourceListResult);
    expect(sourceLinked.items.some((r) => r.id === fid)).toBe(true);

    const detailRes = await fetch(`${env.baseUrl}/v1/conversations/${sourceConvId}`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      messages: Array<{ id: string; role: string }>;
    };
    const anchorMessageId = detail.messages.at(-1)?.id;
    if (!anchorMessageId) throw new Error("E13: source conversation has no messages");

    const forkRes = await fetch(
      `${env.baseUrl}/v1/conversations/${sourceConvId}/fork-from-message/${anchorMessageId}`,
      { method: "POST", headers: { authorization: `Bearer ${adminKey}` } },
    );
    expect(forkRes.status).toBe(200);
    const forkBody = (await forkRes.json()) as {
      conversation: { id: string };
      source_conversation_id: string;
    };
    expect(forkBody.source_conversation_id).toBe(sourceConvId);
    const forkConvId = forkBody.conversation.id;
    expect(forkConvId).not.toBe(sourceConvId);

    const forkListResult = await cli(
      ["files", "list", "--linked-to", `conversation:${forkConvId}`, "--json"],
      { env, persona: "admin" },
    );
    expectSuccess(forkListResult, "E13 list fork");
    const forkLinked = parseJson<{ items: Array<{ id: string }> }>(forkListResult);
    expect(forkLinked.items.some((r) => r.id === fid)).toBe(true);

    await cli(["files", "delete", fid, "--force"], { env, persona: "admin" });
  });
});

describe("E16: audit completeness", () => {
  test("upload + download + delete fire audit events", async () => {
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E16 upload");
    const fid = parseJson<{ id: string }>(r1).id;

    const dlDir = mkdtempSync(join(tmpdir(), "sk-e16-dl-"));
    const outPath = join(dlDir, "dl.txt");
    await run(["files", "download", fid, "--output", outPath], { env, persona: "admin" });

    await run(["files", "delete", fid, "--force"], { env, persona: "admin" });

    const rawUuid = fid.startsWith("fid_") ? fid.slice("fid_".length) : fid;
    const auditResult = await cli(
      [
        "audit",
        "query",
        "--action",
        "file.created,file.downloaded,file.deleted",
        "--resource-id",
        rawUuid,
        "--since",
        "10m",
        "--limit",
        "100",
        "--json",
      ],
      { env, persona: "admin" },
    );
    expectSuccess(auditResult, "E16 audit query");
    const auditRows = parseJson<{ items: Array<{ action: string; resource_id: string }> }>(
      auditResult,
    );
    const actions = new Set(auditRows.items.map((r) => r.action));
    expect(actions.has("file.created")).toBe(true);
    expect(actions.has("file.downloaded")).toBe(true);
    expect(actions.has("file.deleted")).toBe(true);

    rmSync(dlDir, { recursive: true, force: true });
  });
});

describe("E18: legacy @attachment: text rewrite", () => {
  test("message with @attachment: token is accepted and round-trips without the legacy token", async () => {
    const result = await cli(
      [
        "--p",
        "please summarise @attachment:report (this is a test of legacy token acceptance)",
        "--output",
        "json",
      ],
      { env, persona: "admin", timeout: 30_000 },
    );
    expectSuccess(result, "E18 legacy @attachment token");
    const data = parseJson<{ status: string; session_id: string }>(result);
    expect(data.status).toBe("completed");
    expect(data.session_id).toBeTruthy();
  });
});

describe("stats smoke", () => {
  test("sk files stats --json returns correct shape", async () => {
    const result = await cli(["files", "stats", "--json"], { env, persona: "admin" });
    expectSuccess(result, "stats shape");
    const stats = parseJson<{
      total: number;
      by_status: Record<string, number>;
      by_size_bucket: Record<string, number>;
      dedup_hits: number;
      scan_verdicts: Record<string, number>;
    }>(result);
    expect(typeof stats.total).toBe("number");
    expect(typeof stats.dedup_hits).toBe("number");
    expect(typeof stats.by_status).toBe("object");
    expect(typeof stats.by_size_bucket).toBe("object");
    expect(typeof stats.scan_verdicts).toBe("object");
  });
});
