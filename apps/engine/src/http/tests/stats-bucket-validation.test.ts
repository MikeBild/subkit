// Integration tests for stats route bucket-window validation via HTTP.
//
// Covers:
//   - Window cap rejections for each bucket unit (400 + reason).
//   - to <= from rejection (400 + reason).
//   - Retention horizon: when `from` predates the oldest audit row,
//     `truncated_at` is set on the connector/events response envelopes.
//   - Retention horizon: when the entire window predates the oldest audit
//     row, the endpoint returns 400 from_before_retention_horizon.
//   - /v1/stats/executions and /v1/stats/llm (not audit-backed) do NOT
//     clamp nor reject based on retention horizon.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { WINDOW_CAP_MS } from "../routes/stats/bucket-window.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x02);

let srv: HttpTestServer;

// The oldest audit row we will seed.
const OLDEST_AUDIT_TS = "2026-01-10T00:00:00.000Z";

beforeAll(async () => {
  srv = await createHttpTestServer("stats-bucket-val");
  // Seed one audit row so there is a retention horizon.
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

// ---- Window-cap rejections (400 + details.reason=bucket_window_too_large) ---

describe("window cap rejections", () => {
  // We use the connectors route as the HTTP vehicle; the caps apply to all routes.
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

// ---- to <= from (400 window_empty) -----------------------------------------

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

// ---- Retention horizon (audit-backed routes: /connectors, /events) ---------

describe("retention horizon — truncated_at", () => {
  // from is before OLDEST_AUDIT_TS but to is after it → should clamp and set truncated_at.
  test("/v1/stats/connectors with from before oldest audit row sets truncated_at", async () => {
    const fromBefore = "2026-01-05T00:00:00.000Z"; // before OLDEST_AUDIT_TS
    const toAfter = "2026-01-15T00:00:00.000Z"; // after OLDEST_AUDIT_TS
    const res = await authedFetch(
      `/v1/stats/connectors?bucket=hour&from=${encodeURIComponent(fromBefore)}&to=${encodeURIComponent(toAfter)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated_at?: string; from: string };
    expect(body.truncated_at).toBeDefined();
    expect(body.truncated_at).toBe(new Date(OLDEST_AUDIT_TS).toISOString());
    // The envelope `from` is clamped to the oldest audit row.
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
    // Even with from well before any data, executions should 200 with no truncated_at.
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
  // When the entire window predates the oldest audit row, expect 400.
  test("/v1/stats/connectors with window entirely before oldest audit row → 400", async () => {
    const fromWayBefore = "2026-01-01T00:00:00.000Z"; // before OLDEST_AUDIT_TS
    const toBeforeOldest = "2026-01-08T00:00:00.000Z"; // also before OLDEST_AUDIT_TS

    // This window is 7 days; use bucket=day which caps at 366 days, so the
    // window cap itself is not the blocker.
    const res = await authedFetch(
      `/v1/stats/connectors?bucket=day&from=${encodeURIComponent(fromWayBefore)}&to=${encodeURIComponent(toBeforeOldest)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });
});

// ---- Response envelope shape integrity -------------------------------------

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

// ---- group_by validation on /v1/stats/llm ----------------------------------
//
// The aggregator groups by at most two dimensions. The route used to filter
// silently: a third dimension and an unrecognised name both disappeared, and
// the response said nothing about it. These pin the refusal instead — the same
// contract /v1/stats/usage has always had.

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
