import { describe, expect, test } from "bun:test";
import { connectorCheckFailure, connectorCheckPlan } from "./connector-save-model.ts";

describe("connectorCheckPlan", () => {
  test("retains the command's validation and probe matrix", () => {
    expect(connectorCheckPlan("create", "http", false)).toBe("probe_draft");
    expect(connectorCheckPlan("create", "mcp", false)).toBe("defer_mcp_probe");
    expect(connectorCheckPlan("patch", "mcp", false)).toBe("validate_only");
    expect(connectorCheckPlan("create", "mcp", true)).toBe("skip");
    expect(connectorCheckPlan("patch", "http", true)).toBe("skip");
  });
});

describe("connectorCheckFailure", () => {
  test("omits unavailable probe details", () => {
    for (const warnings of [undefined, null, "invalid", {}, []]) {
      expect(
        connectorCheckFailure({ created: false }, "probe", "probe returned not-ok", {
          probe: { ok: false, warnings },
        }),
      ).toEqual({
        created: false,
        stage: "probe",
        probe: { ok: false },
        error: { code: "CONNECTOR_PROBE_FAILED", message: "probe returned not-ok" },
      });
    }
  });

  const issues = [{ path: "base_url", message: "required" }];
  const cases: Array<[string, Parameters<typeof connectorCheckFailure>, unknown]> = [
    [
      "create validate failure",
      [{ created: false }, "validate", "base_url: required", { issues }],
      {
        created: false,
        stage: "validate",
        error: { code: "CONNECTOR_VALIDATE_FAILED", message: "base_url: required", issues },
      },
    ],
    [
      "update validate failure",
      [{ updated: false }, "validate", "base_url: required", { issues }],
      {
        updated: false,
        stage: "validate",
        error: { code: "CONNECTOR_VALIDATE_FAILED", message: "base_url: required", issues },
      },
    ],
    [
      "create probe failure with engine reason",
      [
        { created: false },
        "probe",
        "upstream refused",
        {
          probe: {
            ok: false,
            status: 401,
            error_code: "credential_rejected",
            warnings: [{ code: "W", message: "m" }, "junk"],
          },
        },
      ],
      {
        created: false,
        stage: "probe",
        probe: {
          ok: false,
          status_code: 401,
          error_code: "credential_rejected",
          warnings: [{ code: "W", message: "m" }],
        },
        error: { code: "CONNECTOR_PROBE_FAILED", message: "upstream refused" },
      },
    ],
    [
      "template probe failure after create",
      [{ created: true, id: "c1", slug: "s" }, "probe", "probe returned not-ok", {}],
      {
        created: true,
        id: "c1",
        slug: "s",
        stage: "probe",
        error: { code: "CONNECTOR_PROBE_FAILED", message: "probe returned not-ok" },
      },
    ],
  ];
  test.each(cases)("%s", (_label, input, expected) => {
    expect(connectorCheckFailure(...input)).toEqual(
      expected as ReturnType<typeof connectorCheckFailure>,
    );
  });
});
