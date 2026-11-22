import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import {
  buildCreateSubscriptionBody,
  buildDeliveriesQuery,
  buildPatchSubscriptionBody,
  parseActiveFlag,
  SUBSCRIPTION_DELIVERY_COLUMNS,
  SUBSCRIPTION_LIST_COLUMNS,
  subscriptionsCommand,
} from "../../commands/subscriptions.ts";

const ENV_KEYS = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

const SUB = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  event_pattern: "execution.*",
  target_url: "https://hooks.example.test/in",
  active: true,
  consecutive_failures: 2,
  circuit_open_until: null,
  created_at: "2026-11-06T10:00:00.000Z",
  updated_at: "2026-11-06T10:00:00.000Z",
};

const DELIVERY = {
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: SUB.tenant_id,
  subscription_id: SUB.id,
  event_id: "55555555-5555-4555-8555-555555555555",
  event_type: "execution.failed",
  outbox_event_id: null,
  attempt: 1,
  attempt_number: 1,
  status: "failed",
  response_code: 500,
  error: "upstream error",
  classification: "retryable",
  terminal_reason: null,
  target_url: SUB.target_url,
  duration_ms: 120,
  next_retry_at: null,
  created_at: "2026-11-06T10:05:00.000Z",
};

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let origFetch: typeof globalThis.fetch;
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;
let stdout: string;
let calls: Captured[];
let reply: { status: number; body: unknown };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-subscriptions-"));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SUBKIT_ENGINE_URL = "http://engine.test";
  process.env.SUBKIT_API_KEY = "wf_live_test_key_xxxxxxxxxxxxxxxxxxxxx";
  calls = [];
  reply = { status: 200, body: SUB };
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method: init?.method ?? "GET",
      url: pathOf(String(input)),
      body: raw ? JSON.parse(raw) : undefined,
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  stdout = "";
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(rawArgs: string[]): Promise<unknown> {
  try {
    await runCommand(subscriptionsCommand, { rawArgs });
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("subscription request bodies", () => {
  test("create body carries the engine CreateBody fields", () => {
    expect(
      buildCreateSubscriptionBody({
        "event-pattern": "execution.failed",
        "target-url": "https://x.test/h",
        secret: "s3cret",
      }),
    ).toEqual({
      event_pattern: "execution.failed",
      target_url: "https://x.test/h",
      secret: "s3cret",
    });
  });

  test("create body includes active only when given", () => {
    expect(
      buildCreateSubscriptionBody({
        "event-pattern": "a",
        "target-url": "https://x.test",
        secret: "s",
        active: "false",
      }),
    ).toEqual({ event_pattern: "a", target_url: "https://x.test", secret: "s", active: false });
  });

  test("patch body keeps only the flags that were passed", () => {
    expect(buildPatchSubscriptionBody({ active: "true" })).toEqual({ active: true });
    expect(
      buildPatchSubscriptionBody({
        "event-pattern": "b.*",
        "target-url": "https://y.test",
        secret: "n",
      }),
    ).toEqual({ event_pattern: "b.*", target_url: "https://y.test", secret: "n" });
  });

  test("patch body without any flag is rejected", () => {
    expect(() => buildPatchSubscriptionBody({})).toThrow("nothing to update");
  });

  test("active flag accepts only true or false", () => {
    expect(parseActiveFlag(undefined)).toBeUndefined();
    expect(parseActiveFlag("true")).toBe(true);
    expect(parseActiveFlag("false")).toBe(false);
    expect(() => parseActiveFlag("yes")).toThrow('--active must be "true" or "false"');
  });

  test("list columns match the engine Subscription schema", () => {
    expect(SUBSCRIPTION_LIST_COLUMNS).toEqual([
      "id",
      "event_pattern",
      "target_url",
      "active",
      "consecutive_failures",
      "circuit_open_until",
    ]);
    for (const column of SUBSCRIPTION_LIST_COLUMNS) expect(Object.keys(SUB)).toContain(column);
  });

  test("delivery columns match the engine SubscriptionDelivery schema", () => {
    for (const column of SUBSCRIPTION_DELIVERY_COLUMNS)
      expect(Object.keys(DELIVERY)).toContain(column);
  });

  test("deliveries query carries only the given paging flags", () => {
    expect(buildDeliveriesQuery({})).toEqual({});
    expect(buildDeliveriesQuery({ limit: "10", offset: "0" })).toEqual({ limit: 10, offset: 0 });
    expect(() => buildDeliveriesQuery({ limit: "0" })).toThrow("--limit must be an integer");
    expect(() => buildDeliveriesQuery({ offset: "-1" })).toThrow("--offset must be an integer");
    expect(() => buildDeliveriesQuery({ limit: "2.5" })).toThrow("--limit must be an integer");
  });
});

describe("subkit subscriptions against the engine contract", () => {
  test("create posts event_pattern, target_url and secret", async () => {
    reply = { status: 201, body: SUB };
    const err = await run([
      "create",
      "--event-pattern",
      "execution.*",
      "--target-url",
      "https://hooks.example.test/in",
      "--secret",
      "s3cret",
    ]);
    expect(err).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/v1/subscriptions");
    expect(calls[0]?.body).toEqual({
      event_pattern: "execution.*",
      target_url: "https://hooks.example.test/in",
      secret: "s3cret",
    });
    expect(JSON.parse(stdout)).toEqual(SUB);
  });

  test("create no longer sends event_type or workflow_id", async () => {
    await run([
      "create",
      "--event-pattern",
      "e",
      "--target-url",
      "https://t.test",
      "--secret",
      "s",
      "--active",
      "false",
    ]);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("event_type");
    expect(body).not.toHaveProperty("workflow_id");
    expect(body.active).toBe(false);
  });

  test("list --json prints the engine rows", async () => {
    reply = { status: 200, body: { items: [SUB] } };
    await run(["list", "--json"]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("/v1/subscriptions");
    expect(JSON.parse(stdout)).toEqual([SUB]);
  });

  test("list table shows the engine columns", async () => {
    reply = { status: 200, body: { items: [SUB] } };
    await run(["list"]);
    for (const column of SUBSCRIPTION_LIST_COLUMNS) expect(stdout).toContain(column);
    expect(stdout).toContain("execution.*");
    expect(stdout).toContain("https://hooks.example.test/in");
    expect(stdout).not.toContain("workflow_id");
    expect(stdout).not.toContain("event_type");
  });

  test("patch sends only the given fields", async () => {
    await run(["patch", SUB.id, "--target-url", "https://new.test/h"]);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`/v1/subscriptions/${SUB.id}`);
    expect(calls[0]?.body).toEqual({ target_url: "https://new.test/h" });
  });

  test("patch without flags fails before any request", async () => {
    const err = await run(["patch", SUB.id]);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  test("get encodes the id into the path", async () => {
    await run(["get", "a/b"]);
    expect(calls[0]?.url).toBe("/v1/subscriptions/a%2Fb");
  });

  test("delete and replay hit the engine routes", async () => {
    reply = { status: 200, body: { deleted: true } };
    await run(["delete", SUB.id]);
    reply = { status: 202, body: { replayed: true } };
    await run(["replay", SUB.id, "33333333-3333-4333-8333-333333333333"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE /v1/subscriptions/${SUB.id}`,
      `POST /v1/subscriptions/${SUB.id}/deliveries/33333333-3333-4333-8333-333333333333/replay`,
    ]);
    expect(stdout).toBe("deleted\nreplayed\n");
  });

  test("deliveries --json lists the engine delivery rows", async () => {
    reply = { status: 200, body: { items: [DELIVERY] } };
    await run(["deliveries", SUB.id, "--json"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /v1/subscriptions/${SUB.id}/deliveries`,
    ]);
    expect(JSON.parse(stdout)).toEqual([DELIVERY]);
  });

  test("deliveries forwards paging and shows the delivery columns", async () => {
    reply = { status: 200, body: { items: [DELIVERY] } };
    await run(["deliveries", SUB.id, "--limit", "5", "--offset", "10"]);
    expect(calls[0]?.url).toBe(`/v1/subscriptions/${SUB.id}/deliveries?limit=5&offset=10`);
    for (const column of SUBSCRIPTION_DELIVERY_COLUMNS) expect(stdout).toContain(column);
    expect(stdout).toContain("execution.failed");
  });

  test("deliveries with an invalid limit fails before any request", async () => {
    const err = await run(["deliveries", SUB.id, "--limit", "0"]);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  test("engine errors are reported and rethrown", async () => {
    reply = { status: 400, body: { error: "invalid body", code: "validation_error" } };
    const err = await run(["list", "--json"]);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.parse(stdout).code).toBe("validation_error");
  });
});
