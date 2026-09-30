import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { connectorHref } from "@/app/links";
import {
  blockedSentenceKey,
  blockingConnector,
  connectorFix,
  defaultEnvironment,
  refusedConnector,
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
        href: `${connectorHref(GMAIL)}#connector-credentials`,
      });
    }
  });

  test("a connector switched off opens the connector", () => {
    const fix = connectorFix(
      blockingConnector({ unavailable_connectors: [{ ...gmail, reason: "disabled" }] })!,
    );
    expect(fix).toEqual({ labelKey: "run.openConnector", href: connectorHref(GMAIL) });
  });

  test("every reason the engine names has a sentence, except the reference limit", () => {
    for (const reason of ["needs_reauth", "disabled", "credential_unavailable", "missing"])
      expect(blockedSentenceKey(reason)).not.toBeNull();
    expect(blockedSentenceKey("too_many_references")).toBeNull();
  });
});
