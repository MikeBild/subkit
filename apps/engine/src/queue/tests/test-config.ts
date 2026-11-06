import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";

export async function ensureTestConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}
