// G10 / H3: typed error classification for HTTP probe failures.
//
// Pre-G10 a Google Drive 404 looked identical to a 401 looked
// identical to "Drive API not enabled" — operators (and the LLM) had
// no discrete signal to branch on. Post-G10 the probe reports a typed
// `error_code` derived from the upstream status code; H3 adds
// body-aware upgrades for known provider error shapes (Google's
// `accessNotConfigured` reason) so the LLM gets the specific
// `remote_api_disabled` signal + console deep link instead of a
// generic `scope_insufficient`.

import { describe, expect, test } from "bun:test";
import type { ConnectorView } from "../../types.ts";
import { classifyHttpProbeStatus } from "../http.ts";

const stubConnector = {
  id: "00000000-0000-0000-0000-000000000000",
  slug: "stub",
  driver: "http",
  environment: "dev",
  base_url: null,
} as unknown as ConnectorView;

const googleDriveConnector = {
  id: "00000000-0000-0000-0000-000000000001",
  slug: "google-workspace",
  driver: "http",
  environment: "dev",
  base_url: "https://www.googleapis.com",
} as unknown as ConnectorView;

describe("classifyHttpProbeStatus — status-only (G10)", () => {
  test("401 → credential_invalid", () => {
    expect(classifyHttpProbeStatus(401, stubConnector).code).toBe("credential_invalid");
  });
  test("403 → scope_insufficient (no body signal)", () => {
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

describe("classifyHttpProbeStatus — body-aware (H3)", () => {
  // Verbatim Google API error shape for "API not enabled in this
  // project". Pre-H3 this classified as `scope_insufficient` (generic
  // 403 fallback) and the model spent ~10 min of session ed20f48d
  // chasing wrong hypotheses (HTTPS, callback URL, OAuth scopes)
  // before the user volunteered the Gmail-works comparison.
  const driveAccessNotConfiguredBody = {
    error: {
      code: 403,
      message:
        "Access Not Configured. Drive API has not been used in project 86471638913 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=86471638913 then retry.",
      errors: [
        {
          message: "Access Not Configured.",
          domain: "usageLimits",
          reason: "accessNotConfigured",
          extendedHelp: "https://console.developers.google.com",
        },
      ],
      status: "PERMISSION_DENIED",
    },
  };

  test("403 + Google accessNotConfigured body → remote_api_disabled", () => {
    const r = classifyHttpProbeStatus(403, googleDriveConnector, driveAccessNotConfiguredBody);
    expect(r.code).toBe("remote_api_disabled");
  });

  test("remote_api_disabled carries a Google console deep link extracted from base_url", () => {
    const r = classifyHttpProbeStatus(403, googleDriveConnector, driveAccessNotConfiguredBody);
    expect(r.provider_action_url).toBeDefined();
    // The deep link names the actual API service (Drive) parsed from
    // the body's message, NOT the bare host.
    expect(r.provider_action_url).toContain("console.cloud.google.com/apis/library/");
    expect(r.provider_action_url).toContain("drive.googleapis.com");
  });

  test("400 with accessNotConfigured body → remote_api_disabled (older Google APIs)", () => {
    const r = classifyHttpProbeStatus(400, googleDriveConnector, driveAccessNotConfiguredBody);
    expect(r.code).toBe("remote_api_disabled");
  });

  test("404 with accessNotConfigured body → remote_api_disabled", () => {
    const r = classifyHttpProbeStatus(404, googleDriveConnector, driveAccessNotConfiguredBody);
    expect(r.code).toBe("remote_api_disabled");
  });

  test("403 with a non-Google body (Atlassian) does NOT upgrade", () => {
    const atlassianBody = {
      errorMessages: ["The user has no permission to view this issue"],
      errors: {},
    };
    const r = classifyHttpProbeStatus(403, stubConnector, atlassianBody);
    expect(r.code).toBe("scope_insufficient");
  });

  test("403 with malformed body falls back to scope_insufficient", () => {
    expect(classifyHttpProbeStatus(403, stubConnector, null).code).toBe("scope_insufficient");
    expect(classifyHttpProbeStatus(403, stubConnector, "garbage").code).toBe("scope_insufficient");
    expect(classifyHttpProbeStatus(403, stubConnector, { error: "string-not-object" }).code).toBe(
      "scope_insufficient",
    );
  });

  test("500 with accessNotConfigured body still classifies as 5xx (body upgrade gated on 4xx)", () => {
    // 5xx are clearly server-side; even if the body talks about
    // disabled APIs we don't upgrade — a Google 500 is a Google
    // problem, not a config problem the user can fix.
    const r = classifyHttpProbeStatus(500, googleDriveConnector, driveAccessNotConfiguredBody);
    expect(r.code).toBe("unknown_upstream_error");
  });
});
