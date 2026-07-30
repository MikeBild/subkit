// Per-driver config validation.
//
// The behaviour under test is the one that changed: graphql and s3 configs are
// now checked when they are written. Before, only http was — everything else
// returned early, was stored as given, and failed later inside the driver with
// a message naming the connector id instead of the bad field.

import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CONFIG_SCHEMAS,
  MCP_ONLY_AUTH_TYPES,
  validateConnectorAuthType,
  validateConnectorConfig,
  validateConnectorConfigOrThrow,
} from "./config-schemas.ts";
import { AuthTypeEnum, DriverEnum } from "./types.ts";

describe("every driver has a config schema", () => {
  test("the registry covers DriverEnum exactly", () => {
    // Drift here is how a new driver silently gets no validation at all.
    expect(Object.keys(CONNECTOR_CONFIG_SCHEMAS).sort()).toEqual([...DriverEnum.options].sort());
  });
});

describe("s3 — the missing bucket is caught at write time", () => {
  test("a config without bucket is rejected", () => {
    // The driver throws `missing config.bucket` on first use. Catching it here
    // means the author sees the field name while they are still authoring.
    const issues = validateConnectorConfig("s3", { region: "eu-central-1" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === "bucket")).toBe(true);
  });

  test("a config with bucket passes", () => {
    expect(validateConnectorConfig("s3", { bucket: "my-bucket" })).toEqual([]);
  });

  test("unknown keys are accepted", () => {
    // The s3 driver has always ignored what it does not read. Rejecting extras
    // here would turn configs that work today into write errors.
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
    // http has always been `.strict()`. This pins that the registry did not
    // quietly relax it while making the other drivers permissive.
    const issues = validateConnectorConfig("http", { timeout_ms: 1000, nope: true });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("a known key still passes", () => {
    expect(validateConnectorConfig("http", { timeout_ms: 1000 })).toEqual([]);
  });
});

describe("an absent config is valid everywhere", () => {
  // `config` is optional on create, and a patch that does not mention it must
  // not be treated as an attempt to write an empty one.
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
    // Encoding the refusal here turns a handshake-time throw into an
    // authoring-time message, which is what this file is for.
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
    // Secret-by-reference: the credential lives encrypted in `credentials`.
    // The DB CHECK is the backstop for writers that bypass Zod; this is the
    // gate for the ones that do not.
    const issues = validateConnectorConfig("mcp", {
      mcp: { transport: "http", auth: { kind: "bearer", token: "sk-live-abc" } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("bounds the per-connector call timeout", () => {
    // The timeout is what stops a hung remote from holding the turn's tool
    // mutex; an unbounded override would remove that guarantee.
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
  // `AuthTypeEnum` is one enum every driver shares, so the two
  // machine-to-machine MCP kinds would otherwise be offered to every driver by
  // the generated contract. The HTTP driver throws on both rather than sign a
  // request with one, so accepting them there would store a connector that
  // cannot complete a call.
  for (const auth_type of MCP_ONLY_AUTH_TYPES) {
    test(`${auth_type} is accepted for mcp`, () => {
      expect(validateConnectorAuthType("mcp", auth_type)).toEqual([]);
    });

    for (const driver of DriverEnum.options.filter((d) => d !== "mcp")) {
      test(`${auth_type} is refused for ${driver}, naming the field`, () => {
        const issues = validateConnectorAuthType(driver, auth_type);
        expect(issues.length).toBe(1);
        expect(issues[0]?.path).toBe("auth_type");
        expect(issues[0]?.message).toContain(auth_type);
      });
    }
  }

  test("every other auth kind stays valid on every driver", () => {
    for (const driver of DriverEnum.options) {
      for (const auth_type of AuthTypeEnum.options) {
        if (MCP_ONLY_AUTH_TYPES.includes(auth_type)) continue;
        expect(validateConnectorAuthType(driver, auth_type)).toEqual([]);
      }
    }
  });

  test("an absent auth_type is not an issue", () => {
    // A patch that does not mention `auth_type` leaves the stored value alone.
    expect(validateConnectorAuthType("http", undefined)).toEqual([]);
    expect(validateConnectorAuthType("http", null)).toEqual([]);
  });
});
