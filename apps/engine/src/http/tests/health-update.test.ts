import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resetUpdateState, setUpdateState } from "../../update-state.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

// Requires a real Postgres database — set REQUIRES_PG=0 to skip in environments without a DB.
const skip = process.env.REQUIRES_PG === "0";

let ctx: HttpTestServer;

beforeAll(async () => {
  if (skip) return;
  ctx = await createHttpTestServer("health-update");
});

afterAll(async () => {
  if (skip) return;
  await ctx.cleanup();
});

afterEach(() => {
  resetUpdateState();
});

describe("GET /v1/health — update info", () => {
  test.skipIf(skip)("returns 200 without update fields when no check completed", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.update_available).toBeUndefined();
    expect(body.latest_version).toBeUndefined();
  });

  test.skipIf(skip)("includes update_available=true when newer version set", async () => {
    setUpdateState({ update_available: true, latest_version: "2.0.0" });
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    const body = await res.json();
    expect(body.update_available).toBe(true);
    expect(body.latest_version).toBe("2.0.0");
  });

  test.skipIf(skip)("includes update_available=false when current version set", async () => {
    setUpdateState({ update_available: false, latest_version: "1.0.0" });
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    const body = await res.json();
    expect(body.update_available).toBe(false);
    expect(body.latest_version).toBe("1.0.0");
  });

  test.skipIf(skip)("always includes status, version, db_connected, uptime_seconds", async () => {
    setUpdateState({ update_available: true, latest_version: "9.9.9" });
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.db_connected).toBe("boolean");
    expect(typeof body.uptime_seconds).toBe("number");
  });

  test.skipIf(skip)("latest_version matches the value set via setUpdateState", async () => {
    setUpdateState({ update_available: true, latest_version: "3.5.7" });
    const res = await fetch(`${ctx.baseUrl}/v1/health`);
    const body = await res.json();
    expect(body.latest_version).toBe("3.5.7");
  });
});
