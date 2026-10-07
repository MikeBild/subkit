import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as loader from "../../../config/loader.ts";
import type { AppEnv } from "../../openapi.ts";
import { apiKeyLoginRefusal, registerLoginRoutes } from "./login.ts";

beforeAll(async () => {
  try {
    loader.getConfig();
  } catch {
    await loader.loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/login-test", NODE_ENV: "test" },
      configPathOverride: join(mkdtempSync(join(tmpdir(), "sk-cfg-login-")), "subkit.config.json"),
    });
  }
});

afterEach(() => {
  mock.restore();
});

function withoutProviders(): OpenAPIHono<AppEnv> {
  const real = loader.getConfig();
  spyOn(loader, "getConfig").mockReturnValue({
    ...real,
    auth: { ...real.auth, providers: [] },
  });
  const app = new OpenAPIHono<AppEnv>();
  registerLoginRoutes(app);
  return app;
}

describe("a sign-in with no provider configured", () => {
  test("an API client keeps the error envelope", async () => {
    const res = await withoutProviders().request("http://127.0.0.1/v1/identity/login/start", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("login_not_configured");
    expect(res.headers.get("vary")).toBe("Accept, Cookie");
  });

  test("a browser gets the designed page with its one way out", async () => {
    const res = await withoutProviders().request("http://127.0.0.1/v1/identity/login/start", {
      headers: { accept: "text/html", cookie: "sk_locale=de" },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("vary")).toBe("Accept, Cookie");
    const html = await res.text();
    expect(html).toContain("Anmeldung nicht eingerichtet");
    expect(html.match(/<a\s/g)?.length).toBe(1);
    expect(html).toContain('href="/"');
  });
});

test("a refused API key is explained in the page's language", () => {
  expect(apiKeyLoginRefusal("de")).toContain("API-Schlüssel ist ungültig");
  expect(apiKeyLoginRefusal("de")).not.toMatch(/invalid|expired|owned/);
  expect(apiKeyLoginRefusal("en")).toContain("not owned by a person");
});
