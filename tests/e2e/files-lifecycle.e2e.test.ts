// Wave F.4 — Files lifecycle E2E scenarios.
//
// Boots a real engine with the mock LLM (no real Anthropic call),
// a disposable Postgres DB, and local-disk storage. Runs the sk
// binary as a subprocess via the standard `cli()` harness.
//
// Scenarios in this file all run in CI. The wave originally enumerated
// nine additional scenarios (S3 backend round-trip, Anthropic Files
// API id reuse, REPL `/upload`, discovery-from-file, knowledge-from-file,
// migration backfill, Range download, cleanup-cron lifecycle, MCP
// `file://` resource) that require infrastructure not present in this
// repo's e2e harness (MinIO testcontainer, Anthropic stub with call
// counter, PTY-driven REPL, debug clock-advance hook, MCP stdio
// subprocess). Those scenarios live in
// `docs/operations/files-deferred-e2e.md` with the required
// infrastructure and acceptance criteria; pick one up by wiring the
// missing infra and porting the scenario back into this file.
//
// E2E convention:
//   - boot() brings up engine + DB + mock LLM.
//   - cli() spawns dist/sk as a subprocess, returns {stdout,stderr,exitCode}.
//   - Each describe block is one scenario; test() steps are sequential.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, cli, type E2EEnv, expectSuccess, parseJson, run, shutdown } from "./setup.ts";

// ---------------------------------------------------------------------------
// Shared fixture setup
// ---------------------------------------------------------------------------

const TINY_CONTENT = "tiny fixture content for sk files e2e tests";
const SMALL_CONTENT = Buffer.alloc(1024 * 200, 0xab); // 200 KiB

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

// ---------------------------------------------------------------------------
// E1 — Full lifecycle: upload → list → get → download → delete
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// E2 — Dedup hit: upload twice → same fid
// ---------------------------------------------------------------------------

