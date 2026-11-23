import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CONFIG_SCHEMAS,
  MCP_ONLY_AUTH_TYPES,
  mcpAuthKindForType,
  validateConnectorConfig,
  validateConnectorConfigOrThrow,
  validateMcpAuthConsistency,
  withMcpConfigDefaults,
} from "./config-schemas.ts";
import { validateConnectorAuthType } from "./core/config-policy.ts";
import {
  validateConnectorAuthType as validateConnectorAuthTypeFromEntry,
  validateSftpAuthConsistency,
} from "./index.ts";
import { AuthTypeEnum, DriverEnum } from "./types.ts";

describe("every driver has a config schema", () => {
  test("the registry covers DriverEnum exactly", () => {
    expect(Object.keys(CONNECTOR_CONFIG_SCHEMAS).sort()).toEqual([...DriverEnum.options].sort());
  });
});

describe("s3 — the missing bucket is caught at write time", () => {
  test("a config without bucket is rejected", () => {
    const issues = validateConnectorConfig("s3", { region: "eu-central-1" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === "bucket")).toBe(true);
  });

  test("a config with bucket passes", () => {
    expect(validateConnectorConfig("s3", { bucket: "my-bucket" })).toEqual([]);
  });

  test("unknown keys are accepted", () => {
    expect(validateConnectorConfig("s3", { bucket: "b", legacy_flag: true })).toEqual([]);
  });

  test("a wrong type on a known key is caught", () => {
    const issues = validateConnectorConfig("s3", { bucket: "b", force_path_style: "yes" });
    expect(issues.some((i) => i.path === "force_path_style")).toBe(true);
  });
});

