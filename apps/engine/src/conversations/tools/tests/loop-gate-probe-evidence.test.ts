import { describe, expect, test } from "bun:test";
import { stepFingerprint } from "../../step-fingerprint.ts";
import type { DraftDocument } from "../../types.ts";
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
            body: ["body"],
          },
          { id: "body", kind: "transform", expression: "$item" },
        ],
      },
      null,
      { probedConnectorSlugs: new Set(["digitalocean"]) },
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("no_dry_run_yet");
  });

  test("fingerprint-valid recorded evidence satisfies the gate", () => {
    const fetch = {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://example.com/items",
    };
    const preview: DraftDocument["latest_preview"] = {
      ok: true,
      step_id: "fetch",
      summary: "ok",
      step_traces: [
        {
          step_id: "fetch",
          kind: "request",
          status: "succeeded",
          fingerprint: stepFingerprint(fetch),
          output_preview: { items: [{ id: "a" }] },
          scope_at_step: {
            available_paths: ["items", "items[0].id"],
            shape_summary: "object{items[1]}",
            primary_data_path: "items",
          },
        },
      ],
    };
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          fetch,
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["b"] },
          { id: "b", kind: "transform", expression: "$item" },
        ],
      },
      preview,
    );
    expect(result.ok).toBe(true);
  });

  test("STALE evidence (fingerprint recorded against a different definition) blocks", () => {
    const fetch = {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://example.com/v2/items",
    };
    const preview: DraftDocument["latest_preview"] = {
      ok: true,
      step_id: "fetch",
      summary: "ok",
      step_traces: [
        {
          step_id: "fetch",
          kind: "request",
          status: "succeeded",
          fingerprint: stepFingerprint({ ...fetch, url: "https://example.com/items" }),
          output_preview: { items: [{ id: "a" }] },
          scope_at_step: {
            available_paths: ["items"],
            shape_summary: "object{items[1]}",
            primary_data_path: "items",
          },
        },
      ],
    };
    const result = evaluateLoopAuthoringGate(
      {
        steps: [
          fetch,
          { id: "iter", kind: "loop", over: "$scope.fetch.data.items", body: ["b"] },
          { id: "b", kind: "transform", expression: "$item" },
        ],
      },
      preview,
    );
    expect(result.ok).toBe(false);
    expect(result.blocks[0]?.reason).toBe("preview_stale_for_referenced_step");
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
            body: ["body"],
          },
          { id: "body", kind: "transform", expression: "$item" },
        ],
      },
      null,
    );
    expect(result.ok).toBe(false);
  });
});
