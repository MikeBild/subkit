import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

export let det = createDeterministicHexFactory(0xc0ffee);

let seq = 0;

export function nextSeq(): string {
  seq += 1;
  return seq.toString(36).padStart(4, "0");
}

export let server: HttpTestServer;

let cfgDir: string;

export interface PutResult {
  value: unknown;
  requiresRestart: boolean;
}

export interface ValidationFailure {
  code: "validation_failed";
  message: string;
  path: string[];
  expected: string;
}

export interface ScopeViolation {
  code: "scope_violation";
  message: string;
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.apiKey}`,
      ...(init.headers ?? {}),
    },
  });
}

export function setupSettingsRoutes(): void {
  det = createDeterministicHexFactory(0xc0ffee);
  seq = 0;
  beforeAll(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), "subkit-cfg-route-"));
    _resetConfigForTests();
    await loadConfig({
      env: {
        DATABASE_URL: "postgres://placeholder/route-test",
        NODE_ENV: "test",
      },
      configPathOverride: join(cfgDir, "subkit.config.json"),
    });
    server = await createHttpTestServer("settings-route");
  });
  afterAll(async () => {
    await server.cleanup();
    _resetConfigForTests();
    rmSync(cfgDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await server.db.delete(auditLog);
  });
}
