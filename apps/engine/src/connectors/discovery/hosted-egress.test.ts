import { expect, mock, test } from "bun:test";
import type { Executor } from "../../db/client.ts";
import { _withDriverFetchForTests, getDriverFetch } from "../drivers/fetch-seam.ts";
import { _withEgressTenantOriginForTests } from "../egress-guard.ts";
import { discoverConnectorEndpoints } from "./index.ts";
import type { DiscoveryStrategy } from "./types.ts";

const originOverrideExec = {} as Executor;

test("hosted discovery cannot follow a raw strategy HTTP redirect to a private address", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  const strategy: DiscoveryStrategy = {
    name: "openapi-direct",
    canHandle: () => true,
    fetch: async (url) => {
      await getDriverFetch()(url);
      throw new Error("unexpected strategy completion");
    },
  };
  await _withEgressTenantOriginForTests(
    async () => "self_service",
    () =>
      _withDriverFetchForTests(fetchImpl as unknown as typeof fetch, async () => {
        await expect(
          discoverConnectorEndpoints({
            tenant_id: "hosted-fixture",
            exec: originOverrideExec,
            base_url: "https://93.184.216.34/",
            strategies: [strategy],
          }),
        ).rejects.toThrow("private_ip_blocked");
      }),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("hosted browser discovery provides an unsupported-action continuation without starting browser", async () => {
  const fetchBrowser = mock(async () => {
    throw new Error("browser must not start");
  });
  await _withEgressTenantOriginForTests(
    async () => "self_service",
    async () => {
      await expect(
        discoverConnectorEndpoints({
          tenant_id: "hosted-fixture",
          exec: originOverrideExec,
          base_url: "https://93.184.216.34/",
          strategies: [{ name: "playwright-crawl", canHandle: () => true, fetch: fetchBrowser }],
        }),
      ).rejects.toThrow("use a public API specification or HTTP discovery instead");
    },
  );
  expect(fetchBrowser).not.toHaveBeenCalled();
});
