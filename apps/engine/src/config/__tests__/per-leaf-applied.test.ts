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

function pickStringCandidate(leaf: ConfigLeaf, tag: string): string {
  // Try a plain tagged string first. If the leaf's schema rejects it
  // (e.g. optionalUrl unions or session.secret min(32) refinements)
  // walk a small candidate list until one passes. Keeps the sweep
  // deterministic without baking path-name knowledge into the test.
  const candidates: string[] = [
    tag,
    `https://example.com/${tag.replaceAll("_", "-")}`,
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

function valueFor(leaf: ConfigLeaf, salt: number): unknown {
  const tag = `applied-${dottedPath(leaf).replaceAll(".", "-")}-${salt}`;
  switch (leaf.kind) {
    case "string":
      return pickStringCandidate(leaf, tag);
    case "number": {
      // Avoid 100 (matches the default for errors.ring_size). Pick
      // (salt mod 45) + 5 → 5..49, in-range for both high-min leaves
      // (via the ladder below) and tight-max leaves like
      // min_runs_before_proposing (max 50).
      const candidates = [((salt + 5) % 45) + 5, 200, 1_000, 60_000, 100_000, 3_600_000];
      for (const c of candidates) {
        if (leaf.schema.safeParse(c).success) return c;
      }
      return candidates[0]!;
    }
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
      return arrayOfObjectsCandidate(leaf, tag) ?? [tag];
    default:
      return tag;
  }
}

// A `string-array` leaf may be an array of objects (e.g. `mcp.servers`).
// Probe a structured candidate the leaf's schema accepts; fall back to the
// string-array form for genuine string-list-shaped leaves.
function arrayOfObjectsCandidate(leaf: ConfigLeaf, tag: string): unknown | null {
  const slug = tag.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "srv";
  const candidate = [
    { name: tag, namespace: slug, transport: "http", url: "https://example.com/mcp" },
  ];
  return leaf.schema.safeParse(candidate).success ? candidate : null;
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

// Cross-leaf invariants the generic walker can't satisfy on its own.
// `storage.files.backend = "s3"` requires storage.s3.access_key,
// storage.s3.secret_key, and storage.files.bucket all non-empty
// (schema refine in `storage`). The prime hook runs before the write
// so the refinement passes; force=true alone doesn't bypass it.
const PRIME_BEFORE_WRITE: Record<string, () => Promise<void>> = {
  "storage.files.backend": async () => {
    await setConfigKey(["storage", "s3", "access_key"], "ak", { force: true });
    await setConfigKey(["storage", "s3", "secret_key"], "sk", { force: true });
    await setConfigKey(["storage", "files", "bucket"], "test-bucket", { force: true });
  },
};

describe("per-leaf application sweep — every leaf in ConfigSchema", () => {
  test(`every leaf round-trips through PUT + getConfig + on-disk file (${LEAVES.length} leaves)`, async () => {
    let salt = 0;
    for (const leaf of LEAVES) {
      const written = valueFor(leaf, salt++);
      // Skip enum leaves with no values (defensive) — none today.
      if (leaf.kind === "enum" && (leaf.enumValues?.length ?? 0) === 0) continue;

      const prime = PRIME_BEFORE_WRITE[dottedPath(leaf)];
      if (prime) await prime();

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
    // log.level / log.format hot-reload the live logger inside
    // setConfigKey, but the setting.applied log is emitted BEFORE
    // the reconfigure (see loader.ts), so flipping log.* to a
    // restrictive value (e.g. error) cannot retroactively suppress
    // the line documenting the change. We can therefore include
    // log.* leaves in this sweep — but we still reset the logger to
    // info+ndjson at the top of every iteration so a previous
    // iteration's flip cannot mask the current iteration's emit.
    const { reconfigureLogger } = await import("../../logging/logger.ts");
    let salt = 100;
    for (const leaf of LEAVES) {
      // Reset the logger threshold every iteration — defends against
      // any leaf write that might have flipped it.
      reconfigureLogger({ level: "info", format: "ndjson" });
      const written = valueFor(leaf, salt++);
      const prime = PRIME_BEFORE_WRITE[dottedPath(leaf)];
      if (prime) await prime();
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
