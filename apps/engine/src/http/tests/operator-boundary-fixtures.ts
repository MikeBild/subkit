import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { RuntimeConfigCoordinator } from "../../runtime-config/coordinator.ts";
import { initializeRuntimeConfig } from "../../runtime-config/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "./setup.ts";

export let server: HttpTestServer;

let coordinator: RuntimeConfigCoordinator;

export let secondary: SecondaryTenant;

let configDir: string;

let previousMasterKey: string | undefined;

export type Credential = { label: string; headers: () => Promise<Record<string, string>> };

export function bearer(token: string): () => Promise<Record<string, string>> {
  return async () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
}

export function nonOperatorCredentials(): Credential[] {
  return [
    { label: "admin api key", headers: bearer(secondary.admin.apiKey) },
    { label: "admin browser session", headers: secondary.admin.sessionHeaders },
    { label: "member api key", headers: bearer(secondary.member.apiKey) },
    { label: "member browser session", headers: secondary.member.sessionHeaders },
    { label: "admin MCP OAuth token", headers: bearer(secondary.admin.oauthToken) },
    { label: "member MCP OAuth token", headers: bearer(secondary.member.oauthToken) },
  ];
}

export async function call(
  credential: Credential,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: await credential.headers(),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

export const operator: Credential = {
  label: "operator admin",
  headers: async () => bearer(server.apiKey)(),
};

export async function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = testEnv.NODE_ENV;
  testEnv.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete testEnv.NODE_ENV;
    else testEnv.NODE_ENV = previous;
  }
}

export function isScopeBoundOauth(credential: Credential): boolean {
  return credential.label.endsWith("MCP OAuth token");
}

export function secondaryPrincipal(scopes: string[]): ResolvedPrincipal {
  return {
    provider: "api_key",
    kind: "user",
    id: secondary.admin.userId,
    tenant_id: secondary.tenantId,
    roles: ["admin"],
    scopes,
  };
}

export async function expectRefused(
  response: Response,
  codes: string[],
  options: { scopeBound?: boolean } = {},
): Promise<string> {
  const text = await response.text();
  expect(response.status).toBe(403);
  const body = JSON.parse(text) as {
    code: string;
    message: string;
    details?: { cause?: string };
  };
  if (options.scopeBound && body.message === "scope_missing:metrics:read") {
    expect(body.code).toBe("forbidden");
    expect(body.details).toBeUndefined();
  } else if (body.code === "forbidden") expect(body.details?.cause).toBe("operator_only");
  else expect(codes).toContain(body.code);
  expect(text).not.toContain(server.tenantId);
  return text;
}

export function setupOperatorBoundary(): void {
  beforeAll(async () => {
    previousMasterKey = testEnv.MASTER_KEY;
    testEnv.MASTER_KEY = "44".repeat(32);
    testEnv.NODE_ENV = "test";
    configDir = mkdtempSync(join(tmpdir(), "subkit-operator-boundary-"));
    _resetConfigForTests();
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/operator-boundary", NODE_ENV: "test" },
      configPathOverride: join(configDir, "seed.json"),
    });
    server = await createHttpTestServer("operator-boundary");
    await initializeRuntimeConfig(server.db, getConfig());
    coordinator = new RuntimeConfigCoordinator(server.db, "test", "operator-boundary-replica");
    await coordinator.start();
    secondary = await createSecondaryTenant(server, "operator-boundary");
  });
  afterAll(async () => {
    await coordinator.stop();
    await server.cleanup();
    _resetConfigForTests();
    rmSync(configDir, { recursive: true, force: true });
    if (previousMasterKey === undefined) delete testEnv.MASTER_KEY;
    else testEnv.MASTER_KEY = previousMasterKey;
  });
}
