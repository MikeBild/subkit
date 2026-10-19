import { afterAll, beforeAll, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("files-hosted-quota", { operator: false, hosted: true });
  await setConfigKey("server.hosted_rate_limit.peer_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.principal_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_minute", 1000);
  await setConfigKey("server.hosted_rate_limit.global_per_minute", 1000);
  await setConfigKey("storage.hosted.tenant_bytes", "10");
  await setConfigKey("storage.hosted.max_file_bytes", "6");
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
function post(path: string, body: unknown) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
}
function inline(content: string) {
  return post("/v1/files/inline", {
    filename: "quota.txt",
    content_base64: Buffer.from(content).toString("base64"),
  });
}

test("actual hosted HTTP inline and batch admission enforce a shared persistent file quota", async () => {
  const first = await inline("abcdef");
  expect(first.status).toBe(201);
  const file = (await first.json()) as { id: string };
  expect((await inline("abcdef")).status).toBe(200);
  const oversized = await inline("abcdefg");
  expect(oversized.status).toBe(429);
  expect(await oversized.json()).toMatchObject({ code: "hosted_file_quota_exhausted" });
  expect((await inline("fedcba")).status).toBe(429);
  expect(
    (
      await fetch(`${ctx.baseUrl}/v1/files/${file.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ctx.apiKey}`, connection: "close" },
      })
    ).status,
  ).toBe(204);
  expect((await inline("fedcba")).status).toBe(429);
  expect(
    (await post("/v1/files/batch-create", { files: [{ filename: "staged.txt", size_bytes: 4 }] }))
      .status,
  ).toBe(201);
  expect(
    (
      await post("/v1/files/batch-create", {
        files: [{ filename: "over-limit.txt", size_bytes: 1 }],
      })
    ).status,
  ).toBe(429);
});
