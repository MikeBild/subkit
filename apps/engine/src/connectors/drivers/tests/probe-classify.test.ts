// Unit tests for per-driver probe classifiers in probe-classify.ts.
//
// Pure functions — no DB, no network, no Docker. Each classifier is
// tested with:
//   - credential_invalid trigger(s)
//   - must-NOT-flag cases (network errors, resource-not-found, unrelated errors)
//   - null / undefined / empty-object defensiveness (never throws, never guesses
//     credential death on an unknown error shape)

import { describe, expect, test } from "bun:test";
import {
  classifyFtpProbeError,
  classifyGraphqlProbe,
  classifyMssqlProbeError,
  classifyPgProbeError,
  classifyRedisProbeError,
  classifyS3ProbeError,
  classifySftpProbeError,
  classifySmbProbeError,
} from "../probe-classify.ts";

// ---------------------------------------------------------------------------
// classifyGraphqlProbe
// ---------------------------------------------------------------------------

describe("classifyGraphqlProbe — HTTP status signals", () => {
  test("401 → credential_invalid", () => {
    expect(classifyGraphqlProbe(401, null)).toBe("credential_invalid");
  });

  test("403 → credential_invalid", () => {
    expect(classifyGraphqlProbe(403, null)).toBe("credential_invalid");
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

  // False-flag guard: a real GraphQL validation error must NOT be classified as auth
  test('200 + ["Variable $x not defined"] → unknown_upstream_error (not auth)', () => {
    expect(classifyGraphqlProbe(200, ["Variable $x not defined"])).toBe("unknown_upstream_error");
  });

  test("200 + null messages → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(200, null)).toBe("unknown_upstream_error");
  });

  test("200 + empty messages array → unknown_upstream_error", () => {
    expect(classifyGraphqlProbe(200, [])).toBe("unknown_upstream_error");
  });

  // Case-insensitive matching
  test('200 + ["FORBIDDEN by policy"] → credential_invalid (case-insensitive)', () => {
    expect(classifyGraphqlProbe(200, ["FORBIDDEN by policy"])).toBe("credential_invalid");
  });
});

// ---------------------------------------------------------------------------
// classifyPgProbeError
// ---------------------------------------------------------------------------

describe("classifyPgProbeError — SQLSTATE codes", () => {
  test("28P01 (invalid_password) → credential_invalid", () => {
    expect(classifyPgProbeError({ code: "28P01" })).toBe("credential_invalid");
  });

  test("28000 (invalid_authorization_specification) → credential_invalid", () => {
    expect(classifyPgProbeError({ code: "28000" })).toBe("credential_invalid");
  });

  // Must NOT be flagged as credential — database simply doesn't exist
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

// ---------------------------------------------------------------------------
// classifyS3ProbeError
// ---------------------------------------------------------------------------

describe("classifyS3ProbeError — statusCode (primary signal)", () => {
  test("statusCode 401 → credential_invalid", () => {
    expect(classifyS3ProbeError({ statusCode: 401 })).toBe("credential_invalid");
  });

  test("statusCode 403 → credential_invalid", () => {
    expect(classifyS3ProbeError({ statusCode: 403 })).toBe("credential_invalid");
  });

  // Must NOT be flagged as credential
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

  // Must NOT be flagged as credential
  test("code NoSuchBucket (no statusCode) → remote_resource_not_found, not credential", () => {
    expect(classifyS3ProbeError({ code: "NoSuchBucket" })).toBe("remote_resource_not_found");
  });

  test("code ETIMEDOUT (no statusCode) → unknown_upstream_error", () => {
    expect(classifyS3ProbeError({ code: "ETIMEDOUT" })).toBe("unknown_upstream_error");
  });

  test("statusCode takes precedence over code: 403 + code NoSuchBucket → credential_invalid", () => {
    // statusCode is the primary signal; code is only consulted when statusCode is absent.
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

// ---------------------------------------------------------------------------
// classifyRedisProbeError
// ---------------------------------------------------------------------------

describe("classifyRedisProbeError — RESP leading-token match", () => {
  test('Error with message "WRONGPASS invalid password" → credential_invalid', () => {
    expect(classifyRedisProbeError(new Error("WRONGPASS invalid password"))).toBe(
      "credential_invalid",
    );
  });

  test('Error with message "NOAUTH Authentication required" → credential_invalid', () => {
    expect(classifyRedisProbeError(new Error("NOAUTH Authentication required"))).toBe(
      "credential_invalid",
    );
  });

  test("plain object with message WRONGPASS → credential_invalid", () => {
    expect(classifyRedisProbeError({ message: "WRONGPASS bad creds" })).toBe("credential_invalid");
  });

  test("plain object with message NOAUTH → credential_invalid", () => {
    expect(classifyRedisProbeError({ message: "NOAUTH" })).toBe("credential_invalid");
  });

  // False-flag guard: READONLY is a replication error, not auth
  test('"READONLY You can\'t write" → unknown_upstream_error (not auth)', () => {
    expect(classifyRedisProbeError(new Error("READONLY You can't write against a replica."))).toBe(
      "unknown_upstream_error",
    );
  });

  test("connection-refused error → unknown_upstream_error", () => {
    expect(classifyRedisProbeError(new Error("connect ECONNREFUSED 127.0.0.1:6379"))).toBe(
      "unknown_upstream_error",
    );
  });

  // Leading-token precision: WRONGPASS that appears in the middle of a message must NOT match
  test("message with WRONGPASS mid-string → unknown_upstream_error (leading-token guard)", () => {
    expect(classifyRedisProbeError(new Error("some prefix WRONGPASS extra"))).toBe(
      "unknown_upstream_error",
    );
  });
});

describe("classifyRedisProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifyRedisProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifyRedisProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifyRedisProbeError({})).toBe("unknown_upstream_error");
  });
});

// ---------------------------------------------------------------------------
// classifySftpProbeError
// ---------------------------------------------------------------------------

describe("classifySftpProbeError — ssh2 error levels", () => {
  test('level "client-authentication" → credential_invalid', () => {
    expect(classifySftpProbeError({ level: "client-authentication" })).toBe("credential_invalid");
  });

  test('level "client-timeout" → unknown_upstream_error (not auth)', () => {
    expect(classifySftpProbeError({ level: "client-timeout" })).toBe("unknown_upstream_error");
  });

  test('level "client-socket" → unknown_upstream_error', () => {
    expect(classifySftpProbeError({ level: "client-socket" })).toBe("unknown_upstream_error");
  });

  test("Error with no level → unknown_upstream_error", () => {
    expect(classifySftpProbeError(new Error("ECONNREFUSED"))).toBe("unknown_upstream_error");
  });
});

describe("classifySftpProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifySftpProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifySftpProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifySftpProbeError({})).toBe("unknown_upstream_error");
  });
});

// ---------------------------------------------------------------------------
// classifyFtpProbeError
// ---------------------------------------------------------------------------

describe("classifyFtpProbeError — RFC 959 reply codes", () => {
  test("code 530 (Not logged in) → credential_invalid", () => {
    expect(classifyFtpProbeError({ code: 530 })).toBe("credential_invalid");
  });

  test("code 421 (Service not available) → unknown_upstream_error (not auth)", () => {
    expect(classifyFtpProbeError({ code: 421 })).toBe("unknown_upstream_error");
  });

  test("code 550 (file not found) → unknown_upstream_error", () => {
    expect(classifyFtpProbeError({ code: 550 })).toBe("unknown_upstream_error");
  });

  test("no code property → unknown_upstream_error", () => {
    expect(classifyFtpProbeError(new Error("ECONNREFUSED"))).toBe("unknown_upstream_error");
  });
});

describe("classifyFtpProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifyFtpProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifyFtpProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifyFtpProbeError({})).toBe("unknown_upstream_error");
  });
});

