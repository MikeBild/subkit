import { expect, test } from "bun:test";
import { canonicalWorkflowJson, workflowJsonDigest } from "../canonical-json.ts";
import { compileWorkflowEffectManifest } from "../effect-manifest.ts";
import { WorkflowDefSchema } from "../types.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";
const CONNECTOR = "00000000-0000-4000-8000-000000000004";
const GMAIL_CONNECTOR = "00000000-0000-4000-8000-000000000005";
const CK_CONNECTOR = "00000000-0000-4000-8000-000000000006";
const ITEM_A = "00000000-0000-4000-8000-00000000000a";
const ITEM_B = "00000000-0000-4000-8000-00000000000b";
const SITE = "00000000-0000-4000-8000-00000000000c";
const CHILD_WORKFLOW = "00000000-0000-4000-8000-00000000000d";
const CHILD_VERSION = "00000000-0000-4000-8000-00000000000e";
const CHILD_OPTIONS_DIGEST = "b".repeat(64);

const RUNTIME_OPTIONS_DIGEST = "a".repeat(64);
const CONFIG_DIGEST = "d".repeat(64);
const CREDENTIAL_DIGEST = "e".repeat(64);

function binding(step_id: string, request_digest: string, extra: Record<string, unknown>) {
  return {
    tenant_id: TENANT,
    step_id,
    connector_id: CONNECTOR,
    driver: "http" as const,
    environment: "prod" as const,
    request_digest,
    configuration_digest: CONFIG_DIGEST,
    credential_binding_digest: CREDENTIAL_DIGEST,
    rewrites_target: false,
    ...extra,
  };
}

