import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { METRICS_SCOPE } from "../../../auth/scopes.ts";
import {
  configurationSweepLeaves,
  sampleConfigLeaf,
} from "../../../config/__tests__/leaf-samples.ts";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../../config/loader.ts";
import { PROCESS_BINDING_PATHS } from "../../../config/process-bindings.ts";
import { dottedPath } from "../../../config/walk.ts";
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
      } catch {}
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "subkit-cfg-sweep-"));
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

const LEAVES = configurationSweepLeaves();
const BOOTSTRAP_ONLY_PATHS = new Set<string>(PROCESS_BINDING_PATHS);
const EDITABLE_LEAVES = LEAVES.filter((leaf) => !BOOTSTRAP_ONLY_PATHS.has(dottedPath(leaf)));
const SWEPT_LEAVES = EDITABLE_LEAVES.filter((leaf) => leaf.path[0] !== "log");

describe(`per-leaf HTTP sweep — ${EDITABLE_LEAVES.length}/${LEAVES.length} editable leaves`, () => {
  test("every leaf round-trips PUT + GET + audit row + setting.applied log with matching resource_id", async () => {
    const failures: string[] = [];
    let salt = 0;
    for (const leaf of EDITABLE_LEAVES) {
      const dotted = dottedPath(leaf);
      const { reconfigureLogger } = await import("../../../logging/logger.ts");
      reconfigureLogger({ level: "info", format: "ndjson" });
      if (leaf.path[0] === "log") {
        salt += 1;
        continue;
      }

      const value = sampleConfigLeaf(leaf, salt++);
      captured.length = 0;
      await server.db.delete(auditLog);

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
      if (leaf.meta.secret && typeof value === "string" && value.length > 0) {
        if (JSON.stringify(rows[0]?.after).includes(value)) {
          failures.push(`${dotted}: secret leaked into audit_log.after`);
        }
      }

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
    await setConfigKey("errors.ring_size", 100, { force: true });
  });
});
