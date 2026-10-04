import { describe, expect, test } from "bun:test";
import {
  classifyGraphqlProbe,
  classifyPgProbeError,
  classifyS3ProbeError,
} from "../probe-classify.ts";

describe("classifyGraphqlProbe — HTTP status signals", () => {
  test("401 → credential_invalid", () => {
    expect(classifyGraphqlProbe(401, null)).toBe("credential_invalid");
  });

  test("403 → credential_invalid", () => {
    expect(classifyGraphqlProbe(403, null)).toBe("credential_invalid");
  });

  test("404 → remote_resource_not_found, not credential or upstream blip", () => {
    expect(classifyGraphqlProbe(404, null)).toBe("remote_resource_not_found");
  });

  test("500 + null messages → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(500, null)).toBe("unknown_upstream_error");
  });

  test("502 → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(502, [])).toBe("unknown_upstream_error");
  });
});

describe("classifyGraphqlProbe — 2xx + GraphQL errors array", () => {
  test('200 + ["UNAUTHENTICATED: token expired"] → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["UNAUTHENTICATED: token expired"])).toBe(
      "credential_invalid",
    );
  });

  test('200 + ["unauthorized"] (lowercase) → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["unauthorized"])).toBe("credential_invalid");
  });

  test('200 + ["forbidden"] → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["forbidden: insufficient privileges"])).toBe(
      "credential_invalid",
    );
  });

  test('200 + ["authentication failed"] → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["authentication failed"])).toBe("credential_invalid");
  });

  test('200 + ["not authorized to perform this action"] → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["not authorized to perform this action"])).toBe(
      "credential_invalid",
    );
  });

  test('200 + ["access denied"] → credential_invalid', () => {
    expect(classifyGraphqlProbe(200, ["access denied"])).toBe("credential_invalid");
  });

  test('200 + ["Variable $x not defined"] → unknown_upstream_error (not auth)', () => {
    expect(classifyGraphqlProbe(200, ["Variable $x not defined"])).toBe("unknown_upstream_error");
  });

  test("200 + null messages → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(200, null)).toBe("unknown_upstream_error");
  });

  test("200 + empty messages array → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(200, [])).toBe("unknown_upstream_error");
  });

  test('200 + ["FORBIDDEN by policy"] → credential_invalid (case-insensitive)', () => {
    expect(classifyGraphqlProbe(200, ["FORBIDDEN by policy"])).toBe("credential_invalid");
  });
});

describe("classifyPgProbeError — SQLSTATE codes", () => {
  test("28P01 (invalid_password) → credential_invalid", () => {
    expect(classifyPgProbeError({ code: "28P01" })).toBe("credential_invalid");
  });

  test("28000 (invalid_authorization_specification) → credential_invalid", () => {
    expect(classifyPgProbeError({ code: "28000" })).toBe("credential_invalid");
  });

  test("3D000 (invalid_catalog_name) → remote_resource_not_found, not credential", () => {
    expect(classifyPgProbeError({ code: "3D000" })).toBe("remote_resource_not_found");
  });

  test("ECONNREFUSED (no-code Error) → unknown_upstream_error", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    expect(classifyPgProbeError(err)).toBe("unknown_upstream_error");
  });

  test("error object with no code → unknown_upstream_error", () => {
    expect(classifyPgProbeError({ message: "timeout" })).toBe("unknown_upstream_error");
  });

  test("error with unrelated SQLSTATE → unknown_upstream_error", () => {
    expect(classifyPgProbeError({ code: "42P01" })).toBe("unknown_upstream_error");
  });
});

describe("classifyPgProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifyPgProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifyPgProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifyPgProbeError({})).toBe("unknown_upstream_error");
  });
});

describe("classifyS3ProbeError — statusCode (primary signal)", () => {
  test("statusCode 401 → credential_invalid", () => {
    expect(classifyS3ProbeError({ statusCode: 401 })).toBe("credential_invalid");
  });

  test("statusCode 403 → credential_invalid", () => {
    expect(classifyS3ProbeError({ statusCode: 403 })).toBe("credential_invalid");
  });

  test("statusCode 404 → remote_resource_not_found, not credential", () => {
    expect(classifyS3ProbeError({ statusCode: 404 })).toBe("remote_resource_not_found");
  });

  test("statusCode 500 → unknown_upstream_error", () => {
    expect(classifyS3ProbeError({ statusCode: 500 })).toBe("unknown_upstream_error");
  });
});

describe("classifyS3ProbeError — named S3 error codes (fallback)", () => {
  test("code InvalidAccessKeyId (no statusCode) → credential_invalid", () => {
    expect(classifyS3ProbeError({ code: "InvalidAccessKeyId" })).toBe("credential_invalid");
  });

  test("code SignatureDoesNotMatch (no statusCode) → credential_invalid", () => {
    expect(classifyS3ProbeError({ code: "SignatureDoesNotMatch" })).toBe("credential_invalid");
  });

  test("code AccessDenied (no statusCode) → credential_invalid", () => {
    expect(classifyS3ProbeError({ code: "AccessDenied" })).toBe("credential_invalid");
  });

  test("code NoSuchBucket (no statusCode) → remote_resource_not_found, not credential", () => {
    expect(classifyS3ProbeError({ code: "NoSuchBucket" })).toBe("remote_resource_not_found");
  });

  test("code ETIMEDOUT (no statusCode) → unknown_upstream_error", () => {
    expect(classifyS3ProbeError({ code: "ETIMEDOUT" })).toBe("unknown_upstream_error");
  });

  test("statusCode takes precedence over code: 403 + code NoSuchBucket → credential_invalid", () => {
    expect(classifyS3ProbeError({ statusCode: 403, code: "NoSuchBucket" })).toBe(
      "credential_invalid",
    );
  });
});

describe("classifyS3ProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifyS3ProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifyS3ProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifyS3ProbeError({})).toBe("unknown_upstream_error");
  });
});