const SHAPES: Record<string, { definition: unknown; bindings: unknown[]; calls?: unknown[] }> = {
  read_path: {
    definition: {
      name: "read path",
      steps: [
        {
          id: "read",
          kind: "request",
          connector_id: CONNECTOR,
          method: "GET",
          path: "/v2/projects/${item.id}/resources",
        },
      ],
    },
    bindings: [
      binding("read", "ab217d8a940e9fd1798d8e5a1b8c6d19d1ef8b49d51ec103731f844bcbea08cb", {
        read_path: {
          origin: "https://api.example.test",
          segments: ["", "v2", "projects", null, "resources"],
          search: "",
        },
        target: "https://api.example.test/v2/projects/{ID}/resources",
      }),
    ],
  },
  read_query: {
    definition: {
      name: "read query",
      steps: [
        {
          id: "list",
          kind: "request",
          connector_id: CONNECTOR,
          method: "GET",
          path: "/v1/reports?limit=50",
          query: { since: "${input.since}" },
        },
      ],
    },
    bindings: [
      binding("list", "eb3a611faf31c8245e4a1e628aeb328e6eb84f88a8c2fc626c244b0f0789d348", {
        target: "https://api.example.test/v1/reports",
      }),
    ],
  },
  report_delivery: {
    definition: {
      name: "report delivery",
      steps: [
        {
          id: "send_report",
          kind: "request",
          connector_id: GMAIL_CONNECTOR,
          method: "POST",
          path: "/gmail/v1/users/me/messages/send",
          body: { raw: "${steps.render.data.raw}" },
        },
      ],
    },
    bindings: [
      {
        ...binding(
          "send_report",
          "562d85e4d755a7ddf1493ac0cab4ca415274adc3ab5a28e34fad782a33fd96ca",
          {
            target: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            report_delivery: {
              kind: "gmail_report",
              to: "recipient@example.test",
              from: "sender@example.test",
              content_type: "text/html",
            },
          },
        ),
        connector_id: GMAIL_CONNECTOR,
      },
    ],
  },
  content_publication: {
    definition: {
      name: "content publication",
      steps: [
        {
          id: "revise",
          kind: "request",
          connector_id: CK_CONNECTOR,
          method: "PUT",
          path: "/v1/content/${item.id}/revisions",
          body: "${item.markdown}",
          headers: { "content-type": "text/markdown" },
        },
        {
          id: "release",
          kind: "request",
          connector_id: CK_CONNECTOR,
          method: "POST",
          path: `/v1/sites/${SITE}/releases`,
          body: {
            revision_ids: "${steps.revise.data.revision_ids}",
            reason: "weekly release",
          },
          headers: { "content-type": "application/json" },
        },
      ],
    },
    bindings: [
      {
        ...binding("revise", "a2db2ff26d75ab1df802d141d09c0416a4e946d157994fad22ce4c7284aac9b1", {
          target: "https://contentkit.example.test/v1/content/{approved-item}/revisions",
          content_publication: {
            kind: "content_revision",
            origin: "https://contentkit.example.test",
            item_ids: [ITEM_A, ITEM_B],
            max_bytes: 200_000,
          },
        }),
        connector_id: CK_CONNECTOR,
      },
      {
        ...binding("release", "98a0c6b18e261305060bc5b38fed5d0bdc1beb208037de75935b69a93898a949", {
          target: `https://contentkit.example.test/v1/sites/${SITE}/releases`,
          content_publication: {
            kind: "content_release",
            origin: "https://contentkit.example.test",
            site_id: SITE,
            reason: "weekly release",
            sources: [{ step_id: "revise", item_ids: [ITEM_A, ITEM_B] }],
          },
        }),
        connector_id: CK_CONNECTOR,
      },
    ],
  },
  request_boundary: {
    definition: {
      name: "request boundary",
      steps: [
        {
          id: "retire",
          kind: "request",
          connector_id: CONNECTOR,
          method: "POST",
          path: "/sites/${input.site}/releases",
          headers: { "content-type": "application/json" },
          body: {
            reason: "retire ${scope.pick.data.count}",
            retire_item_ids: "${scope.pick.data.ids}",
          },
          boundary: {
            variables: { "input.site": { enum: ["company-cockpit"] } },
            max_body_bytes: 20000,
            max_calls: 1,
          },
        },
      ],
    },
    bindings: [
      binding("retire", "47fed950a2f4e773f48ad3fa8e3d0d5a3daee27e112d318e80e5f515faaf180f", {
        target: "https://api.example.test/v2/sites/{input.site}/releases",
        boundary: {
          base_url: "https://api.example.test/v2",
          method: "POST",
          origin: "https://api.example.test",
          segments: ["", "v2", "sites", { var: "input.site" }, "releases"],
          variables: { "input.site": { enum: ["company-cockpit"] } },
          query: { fixed: {}, variable: [] },
          max_body_bytes: 20000,
          max_calls: 1,
        },
      }),
    ],
  },
  request_boundary_classes_query: {
    definition: {
      name: "request boundary classes query",
      steps: [
        {
          id: "stats",
          kind: "request",
          connector_id: CONNECTOR,
          method: "GET",
          path: "/sites/${input.site}/stats/${item.id}",
          query: { from: "${scope.window.data.start}", tz: "UTC" },
          boundary: {
            variables: {
              "input.site": { enum: ["company-cockpit"] },
              "item.id": { class: "uuid" },
              "scope.window.data.start": { class: "timestamp" },
            },
            max_body_bytes: 0,
            max_calls: 30,
          },
        },
      ],
    },
    bindings: [
      binding("stats", "8d1da1942736f681a07dfa70e42cda092d99f625ba42befeebe74da251169963", {
        target: "https://api.example.test/v2/sites/{input.site}/stats/{item.id}",
        boundary: {
          base_url: "https://api.example.test/v2",
          method: "GET",
          origin: "https://api.example.test",
          segments: ["", "v2", "sites", { var: "input.site" }, "stats", { var: "item.id" }],
          variables: {
            "input.site": { enum: ["company-cockpit"] },
            "item.id": { class: "uuid" },
            "scope.window.data.start": { class: "timestamp" },
          },
          query: {
            fixed: { tz: "UTC" },
            variable: [{ key: "from", var: "scope.window.data.start" }],
          },
          max_body_bytes: 0,
          max_calls: 30,
        },
      }),
    ],
  },
  static_post: {
    definition: {
      name: "static post",
      steps: [
        {
          id: "send",
          kind: "request",
          connector_id: CONNECTOR,
          method: "POST",
          path: "/messages",
          body: { recipient: "reviewed@example.test", text: "Hello" },
        },
      ],
    },
    bindings: [
      binding("send", "fe24590c1f55a44c214fe8686b2f3c46bb9a5f6508253536eba65ef72893e1f1", {
        target: "https://example.test/messages",
      }),
    ],
  },
  bound_call: {
    definition: {
      name: "bound call",
      steps: [
        {
          id: "collect",
          kind: "request",
          connector_id: CONNECTOR,
          method: "GET",
          path: "/items",
        },
        { id: "run_child", kind: "call", workflow_id: CHILD_WORKFLOW },
      ],
    },
    bindings: [
      binding("collect", "6645cca45ef845fb842dc818388e962fdb999b57cd92b00abf4143879c6a9ad2", {
        target: "https://example.test/items",
      }),
    ],
    calls: [
      {
        step_id: "run_child",
        workflow_id: CHILD_WORKFLOW,
        workflow_slug: "publish-essay",
        workflow_version_id: CHILD_VERSION,
        execution_options_digest: CHILD_OPTIONS_DIGEST,
        definition: {
          name: "child",
          steps: [
            {
              id: "publish",
              kind: "request",
              connector_id: CONNECTOR,
              method: "POST",
              path: "/publish",
              body: { text: "Hello" },
            },
          ],
        },
        bindings: [
          binding("publish", "caedf38665e518b8104081bc75bcc513234e340e4a30c94c95c229f8953f0c35", {
            target: "https://example.test/publish",
          }),
        ],
      },
    ],
  },
  bound_call_shared_step_id: {
    definition: {
      name: "bound call shared step id",
      steps: [
        {
          id: "publish",
          kind: "request",
          connector_id: CONNECTOR,
          method: "POST",
          path: "/publish",
          body: { text: "Parent" },
        },
        { id: "run_child", kind: "call", workflow_id: CHILD_WORKFLOW },
      ],
    },
    bindings: [
      binding("publish", "89da25ecee202d1b8a623b3c0bd94b4b573d998bcabe658806c934b14fb5a7b8", {
        target: "https://parent.test/publish",
      }),
    ],
    calls: [
      {
        step_id: "run_child",
        workflow_id: CHILD_WORKFLOW,
        workflow_slug: "publish-essay",
        workflow_version_id: CHILD_VERSION,
        execution_options_digest: CHILD_OPTIONS_DIGEST,
        definition: {
          name: "child",
          steps: [
            {
              id: "publish",
              kind: "request",
              connector_id: CONNECTOR,
              method: "POST",
              path: "/publish",
              body: { text: "Child" },
            },
          ],
        },
        bindings: [
          binding("publish", "fc6fd295d4cb0a2a0d383dba0225578a7f3fb65d8b4ffd189ced736022d7559d", {
            target: "https://child.test/publish",
          }),
        ],
      },
    ],
  },
};

