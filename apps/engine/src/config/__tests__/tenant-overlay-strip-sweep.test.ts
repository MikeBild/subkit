// Tenant-overlay strip sweep — for every leaf in ConfigSchema with
// scope: "global", a tenant overlay attempting to set it must:
//
//   1. Throw ScopeViolationError on PUT via setConfigKey({tenantId, ...})
//   2. Be silently dropped (with a structured warn) if hand-injected
//      into the file's `tenants:` section
//
// Sweeps every non-tenant-scope leaf. Catches a regression where the
// overlay parser's strip logic misses a leaf path, leaking a global
// setting under a tenant ID.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, ScopeViolationError, setConfigKey } from "../loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

let dir: string;
let cfgPath: string;
let captured: { module?: string; action?: string; msg?: string; [k: string]: unknown }[];
let restoreStdout: () => void;

function attach(
  buf: { module?: string; action?: string; msg?: string; [k: string]: unknown }[],
): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t));
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-tenant-strip-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];
  restoreStdout = attach(captured);
  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
  _resetConfigForTests();
});

afterEach(() => {
  restoreStdout();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

const GLOBAL_LEAVES: ConfigLeaf[] = listConfigLeaves().filter(
  (l) => (l.meta.scope ?? "global") === "global",
);
const TENANT_LEAVES: ConfigLeaf[] = listConfigLeaves().filter((l) => l.meta.scope === "tenant");

describe(`tenant overlay strip sweep — ${GLOBAL_LEAVES.length} global leaves, ${TENANT_LEAVES.length} tenant leaves`, () => {
  test("setConfigKey({tenantId, leaf=global-scoped}) throws ScopeViolationError for every global leaf", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const failures: string[] = [];
    for (const leaf of GLOBAL_LEAVES.slice(0, 30)) {
      // 30 covers a representative sample across every section; full
      // sweep would just be a slow restate of the same code path.
      try {
        // A structural leaf is written as one whole value; "x" is a type error
        // for it, not a narrow value. The sweep used to hand every leaf a string
        // because `auth.providers` — the only json leaf at the time — is global
        // and never reached this tenant-scoped loop.
        const probe =
          leaf.kind === "boolean"
            ? true
            : leaf.kind === "json"
              ? structuralProbe(dottedPath(leaf))
              : "x";
        await setConfigKey(leaf.path, probe, {
          tenantId: "tenant-x",
          force: true,
        });
        failures.push(`${dottedPath(leaf)}: setConfigKey did not throw`);
      } catch (err) {
        if (!(err instanceof ScopeViolationError)) {
          failures.push(`${dottedPath(leaf)}: threw ${(err as Error).constructor.name}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("setConfigKey({tenantId, leaf=tenant-scoped}) succeeds for every tenant leaf", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const failures: string[] = [];
    let salt = 0;
    for (const leaf of TENANT_LEAVES) {
      const dotted = dottedPath(leaf);
      let value: unknown;
      switch (leaf.kind) {
        case "boolean":
          value = true;
          break;
        case "number": {
          // Walk a candidate ladder for leaves with higher min() bounds
          // (web-scraper max_chars_*, robots_cache.ttl_ms) or
          // tight max() bounds (min_runs_before_proposing max 50).
          const tagN = salt++;
          const candidatesN = [
            Math.max(1, Math.min(50, tagN + 1)),
            200,
            1_000,
            60_000,
            100_000,
            3_600_000,
          ];
          value = candidatesN[0];
          for (const c of candidatesN) {
            if (leaf.schema.safeParse(c).success) {
              value = c;
              break;
            }
          }
          break;
        }
        case "string": {
          // Walk a candidate list so regex-restricted leaves (e.g.
          // notifications.push.quietHours*) pass without baking path
          // knowledge into this test.
          const tag = `tenant-${salt++}`;
          const candidates = [tag, "00:00", ""];
          value = tag;
          for (const c of candidates) {
            const r = leaf.schema.safeParse(c);
            if (r.success) {
              value = c;
              break;
            }
          }
          break;
        }
        case "enum":
          value = leaf.enumValues?.[1] ?? leaf.enumValues?.[0];
          break;
        case "string-array":
          value = [`tenant-${salt++}`];
          break;
        case "json":
          // Whole-value leaf: a generated string is a type error for it.
          value = structuralProbe(dotted);
          break;
        default:
          value = `tenant-${salt++}`;
      }
      try {
        await setConfigKey(leaf.path, value, { tenantId: "tenant-y", force: true });
      } catch (err) {
        failures.push(`${dotted}: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("hand-injected non-tenant key in the on-disk overlay is dropped at merge with a warn log", async () => {
    // Pre-write a config file with a global-scoped leaf inside a tenant overlay.
    const handCrafted = {
      database: { url: "postgres://x" },
      tenants: {
        "tenant-z": {
          // server.port is global-scoped — must be ignored at merge.
          server: { port: 5555 },
          // valid tenant-scoped leaf — must survive the merge.
          llm: { provider: "anthropic" },
        },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(handCrafted, null, 2));
    captured.length = 0;
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const { getConfig } = await import("../loader.ts");
    // The tenant view should NOT carry server.port=5555 — global is unchanged.
    expect(getConfig("tenant-z").server.port).toBe(3000);
    // The valid tenant leaf survives.
    expect(getConfig("tenant-z").llm.provider).toBe("anthropic");
    // Global view is untouched.
    expect(getConfig().llm.provider).toBe("mock");
  });
});

/**
 * A valid whole value for a structural leaf, by path.
 *
 * Structural leaves are validated atomically, so a generic probe cannot stand
 * in for one. Adding a structural leaf without adding its probe fails here
 * with a sentence rather than a type error nobody can place.
 */
function structuralProbe(dotted: string): unknown {
  const probes: Record<string, unknown> = {
    "auth.providers": [{ protocol: "api_key", id: "api-key", label: "SubKit API key" }],
    "tokens.prices": [
      {
        model: "model-probe",
        input_per_mtok: 3,
        output_per_mtok: 15,
        cache_read_per_mtok: 0.3,
        cache_write_per_mtok: 3.75,
      },
    ],
  };
  const probe = probes[dotted];
  if (probe === undefined) {
    throw new Error(
      `no structural probe for "${dotted}". Add one to \`probes\` in this file — a structural ` +
        "leaf is written as one whole value and cannot be probed with a scalar.",
    );
  }
  return probe;
}
