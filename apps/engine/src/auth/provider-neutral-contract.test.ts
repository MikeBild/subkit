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
  const concreteProvider = new RegExp(["fire" + "base", "supa" + "base"].join("|"), "i");
  const files = [
    ...productionSources("apps/engine/src/auth"),
    ...productionSources("apps/engine/src/config"),
    ...productionSources("apps/engine/src/http/routes/identity"),
    ...productionSources("apps/subkit/src"),
    ...productionSources("packages/cli-core/src"),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const retiredAuthTree = new RegExp(
    `auth\\.(?:${["provider", "fire" + "base", "oidc"].join("|")})\\b|mcp_oauth\\.providers`,
  );
  expect(source).not.toMatch(concreteProvider);
  expect(source).not.toMatch(/login\/(?:api-key|oidc)/i);
  expect(source).not.toContain(["token", "bridge"].join("_"));
  expect(source).not.toMatch(retiredAuthTree);
  expect(source).not.toContain("/v1/identity/sessions/oidc");
  expect(source).toContain("/v1/identity/login/start");
  expect(source).toContain("/v1/identity/login/callback");
  expect(source).toContain("/v1/identity/logout");
  expect(source).toContain("/v1/identity/sessions");
});
