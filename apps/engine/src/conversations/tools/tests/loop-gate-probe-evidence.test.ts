// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// Probe-evidence exemption for the loop-authoring gate. When a
// loop's referenced upstream step is a `request` step routed through
// a connector the operator has already successfully probed in this
// conversation, the probe counts as shape evidence and the gate
// skips. Mirrors the reference impl's call_system → build_tool flow.
//
// Pre-fix (session 0a01c5f3 16:18:26): the LLM successfully probed
// the DigitalOcean connector twice (200 OK on /v2/projects and
// /v2/projects/{id}/resources), then issued build_workflow with a
// loop reading those same endpoints — and the gate STILL fired
// `loop_authoring_requires_inspect` because the probe wasn't
// recorded as a workflow dry_run. The LLM had to add an extra
// dry_run round-trip just to satisfy the gate. This test pins the
// new exemption.

import { describe, expect, test } from "bun:test";
import { evaluateLoopAuthoringGate } from "../loop-authoring-gate.ts";

describe("evaluateLoopAuthoringGate · probe-evidence exemption", () => {
  test("loop over a probed connector's request step → gate passes", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            connector_id: "co-1",
            connector_slug: "digitalocean",
            path: "/v2/projects",
          },
          {
            id: "iter",
            kind: "loop",
            over: "$scope.fetch.data.projects",
            item_var: "project",
            body: ["body"],
          },
          {
            id: "body",
            kind: "request",
            method: "GET",
            connector_id: "co-1",
            connector_slug: "digitalocean",
            path: "/v2/projects/${item.id}/resources",
          },
        ],
      },
      null,
      { probedConnectorSlugs: new Set(["digitalocean"]) },
    );
    expect(result.ok).toBe(true);
  });

  test("loop over a NON-probed connector still trips the gate", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            connector_id: "co-2",
            connector_slug: "stripe",
            path: "/v1/customers",
          },
          {
            id: "iter",
            kind: "loop",
            over: "$scope.fetch.data",
            item_var: "c",
            body: ["body"],
          },
          { id: "body", kind: "transform", expression: "$c" },
        ],
      },
      null,
      { probedConnectorSlugs: new Set(["digitalocean"]) },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_dry_run_yet");
  });

  test("when probedConnectorSlugs is omitted, behaves identically to pre-fix", () => {
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            connector_id: "co-1",
            connector_slug: "digitalocean",
            path: "/v2/projects",
          },
          {
            id: "iter",
            kind: "loop",
            over: "$scope.fetch.data.projects",
            item_var: "p",
            body: ["body"],
          },
          { id: "body", kind: "transform", expression: "$p" },
        ],
      },
      null,
      // No probedConnectorSlugs.
    );
    expect(result.ok).toBe(false);
  });
});
