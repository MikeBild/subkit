import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { dottedPath, listConfigLeaves } from "../../../config/walk.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let cfgDir: string;
let captured: string[];
let restoreStdout: () => void;

function attachStdoutCapture(buf: string[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    buf.push(s);
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "subkit-cfg-leak-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/leak", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
  server = await createHttpTestServer("settings-secret-leak");
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

const SECRET_LEAVES = listConfigLeaves().filter(
  (l) => l.meta.secret && l.kind === "string" && dottedPath(l) !== "database.url",
);

describe(`secret-mask leak audit — ${SECRET_LEAVES.length} secret leaves`, () => {
  test("every secret leaf masks across HTTP, audit, and structured logs", async () => {
    const failures: string[] = [];
    let salt = 0;
    for (const leaf of SECRET_LEAVES) {
      const dotted = dottedPath(leaf);
      const sentinel = `SENTINEL-${salt++}-${dotted.replaceAll(".", "-")}-do-not-leak`;
      const v = sentinel.length >= 32 ? sentinel : sentinel.padEnd(32, "x");
      captured.length = 0;
      await server.db.delete(auditLog);

      const putRes = await authedFetch(`/v1/settings/${dotted}`, {
        method: "PUT",
        body: JSON.stringify({ value: v, force: true }),
      });
      if (putRes.status !== 200) {
        failures.push(`${dotted}: PUT ${putRes.status}`);
        continue;
      }
      const putBody = await putRes.text();
      if (putBody.includes(v)) failures.push(`${dotted}: PUT response body leaks sentinel`);

      const getRes = await authedFetch(`/v1/settings/${dotted}`);
      const getBody = await getRes.text();
      if (getBody.includes(v)) failures.push(`${dotted}: GET single leaks sentinel`);

      const listRes = await authedFetch("/v1/settings");
      const listBody = await listRes.text();
      if (listBody.includes(v)) failures.push(`${dotted}: GET list leaks sentinel`);

      const rows = await server.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.changed"));
      const auditBlob = JSON.stringify(rows);
      if (auditBlob.includes(v)) failures.push(`${dotted}: audit_log leaks sentinel`);

      const logBlob = captured.join("");
      if (logBlob.includes(v)) failures.push(`${dotted}: structured log leaks sentinel`);
    }
    expect(
      failures,
      `${failures.length} secret leaks across ${SECRET_LEAVES.length} leaves:\n${failures.slice(0, 20).join("\n")}`,
    ).toEqual([]);
  }, 90_000);

  test("listConfigLeaves classifies the canonical secret leaves correctly", () => {
    const dotted = SECRET_LEAVES.map((l) => dottedPath(l));
    expect(dotted).toContain("llm.api_key");
    expect(dotted).toContain("auth.session.secret");
    expect(dotted).toContain("storage.object_store.access_key_id");
    expect(dotted).toContain("storage.object_store.secret_access_key");
    expect(dotted).toContain("storage.object_store.session_token");
    expect(dotted).toContain("mcp.api_key");
    expect(dotted).toContain("observability.langfuse.secret_key");
  });
});
