import { describe, expect, test } from "bun:test";
import {
  connectorIdFromPage,
  connectorPath,
  isConnectorSignIn,
  namedSheet,
  openSheet,
  reduceSheet,
  SHEET_CLOSE_MS,
  SIGNIN_FINISHED_EVENT,
  sheetAddress,
  sheetSubject,
  signInFinished,
} from "./browser-sheet-model.ts";

const server = "https://subkit.example.com";
const authorize = (redirect: string, extra = "") =>
  `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&state=s1&redirect_uri=${encodeURIComponent(redirect)}${extra}`;

describe("connector sign-in", () => {
  test("is an authorization request that returns to this server's callback", () => {
    expect(isConnectorSignIn(authorize(`${server}/v1/oauth/callback`), server)).toBe(true);
  });

  test("ignores other servers, other paths and ordinary links", () => {
    expect(isConnectorSignIn(authorize("https://evil.example/v1/oauth/callback"), server)).toBe(
      false,
    );
    expect(isConnectorSignIn(authorize(`${server}/elsewhere`), server)).toBe(false);
    expect(isConnectorSignIn("https://docs.example.com/guide", server)).toBe(false);
    expect(isConnectorSignIn("mailto:a@b.c", server)).toBe(false);
  });

  test("takes the connector from the Cockpit page that started it", () => {
    expect(connectorIdFromPage(`${server}/cockpit/i/abc/connectors/con_42`)).toBe("con_42");
    expect(connectorIdFromPage(`${server}/cockpit/connectors/con_42?tab=auth`)).toBe("con_42");
    expect(connectorIdFromPage(`${server}/cockpit/connectors`)).toBeNull();
    expect(connectorIdFromPage(null)).toBeNull();
  });
});

describe("finished event", () => {
  const data = (value: unknown) => JSON.stringify(value);

  test("reads connector, outcome and the reason of a failure", () => {
    expect(
      signInFinished(
        SIGNIN_FINISHED_EVENT,
        data({ connector_id: "c1", attention_id: "connector:c1", outcome: "succeeded" }),
      ),
    ).toEqual({ connectorId: "c1", outcome: "succeeded", reason: null });
    expect(
      signInFinished(
        SIGNIN_FINISHED_EVENT,
        data({ connector_id: "c1", outcome: "failed", reason: "token_exchange_failed" }),
      ),
    ).toEqual({ connectorId: "c1", outcome: "failed", reason: "token_exchange_failed" });
  });

  test("ignores other events and malformed data", () => {
    expect(signInFinished("connector.auth_failed", data({ connector_id: "c1" }))).toBeNull();
    expect(signInFinished(SIGNIN_FINISHED_EVENT, "{")).toBeNull();
    expect(signInFinished(SIGNIN_FINISHED_EVENT, data({ outcome: "succeeded" }))).toBeNull();
    expect(
      signInFinished(SIGNIN_FINISHED_EVENT, data({ connector_id: "c1", outcome: "maybe" })),
    ).toBeNull();
    expect(
      signInFinished(
        SIGNIN_FINISHED_EVENT,
        data({ connector_id: "c1", outcome: "failed", reason: "<b>x</b>" }),
      )?.reason,
    ).toBeNull();
  });
});

describe("sheet", () => {
  test("shows host and path, never the query", () => {
    const sheet = openSheet(authorize(`${server}/v1/oauth/callback`), "c1");
    expect(sheet).toMatchObject({ host: "accounts.google.com", secure: true, phase: "open" });
    expect(sheetAddress(sheet ?? { url: "" })).toBe("accounts.google.com/o/oauth2/v2/auth");
    expect(openSheet("not a url")).toBeNull();
    expect(openSheet("http://localhost:9000/auth")?.secure).toBe(false);
  });

  test("ends with the outcome for its own connector only", () => {
    const sheet = openSheet("https://idp.example/auth", "c1");
    const other = { connectorId: "c2", outcome: "succeeded" as const, reason: null };
    expect(reduceSheet(sheet, { type: "finished", event: other })).toBe(sheet);
    const failed = reduceSheet(sheet, {
      type: "finished",
      event: { connectorId: "c1", outcome: "failed", reason: "provider_error" },
    });
    expect(failed).toMatchObject({ phase: "failed", reason: "provider_error" });
    expect(reduceSheet(failed, { type: "finished", event: { ...other, connectorId: "c1" } })).toBe(
      failed,
    );
  });

  test("without a known connector the first finished sign-in ends it", () => {
    const sheet = openSheet("https://idp.example/auth");
    expect(
      reduceSheet(sheet, {
        type: "finished",
        event: { connectorId: "any", outcome: "succeeded", reason: null },
      })?.phase,
    ).toBe("succeeded");
  });

  test("names the connector instead of the provider host once the name is known", () => {
    const sheet = openSheet("https://accounts.google.com/o/oauth2/v2/auth", "c 1");
    if (!sheet) throw new Error("sheet");
    expect(sheetSubject(sheet)).toBe("accounts.google.com");
    expect(connectorPath("c 1")).toBe("/v1/connectors/c%201");
    const named = namedSheet(sheet, "c 1", { id: "c 1", name: " Google Workspace " });
    expect(named?.connectorName).toBe("Google Workspace");
    expect(sheetSubject(named ?? sheet)).toBe("Google Workspace");
    expect(namedSheet(sheet, "c2", { name: "Other" })).toBe(sheet);
    expect(namedSheet(sheet, "c 1", { name: "" })).toBe(sheet);
    expect(namedSheet(sheet, "c 1", null)).toBe(sheet);
    expect(namedSheet(null, "c 1", { name: "X" })).toBeNull();
  });

  test("closes on request, a failure stays readable longer", () => {
    expect(reduceSheet(openSheet("https://idp.example/auth"), { type: "close" })).toBeNull();
    expect(SHEET_CLOSE_MS.failed).toBeGreaterThan(SHEET_CLOSE_MS.succeeded);
  });
});
