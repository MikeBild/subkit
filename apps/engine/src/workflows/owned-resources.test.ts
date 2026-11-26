import { describe, expect, test } from "bun:test";
import {
  createdByWorkflowMisplaced,
  createdResourceKey,
  deleteOutcome,
  OWNED_RESOURCE_STATES,
  type OwnedResourceEvent,
  type OwnedResourceState,
  ownedDeleteCollection,
  ownedDeleteDecision,
  ownedResourceGuard,
  ownedResourceKeyAllowed,
  ownedResourceKeysOf,
  ownedResourceTransition,
  RECORDS_CREATED_MISPLACED,
  recordsCreatedEndpoint,
} from "./owned-resources.ts";
import { RequestStepSchema } from "./types.ts";

const EVENTS: OwnedResourceEvent[] = [
  "delete_reserved",
  "delete_confirmed",
  "delete_unconfirmed",
  "delete_refused",
];

describe("ownership ledger state machine", () => {
  const table: Array<[OwnedResourceState, OwnedResourceEvent, OwnedResourceState | null]> = [
    ["owned", "delete_reserved", "deleting"],
    ["owned", "delete_confirmed", null],
    ["owned", "delete_unconfirmed", null],
    ["owned", "delete_refused", null],
    ["deleting", "delete_reserved", null],
    ["deleting", "delete_confirmed", "deleted"],
    ["deleting", "delete_unconfirmed", "delete_unknown"],
    ["deleting", "delete_refused", "owned"],
    ["deleted", "delete_reserved", null],
    ["deleted", "delete_confirmed", null],
    ["deleted", "delete_unconfirmed", null],
    ["deleted", "delete_refused", null],
    ["delete_unknown", "delete_reserved", null],
    ["delete_unknown", "delete_confirmed", null],
    ["delete_unknown", "delete_unconfirmed", null],
    ["delete_unknown", "delete_refused", null],
  ];

  test.each(table)("%s + %s -> %s", (state, event, next) => {
    expect(ownedResourceTransition(state, event)).toBe(next);
  });

  test("the table covers every state and event", () => {
    expect(table).toHaveLength(OWNED_RESOURCE_STATES.length * EVENTS.length);
  });

  test("every event has exactly one guarded source state", () => {
    expect(EVENTS.map((event) => ownedResourceGuard(event))).toEqual([
      { from: "owned", to: "deleting" },
      { from: "deleting", to: "deleted" },
      { from: "deleting", to: "delete_unknown" },
      { from: "deleting", to: "owned" },
    ]);
  });

  test("an unknown event has no guard", () => {
    expect(() => ownedResourceGuard("delete_forgotten" as OwnedResourceEvent)).toThrow(
      "no owned resource transition for delete_forgotten",
    );
  });
});

describe("owned delete decision", () => {
  const ledger = new Map<string, OwnedResourceState>([
    ["job-1", "owned"],
    ["job-2", "deleted"],
    ["job-3", "delete_unknown"],
    ["job-4", "deleting"],
  ]);
  const send = { allow: true, replay: false };
  const replay = { allow: true, replay: true };
  const deny = (code: string, resource_key: string | null) => ({
    allow: false,
    code,
    resource_key,
  });
  const table: Array<[string, string, boolean, string[], object]> = [
    ["an owned id is sent", "DELETE", true, ["job-1"], send],
    ["a lowercase method", "delete", true, ["job-1"], send],
    ["a removed id replays its outcome", "DELETE", true, ["job-2"], replay],
    ["not marked destructive", "DELETE", false, ["job-1"], deny("delete_not_destructive", null)],
    ["not a DELETE", "POST", true, ["job-2"], deny("delete_not_destructive", null)],
    ["no id at all", "DELETE", true, [], deny("delete_target_not_created_by_workflow", null)],
    [
      "a foreign id",
      "DELETE",
      true,
      ["job-9"],
      deny("delete_target_not_created_by_workflow", "job-9"),
    ],
    [
      "an unknown outcome",
      "DELETE",
      true,
      ["job-3"],
      deny("delete_target_outcome_unknown", "job-3"),
    ],
    [
      "a removal in flight",
      "DELETE",
      true,
      ["job-4"],
      deny("delete_target_outcome_unknown", "job-4"),
    ],
    [
      "one foreign of two",
      "DELETE",
      true,
      ["job-1", "job-9"],
      deny("delete_target_not_created_by_workflow", "job-9"),
    ],
    [
      "a removed and an owned id",
      "DELETE",
      true,
      ["job-1", "job-2"],
      deny("delete_target_already_deleted", "job-2"),
    ],
    [
      "a removed and an unknown id",
      "DELETE",
      true,
      ["job-2", "job-3"],
      deny("delete_target_outcome_unknown", "job-3"),
    ],
  ];

  test.each(table)("%s", (_name, method, destructive, keys, expected) => {
    expect(ownedDeleteDecision({ method, destructive, resource_keys: keys, ledger })).toEqual(
      expected as never,
    );
  });
});

