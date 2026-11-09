// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored workflow substitutions
import { expect, test } from "bun:test";
import { workflowJsonDigest } from "../canonical-json.ts";
import {
  compileWorkflowEffectManifest,
  type ResolvedEffectBinding,
} from "../core/effect-manifest.ts";
import { GMAIL_SEND_TARGET } from "../report-delivery-boundary.ts";
import { WorkflowDefSchema } from "../types.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const workflow = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const connector = "00000000-0000-4000-8000-000000000004";
const profile = {
  kind: "gmail_outbox",
  source_step_id: "next_mail",
  recipient_field: "recipient",
  item_id_field: "id",
  from: "sender@example.test",
  content_type: "text/plain",
  max_body_bytes: 4096,
  max_per_day: 50,
};

function fixture(
  options: {
    source?: boolean;
    sourceMethod?: string;
    sourceIssue?: boolean;
    sourceGraphql?: unknown;
  } = {},
) {
  const definition = WorkflowDefSchema.parse({
    name: "Outbox",
    execution_privacy: "sensitive",
    steps: [
      ...(options.source === false
        ? []
        : [
            {
              id: "next_mail",
              kind: "request",
              connector_id: connector,
              method: options.sourceMethod ?? "GET",
              url: "https://queue.example.test/next",
              ...(options.sourceGraphql ? { graphql: options.sourceGraphql } : {}),
            },
          ]),
      {
        id: "send_email",
        kind: "request",
        connector_id: connector,
        method: "POST",
        url: GMAIL_SEND_TARGET,
        max_retries: 0,
        outbox_delivery: profile,
        body: { raw: "${scope.compose.data.raw}" },
      },
    ],
  });
  const bindings: ResolvedEffectBinding[] = definition.steps.map((step) => ({
    tenant_id: tenant,
    step_id: step.id,
    connector_id: connector,
    driver: options.sourceGraphql && step.id === "next_mail" ? "graphql" : "http",
    environment: "dev",
    request_digest:
      options.sourceIssue && step.id === "next_mail" ? "0".repeat(64) : workflowJsonDigest(step),
    target: step.id === "next_mail" ? "https://queue.example.test/next" : GMAIL_SEND_TARGET,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    ...(step.kind === "request" && step.outbox_delivery
      ? { outbox_delivery: step.outbox_delivery }
      : {}),
  }));
  return {
    tenant_id: tenant,
    workflow_id: workflow,
    workflow_version_id: version,
    execution_environment: "dev",
    execution_options_digest: "c".repeat(64),
    definition,
    bindings,
  };
}

test("outbox delivery requires an issue-free read source in the same manifest", () => {
  const accepted = compileWorkflowEffectManifest(fixture());
  expect(accepted.manifest.issues).toEqual([]);
  expect(accepted.eligible_for_repeated_runs).toBe(true);
  expect(accepted.manifest.effects.map((effect) => [effect.step_id, effect.effect])).toEqual([
    ["next_mail", "read"],
    ["send_email", "write"],
  ]);
  for (const [options, expected] of [
    [
      { source: false },
      [
        { step_id: "send_email", code: "binding_mismatch" },
        { step_id: "send_email", code: "binding_mismatch" },
      ],
    ],
    [
      { sourceMethod: "POST" },
      [
        { step_id: "send_email", code: "binding_mismatch" },
        { step_id: "send_email", code: "binding_mismatch" },
      ],
    ],
    [
      { sourceGraphql: { query: "mutation Consume { consume { id } }" } },
      [{ step_id: "send_email", code: "binding_mismatch" }],
    ],
    [
      { sourceIssue: true },
      [
        { step_id: "next_mail", code: "binding_mismatch" },
        { step_id: "send_email", code: "binding_mismatch" },
      ],
    ],
  ] as const) {
    const rejected = compileWorkflowEffectManifest(fixture(options));
    expect(rejected.eligible_for_repeated_runs).toBe(false);
    expect(rejected.manifest.issues).toEqual(
      expected.map(({ step_id, code }) => ({ step_id, code })),
    );
  }
});

