import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRICS_SCOPE } from "../../auth/scopes.ts";
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
      } catch {}
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
  const candidates: string[] = [
    tag,
    `https://example.com/${tag.replaceAll("_", "-")}`,
    tag.padEnd(32, "x").slice(0, 32),
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
      const sandboxValues: Record<string, number> = {
        "sandbox.queue_limit": 64,
        "sandbox.tenant_queue_limit": 4,
        "sandbox.ipc_max_bytes": 1024 * 1024,
        "sandbox.worker_rss_bytes": 256 * 1024 * 1024,
      };
      const sandboxValue = sandboxValues[dottedPath(leaf)];
      if (sandboxValue !== undefined) return sandboxValue;
      const candidates = [((salt + 5) % 45) + 5, 0.5, 200, 1_000, 60_000, 100_000, 3_600_000];
      for (const c of candidates) {
        if (leaf.schema.safeParse(c).success) return c;
      }
      return candidates[0]!;
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
    case "json": {
      const samples: Record<string, unknown> = {
        "auth.providers": [
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
        "tokens.prices": [
          {
            model: `model-${salt}`,
            input_per_mtok: 3,
            output_per_mtok: 15,
            cache_read_per_mtok: 0.3,
            cache_write_per_mtok: 3.75,
          },
        ],
      };
      const dotted = dottedPath(leaf);
      const sample = samples[dotted];
      if (sample === undefined) {
        throw new Error(
          `no sample value for structural leaf "${dotted}". Add one to \`samples\` in this file — ` +
            "a structural leaf is written as one whole value and cannot be synthesised generically.",
        );
      }
      return sample;
    }
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

const PINNED_SCOPES_LEAF = "auth.mcp_oauth.scopes_supported";

function expectApplied(leaf: ConfigLeaf, actual: unknown, written: unknown, where: string): void {
  const label = `${dottedPath(leaf)} (${leaf.kind}) ${where}`;
  if (dottedPath(leaf) !== PINNED_SCOPES_LEAF) {
    expect(actual, label).toEqual(written);
    return;
  }
  const applied = actual as string[];
  const asked = written as string[];
  expect(applied.slice(0, asked.length), `${label} keeps what was written`).toEqual(asked);
  expect(applied, `${label} pins the non-removable scope`).toContain(METRICS_SCOPE);
}

describe("per-leaf application sweep — every leaf in ConfigSchema", () => {
  test(`every leaf round-trips through PUT + getConfig + on-disk file (${LEAVES.length} leaves)`, async () => {
    let salt = 0;
    for (const leaf of LEAVES) {
      const written = valueFor(leaf, salt++);
      if (leaf.kind === "enum" && (leaf.enumValues?.length ?? 0) === 0) continue;

      const result = await setConfigKey(leaf.path, written, { force: true });
      expect(result.leafPath, `${dottedPath(leaf)} returned path`).toBe(dottedPath(leaf));

      expectApplied(leaf, readDeep(getConfig(), leaf.path), written, "in-memory");

      const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
      expectApplied(leaf, readDeep(onDisk, leaf.path), written, "on-disk");
    }
  });

  test(`every applied setting emits exactly one setting.applied log with correct meta`, async () => {
    const { reconfigureLogger } = await import("../../logging/logger.ts");
    let salt = 100;
    for (const leaf of LEAVES) {
      reconfigureLogger({ level: "info", format: "ndjson" });
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
      if (leaf.meta.secret && typeof written === "string" && written.length > 0) {
        const allLines = JSON.stringify(captured);
        expect(allLines, `${dottedPath(leaf)} secret leak check`).not.toContain(written);
      }
    }
  });

  test("source_map flips per-leaf as writes accumulate", async () => {
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
    await setConfigKey("observability.langfuse.host", "https://lf.local", {
      force: true,
    });
    await setConfigKey("errors.ring_size", 256, { force: true });
    for (const dotted of spotChecks) {
      expect(getDiagnostics().source_map[dotted]).toBe("global");
    }
  });

  test("tenant-scope leaves: source flips to tenant for the overlay, stays default global", async () => {
    const tenantScopeLeaves = LEAVES.filter((l) => l.meta.scope === "tenant").slice(0, 5);
    for (const leaf of tenantScopeLeaves) {
      const written = valueFor(leaf, 200);
      await setConfigKey(leaf.path, written, {
        tenantId: "tenant-x",
        force: true,
      });
      const tenantView = readDeep(getConfig("tenant-x"), leaf.path);
      expect(tenantView, `tenant view ${dottedPath(leaf)}`).toEqual(written);
      const globalView = readDeep(getConfig(), leaf.path);
      expect(globalView).not.toEqual(written);
    }
  });
});