describe("resource keys", () => {
  test.each([
    ["job-1", true],
    ["a:b.c~d_e", true],
    [".", false],
    ["..", false],
    ["", false],
    ["a/b", false],
    ["a%2Fb", false],
    ["x".repeat(1024), true],
    ["x".repeat(1025), false],
  ])("%s allowed: %s", (value, allowed) => {
    expect(ownedResourceKeyAllowed(value)).toBe(allowed);
  });

  test("a created id is one string or whole number", () => {
    expect(createdResourceKey("job-1", "data.id")).toEqual({ key: "job-1" });
    expect(createdResourceKey(42, "id")).toEqual({ key: "42" });
  });

  test.each([
    ["nothing", undefined],
    ["a fraction", 1.5],
    ["a path", "a/b"],
    ["an object", { nested: 1 }],
    ["a list of ids from a search", ["job-1", "job-2"]],
    ["an empty list", []],
  ])("%s is never recorded", (_name, value) => {
    expect(createdResourceKey(value, "id")).toEqual({
      invalid: "`id` does not resolve to one id (a single string or whole number)",
    });
  });

  test("the removed id is read from its path segment as sent", () => {
    const boundary = {
      segments: ["", "v2", "jobs", { var: "scope.make.data.id" }, { var: "input.kind" }],
      variables: {
        "scope.make.data.id": { created_by_workflow: true },
        "input.kind": { enum: ["x"] },
      },
    };
    expect(
      ownedResourceKeysOf(boundary, new URL("https://api.example.test/v2/jobs/job-1/x")),
    ).toEqual(["job-1"]);
    expect(ownedResourceKeysOf({ variables: {} }, new URL("https://a.test/x"))).toEqual([]);
    expect(
      ownedResourceKeysOf(
        {
          segments: ["", { var: "item.id" }, { var: "item.other" }],
          variables: { "item.other": { created_by_workflow: true } },
        },
        new URL("https://a.test/only"),
      ),
    ).toEqual([""]);
  });
});

describe("rule placement", () => {
  const id = "scope.make.data.id";
  const variables = { [id]: { created_by_workflow: true } };
  const connector = "00000000-0000-4000-8000-000000000001";
  const at = (path: string, extra: Record<string, unknown> = {}) => ({
    connector_id: connector,
    path,
    max_retries: 0,
    ...extra,
  });
  test.each([
    ["default retries", at(`/jobs/\${${id}}`, { max_retries: undefined })],
    ["two retries", at(`/jobs/\${${id}}`, { max_retries: 2 })],
    ["a retried status", at(`/jobs/\${${id}}`, { retry_on_status: [503] })],
  ])("a removal with %s is misplaced though its path fits", (_name, step) => {
    expect(ownedDeleteCollection({ variables }, step)).toBe("/jobs");
    expect(createdByWorkflowMisplaced({ variables }, "DELETE", step)).toBe(true);
  });

  test.each([
    ["the last segment after a fixed collection", "DELETE", at(`/jobs/\${${id}}`), "/jobs"],
    ["a nested fixed collection", "DELETE", at(`v2/sites/jobs/\${${id}}/`), "/v2/sites/jobs"],
    ["the root collection", "DELETE", at(`/\${${id}}`), "/"],
    ["another method", "PATCH", at(`/jobs/\${${id}}`), null],
    ["no connector", "DELETE", { path: `/jobs/\${${id}}` }, null],
    ["a full url", "DELETE", at(`/jobs/\${${id}}`, { url: "https://a.test" }), null],
    ["no path", "DELETE", { connector_id: connector }, null],
    ["not the last segment", "DELETE", at(`/jobs/\${${id}}/runs`), null],
    ["a varying collection", "DELETE", at(`/\${input.team}/jobs/\${${id}}`), null],
    ["a dot segment", "DELETE", at(`/jobs/../\${${id}}`), null],
    ["a query in the path", "DELETE", at(`/jobs?x=1/\${${id}}`), null],
    ["part of a segment", "DELETE", at(`/jobs/job-\${${id}}`), null],
    ["the runtime destination", "DELETE", undefined, null],
    [
      "a paged removal",
      "DELETE",
      at(`/jobs/\${${id}}`, {
        pagination: {
          strategy: "cursor",
          cursor_request_param: "start_cursor",
          cursor_response_path: "$.next_cursor",
          max_pages: 3,
        },
      }),
      null,
    ],
  ])("%s", (_name, method, step, collection) => {
    const allowed = method === "DELETE" ? ownedDeleteCollection({ variables }, step) : null;
    expect(allowed).toBe(collection);
    expect(createdByWorkflowMisplaced({ variables }, method, step)).toBe(collection === null);
  });

  test("two owned variables on one removal are refused", () => {
    const both = { variables: { ...variables, "item.id": { created_by_workflow: true } } };
    expect(ownedDeleteCollection(both, at(`/jobs/\${${id}}`))).toBeNull();
  });

  test("a boundary without the rule is never misplaced", () => {
    expect(
      createdByWorkflowMisplaced({ variables: { a: { enum: ["x"] } } }, "GET", undefined),
    ).toBe(false);
  });
});

