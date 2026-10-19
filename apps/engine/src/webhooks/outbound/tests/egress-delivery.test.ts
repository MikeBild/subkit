import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import {
  _withEgressLookupForTests,
  _withEgressTenantOriginForTests,
} from "../../../connectors/egress-guard.ts";
import { auditLog, deliveries } from "../../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { now } from "../../../utils/clock.ts";
import { registerDeliveryWorker, type WebhookDeliverJob } from "../delivery-worker.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(812);

let ctx: OutboundTestCtx;
beforeAll(async () => {
  ctx = await createOutboundCtx("egress-delivery");
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function fakeFetch(run: (url: URL, init?: RequestInit) => Response | never): typeof fetch {
  return Object.assign(
    async (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
      run(new URL(String(target)), init),
    { preconnect: () => {} },
  ) as typeof fetch;
}

async function deliver(fetchImpl: typeof fetch) {
  const sub = await ctx.createSub({
    event_pattern: "execution.*",
    target_url: "https://delivery.example.test/hook?secret=url-canary",
    secret: "whsec_fixture_delivery_secret_value",
  });
  const { handle } = await registerDeliveryWorker({
    boss: ctx.boss,
    db: ctx.db,
    fetchImpl,
    jitter: false,
    noWork: true,
  });
  await handle({
    id: "fixture-job",
    name: "webhook.deliver",
    data: {
      tenant_id: ctx.tenantId,
      subscription_id: sub.id,
      event_id: uuid(),
      event_type: "execution.succeeded",
      body: '{"private":"body-canary"}',
      webhook_id: "fixture-message",
      timestamp: Math.floor(now() / 1000),
      attempt_number: 1,
    },
  } as Job<WebhookDeliverJob>);
  const [result] = await ctx.db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.tenant_id, ctx.tenantId), eq(deliveries.subscription_id, sub.id)));
  return { sub, result };
}

function hosted<T>(
  lookup: () => Promise<Array<{ address: string; family: number }>>,
  run: () => Promise<T>,
) {
  return _withEgressTenantOriginForTests(
    async () => "self_service",
    () => _withEgressLookupForTests(lookup, run),
  );
}

test("signed webhook dispatch pins the address and never follows a redirect", async () => {
  let calls = 0;
  await hosted(
    async () => [{ address: "8.8.8.8", family: 4 }],
    async () => {
      const { result } = await deliver(
        fakeFetch((url, init) => {
          calls++;
          expect(url.hostname).toBe("8.8.8.8");
          expect(new Headers(init?.headers).get("host")).toBe("delivery.example.test");
          expect(init?.body).toBe('{"private":"body-canary"}');
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 307,
            headers: { location: "https://127.0.0.1/private" },
          });
        }),
      );
      expect(result?.response_code).toBe(307);
      expect(result?.status).not.toBe("success");
    },
  );
  expect(calls).toBe(1);
});

test("a private answer after successful preflight is terminal before sending the signed payload", async () => {
  let lookups = 0;
  let calls = 0;
  await hosted(
    async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
    async () => {
      const { result } = await deliver(
        fakeFetch(() => {
          calls++;
          return new Response("");
        }),
      );
      expect(result?.status).toBe("dead_letter");
      expect(result?.terminal_reason).toBe("egress_blocked");
    },
  );
  expect(calls).toBe(0);
});

test("runtime failures expose a stable error without destination or request-body canaries in audit", async () => {
  await hosted(
    async () => [{ address: "8.8.8.8", family: 4 }],
    async () => {
      const { sub, result } = await deliver(
        fakeFetch(() => {
          throw new Error("https://delivery.example.test?secret=url-canary body-canary");
        }),
      );
      expect(result?.error).toBe("network_error");
      const entries = await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, sub.id)));
      const failure = entries.filter((entry) => entry.action === "webhook.outbound.failed");
      expect(failure).toHaveLength(1);
      expect(JSON.stringify(failure)).not.toContain("url-canary");
      expect(JSON.stringify(failure)).not.toContain("body-canary");
    },
  );
});
