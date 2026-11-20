import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("connector_invalid_config");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function send(method: string, path: string, body: unknown) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      code?: string;
      message?: string;
      details?: { issues?: string[] };
      id?: string;
    },
  };
}

test("creating a connector with a config its driver rejects is a validation error", async () => {
  for (const [driver, config, path] of [
    ["s3", { force_path_style: "yes" }, "bucket"],
    ["http", { timeout_ms: "soon" }, "timeout_ms"],
    ["graphql", { default_headers: { accept: 1 } }, "default_headers.accept"],
  ] as const) {
    const refused = await send("POST", "/v1/connectors", {
      name: `Broken ${driver}`,
      driver,
      base_url: "https://example.test",
      config,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("connector_config_invalid");
    expect(refused.body.message).toContain(`invalid ${driver} connector config`);
    expect(refused.body.details?.issues?.some((issue) => issue.startsWith(path))).toBe(true);
  }
});

test("changing a connector to a config its driver rejects is a validation error too", async () => {
  const created = await send("POST", "/v1/connectors", {
    name: "Bucket",
    driver: "s3",
    config: { bucket: "reports" },
  });
  expect(created.status).toBe(201);
  const refused = await send("PATCH", `/v1/connectors/${created.body.id}`, {
    config: { bucket: "" },
  });
  expect(refused.status).toBe(400);
  expect(refused.body.code).toBe("connector_config_invalid");
});