describe("delete outcome", () => {
  const refusals = new Set(["execution_authority_changed"]);
  test.each([
    ["succeeded", undefined, undefined, "delete_confirmed"],
    ["succeeded", true, undefined, "delete_refused"],
    ["timed_out", undefined, undefined, "delete_unconfirmed"],
    ["aborted", undefined, undefined, "delete_unconfirmed"],
    ["failed", undefined, "http_5xx", "delete_unconfirmed"],
    ["failed", undefined, "connection", "delete_unconfirmed"],
    ["failed", undefined, undefined, "delete_unconfirmed"],
    ["failed", undefined, "http_4xx", "delete_refused"],
    ["failed", undefined, "http_429", "delete_refused"],
    ["failed", undefined, "request_invalid", "delete_refused"],
    ["failed", undefined, "authority_invalid", "delete_refused"],
    ["failed", undefined, "execution_authority_changed", "delete_refused"],
  ])("%s held=%s code=%s -> %s", (status, held, code, outcome) => {
    expect(
      deleteOutcome({ status, held, error: code === undefined ? null : { code } }, refusals),
    ).toBe(outcome as never);
  });
});

describe("records_created on a step", () => {
  const connector = "00000000-0000-4000-8000-000000000001";
  const base = {
    id: "make",
    kind: "request",
    connector_id: connector,
    path: "/jobs",
    records_created: { id_path: "data.id" },
  };
  const issues = (step: Record<string, unknown>) =>
    JSON.stringify(RequestStepSchema.safeParse(step).error?.issues ?? []);

  test.each([
    ["a POST to a fixed collection", { method: "POST" }, "/jobs"],
    ["a PUT to a fixed path", { method: "PUT", path: "jobs/nightly/" }, "/jobs/nightly"],
    ["a POST to a search action", { method: "POST", path: "/items/search" }, "/items/search"],
  ])("%s may record", (_name, extra, collection) => {
    const step = RequestStepSchema.parse({ ...base, ...extra });
    expect(recordsCreatedEndpoint(step)).toEqual({
      id_path: "data.id",
      collection_path: collection,
    });
  });

  test.each([
    ["a PUT on an existing resource", { method: "PUT", path: "/jobs/${input.id}" }],
    ["a PATCH", { method: "PATCH" }],
    ["a GET", { method: "GET" }],
    ["a DELETE", { method: "DELETE" }],
    ["a POST to an action on an existing id", { method: "POST", path: "/jobs/${scope.a.id}/copy" }],
    ["a path with a query", { method: "POST", path: "/jobs?id=1" }],
    ["a dot segment", { method: "POST", path: "/jobs/../users" }],
    ["a full url", { method: "POST", path: undefined, url: "https://a.test/jobs" }],
    ["no connector", { method: "POST", connector_id: undefined, url: "https://a.test/jobs" }],
  ])("%s is refused with records_created_misplaced", (_name, extra) => {
    expect(issues({ ...base, ...extra })).toContain(
      JSON.stringify(RECORDS_CREATED_MISPLACED).slice(1, -1),
    );
  });

  test.each([["$.id"], ["items[0].id"], ["items[*].id"], ["*"], ["data..id"], [".id"]])(
    "the id path %s is refused",
    (id_path) => {
      expect(
        RequestStepSchema.safeParse({ ...base, method: "POST", records_created: { id_path } })
          .success,
      ).toBe(false);
    },
  );

  test("a step without records_created records nothing", () => {
    expect(
      recordsCreatedEndpoint({ ...base, records_created: undefined, method: "POST" }),
    ).toBeNull();
  });
});
