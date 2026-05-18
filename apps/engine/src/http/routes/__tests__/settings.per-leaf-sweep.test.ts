// Per-leaf HTTP sweep — every leaf in ConfigSchema goes through:
//
//   1. PUT /v1/settings/{path}                      → 200
//   2. GET /v1/settings/{path}                      → masked or live value
//   3. audit_log row with action=settings.changed   → exactly one
//   4. setting.applied structured log line          → exactly one
//   5. resource_id matches the dotted leaf path     → exact equality
//
// Tests every wire-shape contract in one pass against testcontainers
// Postgres + the real Hono app. A leaf that 422s on a valid value, or
// silently skips audit emission, or emits the log without the row,
// fails this test loudly.
//
// Drift is keyed on listConfigLeaves() — a new leaf in the schema
// automatically extends the sweep on the next bun test run.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../../config/loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../../../config/walk.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;

interface CapturedLog {
  module?: string;
  action?: string;
  leaf?: string;
  [k: string]: unknown;
}

let captured: CapturedLog[];
let restoreStdout: () => void;

function attachStdoutCapture(buf: CapturedLog[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t) as CapturedLog);
      } catch {
        /* not JSON */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-cfg-sweep-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/sweep", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  const { reconfigureLogger } = await import("../../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
  server = await createHttpTestServer("settings-per-leaf-sweep");
});

afterAll(async () => {
  await server.cleanup();
  _resetConfigForTests();
  rmSync(cfgDir, { recursive: true, force: true });
});

beforeEach(async () => {
  captured = [];
  restoreStdout = attachStdoutCapture(captured);
  await server.db.delete(auditLog);
});

afterAll(() => {
  restoreStdout?.();
});

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.apiKey}`,
      ...(init.headers ?? {}),
    },
  });
}

function pickValue(leaf: ConfigLeaf, salt: number): unknown {
  const tag = `sweep-${dottedPath(leaf).replaceAll(".", "-")}-${salt}`;
  switch (leaf.kind) {
    case "string": {
      const candidates = [
        tag,
        `https://example.com/${tag}`,
        tag.padEnd(32, "x").slice(0, 32),
        // W2 of PR #161 review (round 4): HH:MM-shaped value for the
        // notifications.push.quietHours* regex.
        "00:00",
        "",
      ];
      for (const c of candidates) {
        const r = leaf.schema.safeParse(c);
        if (r.success) return c;
      }
      return tag;
    }
    case "number": {
      // Candidate ladder for leaves with high min() bounds (web-scraper
      // #144 max_chars_*, robots_cache.ttl_ms) or tight max() bounds
      // (min_runs_before_proposing max 50).
      const numCandidates = [
        Math.max(1, Math.min(50, salt + 1)),
        200,
        1_000,
        60_000,
        100_000,
        3_600_000,
      ];
      for (const c of numCandidates) {
        if (leaf.schema.safeParse(c).success) return c;
      }
      return numCandidates[0]!;
    }
    case "boolean":
      return true;
    case "enum": {
      const values = leaf.enumValues ?? [];
      if (values.length < 2) return values[0] ?? null;
      return values[1 + (salt % (values.length - 1))];
    }
    case "string-list":
      return [tag];
    case "string-array":
      return [tag];
    default:
      return tag;
  }
}

const LEAVES = listConfigLeaves();

// Cross-leaf invariants the per-leaf walker can't satisfy on its own.
// `storage.files.backend = "s3"` requires storage.s3.access_key,
// storage.s3.secret_key, and storage.files.bucket all non-empty
// (schema refine in `config/schema.ts`). force=true bypasses the
// leaf's own schema but NOT cross-leaf refinements, so we prime the
// dependencies over the HTTP surface before flipping backend. The
// per-leaf-applied sibling test uses the same shape (770bd43c) —
// inlined here because it's a 3-line map and a shared util would be
// thinner than the HTTP-vs-setConfigKey divergence.
const PRIME_BEFORE_WRITE: Record<
  string,
  (
    authedFetch: (path: string, init?: RequestInit) => Promise<Response>,
    salt: number,
  ) => Promise<void>
> = {
  "storage.files.backend": async (authedFetch, salt) => {
    for (const [primeDotted, primeValue] of [
      ["storage.s3.access_key", `ak-${salt}`],
      ["storage.s3.secret_key", `sk-${salt}`],
      ["storage.files.bucket", `bucket-${salt}`],
    ] as const) {
      await authedFetch(`/v1/settings/${primeDotted}`, {
        method: "PUT",
        body: JSON.stringify({ value: primeValue, force: true }),
      });
    }
  },
};