describe("graphql", () => {
  test("header values must be strings", () => {
    const issues = validateConnectorConfig("graphql", { default_headers: { "x-api": 42 } });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("a valid header map passes", () => {
    expect(validateConnectorConfig("graphql", { default_headers: { "x-api": "v1" } })).toEqual([]);
  });
});

describe("http keeps its strictness", () => {
  test("an unknown key is still rejected", () => {
    const issues = validateConnectorConfig("http", { timeout_ms: 1000, nope: true });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("a known key still passes", () => {
    expect(validateConnectorConfig("http", { timeout_ms: 1000 })).toEqual([]);
  });
});

describe("signed_jwt", () => {
  const config = {
    signed_jwt: { algorithm: "ES256", audience: "provider-api", issuer: "issuer-id" },
  };

  test("is valid for HTTP and GraphQL connectors", () => {
    expect(validateConnectorAuthType("http", "signed_jwt")).toEqual([]);
    expect(validateConnectorAuthType("graphql", "signed_jwt")).toEqual([]);
    expect(validateConnectorConfig("http", config)).toEqual([]);
    expect(validateConnectorConfig("graphql", config)).toEqual([]);
  });

  test("rejects an unsupported driver and reserved static claims", () => {
    expect(validateConnectorAuthType("postgres", "signed_jwt")).not.toEqual([]);
    expect(
      validateConnectorConfig("http", {
        signed_jwt: { ...config.signed_jwt, claims: { exp: 1 } },
      }),
    ).not.toEqual([]);
  });
});

describe("an absent config is valid everywhere", () => {
  for (const driver of DriverEnum.options) {
    test(`${driver} accepts undefined and null`, () => {
      expect(validateConnectorConfig(driver, undefined)).toEqual([]);
      expect(validateConnectorConfig(driver, null)).toEqual([]);
    });
  }
});

describe("the write-path wrapper", () => {
  test("throws with the code the HTTP layer maps to 400, listing every issue", () => {
    let caught: unknown;
    try {
      validateConnectorConfigOrThrow("s3", { force_path_style: "yes" });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string })?.code).toBe("connector_config_invalid");
    const details = (caught as { details?: string[] })?.details ?? [];
    expect(details.length).toBeGreaterThan(0);
    expect(details.join(" ")).toContain("bucket");
  });

  test("stays silent on a valid config", () => {
    expect(() => validateConnectorConfigOrThrow("postgres", {})).not.toThrow();
  });
});

describe("mcp", () => {
  test("seeds the transport and auth shape for an otherwise empty draft config", () => {
    expect(withMcpConfigDefaults("mcp", "bearer", {})).toEqual({
      mcp: { transport: "http", auth: { kind: "bearer" } },
    });
  });

  test("does not overwrite an explicitly authored auth shape", () => {
    const config = { mcp: { transport: "sse", auth: { kind: "basic" } } };
    expect(withMcpConfigDefaults("mcp", "bearer", config)).toEqual(config);
  });

  test("does not repair a malformed explicit MCP block behind the author's back", () => {
    const config = { mcp: "not-an-object" };
    const effective = withMcpConfigDefaults("mcp", "bearer", config);
    expect(effective).toEqual(config);
    expect(validateConnectorConfig("mcp", effective)).not.toEqual([]);
  });

  test("maps every supported connector auth type to the MCP transport kind", () => {
    expect(mcpAuthKindForType("none")).toBe("none");
    expect(mcpAuthKindForType("bearer")).toBe("bearer");
    expect(mcpAuthKindForType("basic")).toBe("basic");
    expect(mcpAuthKindForType("oauth2")).toBe("oauth2");
    expect(mcpAuthKindForType("oauth2_client")).toBe("oauth2_client_credentials");
    expect(mcpAuthKindForType("oauth2_private_key")).toBe("oauth2_private_key_jwt");
    expect(mcpAuthKindForType("header")).toBe("header");
    expect(mcpAuthKindForType("query")).toBeNull();
  });

  test("rejects disagreement between top-level auth_type and config.mcp.auth.kind", () => {
    expect(
      validateMcpAuthConsistency("mcp", "bearer", {
        mcp: { transport: "http", auth: { kind: "basic" } },
      }),
    ).toEqual([expect.objectContaining({ path: "config.mcp.auth.kind" })]);
    expect(
      validateMcpAuthConsistency("mcp", "bearer", {
        mcp: { transport: "http", auth: { kind: "bearer" } },
      }),
    ).toEqual([]);
  });

  test("accepts the block the migration writes", () => {
    expect(
      validateConnectorConfig("mcp", {
        mcp: { transport: "http", auth: { kind: "oauth2", client_id: "abc" } },
      }),
    ).toEqual([]);
  });

  test("defaults the transport so a bare block is valid", () => {
    expect(validateConnectorConfig("mcp", { mcp: {} })).toEqual([]);
  });

  test("refuses stdio — the pool does not serve a local subprocess", () => {
    const issues = validateConnectorConfig("mcp", { mcp: { transport: "stdio" } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe("mcp.transport");
  });

  test("is strict — mcp has no legacy configs to stay compatible with", () => {
    expect(validateConnectorConfig("mcp", { mcp: { transport: "http" }, extra: 1 })).not.toEqual(
      [],
    );
    expect(validateConnectorConfig("mcp", { mcp: { transport: "http", extra: 1 } })).not.toEqual(
      [],
    );
  });

  test("refuses an inlined secret in the auth block", () => {
    const issues = validateConnectorConfig("mcp", {
      mcp: { transport: "http", auth: { kind: "bearer", token: "sk-live-abc" } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("bounds the per-connector call timeout", () => {
    expect(
      validateConnectorConfig("mcp", {
        mcp: { transport: "http", remote_tool_call_timeout_ms: 10_000_000 },
      }),
    ).not.toEqual([]);
    expect(
      validateConnectorConfig("mcp", {
        mcp: { transport: "http", remote_tool_call_timeout_ms: 45_000 },
      }),
    ).toEqual([]);
  });
});

describe("auth kinds are scoped to the driver that can honour them", () => {
  for (const auth_type of MCP_ONLY_AUTH_TYPES) {
    test(`${auth_type} is accepted for mcp`, () => {
      expect(validateConnectorAuthType("mcp", auth_type)).toEqual([]);
    });

    for (const driver of DriverEnum.options.filter((d) => d !== "mcp")) {
      test(`${auth_type} is refused for ${driver}, naming the field`, () => {
        const issues = validateConnectorAuthType(driver, auth_type);
        expect(issues.length).toBe(1);
        expect(issues[0]?.path).toBe("auth_type");
        if (driver !== "sftp" && !driver.startsWith("local_"))
          expect(issues[0]?.message).toContain(auth_type);
      });
    }
  }

  test("every other auth kind stays valid on the http, graphql, postgres and s3 drivers", () => {
    for (const driver of DriverEnum.options.filter(
      (candidate) => candidate !== "mcp" && candidate !== "sftp" && !candidate.startsWith("local_"),
    )) {
      for (const auth_type of AuthTypeEnum.options) {
        if (
          MCP_ONLY_AUTH_TYPES.includes(auth_type) ||
          (auth_type === "signed_jwt" && driver !== "http" && driver !== "graphql")
        )
          continue;
        expect(validateConnectorAuthType(driver, auth_type)).toEqual([]);
      }
    }
  });

  test("a header name in the MCP auth block is refused with where it belongs", () => {
    const issues = validateConnectorConfig("mcp", {
      mcp: { transport: "http", auth: { kind: "header", header_name: "X-API-KEY" } },
    });
    expect(issues).toEqual([
      expect.objectContaining({
        path: "mcp.auth",
        message: expect.stringContaining("header_name (pre-filled, not sensitive)"),
      }),
    ]);
  });

  test("MCP refuses auth modes its transport cannot represent", () => {
    for (const auth_type of ["query", "aws_sigv4"] as const) {
      const issues = validateConnectorAuthType("mcp", auth_type);
      expect(issues).toEqual([expect.objectContaining({ path: "auth_type" })]);
    }
  });

  test("an absent auth_type is not an issue", () => {
    expect(validateConnectorAuthType("http", undefined)).toEqual([]);
    expect(validateConnectorAuthType("http", null)).toEqual([]);
  });
});

describe("one auth-type policy for every caller", () => {
  test("the connectors entry exports the core policy itself", () => {
    expect(validateConnectorAuthTypeFromEntry).toBe(validateConnectorAuthType);
  });

  test("sftp accepts basic and none and refuses every other auth kind", () => {
    for (const auth_type of AuthTypeEnum.options) {
      const issues = validateConnectorAuthType("sftp", auth_type);
      if (auth_type === "basic" || auth_type === "none") expect(issues).toEqual([]);
      else expect(issues).toEqual([expect.objectContaining({ path: "auth_type" })]);
    }
  });

  test("sftp pairs none with an SSH key and basic with a password", () => {
    const key = {
      auth: { method: "private_key", username: "deploy", private_key_item: "sftp-key" },
    };
    expect(validateSftpAuthConsistency("sftp", "none", key)).toEqual([]);
    expect(validateSftpAuthConsistency("sftp", "basic", {})).toEqual([]);
    expect(
      validateConnectorConfig("sftp", { host_key_sha256: `SHA256:${"A".repeat(43)}`, ...key }),
    ).toEqual([]);
  });

  test("a device connector takes no credentials", () => {
    for (const driver of DriverEnum.options.filter((candidate) => candidate.startsWith("local_"))) {
      expect(validateConnectorAuthType(driver, "none")).toEqual([]);
      expect(validateConnectorAuthType(driver, "basic")).toEqual([
        expect.objectContaining({ path: "auth_type" }),
      ]);
    }
  });
});
