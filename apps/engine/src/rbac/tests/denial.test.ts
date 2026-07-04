// Pure unit tests for the actionable-denial formatter (Stream 2).
// No DB — just the message/details shaping from a DenyDetail (+ optional
// connector level). Covers the connector-level path, the credential-ceiling
// path, the generic path, and the missing-detail fallback.

import { describe, expect, test } from "bun:test";
import { denialDetails, denialHint } from "../denial.ts";
import type { DenyDetail } from "../evaluator.ts";

describe("denialHint", () => {
  test("missing detail → generic remediation", () => {
    expect(denialHint(undefined)).toContain("ask an admin for a grant");
  });

  test("connector write deny with read-only level names the level and the need", () => {
    const detail: DenyDetail = {
      required: "connector:write",
      resource: { type: "connector", id: "conn-1" },
      cause: "no_matching_grant",
    };
    const hint = denialHint(detail, "read-only");
    expect(hint).toContain("read-only access to connector conn-1");
    expect(hint).toContain("read-write access");
    expect(hint).toContain("request a grant or a key");
  });

  test("connector write deny with no access says 'no access'", () => {
    const detail: DenyDetail = {
      required: "connector:write",
      resource: { type: "connector", id: "conn-2" },
      cause: "credential_ceiling:connector_not_in_allowlist",
    };
    expect(denialHint(detail, "none")).toContain("no access to connector conn-2");
  });

  test("connector read deny asks for read access, not read-write", () => {
    const detail: DenyDetail = {
      required: "connector:read",
      resource: { type: "connector", id: "conn-3" },
      cause: "no_matching_grant",
    };
    const hint = denialHint(detail, "none");
    expect(hint).toContain("this needs read access");
    expect(hint).not.toContain("read-write access");
  });

  test("credential-ceiling deny without a level explains the scoped credential", () => {
    const detail: DenyDetail = {
      required: "workflow:run",
      resource: { type: "workflow", id: "wf-1" },
      cause: "credential_ceiling:scope_not_granted",
    };
    const hint = denialHint(detail);
    expect(hint).toContain("credential is scoped");
    expect(hint).toContain("workflow:run");
    expect(hint).toContain("on workflow wf-1");
  });

  test("generic deny names the missing permission and remedy", () => {
    const detail: DenyDetail = { required: "audit:read", cause: "no_matching_grant" };
    const hint = denialHint(detail);
    expect(hint).toContain("you lack audit:read");
    expect(hint).toContain("request a grant or a key");
  });
});

describe("denialDetails", () => {
  test("missing detail → undefined", () => {
    expect(denialDetails(undefined)).toBeUndefined();
  });

  test("carries required/resource/cause and the level when present", () => {
    const detail: DenyDetail = {
      required: "connector:write",
      resource: { type: "connector", id: "conn-1" },
      cause: "credential_ceiling:connector_not_in_allowlist",
    };
    expect(denialDetails(detail, "read-only")).toEqual({
      required: "connector:write",
      resource: { type: "connector", id: "conn-1" },
      cause: "credential_ceiling:connector_not_in_allowlist",
      connector_level: "read-only",
    });
  });

  test("omits resource and level when absent", () => {
    const detail: DenyDetail = { required: "audit:read", cause: "no_matching_grant" };
    expect(denialDetails(detail)).toEqual({
      required: "audit:read",
      cause: "no_matching_grant",
    });
  });
});
