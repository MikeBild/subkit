import { expect, test } from "bun:test";
import { ConfigSchema } from "../schema.ts";
import { findLeafByPath } from "../walk.ts";

test("reverse proxy trust starts disabled and stays operator-owned", () => {
  const config = ConfigSchema.parse({ database: { url: "postgres://fixture" } });
  expect(config.server.trusted_proxy_hops).toBe(0);
  expect(config.server.trusted_proxy_ips).toEqual([]);
  expect(findLeafByPath("server.trusted_proxy_hops")?.meta.scope).toBe("global");
  expect(findLeafByPath("server.trusted_proxy_ips")?.meta.scope).toBe("global");
});

test("proxy trust rejects wildcards, hostnames, invalid addresses and excessive chains", () => {
  for (const trusted_proxy_ips of [["*"], ["proxy.internal"], ["127.0.0.999"]]) {
    expect(
      ConfigSchema.safeParse({
        database: { url: "postgres://fixture" },
        server: { trusted_proxy_ips },
      }).success,
    ).toBe(false);
  }
  expect(
    ConfigSchema.safeParse({
      database: { url: "postgres://fixture" },
      server: { trusted_proxy_hops: 17 },
    }).success,
  ).toBe(false);
});
