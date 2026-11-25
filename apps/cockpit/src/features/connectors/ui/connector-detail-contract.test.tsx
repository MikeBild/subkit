import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import {
  ConnectorRuntimeSection,
  ConnectorTechnicalFacts,
} from "@/features/connectors/ui/connector-detail";

test("shows effective runtime settings and provider limits to the operator", () => {
  const markup = render(
    <ConnectorRuntimeSection
      latencyMs={42.6}
      record={{
        driver: "mcp",
        config: {
          mcp: { remote_tool_call_timeout_ms: 5_000 },
          capabilities: {
            rate_limits: {
              requests_per_second: 4,
              burst_size: 8,
              recommended_backoff_ms: 500,
            },
          },
        },
      }}
    />,
  );

  expect(markup).toContain('data-testid="connector-runtime"');
  expect(markup).toContain('data-testid="connector-runtime-latency"');
  expect(markup).toContain("43 ms");
  expect(markup).toContain("5000 ms · Wirksam");
  expect(markup).toContain("Nicht angegeben");
  expect(markup).toContain("4 Anfragen/s · Burst: 8 · Empfohlener Backoff: 500 ms");
});

test("keeps secret addresses hidden while exposing stable technical identity and documentation", () => {
  const markup = render(
    <ConnectorTechnicalFacts
      id="connector-1"
      headerNames={[]}
      record={{
        driver: "mcp",
        base_url: "https://secret.example.test/***redacted***",
        auth_type: "none",
        mcp_transport: "http",
        slug: "support",
        created_at: "2026-11-01T09:00:00.000Z",
        self_description: { links: [{ kind: "openapi", url: "https://docs.example.test" }] },
      }}
    />,
  );

  expect(markup).toContain('data-testid="connector-technical-facts"');
  expect(markup).toContain('data-testid="connector-fact-transport"');
  expect(markup).toContain('data-testid="connector-doc-0"');
  expect(markup).toContain('data-testid="connector-technical-slug"');
  expect(markup).toContain('data-testid="connector-copy-id"');
  expect(markup).not.toContain('data-testid="connector-copy-address"');
});
