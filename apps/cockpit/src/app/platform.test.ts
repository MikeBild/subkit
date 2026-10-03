import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSseParser } from "@/lib/sse-stream";
import { listPagePath, listQueryKey, nextPageParam } from "@/lib/use-infinite-list";
import { loadingPhase, SKELETON_MIN_MS } from "@/lib/use-loading-phase";
import { backoffDelay } from "./live-events";
import { keyId, keysForEvent, LIVE_RULES } from "./live-invalidation";
import { isNewVersion } from "./version-notice";
import { routeTransitionTypes, runViewTransition } from "./view-transition";

const SRC = join(import.meta.dir, "..");

describe("SSE parser", () => {
  test("frames split across chunks, with ids, types and multi-line data", () => {
    const parse = createSseParser();
    expect(parse("id: 7\nevent: execution.started\nda")).toEqual([]);
    expect(parse('ta: {"execution_id":"a"}\n\n')).toEqual([
      { id: "7", event: "execution.started", data: '{"execution_id":"a"}' },
    ]);
    expect(parse("data: one\r\ndata: two\r\n\r\n")).toEqual([
      { id: null, event: "message", data: "one\ntwo" },
    ]);
  });

  test("heartbeat comments produce nothing", () => {
    const parse = createSseParser();
    expect(parse(": ping\n\n")).toEqual([]);
    expect(parse("event: hello\ndata: {}\n\n: keepalive\n\n")).toEqual([
      { id: null, event: "hello", data: "{}" },
    ]);
  });
});

describe("live invalidation table", () => {
  const ids = (type: string) => keysForEvent(type).map(keyId);

  test("a step frame refreshes the open run only, never the lists", () => {
    const step = ids("execution.step.finished");
    expect(step).toContain(keyId(["run"]));
    expect(step).toContain(keyId(["run-steps"]));
    expect(step).not.toContain(keyId(["runs"]));
    expect(step).not.toContain(keyId(["attention"]));
  });

  test("a finished run refreshes runs, Übersicht, usage and the workflow's health", () => {
    const done = ids("execution.failed");
    for (const key of [["runs"], ["attention"], ["usage"], ["workflow-automation-status"]])
      expect(done).toContain(keyId(key));
  });

  test("workflow, connector and decision families reach their reads", () => {
    expect(ids("workflow.updated")).toContain(keyId(["workflow-authorities"]));
    expect(ids("workflow.authority_revoked")).toContain(keyId(["attention"]));
    expect(ids("workflow.automation_changed")).toContain(keyId(["workflow-schedule-holds"]));
    expect(ids("connector.health_changed")).toContain(keyId(["connector-runtime"]));
    expect(ids("connector.credential_changed")).toContain(keyId(["connector-credential"]));
    expect(ids("patch.proposed")).toContain(keyId(["decisions"]));
    expect(ids("skill.created")).toContain(keyId(["decisions"]));
  });

  test("an unknown type refreshes nothing", () => {
    expect(keysForEvent("something.new")).toEqual([]);
  });

  test("every key in the table is a key the Cockpit reads", () => {
    // A renamed query key would leave its rule refreshing nothing, silently.
    const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."))
      .filter((file) => !file.endsWith("live-invalidation.ts") && !file.endsWith("schema.d.ts"))
      .map((file) => readFileSync(join(SRC, file), "utf8"))
      .join("\n");
    for (const rule of LIVE_RULES)
      for (const key of rule.keys) {
        const head = String(key[0]);
        const named =
          sources.includes(`["${head}"`) ||
          sources.includes(`"${head}",`) ||
          sources.includes(`: "${head}"`);
        expect({ rule: rule.prefix, head, named }).toEqual({
          rule: rule.prefix,
          head,
          named: true,
        });
      }
  });
});

describe("reconnect and version", () => {
  test("backoff grows and is capped", () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBeGreaterThan(backoffDelay(0));
    expect(backoffDelay(99)).toBe(30_000);
  });

  test("a new version is a different, announced one", () => {
    expect(isNewVersion("1.2.3", null)).toBe(false);
    expect(isNewVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewVersion("1.2.3", "1.2.4")).toBe(true);
  });
});

