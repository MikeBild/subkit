import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import { CATALOGS } from "@/lib/i18n";
import { errorFacts, failureFacts, failureRemedy } from "./failure-remedy";
import { REMEDY_LABEL, type RemedyKind } from "./remedy";

const remedy = (status: number | null, code: string | null, causeClass: string | null = null) =>
  failureRemedy({ status, code, causeClass });

describe("failure remedy", () => {
  test("a rejected session asks the person to sign in again", () => {
    expect(remedy(401, "unauthorized")).toBe("sign_in");
    expect(remedy(401, "installation_session_required")).toBe("sign_in");
    expect(remedy(403, "csrf_rejected")).toBe("sign_in");
    expect(remedy(401, null)).toBe("sign_in");
  });

  test("a connector that lost its sign-in is connected again", () => {
    expect(remedy(409, "connector_needs_sign_in_again")).toBe("reconnect");
    expect(remedy(200, null, "auth_failed")).toBe("reconnect");
  });

  test("a missing or outdated approval leads to the approval", () => {
    expect(remedy(403, "execution_authority_required")).toBe("grant");
    expect(remedy(409, "task_grant_fingerprint_changed")).toBe("grant");
    expect(remedy(409, "authority_manifest_changed")).toBe("grant");
    expect(remedy(null, null, "authority_mismatch")).toBe("grant");
    expect(remedy(null, null, "refused_before_start")).toBe("grant");
  });

  test("a missing right or an exhausted quota goes to an administrator", () => {
    expect(remedy(403, "forbidden")).toBe("admin");
    expect(remedy(403, "scope_violation")).toBe("admin");
    expect(remedy(403, null)).toBe("admin");
    expect(remedy(402, "hosted_storage_quota_exhausted")).toBe("admin");
    expect(remedy(null, null, "budget_exhausted")).toBe("admin");
  });

  test("a passing fault is tried again", () => {
    expect(remedy(0, null)).toBe("retry");
    expect(remedy(408, null)).toBe("retry");
    expect(remedy(429, "rate_limit_exceeded")).toBe("retry");
    expect(remedy(500, "internal_error")).toBe("retry");
    expect(remedy(503, null)).toBe("retry");
    expect(remedy(409, "revision_conflict")).toBe("retry");
    expect(remedy(null, null, "timeout")).toBe("retry");
    expect(remedy(null, null, "connector_unavailable")).toBe("retry");
  });

  test("a fault in the workflow itself is fixed in the chat", () => {
    expect(remedy(422, "input_schema_violation")).toBe("chat");
    expect(remedy(404, "connector_missing")).toBe("chat");
    expect(remedy(null, null, "placeholder_unresolved")).toBe("chat");
    expect(remedy(null, null, "schema_mismatch")).toBe("chat");
    expect(remedy(null, null, "unknown")).toBe("chat");
  });

  test("the cause class outranks the code, the code outranks the status", () => {
    expect(remedy(500, "internal_error", "authority_mismatch")).toBe("grant");
    expect(remedy(403, "connector_needs_sign_in_again")).toBe("reconnect");
  });

  test("an input the person corrects in the form has no remedy button", () => {
    expect(remedy(400, "validation_failed")).toBeNull();
    expect(remedy(404, "not_found")).toBeNull();
    expect(remedy(413, "too_large")).toBeNull();
    expect(remedy(null, null)).toBeNull();
    expect(remedy(200, null, "ok")).toBeNull();
  });

  test("reads the facts from an engine failure", () => {
    const error = new ApiError(
      409,
      {
        code: "execution_authority_required",
        message: "x",
        details: { cause_class: "authority_mismatch", workflow_id: "wf-1", connector_id: "c-1" },
      },
      "trace-1",
    );
    expect(failureFacts(error)).toEqual({
      status: 409,
      code: "execution_authority_required",
      causeClass: "authority_mismatch",
      workflowId: "wf-1",
      connectorId: "c-1",
    });
  });

  test("a failed request without an answer counts as unreachable", () => {
    expect(failureFacts(new TypeError("Failed to fetch")).status).toBe(0);
    expect(failureRemedy(failureFacts(new TypeError("Failed to fetch")))).toBe("retry");
    expect(failureFacts("boom")).toEqual({
      status: null,
      code: null,
      causeClass: null,
      workflowId: null,
      connectorId: null,
    });
    expect(failureFacts(new Error("boom")).status).toBeNull();
  });

  test("code, status and request ID are read once for remedies and error rows", () => {
    const error = new ApiError(429, { code: "rate_limited", message: "x" }, "req-7");
    expect(errorFacts(error)).toEqual({ status: 429, code: "rate_limited", traceId: "req-7" });
    expect(errorFacts(new TypeError("Failed to fetch"))).toEqual({
      status: null,
      code: null,
      traceId: null,
    });
    expect(remedy(null, null, "toString")).toBeNull();
  });

  test("every remedy has a label in both languages", () => {
    for (const kind of Object.keys(REMEDY_LABEL) as RemedyKind[]) {
      expect(CATALOGS.de[REMEDY_LABEL[kind]]).toBeTruthy();
      expect(CATALOGS.en[REMEDY_LABEL[kind]]).toBeTruthy();
    }
    expect(CATALOGS.de["remedy.retry"]).toBe("Erneut versuchen");
    expect(CATALOGS.de["remedy.admin"]).toBe("Administrator fragen");
  });
});
