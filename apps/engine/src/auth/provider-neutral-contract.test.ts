import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function productionSources(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const target = join(path, name);
    if (statSync(target).isDirectory()) return productionSources(target);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [target] : [];
  });
}

test("runtime auth remains provider-neutral with only generic browser routes", () => {
  const files = [
    ...productionSources("apps/engine/src/auth"),
    ...productionSources("apps/engine/src/config"),
    ...productionSources("apps/engine/src/http/routes/identity"),
    ...productionSources("apps/sk/src"),
    ...productionSources("packages/cli-core/src"),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  expect(source).not.toMatch(/firebase|FIREBASE_|login\/(?:firebase|api-key|token-bridge)/i);
  expect(source).not.toMatch(/auth\.(?:provider|firebase|oidc)\b|mcp_oauth\.providers/);
  expect(source).not.toContain("/v1/identity/sessions/oidc");
  expect(source).toContain("/v1/identity/login/start");
  expect(source).toContain("/v1/identity/login/callback");
  expect(source).toContain("/v1/identity/logout");
  expect(source).toContain("/v1/identity/sessions");
});
