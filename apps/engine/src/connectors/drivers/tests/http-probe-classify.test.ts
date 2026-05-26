// G10 (runtime-logs review plan): typed error classification for HTTP
// probe failures. Pre-fix a Google Drive 404 looked identical to a
// 401 looked identical to "Drive API not enabled" — operators (and
// the LLM) had no discrete signal to branch on. Post-fix the probe
// reports a typed `error_code` derived from the upstream status code.

import { describe, expect, test } from "bun:test";
import type { ConnectorView } from "../../types.ts";
import { classifyHttpProbeStatus } from "../http.ts";

const stubConnector = {
  id: "00000000-0000-0000-0000-000000000000",
  slug: "stub",
  driver: "http",
  environment: "dev",
} as unknown as ConnectorView;

describe("classifyHttpProbeStatus", () => {
  test("401 → credential_invalid", () => {
    expect(classifyHttpProbeStatus(401, stubConnector).code).toBe("credential_invalid");
  });
  test("403 → scope_insufficient", () => {
    expect(classifyHttpProbeStatus(403, stubConnector).code).toBe("scope_insufficient");
  });
  test("404 → remote_resource_not_found", () => {
    expect(classifyHttpProbeStatus(404, stubConnector).code).toBe("remote_resource_not_found");
  });
  test("500 → unknown_upstream_error", () => {
    expect(classifyHttpProbeStatus(500, stubConnector).code).toBe("unknown_upstream_error");
  });
  test("502 → unknown_upstream_error", () => {
    expect(classifyHttpProbeStatus(502, stubConnector).code).toBe("unknown_upstream_error");
  });
  test("418 (uncommon 4xx) → unknown_upstream_error", () => {
    expect(classifyHttpProbeStatus(418, stubConnector).code).toBe("unknown_upstream_error");
  });
});
