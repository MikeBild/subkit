import { expect, mock, test } from "bun:test";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import { _withDriverFetchForTests } from "./fetch-seam.ts";
import { executePlannedHttpRequest } from "./http.ts";

test("strict HTTP execution refuses a public-to-private redirect before dispatch", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  await runWithTestEnv({ NODE_ENV: "production" }, () =>
    _withDriverFetchForTests(fetchImpl as unknown as typeof fetch, async () => {
      await expect(
        executePlannedHttpRequest({
          tenant_id: "fixture",
          method: "GET",
          url: new URL("https://93.184.216.34/fixture"),
          headers: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("private_ip_blocked");
    }),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
