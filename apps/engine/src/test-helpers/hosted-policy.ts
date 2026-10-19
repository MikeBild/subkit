import { getConfig, setConfigKey } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { initializeRuntimeConfig } from "../runtime-config/service.ts";
import { configureHostedAdmissionsForTests } from "./hosted-admission.ts";

export async function configureHostedPolicyForTests(
  db: Db,
  databaseUrl: string,
  options: { tenantBytes?: string; resourceRows?: number } = {},
): Promise<void> {
  await configureHostedAdmissionsForTests(databaseUrl);
  await setConfigKey("storage.hosted.tenant_bytes", options.tenantBytes ?? "50000000");
  await setConfigKey("storage.hosted.max_file_bytes", options.tenantBytes ?? "50000000");
  await setConfigKey("storage.hosted.retained_rows_per_resource", options.resourceRows ?? 1000);
  await initializeRuntimeConfig(db, getConfig());
}