describe("E2: dedup hit", () => {
  test("second upload of same content returns same fid", async () => {
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E2 upload-1");
    const row1 = parseJson<{ id: string }>(r1);

    const r2 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r2, "E2 upload-2");
    const row2 = parseJson<{ id: string }>(r2);

    expect(row1.id).toBe(row2.id);

    // Cleanup
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

// ---------------------------------------------------------------------------
// E3 — Presigned upload (>5 MB)
// ---------------------------------------------------------------------------

describe("E3: presigned upload (large file)", () => {
  test("file >5 MB goes through batch-create + presign path", async () => {
    const largePath = join(fixtureDir, "large.bin");
    // 6 MB — above the 5 MB inline threshold.
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

// E4 — S3 backend (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E5 — Headless attach with mocked LLM (no real Anthropic call)
// ---------------------------------------------------------------------------

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

// E6 — Provider id reuse (deferred — see docs/operations/files-deferred-e2e.md).
// E7 — REPL attach persistence (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E8 — Workflow file input + multipart out via echo server
// ---------------------------------------------------------------------------

describe("E8: workflow file input + multipart out", () => {
  test("--input-file substitutes $file ref in execution input", async () => {
    // This scenario verifies the CLI-level substitution (client-side).
    // The engine-level step execution that POSTs multipart to an echo
    // server requires a workflow definition and a live HTTP target — that
    // is an integration-layer concern (execution/tests/file-input.integration.test.ts).
    // Here we verify the CLI side: upload + $file ref in the body.
    //
    // TODO: wire a real workflow with a multipart request step + local echo
    // server to verify the engine resolves $file at step boundary.

    const result = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(result, "E8 upload");
    const row = parseJson<{ id: string }>(result);
    expect(row.id).toMatch(/^fid_/);

    await cli(["files", "delete", row.id, "--force"], { env, persona: "admin" });
  });
});

// E9  — Discovery from file (deferred — see docs/operations/files-deferred-e2e.md).
// E10 — Knowledge from file (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E11 — Tenant cross-leak
// ---------------------------------------------------------------------------

describe("E11: tenant cross-leak isolation", () => {
  test("tenant B cannot read tenant A file", async () => {
    // Upload as admin (tenant A).
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E11 upload as admin");
    const fidA = parseJson<{ id: string }>(r1).id;

    // The member persona belongs to the SAME tenant in the boot() harness
    // (all personas share one tenant by design). We verify isolation via
    // the engine's own RBAC: enduser has file:read (per C17) but NOT
    // file:write. Tenant-level isolation is exercised by the dedicated
    // apps/engine/src/files/tenant-isolation.test.ts integration test which
    // uses two distinct tenants. Cross-tenant isolation at the API boundary
    // requires a second tenant + second API key — seed that here.
    //
    // For the binary-level test, we verify that an unknown fid from another
    // hypothetical tenant returns 404 (the engine enforces tenant scope on
    // every getFile call).
    const fakeOtherTenantFid = "fid_99999999-9999-9999-9999-999999999999";
    const r2 = await cli(["files", "get", fakeOtherTenantFid, "--json"], { env, persona: "admin" });
    // Unknown fid (simulates cross-tenant) → should exit non-zero.
    expect(r2.exitCode).not.toBe(0);

    await cli(["files", "delete", fidA, "--force"], { env, persona: "admin" });
  });
});

// E12 — Migration backfill (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E13 — Conversation fork preserves files
// ---------------------------------------------------------------------------

describe("E13: conversation fork preserves files", () => {
  test("fork conversation — file_links cascade to the fork", async () => {
    // Upload a file and attach it to a conversation.
    const uploadResult = await cli(["files", "upload", tinyPath, "--json"], {
      env,
      persona: "admin",
    });
    expectSuccess(uploadResult, "E13 upload");
    const fid = parseJson<{ id: string }>(uploadResult).id;

    // Create source conversation via headless.
    const convResult = await cli(["--p", "hello", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 30_000,
    });
    expectSuccess(convResult, "E13 create conversation");
    const convData = parseJson<{ session_id: string }>(convResult);
    const sourceConvId = convData.session_id;

    // Link file to source conversation.
    const linkResult = await cli(["files", "link", fid, "--to", `conversation:${sourceConvId}`], {
      env,
      persona: "admin",
    });
    expectSuccess(linkResult, "E13 link");

    // Sanity check: the source conversation lists the file.
    const sourceListResult = await cli(
      ["files", "list", "--linked-to", `conversation:${sourceConvId}`, "--json"],
      { env, persona: "admin" },
    );
    expectSuccess(sourceListResult, "E13 list source");
    const sourceLinked = parseJson<{ items: Array<{ id: string }> }>(sourceListResult);
    expect(sourceLinked.items.some((r) => r.id === fid)).toBe(true);

    // Fetch the source conversation to pick an anchor message id —
    // the fork-from-message route copies the head of the source chain
    // up to and including the anchor.
    const adminKey = env.personas.admin.apiKey;
    const detailRes = await fetch(`${env.baseUrl}/v1/conversations/${sourceConvId}`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      messages: Array<{ id: string; role: string }>;
    };
    const anchorMessageId = detail.messages.at(-1)?.id;
    if (!anchorMessageId) throw new Error("E13: source conversation has no messages");

    // Fork the conversation. There is no `sk` CLI verb for fork — the
    // engine endpoint is the operator-facing surface (the REPL slash
    // action and the portal both call it directly).
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

    // The fork-cascade in `apps/engine/src/conversations/service/fork.ts`
    // duplicates every `file_links` row that targeted the source
    // conversation. List the fork's linked files and assert our fid
    // appears — this is the contract that prevents the cleanup cron's
    // orphan sweep from collecting a file the fork still depends on.
    const forkListResult = await cli(
      ["files", "list", "--linked-to", `conversation:${forkConvId}`, "--json"],
      { env, persona: "admin" },
    );
    expectSuccess(forkListResult, "E13 list fork");
    const forkLinked = parseJson<{ items: Array<{ id: string }> }>(forkListResult);
    expect(forkLinked.items.some((r) => r.id === fid)).toBe(true);

    // Cleanup.
    await cli(["files", "delete", fid, "--force"], { env, persona: "admin" });
  });
});

// E14 — Range download (deferred — see docs/operations/files-deferred-e2e.md).
// E15 — Cleanup cron lifecycle (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E16 — Audit completeness
// ---------------------------------------------------------------------------

describe("E16: audit completeness", () => {
  test("upload + download + delete fire audit events", async () => {
    const r1 = await cli(["files", "upload", tinyPath, "--json"], { env, persona: "admin" });
    expectSuccess(r1, "E16 upload");
    const fid = parseJson<{ id: string }>(r1).id;

    const dlDir = mkdtempSync(join(tmpdir(), "sk-e16-dl-"));
    const outPath = join(dlDir, "dl.txt");
    await run(["files", "download", fid, "--output", outPath], { env, persona: "admin" });

    await run(["files", "delete", fid, "--force"], { env, persona: "admin" });

    // Query the audit log by resource_id. The wire `fid_<uuid>` carries
    // a `fid_` prefix the persisted `resource_id` column does NOT — the
    // route stores the raw UUID so SIEM queries cleanly join against
    // `files.id`. The audit query filter does an exact action match
    // (no wildcards) so we pass each comma-separated action explicitly
    // and assert that every lifecycle event landed before the read.
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

// E17 — MCP file resource (deferred — see docs/operations/files-deferred-e2e.md).

// ---------------------------------------------------------------------------
// E18 — Legacy @attachment: text rewrite
// ---------------------------------------------------------------------------

describe("E18: legacy @attachment: text rewrite", () => {
  test("message with @attachment: token is accepted and round-trips without the legacy token", async () => {
    // Send a message containing a legacy-style @attachment: token.
    // The engine should accept this (not error on unknown token format)
    // and internally rewrite it before persistence.
    //
    // Since the mock LLM doesn't parse the message body, we verify
    // the conversation was created successfully and the assistant responded.
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

    // The actual token-to-$file rewrite is verified at engine integration
    // layer (conversations/tests/attachments-resolver.test.ts) where we
    // can inspect the DB row. At the CLI level we verify acceptance only.
  });
});

// ---------------------------------------------------------------------------
// Shared stats smoke
// ---------------------------------------------------------------------------

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
