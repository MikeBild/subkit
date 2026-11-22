import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimed, ledgerPath, type Route, startRunner, until } from "./runner.fixture.ts";

const realFetch = globalThis.fetch;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  globalThis.fetch = realFetch;
});

const stored: Route = () => Response.json({ stored: true, state: "refused" });

describe("runRunner claims", () => {
  test("a failed claim reaches the report port and the next job still runs", async () => {
    const rig = startRunner(ledgerPath(), (request) => {
      if (request.path.endsWith("/c1/claim")) throw new TypeError("network down");
      if (request.path.endsWith("/c2/claim")) return claimed("c2");
      return stored(request);
    });
    await until(() => rig.streams() === 1);
    rig.announce("c1");
    rig.announce("c2");
    await until(() => rig.calls.includes("POST /v1/device-runner/commands/c2/result"));
    expect(unhandled).toEqual([]);
    expect(rig.problems.map((problem) => [problem.scope, problem.error_class])).toEqual([
      ["claim", "network"],
    ]);
    expect(rig.streams()).toBe(1);
    await rig.shutdown();
  });

  test("a job taken elsewhere is a normal outcome, not a problem", async () => {
    const rig = startRunner(ledgerPath(), (request) => {
      if (request.path.endsWith("/c1/claim")) return Response.json({}, { status: 409 });
      if (request.path.endsWith("/c2/claim")) return claimed("c2");
      return stored(request);
    });
    await until(() => rig.streams() === 1);
    rig.announce("c1");
    rig.announce("c2");
    await until(() => rig.calls.includes("POST /v1/device-runner/commands/c2/result"));
    expect(rig.calls).not.toContain("POST /v1/device-runner/commands/c1/result");
    expect(rig.problems).toEqual([]);
    expect(unhandled).toEqual([]);
    await rig.shutdown();
  });
});

const RESULT_C1 = "POST /v1/device-runner/commands/c1/result";
const CLAIM_C1 = "POST /v1/device-runner/commands/c1/claim";
const count = (calls: readonly string[], call: string) =>
  calls.filter((made) => made === call).length;

describe("runRunner delivers every journaled result", () => {
  test("a result whose send failed before it reached the server is sent again", async () => {
    let failures = 1;
    const rig = startRunner(ledgerPath(), (request) => {
      if (request.path.endsWith("/c1/claim")) return claimed("c1");
      if (request.path.endsWith("/c1/result") && failures-- > 0) throw new TypeError("offline");
      return stored(request);
    });
    await until(() => rig.streams() === 1);
    rig.announce("c1");
    await until(() => count(rig.calls, RESULT_C1) === 2);
    expect(count(rig.calls, CLAIM_C1)).toBe(1);
    await rig.shutdown();
  });

  test("a result the server kept but whose answer got lost is sent once more, then never again", async () => {
    const kept: string[] = [];
    const ledger = ledgerPath();
    const rig = startRunner(ledger, (request) => {
      if (request.path.endsWith("/c1/claim")) return claimed("c1");
      if (request.path.endsWith("/c1/result")) {
        kept.push(request.body ?? "");
        if (kept.length === 1) throw new TypeError("connection reset");
        return Response.json({ stored: false, state: "refused" });
      }
      return stored(request);
    });
    await until(() => rig.streams() === 1);
    rig.announce("c1");
    await until(() => kept.length === 2);
    await until(() => !readFileSync(ledger, "utf8").includes("undelivered"));
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBe(kept[0] as string);
    await rig.shutdown();
  });

  test("after a restart the undelivered result is sent without running the command again", async () => {
    const ledger = ledgerPath();
    const first = startRunner(ledger, (request) => {
      if (request.path.endsWith("/c1/claim")) return claimed("c1");
      if (request.path.endsWith("/c1/result")) throw new TypeError("offline");
      return stored(request);
    });
    await until(() => first.streams() === 1);
    first.announce("c1");
    await until(() => count(first.calls, RESULT_C1) >= 1);
    await first.shutdown();

    const second = startRunner(ledger, (request) => {
      if (request.path.endsWith("/c1/claim")) return claimed("c1");
      if (request.path.endsWith("/c2/claim")) return claimed("c2");
      return stored(request);
    });
    await until(() => count(second.calls, RESULT_C1) === 1);
    await until(() => second.streams() === 1);
    second.announce("c1");
    second.announce("c2");
    await until(() => second.calls.includes("POST /v1/device-runner/commands/c2/result"));
    expect(count(second.calls, CLAIM_C1)).toBe(0);
    await second.shutdown();
  });

  test("a result is still sent when the ledger cannot be written, and the failure is reported", async () => {
    const blocker = join(dirname(ledgerPath()), "not-a-folder");
    writeFileSync(blocker, "");
    let failures = 1;
    const rig = startRunner(join(blocker, "ledger.json"), (request) => {
      if (request.path.endsWith("/c1/claim")) return claimed("c1");
      if (request.path.endsWith("/c1/result") && failures-- > 0) throw new TypeError("offline");
      return stored(request);
    });
    await until(() => rig.streams() === 1);
    rig.announce("c1");
    await until(() => count(rig.calls, RESULT_C1) === 2);
    expect(rig.problems.map((problem) => problem.scope)).toContain("ledger");
    expect(unhandled).toEqual([]);
    await rig.shutdown();
  });
});