describe("loading phase", () => {
  test("nothing shows before the delay; once shown, it holds the minimum", () => {
    expect(loadingPhase({ loading: true, shownAt: null, now: 0 })).toBe("reserve");
    expect(loadingPhase({ loading: true, shownAt: 0, now: 10 })).toBe("skeleton");
    expect(loadingPhase({ loading: false, shownAt: 0, now: SKELETON_MIN_MS - 1 })).toBe("skeleton");
    expect(loadingPhase({ loading: false, shownAt: 0, now: SKELETON_MIN_MS })).toBe("content");
    expect(loadingPhase({ loading: false, shownAt: null, now: 0 })).toBe("content");
  });
});

describe("endless lists", () => {
  test("a page request carries the filters, the size and the cursor, and nothing empty", () => {
    expect(listPagePath("/v1/executions", { status: "failed", q: "" }, 50, null)).toBe(
      "/v1/executions?status=failed&limit=50",
    );
    expect(listPagePath("/v1/audit-log", {}, 25, "2026-01-01T00:00:00.000Z|abc")).toBe(
      "/v1/audit-log?limit=25&cursor=2026-01-01T00%3A00%3A00.000Z%7Cabc",
    );
  });

  test("the next page follows the paging the endpoint answered with", () => {
    expect(nextPageParam([{ items: [1], next_cursor: "c1" }])).toBe("c1");
    expect(nextPageParam([{ items: [1], next_cursor: null, total: 9 }])).toBeNull();
    // Offset-paged catalogues: the loaded count is the next offset until the total.
    expect(nextPageParam([{ items: [1, 2], total: 3 }])).toBe(2);
    expect(
      nextPageParam([
        { items: [1, 2], total: 3 },
        { items: [3], total: 3 },
      ]),
    ).toBeNull();
    expect(nextPageParam([{ items: [], total: 5 }])).toBeNull();
    expect(listPagePath("/v1/workflows", {}, 25, 50)).toBe("/v1/workflows?limit=25&offset=50");
  });

  test("lists live under the key family the live table refreshes", () => {
    expect(listQueryKey("/v1/executions", {})[0]).toBe("runs");
    expect(listQueryKey("/v1/audit-log", {})[0]).toBe("audit");
    expect(keysForEvent("execution.succeeded").map(keyId)).toContain(keyId(["runs"]));
  });
});

describe("route transitions", () => {
  test("only a change of page crossfades, and never under reduced motion", () => {
    expect(routeTransitionTypes({ pathChanged: true, reducedMotion: false })).toEqual(["route"]);
    expect(routeTransitionTypes({ pathChanged: false, reducedMotion: false })).toBe(false);
    expect(routeTransitionTypes({ pathChanged: true, reducedMotion: true })).toBe(false);
  });

  test("a skipped transition is caught, and none starts while one runs", async () => {
    const skipped = () => Promise.reject(new DOMException("Transition was skipped", "AbortError"));
    let finish: () => void = () => {};
    let started = 0;
    const doc = {
      startViewTransition(arg: (() => Promise<void>) | { update: () => Promise<void> }) {
        started += 1;
        const update = typeof arg === "function" ? arg : arg.update;
        return {
          updateCallbackDone: update(),
          ready: skipped(),
          finished: new Promise<void>((_, reject) => {
            finish = () => reject(new DOMException("Transition was skipped", "AbortError"));
          }),
        };
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let updates = 0;
    const update = async () => {
      updates += 1;
    };
    await runViewTransition(update, ["route"], doc, true);
    // A second navigation while the first still runs updates without a transition.
    await runViewTransition(update, ["route"], doc, true);
    expect(started).toBe(1);
    expect(updates).toBe(2);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await runViewTransition(update, ["route"], doc, true);
    expect(started).toBe(2);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
