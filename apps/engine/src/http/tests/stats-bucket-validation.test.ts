import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { WINDOW_CAP_MS } from "../routes/stats/bucket-window.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x02);

let srv: HttpTestServer;

const OLDEST_AUDIT_TS = "2026-01-10T00:00:00.000Z";

beforeAll(async () => {
  srv = await createHttpTestServer("stats-bucket-val");
  await srv.db.insert(auditLog).values({
    id: uuid(),
    ts: new Date(OLDEST_AUDIT_TS),
    tenant_id: srv.tenantId,
    actor_type: "system",
    action: AuditAction.POLICY_DENIED,
    resource_type: "test",
    result: "denied",
    metadata: {},
  });
});

afterAll(async () => {
  await srv.cleanup();
});

function authedFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

describe("window cap rejections", () => {
  const cases: Array<[string, number]> = [
    ["minute", WINDOW_CAP_MS.minute + 1],
    ["hour", WINDOW_CAP_MS.hour + 1],
    ["day", WINDOW_CAP_MS.day + 1],
    ["month", WINDOW_CAP_MS.month + 1],
    ["year", WINDOW_CAP_MS.year + 1],
  ];

  const BASE_TO_MS = new Date("2026-06-01T00:00:00.000Z").getTime();

  for (const [bucket, overCapMs] of cases) {
    test(`${bucket} bucket: window ${overCapMs}ms → 400 bucket_window_too_large`, async () => {
      const from = new Date(BASE_TO_MS - overCapMs).toISOString();
      const to = new Date(BASE_TO_MS).toISOString();
      const res = await authedFetch(
        `/v1/stats/connectors?bucket=${bucket}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bad_request");
    });
  }
});

describe("to <= from rejection", () => {
  const TS = "2026-01-15T12:00:00.000Z";

  test("to === from → 400", async () => {
    const res = await authedFetch(
      `/v1/stats/executions?bucket=hour&from=${encodeURIComponent(TS)}&to=${encodeURIComponent(TS)}`,
    );
    expect(res.status).toBe(400);
  });

  test("to < from → 400", async () => {
    const toMs = new Date(TS).getTime();
    const tsBefore = new Date(toMs - 1000).toISOString();
    const res = await authedFetch(
      `/v1/stats/executions?bucket=hour&from=${encodeURIComponent(TS)}&to=${encodeURIComponent(tsBefore)}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("retention horizon — truncated_at", () => {
  test("/v1/stats/connectors with from before oldest audit row sets truncated_at", async () => {
    const fromBefore = "2026-01-05T00:00:00.000Z";
    const toAfter = "2026-01-15T00:00:00.000Z";
    const res = await authedFetch(
      `/v1/stats/connectors?bucket=hour&from=${encodeURIComponent(fromBefore)}&to=${encodeURIComponent(toAfter)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated_at?: string; from: string };
    expect(body.truncated_at).toBeDefined();
    expect(body.truncated_at).toBe(new Date(OLDEST_AUDIT_TS).toISOString());
    expect(body.from).toBe(new Date(OLDEST_AUDIT_TS).toISOString());
  });

  test("/v1/stats/events with from before oldest audit row sets truncated_at", async () => {
    const fromBefore = "2026-01-05T00:00:00.000Z";
    const toAfter = "2026-01-15T00:00:00.000Z";
    const res = await authedFetch(
      `/v1/stats/events?bucket=hour&from=${encodeURIComponent(fromBefore)}&to=${encodeURIComponent(toAfter)}&class=policy`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated_at?: string };
    expect(body.truncated_at).toBeDefined();
  });

  test("/v1/stats/executions does NOT use retention horizon (no truncated_at)", async () => {
    const fromBefore = "2026-01-01T00:00:00.000Z";
    const toAfter = "2026-01-15T00:00:00.000Z";
    const res = await authedFetch(
      `/v1/stats/executions?bucket=day&from=${encodeURIComponent(fromBefore)}&to=${encodeURIComponent(toAfter)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated_at?: string };
    expect(body.truncated_at).toBeUndefined();
  });

  test("/v1/stats/llm does NOT use retention horizon (no truncated_at)", async () => {
    const fromBefore = "2026-01-01T00:00:00.000Z";
    const toAfter = "2026-01-15T00:00:00.000Z";
    const res = await authedFetch(
      `/v1/stats/llm?bucket=day&from=${encodeURIComponent(fromBefore)}&to=${encodeURIComponent(toAfter)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated_at?: string };
    expect(body.truncated_at).toBeUndefined();
  });
});

describe("retention horizon — from_before_retention_horizon", () => {
  test("/v1/stats/connectors with window entirely before oldest audit row → 400", async () => {
    const fromWayBefore = "2026-01-01T00:00:00.000Z";
    const toBeforeOldest = "2026-01-08T00:00:00.000Z";

    const res = await authedFetch(
      `/v1/stats/connectors?bucket=day&from=${encodeURIComponent(fromWayBefore)}&to=${encodeURIComponent(toBeforeOldest)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });
});

describe("response envelope shape", () => {
  const validWin = "bucket=hour&from=2026-01-15T06:00:00.000Z&to=2026-01-15T12:00:00.000Z";

  test("executions response has bucket + tz + from + to + groups + totals", async () => {
    const res = await authedFetch(`/v1/stats/executions?${validWin}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bucket).toBe("hour");
    expect(typeof body.tz).toBe("string");
    expect(typeof body.from).toBe("string");
    expect(typeof body.to).toBe("string");
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.totals).toBeDefined();
  });

  test("llm response has bucket + tz + from + to + groups + totals", async () => {
    const res = await authedFetch(`/v1/stats/llm?${validWin}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bucket).toBe("hour");
    expect(typeof body.tz).toBe("string");
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.totals).toBeDefined();
  });
});

describe("/v1/stats/llm group_by validation", () => {
  const win = "bucket=day&from=2026-01-10T00:00:00.000Z&to=2026-01-15T00:00:00.000Z";

  test("three dimensions → 400 group_by_too_many, not a silent two", async () => {
    const res = await authedFetch(`/v1/stats/llm?${win}&group_by=model,flow,workflow`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: { reason?: string } };
    expect(body.code).toBe("bad_request");
    expect(body.details?.reason).toBe("group_by_too_many");
  });

  test("an unknown dimension → 400 group_by_invalid, not a silent drop", async () => {
    const res = await authedFetch(`/v1/stats/llm?${win}&group_by=model,tenant`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: { reason?: string } };
    expect(body.code).toBe("bad_request");
    expect(body.details?.reason).toBe("group_by_invalid");
  });

  test("model,workflow is served — the pairing the cost report needs", async () => {
    const res = await authedFetch(`/v1/stats/llm?${win}&group_by=model,workflow`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: unknown[] };
    expect(Array.isArray(body.groups)).toBe(true);
  });
});
