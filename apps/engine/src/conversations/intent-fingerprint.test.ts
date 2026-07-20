import { describe, expect, test } from "bun:test";
import type { DiscoveredConnectorEndpoints } from "./endpoint-grounding.ts";
import { authoringIntentFingerprint, groundingFingerprint } from "./intent-fingerprint.ts";

function idx(
  entries: Array<[string, DiscoveredConnectorEndpoints]>,
): Map<string, DiscoveredConnectorEndpoints> {
  return new Map(entries);
}

const stripe: DiscoveredConnectorEndpoints = {
  slug: "stripe",
  base_url: "https://api.stripe.com",
  endpoints: [
    { method: "POST", path: "/v1/charges", request_content_type: "application/json" },
    { method: "POST", path: "/v1/refunds", request_content_type: "application/json" },
  ],
};

describe("groundingFingerprint", () => {
  test("stable across id/slug duplicate entries and endpoint order", () => {
    const a = idx([
      ["conn-1", stripe],
      ["stripe", stripe],
    ]);
    const reordered: DiscoveredConnectorEndpoints = {
      ...stripe,
      endpoints: [...stripe.endpoints].reverse(),
    };
    const b = idx([["stripe", reordered]]);
    expect(groundingFingerprint(a)).toBe(groundingFingerprint(b));
  });

  test("changes when an endpoint's shape actually changes", () => {
    const changed: DiscoveredConnectorEndpoints = {
      ...stripe,
      endpoints: [
        { method: "POST", path: "/v2/charges", request_content_type: "application/json" },
      ],
    };
    expect(groundingFingerprint(idx([["stripe", stripe]]))).not.toBe(
      groundingFingerprint(idx([["stripe", changed]])),
    );
  });

  test("empty index → null (nothing to anchor)", () => {
    expect(groundingFingerprint(idx([]))).toBeNull();
  });

  test("docs content hash participates", () => {
    const base = idx([["stripe", stripe]]);
    expect(groundingFingerprint(base, new Map([["stripe", "h1"]]))).not.toBe(
      groundingFingerprint(base, new Map([["stripe", "h2"]])),
    );
  });
});

describe("authoringIntentFingerprint", () => {
  test("same kind + same workflow draft → same fingerprint", () => {
    const wf = { name: "w", steps: [{ id: "s1", kind: "request" }] };
    const a = authoringIntentFingerprint({ kind: "save_workflow_draft" }, { workflow: wf });
    const b = authoringIntentFingerprint({ kind: "save_workflow_draft" }, { workflow: { ...wf } });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("an edited workflow draft yields a different fingerprint", () => {
    const a = authoringIntentFingerprint(
      { kind: "save_workflow_draft" },
      { workflow: { name: "w", steps: [{ id: "s1" }] } },
    );
    const b = authoringIntentFingerprint(
      { kind: "save_workflow_draft" },
      { workflow: { name: "w", steps: [{ id: "s1" }, { id: "s2" }] } },
    );
    expect(a).not.toBe(b);
  });

  test("different confirm kind → different fingerprint", () => {
    expect(authoringIntentFingerprint({ kind: "external_write" }, null)).not.toBe(
      authoringIntentFingerprint({ kind: "save_workflow_draft" }, null),
    );
  });

  test("no draft → still deterministic (keyed on kind/commit_intent)", () => {
    const a = authoringIntentFingerprint({ kind: "generic", commit_intent: { x: 1 } }, null);
    const b = authoringIntentFingerprint({ kind: "generic", commit_intent: { x: 1 } }, undefined);
    expect(a).toBe(b);
  });
});