const PINNED: Record<string, { options_digest: string; digest: string }> = {
  read_path: {
    options_digest: "0adb25c715644c263971c3e264472a024b620562636261be4a9b969d43c09290",
    digest: "36caaf01c8c947d59b561c2658ee903085c12f6ac2171166e88a12e41f81b581",
  },
  read_query: {
    options_digest: "66184c4651c484e12bc4d96a275c2982ca6c26b4ade8828fbe1983e69c5a2c49",
    digest: "217cfb649d7cfe20c198161ac319b7f631a5ca764c1ca840e0d413011af47ff2",
  },
  report_delivery: {
    options_digest: "04d1ce48b7fead582665cb0eab207b768722e7b78dc2bd4a2296dcd133dff213",
    digest: "70c399cafc052e8ca101fea45ed45237ed5fc195641965166a4c758618d16ced",
  },
  content_publication: {
    options_digest: "d6d2d72cbba26fb45f4c9b802766cd5871e90431b47c1913436cc011152d96a0",
    digest: "81637ecac62fee67bb7b27c65d36a4d7e8ea85eb4906a9298e43046b62d3deb0",
  },
  request_boundary: {
    options_digest: "149b249e3250bd401a9dda84773021c20e7f1c9ae37a4c3f3915662928126bf6",
    digest: "d69c9ae53d07840949643281d900c61d06273c48179f06e44ee6cfd7533aa41d",
  },
  request_boundary_classes_query: {
    options_digest: "bf16eab60b7a38040a2585b62600b3aeb95e71368282fe1feb6f6f29d2b2af33",
    digest: "87f1f92b3669908fa7b01364610e81fa976dd4f8a96814efe1daf71c3c0e8332",
  },
  static_post: {
    options_digest: "8f5489e4afd09de4b17a8ae56cbbbe548e12f5fc16bc20295a3207a8ea31e854",
    digest: "55d4ff9a6cc3e64f551bdca9c7deede7fb4fb7acf5432f65914ba34463b3390c",
  },
  bound_call: {
    options_digest: "b8cfe3c76c5c4f32112d5c1e829f341ccb0f900136e1547fb3dc8a657c5deaaa",
    digest: "06c9dff262f435c18afacc1a1167045016a61aa73e6530e4a95e27749f4883a0",
  },
  bound_call_shared_step_id: {
    options_digest: "3120643a6ba4dfc48fc80a6be2defd91cd5b12e21e802b916f87799ed51b791c",
    digest: "9945d0dbd1691fb96f768b7d657743b722ac45efd4e740c79716695fc0cc61ed",
  },
};

