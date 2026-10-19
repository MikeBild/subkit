import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenantWorkSnapshot } from "../execution/index.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import type { AppEnv } from "./openapi.ts";
import { streamTenantSSE } from "./tenant-stream.ts";

const uuid = createDeterministicUuidFactory(0x71ee011);

test("closing the HTTP body does not acknowledge a producer that still runs", async () => {
  const tenantId = uuid();
  const app = new Hono<AppEnv>();
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.get("/stream", (c) => {
    c.set("principal", { tenant_id: tenantId } as ResolvedPrincipal);
    return streamTenantSSE(c, async () => {
      entered?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
  });
  const response = await app.request("/stream");
  await started;
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
  await response.body?.cancel();
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(1);
  finish?.();
  await waitFor(() => tenantWorkSnapshot(tenantId).in_flight === 0);
  expect(tenantWorkSnapshot(tenantId).in_flight).toBe(0);
});
