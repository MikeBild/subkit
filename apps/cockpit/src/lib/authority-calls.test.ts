// An approval that covers two workflows has to read as two workflows.
//
// The grouping is by call path and never by step id. A parent and the workflow
// it starts may both call a step `publish` against different targets; merged,
// the dialog would show one permission where two are being granted, and the
// human would approve the second without seeing it.

import { expect, test } from "bun:test";
import { effectKey, groupByCall, requestsOfCall } from "./authority-calls";

type Manifest = Parameters<typeof groupByCall>[0];
type Shape = Parameters<typeof groupByCall>[1];

const effect = (step_id: string, target: string, call_path?: string[]) =>
  ({
    tenant_id: "t",
    step_id,
    connector_id: null,
    driver: "http",
    environment: "dev",
    request_digest: "d",
    target,
    configuration_digest: "c",
    credential_binding_digest: null,
    rewrites_target: false,
    operation: "POST",
    effect: "write",
    ...(call_path ? { call_path } : {}),
  }) as unknown as NonNullable<Manifest>["effects"][number];

const manifest = (over: Partial<NonNullable<Manifest>> = {}) =>
  ({
    schema_version: 1,
    tenant_id: "t",
    workflow_id: "w",
    workflow_version_id: "v",
    workflow_digest: "d",
    execution_environment: "dev",
    execution_options_digest: "o",
    effects: [],
    issues: [],
    ...over,
  }) as unknown as Manifest;

test("own permissions come first, then one section per called workflow", () => {
  const groups = groupByCall(
    manifest({
      effects: [
        effect("collect", "https://parent.test/collect"),
        effect("publish", "https://child.test/publish", ["b_call"]),
        effect("publish", "https://other.test/publish", ["a_call"]),
      ],
      calls: [
        {
          step_id: "b_call",
          workflow_id: "w2",
          workflow_version_id: "v2",
          workflow_digest: "x",
          execution_options_digest: "y",
        },
        {
          step_id: "a_call",
          workflow_id: "w3",
          workflow_version_id: "v3",
          workflow_digest: "x",
          execution_options_digest: "y",
        },
      ],
    } as never),
    {
      requests: [],
      iterations: [],
      run_limit_is_request_limit: false,
      calls: [
        {
          step_id: "a_call",
          workflow_id: "w3",
          workflow_slug: "essays",
          workflow_name: "Publish essays",
          version: 4,
        },
      ],
    } as unknown as Shape,
  );
  expect(groups.map((g) => g.step_id)).toEqual([null, "b_call", "a_call"]);
  expect(groups[0]?.effects.map((e) => e.step_id)).toEqual(["collect"]);
  // Named where the shape knows the workflow, honest where it does not.
  expect(groups[2]?.workflow_name).toBe("Publish essays");
  expect(groups[2]?.version).toBe(4);
  expect(groups[1]?.workflow_name).toBeNull();
});

test("a parent and a child sharing a step id stay two permissions", () => {
  const groups = groupByCall(
    manifest({
      effects: [
        effect("publish", "https://parent.test/publish"),
        effect("publish", "https://child.test/publish", ["run_child"]),
      ],
      calls: [
        {
          step_id: "run_child",
          workflow_id: "w2",
          workflow_version_id: "v2",
          workflow_digest: "x",
          execution_options_digest: "y",
        },
      ],
    } as never),
    null,
  );
  expect(groups[0]?.effects[0]?.target).toBe("https://parent.test/publish");
  expect(groups[1]?.effects[0]?.target).toBe("https://child.test/publish");
  // And their React keys differ, or one row would replace the other.
  expect(effectKey(undefined, "publish")).not.toBe(effectKey(["run_child"], "publish"));
});

test("a call that contributes no permissions is still shown", () => {
  // "This run starts that workflow" is part of what is being approved, even
  // when the child turns out to do nothing outward-facing.
  const groups = groupByCall(
    manifest({
      effects: [effect("collect", "https://parent.test/collect")],
      calls: [
        {
          step_id: "run_child",
          workflow_id: "w2",
          workflow_version_id: "v2",
          workflow_digest: "x",
          execution_options_digest: "y",
        },
      ],
    } as never),
    null,
  );
  expect(groups.map((g) => g.step_id)).toEqual([null, "run_child"]);
  expect(groups[1]?.effects).toEqual([]);
});

test("a workflow that calls nothing has exactly one group", () => {
  const groups = groupByCall(
    manifest({ effects: [effect("collect", "https://parent.test/collect")] }),
    null,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.step_id).toBeNull();
  expect(groupByCall(null, null)).toHaveLength(1);
});

test("request blocks split the same way", () => {
  const shape = {
    requests: [
      {
        step_id: "collect",
        retry_policy_max_attempts: 1,
        redacted_request_json: "{}",
        request_review_truncated: false,
        opaque_payload_omitted: false,
      },
      {
        step_id: "publish",
        retry_policy_max_attempts: 1,
        redacted_request_json: "{}",
        request_review_truncated: false,
        opaque_payload_omitted: false,
        call_path: ["run_child"],
      },
    ],
    iterations: [],
    run_limit_is_request_limit: false,
  } as unknown as Shape;
  expect(requestsOfCall(shape, null).map((r) => r.step_id)).toEqual(["collect"]);
  expect(requestsOfCall(shape, "run_child").map((r) => r.step_id)).toEqual(["publish"]);
  expect(requestsOfCall(shape, "absent")).toEqual([]);
});