// ---------------------------------------------------------------------------
// classifySmbProbeError
// ---------------------------------------------------------------------------

describe("classifySmbProbeError — NT status codes", () => {
  test('code "STATUS_LOGON_FAILURE" → credential_invalid', () => {
    expect(classifySmbProbeError({ code: "STATUS_LOGON_FAILURE" })).toBe("credential_invalid");
  });

  test('code "STATUS_OBJECT_NAME_NOT_FOUND" → unknown_upstream_error (not auth)', () => {
    expect(classifySmbProbeError({ code: "STATUS_OBJECT_NAME_NOT_FOUND" })).toBe(
      "unknown_upstream_error",
    );
  });

  test('code "STATUS_ACCESS_DENIED" → unknown_upstream_error (only LOGON_FAILURE is auth)', () => {
    expect(classifySmbProbeError({ code: "STATUS_ACCESS_DENIED" })).toBe("unknown_upstream_error");
  });

  test("no code property → unknown_upstream_error", () => {
    expect(classifySmbProbeError(new Error("ECONNREFUSED"))).toBe("unknown_upstream_error");
  });
});

describe("classifySmbProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifySmbProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifySmbProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifySmbProbeError({})).toBe("unknown_upstream_error");
  });
});

// ---------------------------------------------------------------------------
// classifyMssqlProbeError
// ---------------------------------------------------------------------------

describe("classifyMssqlProbeError — tedious error codes", () => {
  test('code "ELOGIN" → credential_invalid', () => {
    expect(classifyMssqlProbeError({ code: "ELOGIN" })).toBe("credential_invalid");
  });

  test("number 18456 (Login failed for user) → credential_invalid", () => {
    expect(classifyMssqlProbeError({ number: 18456 })).toBe("credential_invalid");
  });

  test('code "ELOGIN" + number 18456 → credential_invalid (both agree)', () => {
    expect(classifyMssqlProbeError({ code: "ELOGIN", number: 18456 })).toBe("credential_invalid");
  });

  test('code "ETIMEOUT" → unknown_upstream_error (not auth)', () => {
    expect(classifyMssqlProbeError({ code: "ETIMEOUT" })).toBe("unknown_upstream_error");
  });

  test('code "ECONNRESET" → unknown_upstream_error', () => {
    expect(classifyMssqlProbeError({ code: "ECONNRESET" })).toBe("unknown_upstream_error");
  });

  test("number 0 → unknown_upstream_error (zero is not 18456)", () => {
    expect(classifyMssqlProbeError({ number: 0 })).toBe("unknown_upstream_error");
  });

  test("no code or number → unknown_upstream_error", () => {
    expect(classifyMssqlProbeError(new Error("network error"))).toBe("unknown_upstream_error");
  });
});

describe("classifyMssqlProbeError — defensive: null / undefined / empty", () => {
  test("null → unknown_upstream_error (no throw)", () => {
    expect(classifyMssqlProbeError(null)).toBe("unknown_upstream_error");
  });

  test("undefined → unknown_upstream_error (no throw)", () => {
    expect(classifyMssqlProbeError(undefined)).toBe("unknown_upstream_error");
  });

  test("{} → unknown_upstream_error (no throw)", () => {
    expect(classifyMssqlProbeError({})).toBe("unknown_upstream_error");
  });
});
