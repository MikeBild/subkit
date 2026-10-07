import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../config/loader.ts";
import { cockpitConnectorUrl, oauthFlowOrigin, SIGN_IN_FAILURES } from "./oauth-origin.ts";

const ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c1";
const STORED = "https://engine.example.org/v1/oauth/callback";

let configuredBefore = "";

beforeAll(async () => {
  try {
    getConfig();
  } catch {
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/oauth-origin-test", NODE_ENV: "test" },
      configPathOverride: join(mkdtempSync(join(tmpdir(), "sk-cfg-origin-")), "subkit.config.json"),
    });
  }
  configuredBefore = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "", { force: true });
});

afterEach(async () => {
  await setConfigKey("server.public_base_url", "", { force: true });
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", configuredBefore, { force: true });
});

describe("oauthFlowOrigin", () => {
  test("reads the four origins as they are", () => {
    for (const origin of ["cli", "cockpit", "chat", "portal"] as const)
      expect(oauthFlowOrigin(origin)).toBe(origin);
  });

  test("a row from before the column, or an unknown word, is a terminal flow", () => {
    for (const stored of [null, undefined, "", "COCKPIT", "https://evil.example", "web"])
      expect(oauthFlowOrigin(stored)).toBe("cli");
  });
});

describe("cockpitConnectorUrl", () => {
  test("without a configured address: the origin of the flow's own redirect_uri", () => {
    expect(cockpitConnectorUrl({ connector_id: ID, redirect_uri: STORED })).toBe(
      `https://engine.example.org/cockpit/connectors/${ID}`,
    );
    expect(
      cockpitConnectorUrl({
        connector_id: ID,
        redirect_uri: STORED,
        outcome: { kind: "signed_in" },
      }),
    ).toBe(`https://engine.example.org/cockpit/connectors/${ID}?signed_in=1`);
  });

  test("a failed sign-in returns with its failure code and nothing else", () => {
    for (const failure of SIGN_IN_FAILURES)
      expect(
        cockpitConnectorUrl({
          connector_id: ID,
          redirect_uri: STORED,
          outcome: { kind: "signin_failed", failure },
        }),
      ).toBe(`https://engine.example.org/cockpit/connectors/${ID}?signin_failed=${failure}`);
  });

  test("the configured public address wins over the stored redirect_uri", async () => {
    await setConfigKey("server.public_base_url", "https://sk.example.org/", { force: true });
    expect(
      cockpitConnectorUrl({
        connector_id: ID,
        redirect_uri: "https://other.example/v1/oauth/callback",
      }),
    ).toBe(`https://sk.example.org/cockpit/connectors/${ID}`);
  });

  test("only the origin of the redirect_uri is used — its path and query are not", () => {
    expect(
      cockpitConnectorUrl({
        connector_id: ID,
        redirect_uri: "https://engine.example.org/v1/oauth/callback?next=https://evil.example#x",
      }),
    ).toBe(`https://engine.example.org/cockpit/connectors/${ID}`);
  });

  test("an id that is not a connector id builds no address", () => {
    for (const connector_id of [
      "",
      "../../v1/identity/logout",
      `${ID}/../../x`,
      `${ID}?next=https://evil.example`,
      `${ID}#@evil.example`,
      "//evil.example",
      "https://evil.example",
      `${ID}%2F..`,
      "javascript:alert(1)",
    ])
      expect(cockpitConnectorUrl({ connector_id, redirect_uri: STORED })).toBeNull();
  });

  test("a redirect_uri that is not a plain web origin builds no address", () => {
    for (const redirect_uri of [
      null,
      "",
      "not a url",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://user:secret@evil.example/v1/oauth/callback",
      "//evil.example/v1/oauth/callback",
    ])
      expect(cockpitConnectorUrl({ connector_id: ID, redirect_uri })).toBeNull();
  });

  test("an uppercase id is the same connector, written the way the route reads it", () => {
    expect(cockpitConnectorUrl({ connector_id: ID.toUpperCase(), redirect_uri: STORED })).toBe(
      `https://engine.example.org/cockpit/connectors/${ID}`,
    );
  });
});
