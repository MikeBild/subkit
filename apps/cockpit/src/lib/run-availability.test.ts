import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { connectorHref } from "@/app/links";
import { translate } from "@/lib/i18n";
import { remedyFor } from "@/lib/remedy";
import {
  approvalRefusal,
  blockedSentenceKey,
  blockingConnector,
  connectorFix,
  defaultEnvironment,
  legacyRefusal,
  refusedConnector,
  refusedSignIn,
} from "@/lib/run-availability";

const GMAIL = "d94b2e61-5a8f-4c3d-b7e0-9f1a2c6d8e45";
const gmail = {
  step_id: "send",
  connector_id: GMAIL,
  connector_slug: "gmail",
  connector_name: "Gmail",
  reason: "needs_reauth",
};

describe("blockingConnector", () => {
  test("names the first unavailable connector of a preview", () => {
    expect(blockingConnector({ unavailable_connectors: [gmail] })).toMatchObject({
      connector_id: GMAIL,
      connector_name: "Gmail",
      reason: "needs_reauth",
    });
  });

  test("a preview that names nothing, failed, or has another shape never blocks", () => {
    expect(blockingConnector({ unavailable_connectors: [] })).toBeNull();
    expect(blockingConnector({ unavailable_steps: ["send"] })).toBeNull();
    expect(blockingConnector({ items: [], total: 0 })).toBeNull();
    expect(blockingConnector(undefined)).toBeNull();
  });
});

describe("defaultEnvironment", () => {
  test("the first environment that can run", () => {
    expect(defaultEnvironment({ dev: null, prod: null })).toBe("dev");
    expect(
      defaultEnvironment({
        dev: blockingConnector({ unavailable_connectors: [gmail] }),
        prod: null,
      }),
    ).toBe("prod");
  });

  test("development when neither can", () => {
    const blocked = blockingConnector({ unavailable_connectors: [gmail] });
    expect(defaultEnvironment({ dev: blocked, prod: blocked })).toBe("dev");
  });
});

describe("approvalRefusal", () => {
  test("a run no approval admits is refused for that reason", () => {
    for (const code of [
      "execution_authority_required",
      "execution_authority_unavailable",
      "execution_authority_changed",
    ])
      expect(approvalRefusal(new ApiError(409, { code }, null))).toBe(true);
  });

  test("any other failure is not an approval refusal", () => {
    expect(approvalRefusal(new ApiError(409, { code: "workflow_version_invalid" }, null))).toBe(
      false,
    );
    expect(approvalRefusal(new ApiError(500, { code: "execution_authority_changed" }, null))).toBe(
      false,
    );
    expect(approvalRefusal(new Error("execution_authority_required"))).toBe(false);
  });
});

describe("refusedConnector", () => {
  test("reads the connector and environment from a 409's details", () => {
    const error = new ApiError(
      409,
      {
        code: "prepared_credential_unavailable",
        message: 'Connector "gmail" in dev must be reconnected before this workflow can run.',
        details: { ...gmail, environment: "dev", execution_id: "x" },
      },
      null,
    );
    expect(refusedConnector(error)).toEqual({
      connector_id: GMAIL,
      connector_slug: "gmail",
      connector_name: "Gmail",
      reason: "needs_reauth",
      environment: "dev",
    });
  });

  test("any other failure is not a connector refusal", () => {
    expect(refusedConnector(new ApiError(500, { code: "internal_error" }, null))).toBeNull();
    expect(refusedConnector(new Error("internal error"))).toBeNull();
  });
});

describe("the fix for a blocked connector", () => {
  test("a lost or missing sign-in lands on the connector's sign-in card", () => {
    for (const reason of ["needs_reauth", "credential_unavailable"]) {
      const fix = connectorFix(
        blockingConnector({ unavailable_connectors: [{ ...gmail, reason }] })!,
      );
      expect(fix).toEqual({
        labelKey: "remedy.reconnect",
        href: `${connectorHref(GMAIL)}?tab=verbindung`,
      });
    }
  });

  test("a connector switched off opens the connector", () => {
    const fix = connectorFix(
      blockingConnector({ unavailable_connectors: [{ ...gmail, reason: "disabled" }] })!,
    );
    expect(fix).toEqual({ labelKey: "run.openConnector", href: connectorHref(GMAIL) });
  });

  test("a run refused for a lost sign-in offers 'Neu verbinden' on the connector's sign-in card", () => {
    const remedy = remedyFor({
      workflowId: "wf",
      executionId: "run",
      patch: null,
      authState: refusedSignIn({ connector_id: GMAIL, reason: "needs_reauth" }),
      canRun: true,
      canChat: true,
    });
    expect(remedy).toEqual({
      kind: "reauth",
      labelKey: "remedy.reconnect",
      href: `${connectorHref(GMAIL)}?tab=verbindung`,
    });
    expect(translate("de", "remedy.reconnect")).toBe("Neu verbinden");
  });

  test("a refusal no sign-in fixes, or that names no connector, offers no reconnect", () => {
    expect(refusedSignIn({ connector_id: GMAIL, reason: "disabled" })).toBeNull();
    expect(refusedSignIn({ connector_id: null, reason: "needs_reauth" })).toBeNull();
    expect(refusedSignIn(null)).toBeNull();
  });

  test("every reason the engine names has a sentence, except the reference limit", () => {
    for (const reason of ["needs_reauth", "disabled", "credential_unavailable", "missing"])
      expect(blockedSentenceKey(reason)).not.toBeNull();
    expect(blockedSentenceKey("too_many_references")).toBeNull();
  });
});

describe("legacyRefusal", () => {
  const refusal = (details: unknown) =>
    new ApiError(
      409,
      {
        code: "workflow_version_invalid",
        message: "stored in an earlier definition format",
        details,
      },
      null,
    );

  test("names the steps the engine names, each once", () => {
    expect(
      legacyRefusal(
        refusal({
          issues: [
            { path: "steps.0.language", step_id: "old", message: "invalid" },
            { path: "steps.0.expression", step_id: "old", message: "invalid" },
            { path: "steps.2.kind", step_id: "shape", message: "invalid" },
            { path: "name", step_id: null, message: "required" },
          ],
        }),
      ),
    ).toEqual({ steps: ["old", "shape"] });
  });

  test("is still the refusal when the engine names no step", () => {
    expect(legacyRefusal(refusal(null))).toEqual({ steps: [] });
    expect(legacyRefusal(refusal({ issues: "none" }))).toEqual({ steps: [] });
  });

  test("any other failure is not one", () => {
    expect(legacyRefusal(new ApiError(409, { code: "connector_unavailable" }, null))).toBeNull();
    expect(legacyRefusal(new Error("boom"))).toBeNull();
  });

  test("the sentence says why, and what to do, in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      const sentence = translate(locale, "run.legacySteps", { steps: "old, shape" });
      expect(sentence).toContain("old, shape");
      expect(sentence).not.toContain("{");
      expect(translate(locale, "run.legacy")).not.toBe(translate(locale, "run.failed"));
    }
    expect(translate("de", "run.legacy")).toContain("älteren Format");
  });
});
