// Unit tests for the connector_resolutions rollup. These don't need the
// engine's Postgres scaffolding — they exercise the pure function that
// derives the run-level summary from per-step request_meta bags.

import { describe, expect, test } from "bun:test";
import { rollupConnectorResolutions } from "../engine.ts";

describe("rollupConnectorResolutions", () => {
  test("extracts one summary per unique connector", () => {
    const stepSummaries = [
      {
        step_key: "a",
        request_meta: {
          url: "https://api.test/x",
          status: 200,
          connector: {
            connector_id: "c1",
            connector_slug: "foo",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "bearer",
            base_url: "https://api.test",
            tunnel_target: null,
          },
        },
      },
      {
        step_key: "b",
        request_meta: {
          url: "https://api.test/y",
          status: 200,
          connector: {
            connector_id: "c1",
            connector_slug: "foo",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "bearer",
            base_url: "https://api.test",
            tunnel_target: null,
          },
        },
      },
      {
        step_key: "c",
        request_meta: {
          url: "https://other.test/graphql",
          status: 200,
          connector: {
            connector_id: "c2",
            connector_slug: "bar",
            driver: "graphql",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "oauth2_refreshed",
            base_url: "https://other.test",
            tunnel_target: null,
          },
        },
      },
    ];
    const out = rollupConnectorResolutions(stepSummaries, "dev");
    expect(out).toHaveLength(2);
    expect(out[0]?.connector_id).toBe("c1");
    expect(out[0]?.step_key).toBe("a"); // first occurrence wins
    expect(out[1]?.connector_id).toBe("c2");
    expect(out[1]?.auth_method).toBe("oauth2_refreshed");
  });

  test("ignores steps without request_meta.connector", () => {
    const out = rollupConnectorResolutions(
      [
        { step_key: "transform", request_meta: null },
        { step_key: "wait", request_meta: { kind: "wait" } },
        {
          step_key: "http-noconnector",
          request_meta: { url: "https://x.test", status: 200 },
        },
      ],
      "dev",
    );
    expect(out).toHaveLength(0);
  });

  test("normalises unknown auth_method to 'none'", () => {
    const out = rollupConnectorResolutions(
      [
        {
          step_key: "a",
          request_meta: {
            connector: {
              connector_id: "c1",
              connector_slug: "foo",
              driver: "http",
              resolved_environment: "dev",
              auth_method: "made-up",
            },
          },
        },
      ],
      "dev",
    );
    expect(out[0]?.auth_method).toBe("none");
  });

  test("falls back to requested_environment when connector did not declare it", () => {
    const out = rollupConnectorResolutions(
      [
        {
          step_key: "a",
          request_meta: {
            connector: {
              connector_id: "c1",
              connector_slug: "foo",
              driver: "http",
              auth_method: "bearer",
            },
          },
        },
      ],
      "prod",
    );
    expect(out[0]?.requested_environment).toBe("prod");
    expect(out[0]?.resolved_environment).toBe("prod");
  });
});
