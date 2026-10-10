import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { intakeCommand } from "./intake.ts";

const ONE = "10000000-0000-4000-8000-000000000001";
const TWO = "10000000-0000-4000-8000-000000000002";

type Request = { method: string; path: string; body: unknown };

let previousFetch: typeof globalThis.fetch;
let previousWrite: typeof process.stdout.write;
let previousError: typeof process.stderr.write;
let output: string[];
let requests: Request[];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function item(id: string, title: string, category = "inbox") {
  return {
    id,
    category,
    title,
    state: "collected",
    version: 3,
    original_snapshot: {
      source_url: `https://example.test/${title}`,
      captured_at: "2026-10-10T00:00:00.000Z",
    },
  };
}

function installEngine(items: readonly ReturnType<typeof item>[], createStatus = 200): void {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname === "/gateway/v1/intake/default-category")
      return response({ category: "inbox" });
    if (url.pathname === "/gateway/v1/intake/items")
      return response({ items, total: items.length });
    if (url.pathname.startsWith("/gateway/v1/intake/items/")) {
      if (init?.method === "PATCH")
        return response({ ...items[0], ...JSON.parse(String(init.body)) });
      return response(items[0]);
    }
    if (url.pathname === "/gateway/v1/conversations")
      return response(
        { conversation: { id: TWO, status: "active" }, events: [], status: "active" },
        createStatus,
      );
    return response({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  previousFetch = globalThis.fetch;
  previousWrite = process.stdout.write.bind(process.stdout);
  previousError = process.stderr.write.bind(process.stderr);
  output = [];
  requests = [];
  process.env.SUBKIT_ENGINE_URL = "https://engine.test/gateway";
  process.env.SUBKIT_API_KEY = "test-key";
  process.env.SUBKIT_TENANT = ONE;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  process.stdout.write = previousWrite;
  process.stderr.write = previousError;
  delete process.env.SUBKIT_ENGINE_URL;
  delete process.env.SUBKIT_API_KEY;
  delete process.env.SUBKIT_TENANT;
});

describe("intake CLI commands", () => {
  test("lists bounded metadata for an exact category", async () => {
    installEngine([item(ONE, "One", "research")]);
    await runCommand(intakeCommand, { rawArgs: ["list", "--category", "research", "--json"] });
    expect(JSON.parse(output.join(""))).toEqual({
      category: "research",
      items: [
        {
          id: ONE,
          category: "research",
          title: "One",
          source_url: "https://example.test/One",
          captured_at: "2026-10-10T00:00:00.000Z",
          state: "collected",
        },
      ],
    });
    expect(requests.map((request) => request.path)).toEqual([
      "/gateway/v1/intake/items?category=research&state=collected",
    ]);
  });

  test("uses the personal default and preserves an engine path in the Cockpit handoff", async () => {
    installEngine([item(ONE, "One")]);
    await runCommand(intakeCommand, { rawArgs: ["review"] });
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/gateway/v1/conversations",
      body: {
        initial_message:
          "Review my new items in “inbox”. Which ones help us? For each suggestion, show the exact text, sources and knowledge destination for my confirmation.",
        intake_item_ids: [ONE],
      },
    });
    expect(output.join("")).toContain(
      "https://engine.test/gateway/cockpit/chat/10000000-0000-4000-8000-000000000002",
    );
    expect(requests.some((request) => request.path.includes("/confirm"))).toBeFalse();
  });

  test("uses an explicit category or explicit UUID selection", async () => {
    installEngine([item(TWO, "Two", "research")]);
    await runCommand(intakeCommand, { rawArgs: ["review", "--category", "research"] });
    expect(requests.at(-1)?.body).toMatchObject({ intake_item_ids: [TWO] });
    requests = [];
    output = [];
    await runCommand(intakeCommand, { rawArgs: ["review", "--items", ONE, "--json"] });
    expect(requests.map((request) => request.path)).toEqual(["/gateway/v1/conversations"]);
    expect(requests.at(-1)?.body).toMatchObject({ intake_item_ids: [ONE] });
  });

  test("does not claim success after a failed conversation create or oversized category", async () => {
    installEngine([item(ONE, "One")], 500);
    await expect(runCommand(intakeCommand, { rawArgs: ["review"] })).rejects.toThrow();
    expect(output.join("")).not.toContain("Review started");
    requests = [];
    output = [];
    installEngine(
      Array.from({ length: 101 }, (_, index) =>
        item(`${`${index}`.padStart(8, "0")}-0000-4000-8000-000000000001`, `${index}`),
      ),
    );
    await expect(runCommand(intakeCommand, { rawArgs: ["review"] })).rejects.toThrow(
      "more than 100",
    );
    expect(requests.some((request) => request.path.endsWith("/v1/conversations"))).toBeFalse();
  });
  test("updates the personal default and reads each current item version before mutations", async () => {
    installEngine([item(ONE, "One")]);
    await runCommand(intakeCommand, { rawArgs: ["default", "--category", "research", "--json"] });
    expect(requests.at(-1)).toEqual({
      method: "PATCH",
      path: "/gateway/v1/intake/default-category",
      body: { category: "research" },
    });
    requests = [];
    output = [];
    await runCommand(intakeCommand, {
      rawArgs: ["move", "--item", ONE, "--category", "research", "--json"],
    });
    expect(requests).toEqual([
      { method: "GET", path: `/gateway/v1/intake/items/${ONE}`, body: undefined },
      {
        method: "PATCH",
        path: `/gateway/v1/intake/items/${ONE}`,
        body: { category: "research", expected_version: 3 },
      },
    ]);
    requests = [];
    output = [];
    await runCommand(intakeCommand, { rawArgs: ["discard", "--item", ONE, "--json"] });
    expect(requests.at(-1)?.body).toEqual({ state: "discarded", expected_version: 3 });
    requests = [];
    output = [];
    await runCommand(intakeCommand, { rawArgs: ["restore", "--item", ONE, "--json"] });
    expect(requests.at(-1)?.body).toEqual({ state: "collected", expected_version: 3 });
  });

  test("rejects malformed mutation input before a write", async () => {
    installEngine([item(ONE, "One")]);
    await expect(
      runCommand(intakeCommand, {
        rawArgs: ["move", "--item", "not-an-id", "--category", "research"],
      }),
    ).rejects.toThrow("--item needs a UUID");
    expect(requests).toEqual([]);
  });
});
