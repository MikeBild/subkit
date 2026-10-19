import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigForTests,
  isConfigLoaded,
  loadConfig,
  setConfigKey,
} from "../config/loader.ts";

let ownedConfig: string | undefined;
afterAll(() => {
  if (!ownedConfig) return;
  _resetConfigForTests();
  rmSync(ownedConfig, { recursive: true, force: true });
});

export async function configureHostedAdmissionsForTests(databaseUrl: string): Promise<void> {
  if (!isConfigLoaded()) {
    ownedConfig = mkdtempSync(join(tmpdir(), "sk-hosted-admission-"));
    await loadConfig({
      env: { DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      configPathOverride: join(ownedConfig, "seed.json"),
    });
  }
  for (const key of [
    "tenant_creations_per_minute",
    "retained_tenants",
    "mcp_clients_per_peer_per_minute",
    "mcp_clients_per_minute",
    "retained_mcp_clients",
  ])
    await setConfigKey(`auth.hosted.admission.${key}`, 1000);
}
