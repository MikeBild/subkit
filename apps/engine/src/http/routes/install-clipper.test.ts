import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";
import { createApp } from "../server.ts";
import { _internal, registerInstallClipperRoute } from "./install-clipper.ts";

let configDirectory: string;
beforeAll(async () => {
  configDirectory = mkdtempSync(join(tmpdir(), "sk-install-clipper-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://localhost/x", NODE_ENV: "test" },
    configPathOverride: join(configDirectory, "subkit.config.json"),
  });
});
afterAll(() => {
  _resetConfigForTests();
  rmSync(configDirectory, { recursive: true, force: true });
});

function buildApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  registerInstallClipperRoute(app);
  return app;
}

describe("GET /install/clipper.zip", () => {
  test("the full application reaches the archive before the generic asset route", async () => {
    const response = await createApp().request("http://127.0.0.1/install/clipper.zip");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(
      createHash("sha256")
        .update(await response.bytes())
        .digest("hex"),
    ).toBe(_internal.clipperManifest.sha256);
  });

  test("serves the embedded archive with its verified checksum", async () => {
    _internal.clearArchiveVerification();
    const response = await buildApp().request("/install/clipper.zip");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="clipper.zip"');
    expect(response.headers.get("x-subkit-sha256")).toBe(_internal.clipperManifest.sha256);

    const archive = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(archive.byteLength));
    expect(createHash("sha256").update(archive).digest("hex")).toBe(
      _internal.clipperManifest.sha256,
    );
  });
});
