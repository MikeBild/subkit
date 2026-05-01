// Audit trail + log correlation — CLI-driven e2e.
//
// Proves the full observability chain works from operator to
// database:
//   1. Operator runs `sk skills create` via CLI
//   2. Engine writes a SKILL_CREATED audit row + emits skill.created log
//   3. Operator runs `sk audit query --action skill.created` and
//      sees the row with a populated trace_id
//   4. Operator runs a write → archive → delete lifecycle and observes
//      4 distinct audit rows, each with a unique trace_id
//
// Complements migrate-idempotency.test.ts by exercising the runtime
// side of the observability story (logs + audit API, both CLI-driven).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, cli, type E2EEnv, run, runJson, shutdown } from "./setup.ts";

const TEST_NOW_MS = Date.now();

let env: E2EEnv;

beforeAll(async () => {
  env = await boot("audit-trail");
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

interface AuditRow {
  id: string;
  ts: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  result: string;
  trace_id: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown>;
}

interface AuditListResponse {
  items: AuditRow[];
  next_cursor: string | null;
}

describe("audit trail over CLI", () => {
  test("`sk skills list --json` returns an array", async () => {
    // The CLI unwraps the engine's `{items: [...]}` envelope and
    // emits the rows array directly.
    const rows = await runJson<unknown[]>(["skills", "list"], {
      env,
      persona: "admin",
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  test("skill lifecycle (create → update → archive → delete) emits 4 audit rows", async () => {
    // 1. create
    const file = path.join(tmpdir(), `rt-skill-${TEST_NOW_MS}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        scope: "global",
        title: "e2e-audit-trail",
        body: "fixture skill for audit-trail e2e suite",
      }),
    );
    const created = await runJson<{ id: string; title: string }>(
      ["skills", "create", "--file", file],
      { env, persona: "admin" },
    );
    expect(created.id).toBeDefined();

    // 2. update
    const patchFile = path.join(tmpdir(), `rt-skill-patch-${TEST_NOW_MS}.json`);
    writeFileSync(patchFile, JSON.stringify({ body: "updated by e2e" }));
    await runJson(["skills", "edit", created.id, "--file", patchFile], {
      env,
      persona: "admin",
    });

    // 3. archive
    await run(["skills", "archive", created.id], { env, persona: "admin" });

    // 4. delete
    await run(["skills", "delete", created.id], { env, persona: "admin" });

    // Query the audit log for this resource via the CLI.
    const audit = await runJson<AuditListResponse>(
      ["audit", "query", "--resource-id", created.id, "--since", "10m", "--limit", "10"],
      { env, persona: "admin" },
    );

    const actions = audit.items.map((r) => r.action).sort();
    // Four lifecycle events expected. Exact lifecycle names may vary —
    // require the four distinct ones.
    expect(actions.length).toBeGreaterThanOrEqual(4);
    expect(actions).toContain("skill.created");
    expect(actions.some((a) => a.startsWith("skill.updated"))).toBe(true);
    expect(actions).toContain("skill.archived");
    expect(actions).toContain("skill.deleted");

    // Every audit row must carry a populated trace_id — that's what
    // makes cross-request correlation possible.
    for (const row of audit.items) {
      expect(row.trace_id).toBeTruthy();
      expect(row.trace_id!.length).toBeGreaterThan(0);
    }

    // All four lifecycle events must carry distinct trace_ids
    // (each was a separate HTTP request).
    const lifecycleRows = audit.items.filter(
      (r) =>
        r.action === "skill.created" ||
        r.action.startsWith("skill.updated") ||
        r.action === "skill.archived" ||
        r.action === "skill.deleted",
    );
    const uniqTraces = new Set(lifecycleRows.map((r) => r.trace_id));
    expect(uniqTraces.size).toBe(lifecycleRows.length);
  }, 60_000);

  test("audit-log pagination uses the shared {items, next_cursor} envelope", async () => {
    const body = await runJson<AuditListResponse>(
      ["audit", "query", "--since", "10m", "--limit", "1"],
      { env, persona: "admin" },
    );
    expect(Array.isArray(body.items)).toBe(true);
    // next_cursor is nullable-or-omitted per the shared contract
    if ("next_cursor" in body) {
      expect(body.next_cursor === null || typeof body.next_cursor === "string").toBe(true);
    }
  });

  test("unauthenticated audit-log returns the unified error envelope", async () => {
    // With a bogus API key the CLI exits non-zero; the formatted
    // error carries code + message from the shared ErrorEnvelope.
    const result = await cli(["audit", "query"], {
      env,
      persona: "admin",
      extraEnv: { SUBKIT_API_KEY: "wf_live_clearly_invalid" },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    // Any error code from the unified envelope proves the error flowed back.
    expect(combined).toMatch(/unauthorized|missing_or_invalid_credentials|trace=/i);
  }, 30_000);
});
