import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as loader from "../config/loader.ts";
import { type Config, ConfigSchema } from "../config/schema.ts";
import type { Executor } from "../db/client.ts";
import {
  _withEgressTenantOriginForTests,
  assertRobotsAllowed,
  RobotsDisallowedError,
} from "./egress-guard.ts";
import { __resetRobotsCacheForTests } from "./robots-cache.test-helpers.ts";

const baseConfig: Config = ConfigSchema.parse({ database: { url: "postgres://test" } });
let configSpy: ReturnType<typeof spyOn<typeof loader, "getConfig">>;

beforeAll(() => {
  configSpy = spyOn(loader, "getConfig").mockReturnValue(baseConfig);
});
afterAll(() => {
  configSpy.mockRestore();
});
beforeEach(() => {
  __resetRobotsCacheForTests();
});

const robots = (async (url: URL | string) =>
  String(url) === "https://example.com/robots.txt"
    ? new Response("User-agent: *\nDisallow: /private", { status: 200 })
    : new Response("", { status: 404 })) as unknown as typeof fetch;

test("a robots refusal names the address without its query", async () => {
  const refusal = await _withEgressTenantOriginForTests(
    async () => "self_hosted",
    () =>
      assertRobotsAllowed("https://example.com/private/list?appid=s3cr3t-robots&page=2", {
        tenant_id: "tenant-robots",
        exec: {} as Executor,
        userAgent: "sk-web-scraper/1.0",
        fetchImpl: robots,
      }).then(
        () => null,
        (error: unknown) => error,
      ),
  );
  expect(refusal).toBeInstanceOf(RobotsDisallowedError);
  const error = refusal as RobotsDisallowedError;
  expect(error.message).toContain("https://example.com/private/list");
  expect(error.message).not.toContain("s3cr3t-robots");
  expect(error.message).not.toContain("?");
  expect(error.url).toBe("https://example.com/private/list");
});
