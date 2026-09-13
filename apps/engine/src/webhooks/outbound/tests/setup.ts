// Shared test scaffolding for outbound webhook tests.
//
//   * createOutboundCtx — disposable DB + pg-boss + seeded tenant +
//     a ready-to-use subscription factory.
//   * startMockReceiver — a tiny http.Server that records every hit
//     and optionally fails N times before succeeding.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { PgBoss } from "pg-boss";

import type { Db } from "../../../db/client.ts";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../../../queue/boss.ts";
import { __resetAll as resetBreakers } from "../circuit-breaker.ts";
import { createSubscription, type SubscriptionRow } from "../service.ts";

export interface OutboundTestCtx {
  testDb: TestDb;
  db: Db;
  boss: PgBoss;
  tenantId: string;
  cleanup: () => Promise<void>;
  createSub: (params: {
    event_pattern: string;
    target_url: string;
    secret: string;
  }) => Promise<SubscriptionRow>;
}

export async function createOutboundCtx(label: string): Promise<OutboundTestCtx> {
  resetBreakers();
  const testDb = await createTestDb(`wh-out-${label}`);
  const boss = await createBoss({ connectionString: testDb.url });
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");

  return {
    testDb,
    db: testDb.db,
    boss,
    tenantId: tenant.id,
    cleanup: async () => {
      await disposeBoss(boss);
      await testDb.cleanup();
    },
    createSub: async (params) => {
      return await createSubscription(
        {
          tenant_id: tenant.id,
          actor_id: null,
          event_pattern: params.event_pattern,
          target_url: params.target_url,
          secret: params.secret,
        },
        testDb.db,
      );
    },
  };
}

// ------------------ mock receiver ------------------------------------

export interface RecordedHit {
  method: string;
  headers: Record<string, string>;
  body: string;
  received_at: number;
}

export interface MockReceiver {
  port: number;
  url: string;
  hits: RecordedHit[];
  /** Set a behavior function. Returns a status code. */
  behavior: (hit: RecordedHit, hitIndex: number) => number;
  close: () => Promise<void>;
}

export async function startMockReceiver(
  opts: { failTimes?: number; statusWhenFailing?: number } = {},
): Promise<MockReceiver> {
  const hits: RecordedHit[] = [];
  const failTimes = opts.failTimes ?? 0;
  const failStatus = opts.statusWhenFailing ?? 500;

  let behavior: (hit: RecordedHit, hitIndex: number) => number = (_hit, idx) => {
    if (idx < failTimes) return failStatus;
    return 200;
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(",");
      }
      const hit: RecordedHit = {
        method: req.method ?? "GET",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        received_at: Date.now(),
      };
      hits.push(hit);
      const status = behavior(hit, hits.length - 1);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock receiver: no address");
  const port = addr.port;
  return {
    port,
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    get behavior() {
      return behavior;
    },
    set behavior(fn) {
      behavior = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
