// Per-leaf HTTP sweep — every runtime-editable leaf in ConfigSchema goes through:
//
//   1. PUT /v1/settings/{path}                      → 200
//   2. GET /v1/settings/{path}                      → masked or live value
//   3. audit_log row with action=settings.changed   → exactly one
//   4. setting.applied structured log line          → exactly one
//   5. resource_id matches the dotted leaf path     → exact equality
//
// Bootstrap-only process bindings are asserted separately to reject writes.
// Tests every wire-shape contract in one pass against testcontainers Postgres
// + the real Hono app. An editable leaf that 422s on a valid value, silently
// skips audit emission, or emits the log without the row fails loudly.
//
// Drift is keyed on listConfigLeaves() — a new leaf in the schema
// automatically extends the sweep on the next bun test run.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { METRICS_SCOPE } from "../../../auth/scopes.ts";
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
        // HH:MM-shaped value for the notifications.push.quietHours* regex.
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
      // max_chars_*, robots_cache.ttl_ms), tight max() bounds
      // (min_runs_before_proposing max 50), or sub-unit fractions
      // (observability.predictive.memory_cap_fraction min 0.1 max 1).
      const numCandidates = [
        0.5,
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
    case "json":
      return structuralSample(dottedPath(leaf), salt);
    default:
      return tag;
  }
}

/**
 * A valid value for a structural leaf — one whose element shape the generator
 * above cannot invent.
 *
 * This used to be a single unconditional `case "json"` returning the
 * `auth.providers` array, written when that was the only structural leaf in
 * the schema. `tokens.prices` became the second one and was handed a list of
 * auth providers, which its element schema rejected: the sweep reported
 * `tokens.prices: PUT 422 expected string, received undefined` — a message
 * about the wrong leaf entirely, three commits red on main before anyone read
 * it closely.
 *
 * So the samples are keyed by path, and a structural leaf with no sample fails
 * by name (below) instead of being silently handed another leaf's shape. The
 * next one added cannot repeat this.
 */
const STRUCTURAL_SAMPLES: Record<string, (salt: number) => unknown> = {
  "auth.providers": (salt) => [
    { protocol: "api_key", id: "api-key", label: "SubKit API key" },
    {
      protocol: "oidc",
      id: `oidc-${salt}`,
      label: "Public OIDC",
      issuer_url: "https://identity.example.test",
      client_id: `client-${salt}`,
      scopes: "openid profile email",
      tenant_slug: "default",
    },
  ],
  "tokens.prices": (salt) => [
    {
      model: `sweep-model-${salt}`,
      input_per_mtok: 3,
      output_per_mtok: 15,
      cache_read_per_mtok: 0.3,
      cache_write_per_mtok: 3.75,
    },
  ],
};

function structuralSample(dotted: string, salt: number): unknown {
  const make = STRUCTURAL_SAMPLES[dotted];
  if (!make) {
    throw new Error(
      `no sweep sample for structural leaf '${dotted}' — add one to STRUCTURAL_SAMPLES; ` +
        `without it the sweep PUTs another leaf's shape and reports a 422 about the wrong thing`,
    );
  }
  return make(salt);
}

const LEAVES = listConfigLeaves();
const BOOTSTRAP_ONLY_PATHS = new Set(["database.url"]);
const EDITABLE_LEAVES = LEAVES.filter((leaf) => !BOOTSTRAP_ONLY_PATHS.has(dottedPath(leaf)));
const SWEPT_LEAVES = EDITABLE_LEAVES.filter((leaf) => leaf.path[0] !== "log");

describe(`per-leaf HTTP sweep — ${EDITABLE_LEAVES.length}/${LEAVES.length} editable leaves`, () => {
  test("every leaf round-trips PUT + GET + audit row + setting.applied log with matching resource_id", async () => {
    const failures: string[] = [];
    let salt = 0;
    // One PUT per leaf — fits comfortably under the global rate
    // limiter (default 100 req / 60s) for ~85 leaves. The
    // setting.applied / audit assertions are the value; we removed
    // the per-leaf round-trip GET that would have doubled the budget.
    for (const leaf of EDITABLE_LEAVES) {
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
        // `auth.mcp_oauth.scopes_supported` reads back as MORE than was PUT:
        // it carries scopes an installation may not drop
        // (`config/non-removable-scopes.ts`). The operator's value survives in
        // their order, so compare the prefix and require the pinned scope
        // rather than skipping the leaf.
        const pinned = dotted === "auth.mcp_oauth.scopes_supported";
        const applied = pinned ? (cur as string[]).slice(0, (value as string[]).length) : cur;
        if (pinned && !(cur as string[]).includes(METRICS_SCOPE)) {
          failures.push(`${dotted}: getConfig=${JSON.stringify(cur)} dropped ${METRICS_SCOPE}`);
        }
        if (JSON.stringify(applied) !== JSON.stringify(value)) {
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
    for (const leaf of SWEPT_LEAVES) {
      if (map[dottedPath(leaf)] === "global") countGlobal += 1;
    }
    expect(countGlobal).toBe(SWEPT_LEAVES.length);
  });

  test("bootstrap-only leaves reject runtime writes without an audit row", async () => {
    for (const path of BOOTSTRAP_ONLY_PATHS) {
      await server.db.delete(auditLog);
      const res = await authedFetch(`/v1/settings/${path}`, {
        method: "PUT",
        body: JSON.stringify({ value: "postgres://replacement/subkit", force: true }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "validation_failed" });
      expect(await server.db.select().from(auditLog)).toHaveLength(0);
    }
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
