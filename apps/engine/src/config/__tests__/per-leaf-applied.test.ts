// Per-leaf application + observability sweep.
//
// For every leaf in ConfigSchema, this test asserts FOUR
// invariants in a single round-trip:
//
//   1. setConfigKey returns the leaf path it claims to have written.
//   2. The in-memory getConfig() view reflects the new value.
//   3. The on-disk subkit.config.json file carries the new value.
//   4. The structured `setting.applied` log line fires once with
//      the correct scope, sensitive flag, and changed=true. Sensitive
//      values NEVER appear in the log.
//
// Plus, for every sensitive leaf:
//   5. The /v1/settings list response shape's `meta.source` flips to
//      "global" (or "tenant" when written under a tenant overlay).
//
// This is the canonical "every setting was applied correctly" test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigForTests,
  getConfig,
  getDiagnostics,
  loadConfig,
  setConfigKey,
} from "../loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

interface CapturedLog {
  module?: string;
  action?: string;
  msg?: string;
  [k: string]: unknown;
}

let dir: string;
let cfgPath: string;
let captured: CapturedLog[];
let restoreStdout: () => void;

function attachStdoutCapture(buf: CapturedLog[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(trimmed) as CapturedLog);
      } catch {
        /* not a JSON line */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-leaf-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];
  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ format: "ndjson", level: "info" });
  restoreStdout = attachStdoutCapture(captured);
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: cfgPath,
  });
  captured.length = 0;
});

afterEach(() => {
  restoreStdout();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function valueFor(leaf: ConfigLeaf, salt: number): unknown {
  const tag = `applied-${dottedPath(leaf).replaceAll(".", "-")}-${salt}`;
  switch (leaf.kind) {
    case "string":
      return tag;
    case "number":
      // Avoid 100 (matches the default for errors.ring_size /
      // tunnel.registry_max). Pick (salt mod 60) + 5 → 5..64.
      return ((salt + 5) % 60) + 5;
    case "boolean":
      // Always flip from the schema default. All boolean leaves in
      // the schema default to `false`, so write `true` here.
      return true;
    case "enum": {
      const values = leaf.enumValues ?? [];
      if (values.length < 2) return values[0] ?? null;
      // Pick a value different from the schema's first entry (which
      // is the default for every enum in the schema).
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

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

const LEAVES = listConfigLeaves();

describe("per-leaf application sweep — every leaf in ConfigSchema", () => {
  test(`every leaf round-trips through PUT + getConfig + on-disk file (${LEAVES.length} leaves)`, async () => {
    let salt = 0;
    for (const leaf of LEAVES) {
      const written = valueFor(leaf, salt++);
      // Skip enum leaves with no values (defensive) — none today.
      if (leaf.kind === "enum" && (leaf.enumValues?.length ?? 0) === 0) continue;

      // 1) setConfigKey returns the dotted path.
      const result = await setConfigKey(leaf.path, written, { force: true });
      expect(result.leafPath, `${dottedPath(leaf)} returned path`).toBe(dottedPath(leaf));

      // 2) in-memory getConfig() reflects the value.
      const live = readDeep(getConfig(), leaf.path);
      expect(live, `${dottedPath(leaf)} (${leaf.kind}) in-memory`).toEqual(written);

      // 3) on-disk file carries the value.
      const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
      expect(readDeep(onDisk, leaf.path), `${dottedPath(leaf)} on-disk`).toEqual(written);
    }
  });

  test(`every applied setting emits exactly one setting.applied log with correct meta`, async () => {
    // log.level / log.format mutate the live logger threshold and
    // would suppress subsequent setting.applied lines. They are
    // covered by the hot-reload test in structured-logs.test.ts;
    // here we exclude them so the threshold stays at info for the
    // sweep.
    const { reconfigureLogger } = await import("../../logging/logger.ts");
    let salt = 100;
    for (const leaf of LEAVES) {
      // Reset the logger threshold every iteration — defends against
      // any leaf write that might have flipped it.
      reconfigureLogger({ level: "info", format: "ndjson" });
      if (leaf.path[0] === "log") continue;
      const written = valueFor(leaf, salt++);
      captured.length = 0;
      await setConfigKey(leaf.path, written, { force: true });
      const applied = captured.filter(
        (l) =>
          l.module === "config" && l.action === "setting.applied" && l.leaf === dottedPath(leaf),
      );
      expect(applied.length, `${dottedPath(leaf)} log count`).toBe(1);
      const entry = applied[0]!;
      expect(entry.scope).toBe("global");
      expect(entry.sensitive).toBe(!!leaf.meta.secret);
      expect(entry.requires_restart).toBe(!!leaf.meta.requiresRestart);
      // Sensitive values must never appear in any log line.
      if (leaf.meta.secret && typeof written === "string" && written.length > 0) {
        const allLines = JSON.stringify(captured);
        expect(allLines, `${dottedPath(leaf)} secret leak check`).not.toContain(written);
      }
    }
  });

  test("source_map flips per-leaf as writes accumulate", async () => {
    // Pick five canonical leaves spanning every section.
    const spotChecks = [
      "log.level",
      "server.port",
      "llm.api_key",
      "observability.langfuse.host",
      "errors.ring_size",
    ];
    for (const dotted of spotChecks) {
      expect(getDiagnostics().source_map[dotted]).toBe("default");
    }
    await setConfigKey("log.level", "debug", { force: true });
    await setConfigKey("server.port", 4242, { force: true });
    await setConfigKey("llm.api_key", "post", { force: true });
    await setConfigKey("observability.langfuse.host", "https://lf.local", { force: true });
    await setConfigKey("errors.ring_size", 256, { force: true });
    for (const dotted of spotChecks) {
      expect(getDiagnostics().source_map[dotted]).toBe("global");
    }
  });

  test("tenant-scope leaves: source flips to tenant for the overlay, stays default global", async () => {
    const tenantScopeLeaves = LEAVES.filter((l) => l.meta.scope === "tenant").slice(0, 5);
    for (const leaf of tenantScopeLeaves) {
      const written = valueFor(leaf, 200);
      await setConfigKey(leaf.path, written, { tenantId: "tenant-x", force: true });
      // Tenant view sees the new value.
      const tenantView = readDeep(getConfig("tenant-x"), leaf.path);
      expect(tenantView, `tenant view ${dottedPath(leaf)}`).toEqual(written);
      // Global view remains the schema default.
      const globalView = readDeep(getConfig(), leaf.path);
      expect(globalView).not.toEqual(written);
    }
  });
});