function explain(name: string, actual: string, expected: string, manifest: unknown): string {
  return [
    "",
    `EFFECT-MANIFEST DIGEST PIN BROKEN — shape "${name}"`,
    `  expected: ${expected}`,
    `  actual:   ${actual}`,
    "",
    "WHAT THIS MEANS: the compiler now produces a different digest for an unchanged",
    "workflow. assertExecutionAuthorityCurrent recompiles and compares digests on EVERY",
    "dispatch, so shipping this stops every live execution authority of this shape with",
    "execution_authority_changed. Those grants cannot be repaired by a migration — a grant",
    "is a human decision bound to a digest, so each one has to be approved again.",
    "",
    "IF THIS IS INTENTIONAL: update the pin AND record the re-grant rollout in the same",
    "change — inventory the affected authorities and have a human re-approve each one.",
    "IF IT IS NOT: a new manifest field must be CONDITIONALLY SPREAD (an always-present",
    "key moves every digest; note a key set to undefined still serialises, so it must be",
    "absent), and a step schema must not gain a .default() (that moves normalized_definition",
    "and therefore every digest).",
    "",
    "canonical manifest:",
    canonicalWorkflowJson(manifest),
    "",
  ].join("\n");
}

test("the normalized definition shape is pinned — a step-schema .default() moves every digest", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const actual = workflowJsonDigest({
      runtime_options_digest: RUNTIME_OPTIONS_DIGEST,
      normalized_definition: WorkflowDefSchema.parse(shape.definition),
    });
    if (actual !== PINNED[name]!.options_digest)
      console.error(
        explain(
          `${name} (normalized definition)`,
          actual,
          PINNED[name]!.options_digest,
          WorkflowDefSchema.parse(shape.definition),
        ),
      );
    expect(actual).toBe(PINNED[name]!.options_digest);
  }
});

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`effect-manifest digest is pinned — ${name}`, () => {
    const result = compileWorkflowEffectManifest({
      tenant_id: TENANT,
      workflow_id: WORKFLOW,
      workflow_version_id: VERSION,
      execution_environment: "prod",
      execution_options_digest: PINNED[name]!.options_digest,
      definition: shape.definition,
      bindings: shape.bindings,
      ...(shape.calls ? { calls: shape.calls } : {}),
    });
    if (result.digest !== PINNED[name]!.digest || !result.eligible_for_repeated_runs)
      console.error(explain(name, result.digest, PINNED[name]!.digest, result.manifest));
    expect(result.manifest.issues).toEqual([]);
    expect(result.eligible_for_repeated_runs).toBe(true);
    expect(result.digest).toBe(PINNED[name]!.digest);
    expect(workflowJsonDigest(result.manifest)).toBe(PINNED[name]!.digest);
  });
}
