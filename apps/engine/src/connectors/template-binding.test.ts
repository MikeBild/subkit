// Pure-function tests for template-binding.ts.
//
// Locks the precedence rules every connector resolves through:
//
//   probe_endpoint   →  config.probe_endpoint  ?? snapshot.probe_endpoint  ?? null
//   capabilities     →  config.capabilities    ?? snapshot.capabilities    ?? null
//   snapshot parse   →  ConnectorTemplateSchema  (returns null on failure,
//                       not throws — the connector boots even with a
//                       garbled snapshot)

import { describe, expect, test } from "bun:test";
import {
  getConnectorCapabilities,
  getConnectorProbeEndpoint,
  getConnectorTemplateSnapshot,
} from "./template-binding.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const aTemplate = loadBuiltinTemplates()[0];
if (!aTemplate) throw new Error("expected at least one built-in template for test fixtures");

describe("getConnectorTemplateSnapshot", () => {
  test("parses a valid snapshot back into a typed template", () => {
    const out = getConnectorTemplateSnapshot({
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out?.slug).toBe(aTemplate.slug);
  });

  test("returns null on a garbled snapshot (does not throw)", () => {
    const out = getConnectorTemplateSnapshot({
      template_snapshot: { wat: true } as unknown as Record<string, unknown>,
    });
    expect(out).toBeNull();
  });

  test("returns null when the snapshot is missing", () => {
    const out = getConnectorTemplateSnapshot({ template_snapshot: null });
    expect(out).toBeNull();
  });
});

describe("getConnectorProbeEndpoint", () => {
  const customProbe = { method: "GET" as const, path: "/v1/whoami", expect_status: 200 };

  test("config.probe_endpoint wins over snapshot", () => {
    const out = getConnectorProbeEndpoint({
      config: { probe_endpoint: customProbe },
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out).toEqual(customProbe);
  });

  test("falls through to snapshot.probe_endpoint when config doesn't set it", () => {
    const out = getConnectorProbeEndpoint({
      config: {},
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out).toEqual(aTemplate.probe_endpoint);
  });

  test("returns null when neither config nor snapshot has a probe", () => {
    const out = getConnectorProbeEndpoint({ config: {}, template_snapshot: null });
    expect(out).toBeNull();
  });

  test("config.probe_endpoint set to null overrides snapshot (operator opted out)", () => {
    const out = getConnectorProbeEndpoint({
      config: { probe_endpoint: null },
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out).toBeNull();
  });
});

describe("getConnectorCapabilities", () => {
  const customCaps = { webhooks: false, webhook_events: [], rate_limits: null };

  test("config.capabilities wins over snapshot", () => {
    const out = getConnectorCapabilities({
      config: { capabilities: customCaps },
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out).toEqual(customCaps);
  });

  test("falls through to snapshot.capabilities when config doesn't set it", () => {
    const out = getConnectorCapabilities({
      config: {},
      template_snapshot: aTemplate as unknown as Record<string, unknown>,
    });
    expect(out).toEqual(aTemplate.capabilities);
  });

  test("returns null when both config and snapshot are absent", () => {
    const out = getConnectorCapabilities({ config: {}, template_snapshot: null });
    expect(out).toBeNull();
  });
});