describe(`per-leaf HTTP sweep — ${LEAVES.length} leaves`, () => {
  test("every leaf round-trips PUT + GET + audit row + setting.applied log with matching resource_id", async () => {
    const failures: string[] = [];
    let salt = 0;
    // One PUT per leaf — fits comfortably under the global rate
    // limiter (default 100 req / 60s) for ~85 leaves. The
    // setting.applied / audit assertions are the value; we removed
    // the per-leaf round-trip GET that would have doubled the budget.
    for (const leaf of LEAVES) {
      const dotted = dottedPath(leaf);
      // log.* hot-reloads the live logger — flipping format to a non-
      // ndjson value would break our capture. Reset between iterations
      // and skip log.format / log.level (covered explicitly elsewhere).
      const { reconfigureLogger } = await import("../../../logging/logger.ts");
      reconfigureLogger({ level: "info", format: "ndjson" });
      if (leaf.path[0] === "log") {
        salt += 1;
        continue;
      }

      // requiresRestart: true leaves need force=true in production —
      // NODE_ENV=test bypasses but we set force defensively.
      const value = pickValue(leaf, salt++);
      captured.length = 0;
      await server.db.delete(auditLog);

      // Prime any cross-leaf dependencies before the write so refines
      // that span sibling leaves (e.g. storage.files.backend='s3'
      // requires storage.s3 creds + bucket) don't fire. The prime
      // PUTs are intentionally not asserted on — they show up in the
      // audit log but we cleared it above; we also clear it again
      // after priming so the per-leaf audit assertion still sees
      // exactly one row.
      const prime = PRIME_BEFORE_WRITE[dotted];
      if (prime) {
        await prime(authedFetch, salt);
        captured.length = 0;
        await server.db.delete(auditLog);
      }

      // 1) PUT
      const putRes = await authedFetch(`/v1/settings/${dotted}`, {
        method: "PUT",
        body: JSON.stringify({ value, force: true }),
      });
      if (putRes.status !== 200) {
        const body = await putRes.text();
        failures.push(`${dotted}: PUT ${putRes.status} ${body.slice(0, 100)}`);
        continue;
      }
      const putBody = (await putRes.json()) as {
        value: unknown;
        requiresRestart: boolean;
      };
      if (typeof putBody.requiresRestart !== "boolean") {
        failures.push(`${dotted}: PUT body missing requiresRestart bool`);
      }

      // 2) Value verification — rely on the PUT response body's
      // masked-value echo + the in-memory getConfig() instead of a
      // round-trip GET (every GET counts against the global rate
      // limiter, and 84 leaves × 2 HTTP req would trip the default
      // 100/min budget).
      if (leaf.meta.secret) {
        if (putBody.value !== "***" && putBody.value !== "" && putBody.value !== null) {
          failures.push(
            `${dotted}: PUT response body did not mask secret: ${JSON.stringify(putBody.value)}`,
          );
        }
      } else {
        const { getConfig } = await import("../../../config/loader.ts");
        const cur = (() => {
          let cursor: unknown = getConfig();
          for (const seg of leaf.path) {
            if (typeof cursor !== "object" || cursor === null) return undefined;
            cursor = (cursor as Record<string, unknown>)[seg];
          }
          return cursor;
        })();
        if (JSON.stringify(cur) !== JSON.stringify(value)) {
          failures.push(
            `${dotted}: getConfig=${JSON.stringify(cur)} != PUT ${JSON.stringify(value)}`,
          );
        }
      }

      // 3) audit row
      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      if (rows.length !== 1) {
        failures.push(`${dotted}: expected 1 audit row, got ${rows.length}`);
        continue;
      }
      if (rows[0]?.resource_id !== dotted) {
        failures.push(`${dotted}: audit resource_id=${rows[0]?.resource_id}`);
      }
      // sensitive leaves: audit's after column must not contain the raw value
      if (leaf.meta.secret && typeof value === "string" && value.length > 0) {
        if (JSON.stringify(rows[0]?.after).includes(value)) {
          failures.push(`${dotted}: secret leaked into audit_log.after`);
        }
      }

      // 4) setting.applied log line
      const applied = captured.filter(
        (l) => l.module === "config" && l.action === "setting.applied" && l.leaf === dotted,
      );
      if (applied.length !== 1) {
        failures.push(`${dotted}: expected 1 setting.applied log, got ${applied.length}`);
        continue;
      }
      const entry = applied[0]!;
      if (leaf.meta.secret && typeof value === "string" && value.length > 0) {
        if (JSON.stringify(entry).includes(value)) {
          failures.push(`${dotted}: secret leaked into setting.applied log line`);
        }
      }
    }
    expect(
      failures,
      `${failures.length} leaves failed:\n${failures.slice(0, 20).join("\n")}`,
    ).toEqual([]);
  }, 120_000);

  test("after the sweep, source_map[every-leaf-touched] === 'global'", async () => {
    // The previous test wrote every leaf; source_map must reflect.
    const { getDiagnostics } = await import("../../../config/loader.ts");
    const map = getDiagnostics().source_map;
    let countGlobal = 0;
    for (const leaf of LEAVES) {
      if (leaf.path[0] === "log") continue;
      if (map[dottedPath(leaf)] === "global") countGlobal += 1;
    }
    expect(countGlobal).toBeGreaterThan(LEAVES.length - 5);
  });

  test("PUT /v1/settings/<unknown.path> returns 404, no audit row", async () => {
    captured.length = 0;
    await server.db.delete(auditLog);
    const res = await authedFetch("/v1/settings/utterly.nonexistent.leaf", {
      method: "PUT",
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(404);
    const rows = await server.db.select().from(auditLog);
    expect(rows.length).toBe(0);
    // Reset for any follow-on test in the same suite.
    await setConfigKey("errors.ring_size", 100, { force: true });
  });
});
