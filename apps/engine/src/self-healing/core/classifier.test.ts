import { expect, test } from "bun:test";
import fc from "fast-check";
import type { PatchProposal } from "../../llm/flows/repair.ts";
import type { DriftSignal } from "../types.ts";
import { classifyPatch, classifyRateLimitFromTemplate } from "./classifier.ts";

const proposal: PatchProposal = {
  kind: "update_field_path",
  classification: "safe",
  description: "repair",
  patch: {},
  reasoning: "rename",
};

test("rate-limit retry hints apply only to 429 or 503 and need template facts", () => {
  const capabilities = {
    webhooks: false,
    webhook_events: [],
    rate_limits: { requests_per_second: 1, burst_size: 2, recommended_backoff_ms: 1500 },
  };
  for (const status of [429, 503]) {
    expect(classifyRateLimitFromTemplate(capabilities, status)).toEqual({
      kind: "rate_limited",
      recommended_action: "retry_with_backoff",
      recommended_backoff_ms: 1500,
    });
    expect(classifyRateLimitFromTemplate(null, status)).toBeNull();
    expect(
      classifyRateLimitFromTemplate({ ...capabilities, rate_limits: null }, status),
    ).toBeNull();
  }
  expect(classifyRateLimitFromTemplate(capabilities, 500)).toBeNull();
});

test("auth and encoding changes require a person even inside the safe palette", () => {
  expect(classifyPatch({ ...proposal, patch: { credential_mode: "changed" } }, null)).toEqual({
    classification: "unsafe",
    reasons: ["patch touches auth scheme"],
  });
  expect(classifyPatch({ ...proposal, patch: { format_flip: true } }, null)).toEqual({
    classification: "unsafe",
    reasons: ["patch flips request/response encoding format"],
  });
  expect(classifyPatch({ ...proposal, patch: null } as unknown as PatchProposal, null)).toEqual({
    classification: "safe",
    reasons: ["rename/widening/optional-only patch"],
  });
});

test("stdlib and validation drift are never inferred safe from the proposed palette", () => {
  const stdlib: DriftSignal = {
    kind: "stdlib_version_drift",
    surface: "workflow",
    resource_id: "w",
    recorded_version: "1.0",
    current_version: "2.0",
    recorded_major: 1,
    current_major: 2,
  };
  expect(classifyPatch(proposal, stdlib)).toEqual({
    classification: "unsafe",
    reasons: ["stdlib drift: recorded major 1, current major 2"],
  });
  expect(
    classifyPatch(proposal, {
      kind: "validation_failed",
      expression: "count > 0",
      actual_value: 0,
    }),
  ).toEqual({
    classification: "unsafe",
    reasons: ["validation_failed: invariant 'count > 0' did not hold"],
  });
});

test("endpoint contract diagnostics prefer explicit path then URL and retain severity", () => {
  const endpoint = {
    kind: "endpoint_contract" as const,
    severity: "removed" as const,
    request: { path: "/items", url: "https://example.org/fallback" },
    sunset: null,
    successor_uri: null,
  };
  expect(classifyPatch(proposal, endpoint)).toEqual({
    classification: "unsafe",
    reasons: ["endpoint_contract: vendor removed /items"],
  });
  expect(
    classifyPatch(proposal, {
      ...endpoint,
      severity: "deprecated",
      request: { url: "https://example.org/items" },
    }).reasons,
  ).toEqual(["endpoint_contract: vendor deprecated https://example.org/items"]);
  expect(classifyPatch(proposal, { ...endpoint, request: {} }).reasons).toEqual([
    "endpoint_contract: vendor removed the endpoint",
  ]);
});

test("unsafe proposal precedence is deterministic without changing frozen patch facts", () => {
  fc.assert(
    fc.property(fc.string(), (method) => {
      const value = Object.freeze({
        ...proposal,
        classification: "unsafe" as const,
        patch: Object.freeze({ method }),
      });
      const before = JSON.stringify(value);
      expect(classifyPatch(value, null)).toEqual({
        classification: "unsafe",
        reasons: ["proposal.classification=unsafe"],
      });
      expect(JSON.stringify(value)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("HTTP method writes are rejected even under a normally safe patch kind", () => {
  expect(classifyPatch({ ...proposal, patch: { method: "POST" } }, null)).toEqual({
    classification: "unsafe",
    reasons: ["patch touches HTTP method"],
  });
});