test("outbox authority is sensitive, profile-exact, and cannot appear on only one side", () => {
  const baseline = fixture();
  const delivery = baseline.bindings.find((binding) => binding.step_id === "send_email");
  if (!delivery?.outbox_delivery) throw new Error("missing outbox fixture");

  const { execution_privacy: _privacy, ...publicDefinition } = baseline.definition;
  const nonSensitive = {
    ...baseline,
    definition: WorkflowDefSchema.parse(publicDefinition),
  };
  const absentBinding = {
    ...baseline,
    bindings: baseline.bindings.map((binding) =>
      binding.step_id === "send_email" ? { ...binding, outbox_delivery: undefined } : binding,
    ),
  };
  const alteredProfile = {
    ...baseline,
    bindings: baseline.bindings.map((binding) =>
      binding.step_id === "send_email"
        ? { ...binding, outbox_delivery: { ...delivery.outbox_delivery, max_per_day: 49 } }
        : binding,
    ),
  };
  const unexpectedBinding = fixture();
  unexpectedBinding.definition = WorkflowDefSchema.parse({
    ...unexpectedBinding.definition,
    steps: unexpectedBinding.definition.steps.map((step) =>
      step.id === "send_email" && step.kind === "request"
        ? (() => {
            const { outbox_delivery: _delivery, ...withoutDelivery } = step;
            return withoutDelivery;
          })()
        : step,
    ),
  });
  for (const candidate of [nonSensitive, absentBinding, alteredProfile, unexpectedBinding]) {
    const result = compileWorkflowEffectManifest(candidate);
    expect(result.manifest.issues).toContainEqual({
      step_id: "send_email",
      code: "binding_mismatch",
    });
    expect(result.eligible_for_repeated_runs).toBe(false);
  }
});

test("outbox post-pass distinguishes a missing source effect from an unknown source effect", () => {
  const withoutEffect = fixture();
  withoutEffect.bindings = withoutEffect.bindings.filter(
    (binding) => binding.step_id !== "next_mail",
  );
  expect(compileWorkflowEffectManifest(withoutEffect).manifest.issues).toEqual([
    { step_id: "next_mail", code: "missing_binding" },
    { step_id: "send_email", code: "binding_mismatch" },
  ]);

  const unknown = fixture();
  unknown.bindings = unknown.bindings.map((binding) =>
    binding.step_id === "next_mail" ? { ...binding, driver: "postgres" } : binding,
  );
  expect(compileWorkflowEffectManifest(unknown).manifest.issues).toEqual([
    { step_id: "next_mail", code: "binding_mismatch" },
    { step_id: "next_mail", code: "unknown_effect" },
    { step_id: "send_email", code: "binding_mismatch" },
  ]);
});

test("a called child's same-named source issue cannot invalidate this manifest's outbox source", () => {
  const parent = fixture();
  parent.definition = WorkflowDefSchema.parse({
    ...parent.definition,
    steps: [
      ...parent.definition.steps,
      { id: "child", kind: "call", workflow_id: "00000000-0000-4000-8000-000000000005" },
    ],
  });
  const child = WorkflowDefSchema.parse({
    name: "child",
    steps: [
      {
        id: "next_mail",
        kind: "request",
        connector_id: connector,
        method: "GET",
        path: "/mail/${scope.input.id}",
      },
    ],
  });
  const childStep = child.steps[0]!;
  const childBinding: ResolvedEffectBinding = {
    tenant_id: tenant,
    step_id: "next_mail",
    connector_id: connector,
    driver: "http",
    environment: "dev",
    request_digest: workflowJsonDigest(childStep),
    target: "https://queue.example.test/mail",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
  };
  const result = compileWorkflowEffectManifest({
    ...parent,
    calls: [
      {
        step_id: "child",
        workflow_id: "00000000-0000-4000-8000-000000000005",
        workflow_slug: "child",
        workflow_version_id: "00000000-0000-4000-8000-000000000006",
        execution_options_digest: "d".repeat(64),
        definition: child,
        bindings: [childBinding],
      },
    ],
  });
  expect(result.manifest.issues).toEqual([
    { step_id: "next_mail", code: "dynamic_request", call_path: ["child"] },
  ]);
});

test("outbox selects its reviewed read source even after an unrelated write effect", () => {
  const input = fixture();
  const definition = WorkflowDefSchema.parse({
    ...input.definition,
    steps: [
      { id: "unrelated", kind: "request", connector_id: connector, method: "POST", path: "/write" },
      ...input.definition.steps,
    ],
  });
  const unrelated: ResolvedEffectBinding = {
    ...input.bindings[0]!,
    step_id: "unrelated",
    request_digest: workflowJsonDigest(definition.steps[0]),
    target: "https://queue.example.test/write",
  };
  const result = compileWorkflowEffectManifest({
    ...input,
    definition,
    bindings: [unrelated, ...input.bindings],
  });
  expect(result.manifest.issues).toEqual([]);
  expect(result.manifest.effects.find((effect) => effect.step_id === "unrelated")?.effect).toBe(
    "write",
  );
});

test("an unrelated root issue does not invalidate an otherwise valid outbox source", () => {
  const input = fixture();
  const definition = WorkflowDefSchema.parse({
    ...input.definition,
    steps: [
      { id: "unrelated", kind: "request", connector_id: connector, method: "GET", path: "/read" },
      ...input.definition.steps,
    ],
  });
  const result = compileWorkflowEffectManifest({ ...input, definition });
  expect(result.manifest.issues).toEqual([{ step_id: "unrelated", code: "missing_binding" }]);
});
